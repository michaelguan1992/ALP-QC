import test from "node:test";
import assert from "node:assert/strict";
import { installDomStub, findButton, flush } from "./dom-stub.js";

const dom = installDomStub();
const { renderBatchesPage } = await import("../qc-ops-batches.js");
const { createManualSaveRegistry } = await import("../qc-manual-save-registry.js");
const drafts = await import("../qc-batch-drafts.js");
const recovery = await import("../qc-draft-recovery.js");
const { DRAFT_MAX_AGE_MS, draftStorageKey } = await import("../qc-draft-storage.js");

const ORIGIN = "http://127.0.0.1:4173";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-17T10:00:00.000Z");
const KEY = draftStorageKey({ origin: ORIGIN, workspace: "main", actor: "ann", kind: "batch", recordId: "batch-1" });
const STALE = Object.assign(
  new Error("Someone else changed this record. Reload the latest data, then reapply your change."),
  { code: "stale_revision", status: 409 },
);

// A fake localStorage. `failing` makes every call throw, like a blocked or full browser store.
function fakeStorage({ failing = false } = {}) {
  const items = new Map();
  const guard = () => {
    if (failing) throw new Error("The storage is blocked.");
  };
  return {
    items,
    get length() {
      guard();
      return items.size;
    },
    key(index) {
      guard();
      return [...items.keys()][index] ?? null;
    },
    getItem(key) {
      guard();
      return items.has(key) ? items.get(key) : null;
    },
    setItem(key, value) {
      guard();
      items.set(key, String(value));
    },
    removeItem(key) {
      guard();
      items.delete(key);
    },
  };
}

let storage = null;
function configure(options = {}) {
  saveCalls = 0;
  storage = fakeStorage(options);
  recovery.configureDraftRecovery({ storage, origin: ORIGIN, workspace: "main", actor: "ann", now: () => NOW });
}

const PROCEDURE = {
  id: "asset-procedure",
  name: "procedure.pdf",
  mimeType: "application/pdf",
  category: "procedure",
  contentRevision: "r1",
  decodedBytes: 10,
  dataUrl: "data:application/pdf;base64,JVBERi0=",
};

function batchFixture() {
  return {
    id: "batch-1",
    number: "S1-20261001-AP-OQC",
    kind: "operational",
    status: "draft",
    orderId: "order-1",
    factory: "AP",
    stage: "OQC",
    date: "2026-10-01",
    recorder: "Ann",
    notes: "",
    quantity: 100,
    lineId: "line-1",
    variantId: "variant-red",
    familyId: "family-s11",
    versionId: "version-1",
    versionLabel: "26.10.01",
    products: [{ lineId: "line-1", variantId: "variant-red", familyId: "family-s11", quantity: 100, versionId: "version-1", versionLabel: "26.10.01" }],
    attachmentIds: [],
    countForPO: false,
  };
}

function rowFixtures({ defective = 1 } = {}) {
  return [
    {
      id: "row-1", no: "1", title: "Check label", titleZh: "", inspectedQty: 10, defectiveQty: defective, actualTimeSeconds: 12,
      remarks: "", savedAt: "2026-10-01T00:00:00.000Z", samplingPercent: 10, specification: "", devices: "", recordingRule: "",
      productLineId: "line-1", photoIds: [], history: [], important: false,
      attachments: { videos: null, procedures: PROCEDURE, log: null },
    },
    {
      id: "row-2", no: "2", title: "Check paint", titleZh: "", inspectedQty: 10, defectiveQty: 0, actualTimeSeconds: 8,
      remarks: "", savedAt: "2026-10-01T00:00:00.000Z", samplingPercent: 10, specification: "", devices: "", recordingRule: "",
      productLineId: "line-1", photoIds: [], history: [], important: false,
      attachments: { videos: null, procedures: null, log: null },
    },
  ];
}

function stateFixture({ batches = [batchFixture()], revision = 4 } = {}) {
  return {
    revision,
    batches,
    orders: [{ id: "order-1", number: "PO-7", lines: [] }],
    variants: [{ id: "variant-red", label: "S11", familyId: "family-s11", model: "S11" }],
    families: [{ id: "family-s11", name: "S11-S14", models: ["S11"] }],
    versions: [],
    assets: [PROCEDURE],
    issues: [],
  };
}

function workspaceFixture({ rows = rowFixtures() } = {}) {
  return {
    batch: structuredClone(batchFixture()),
    rows: structuredClone(rows),
    releaseBlockers: [],
    attachments: [],
    displayNumber: "S1-20261001-AP-OQC",
    order: { id: "order-1", number: "PO-7", lines: [] },
    issues: [],
  };
}

function savedResponse(request, revision) {
  const updated = batchFixture();
  // The server returns the batch as saved. The core trims the recorder and the notes, so the saved text is the trimmed text.
  if (request.details) {
    Object.assign(updated, {
      date: request.details.date,
      recorder: request.details.recorder.trim(),
      notes: request.details.notes.trim(),
    });
  }
  updated.rows = rowFixtures().map((row) => {
    const change = request.rows.find((candidate) => candidate.rowId === row.id);
    return change ? { ...row, defectiveQty: change.defectiveQty, actualTimeSeconds: change.actualTimeSeconds ?? row.actualTimeSeconds } : row;
  });
  return { ok: true, revision, state: stateFixture({ batches: [updated], revision }) };
}

// A departure that keeps saving would loop forever, so a test's saves are counted and the test fails after a few.
let saveCalls = 0;
function boundedSave(data) {
  saveCalls += 1;
  if (saveCalls > 3) throw new Error("Departure kept saving: the page did not settle after the save.");
  return savedResponse(data, 5);
}

function batchContext({ service, state = stateFixture(), run = async () => ({ ok: true, state }) }) {
  const saves = createManualSaveRegistry();
  const context = {
    service,
    state,
    selectedId: "batch-1",
    isDemo: false,
    navigations: [],
    commands: [],
    navigate: async (route, id, force) => {
      context.navigations.push([route, id, force]);
      return true;
    },
    refresh: async () => {},
    refreshState: async () => ({ ok: true, state }),
    isCurrentRender: () => true,
    registerManualSaveController: (controller) => saves.register(controller),
    resolveManualChanges: (label, action, options) => saves.resolve(label, action, options),
    run: async (type, data, options = {}) => {
      context.commands.push({ type, data, options });
      return run(type, data, options);
    },
  };
  return context;
}

function mount() {
  const root = dom.document.createElement("div");
  dom.body.append(root);
  return root;
}

function inputLabelled(root, label) {
  return root.querySelectorAll("input").find((input) => input.getAttribute("aria-label") === label) ?? null;
}

const DEFECTIVE_LABEL = "Defective quantity for Check label";

function noticeIn(root) {
  return root.querySelector(".qc-draft-notice");
}

function storedRecord() {
  return storage.items.has(KEY) ? JSON.parse(storage.items.get(KEY)) : null;
}

/** A page render that stands in for a reload: nothing is held in memory, and the stored copy is read again. */
async function reopen(service) {
  drafts.forgetBatchDraftsInMemory();
  const root = mount();
  await renderBatchesPage(root, batchContext({ service }));
  return root;
}

test("an edit is written to browser storage with its saved base, and no attachment body is written", async () => {
  configure();
  const root = mount();
  await renderBatchesPage(root, batchContext({ service: { getBatchWorkspace: async () => workspaceFixture() } }));

  dom.setValue(inputLabelled(root, DEFECTIVE_LABEL), "3");
  await recovery.flushDraftWrites();

  const stored = storedRecord();
  assert.deepEqual(stored.draft, { rows: { "row-1": { defectiveQty: "3" } } });
  assert.deepEqual(stored.base, { rows: { "row-1": { defectiveQty: "1" } } });
  assert.equal(stored.baseRevision, 4);
  assert.equal(storage.items.get(KEY).includes("data:"), false, "the Data URL of the attached procedure is never stored");
});

test("a reload restores the unsaved edit into the input, still unsaved, with a notice", async () => {
  configure();
  const service = { getBatchWorkspace: async () => workspaceFixture() };
  const root = mount();
  await renderBatchesPage(root, batchContext({ service }));
  dom.setValue(inputLabelled(root, DEFECTIVE_LABEL), "3");
  await recovery.flushDraftWrites();

  const reloaded = await reopen(service);

  assert.equal(inputLabelled(reloaded, DEFECTIVE_LABEL).value, "3");
  assert.equal(drafts.getRowDraft("batch-1", "row-1").defectiveQty, "3");
  assert.equal(drafts.hasBatchDrafts("batch-1"), true, "the restored edit will be saved on departure");
  assert.match(noticeIn(reloaded).textContent, /Restored unsaved edits from /);
  assert.ok(findButton(noticeIn(reloaded), "Discard restored edits"));
});

test("a field that someone else changed since the edit is not restored, and the notice names it with the typed value", async () => {
  configure();
  const service = { getBatchWorkspace: async () => workspaceFixture() };
  const root = mount();
  await renderBatchesPage(root, batchContext({ service }));
  dom.setValue(inputLabelled(root, DEFECTIVE_LABEL), "3");
  await recovery.flushDraftWrites();

  // Another person has saved row 1 with 2 since the edit was made.
  const changed = { getBatchWorkspace: async () => workspaceFixture({ rows: rowFixtures({ defective: 2 }) }) };
  const reloaded = await reopen(changed);

  assert.equal(inputLabelled(reloaded, DEFECTIVE_LABEL).value, "2");
  assert.equal(drafts.getRowDraft("batch-1", "row-1"), undefined);
  assert.match(noticeIn(reloaded).textContent, /Not restored because someone else changed it: Row 1: Check label · Defective quantity \(your value: 3\)/);
  assert.equal(storage.items.has(KEY), false, "the conflicting edit is not kept in storage either");
});

// Regression: a restored draft must be pending for in-app departure, exactly like a typed edit. Departure
// is the page's own resolveManualChanges call; a restored draft that did not count as pending would leave
// no save command behind, and the value would stay only in browser storage.
test("a restored draft is pending: departure sends the save command for it, as it would for a typed edit", async () => {
  configure();
  const service = { getBatchWorkspace: async () => workspaceFixture() };
  const root = mount();
  await renderBatchesPage(root, batchContext({ service }));
  dom.setValue(inputLabelled(root, DEFECTIVE_LABEL), "3");
  await recovery.flushDraftWrites();

  drafts.forgetBatchDraftsInMemory();
  const reopened = batchContext({ service, run: async (type, data) => boundedSave(data) });
  const reopenedRoot = mount();
  await renderBatchesPage(reopenedRoot, reopened);
  assert.equal(inputLabelled(reopenedRoot, DEFECTIVE_LABEL).value, "3");
  assert.equal(drafts.hasBatchDrafts("batch-1"), true, "the restored edit is an unsaved edit of this page");

  let left = false;
  await reopened.resolveManualChanges("leave for batches", () => {
    left = true;
  });
  await flush();

  const saves = reopened.commands.filter((command) => command.type === "saveBatchChanges");
  assert.equal(saves.length, 1, "departure issued one save for the restored edit");
  assert.deepEqual(saves[0].data.rows.map((row) => [row.rowId, row.defectiveQty]), [["row-1", 3]]);
  assert.equal(left, true, "departure continued after the acknowledgment");
  assert.equal(storage.items.has(KEY), false, "the acknowledged edit is no longer stored");
});

test("restored batch details are sent on departure", async () => {
  configure();
  const service = { getBatchWorkspace: async () => workspaceFixture() };
  const root = mount();
  await renderBatchesPage(root, batchContext({ service }));
  const recorder = root.querySelectorAll("input").find((input) => input.getAttribute("aria-label") === "Recorded by 记录人员");
  dom.setValue(recorder, "Bea");
  await recovery.flushDraftWrites();

  drafts.forgetBatchDraftsInMemory();
  const reopened = batchContext({ service, run: async (type, data) => boundedSave(data) });
  await renderBatchesPage(mount(), reopened);
  await reopened.resolveManualChanges("leave for batches", () => {});
  await flush();

  const saves = reopened.commands.filter((command) => command.type === "saveBatchChanges");
  assert.equal(saves.length, 1);
  assert.equal(saves[0].data.details.recorder, "Bea");
});

// Regression: the core trims the recorder on save. The page must not treat the trimmed saved text as a new change, or the
// departure would save the same details again and again and never leave the page.
test("a recorder and notes typed with trailing spaces are saved once, and departure completes", async () => {
  configure();
  const service = { getBatchWorkspace: async () => workspaceFixture() };
  const root = mount();
  const context = batchContext({ service, run: async (type, data) => boundedSave(data) });
  await renderBatchesPage(root, context);
  const recorder = root.querySelectorAll("input").find((input) => input.getAttribute("aria-label") === "Recorded by 记录人员");
  const notes = root.querySelectorAll("textarea").find((input) => input.getAttribute("aria-label") === "Special notes 本批次特殊情况");
  dom.setValue(recorder, "Bea ");
  dom.setValue(notes, "Second lot ");

  let left = false;
  await context.resolveManualChanges("leave for batches", () => {
    left = true;
  });
  await flush();

  const saves = context.commands.filter((command) => command.type === "saveBatchChanges");
  assert.equal(saves.length, 1, "the trimmed saved text is not a further change");
  assert.equal(left, true, "departure completes");
});

test("the batch list shows unsent edits that survive a reload, and Resume opens the batch again", async () => {
  configure();
  const service = { getBatchWorkspace: async () => workspaceFixture() };
  const root = mount();
  await renderBatchesPage(root, batchContext({ service }));
  dom.setValue(inputLabelled(root, DEFECTIVE_LABEL), "3");
  await recovery.flushDraftWrites();

  // A new tab of the same browser profile opens the list, with nothing held in memory.
  drafts.forgetBatchDraftsInMemory();
  const listRoot = mount();
  const list = { ...batchContext({ service }), selectedId: null };
  await renderBatchesPage(listRoot, list);

  const banner = listRoot.querySelector(".qc-ops-draft-warning");
  assert.ok(banner, "the list warns about the unsent edit");
  assert.match(banner.textContent, /Unsaved edits are kept in this browser until saved/);
  assert.match(banner.textContent, /1 inspection row\(s\) and 0 batch detail set\(s\) need saving\./);
  dom.click(banner.querySelectorAll("button").find((candidate) => candidate.textContent.startsWith("Resume ")));
  assert.deepEqual(list.navigations.at(-1), ["batches", "batch-1", true]);
});

test("a stored copy is removed as soon as its save is acknowledged", async () => {
  configure();
  const requests = [];
  const context = batchContext({
    service: { getBatchWorkspace: async () => workspaceFixture() },
    run: async (type, data) => {
      requests.push(data);
      return savedResponse(data, 5);
    },
  });
  const root = mount();
  await renderBatchesPage(root, context);
  dom.setValue(inputLabelled(root, DEFECTIVE_LABEL), "3");
  await recovery.flushDraftWrites();
  assert.notEqual(storage.items.get(KEY), undefined);

  let left = false;
  await context.resolveManualChanges("leave for batches", () => {
    left = true;
  });
  await flush();
  assert.equal(left, true, "departure waits for the acknowledgment");
  assert.equal(requests.length, 1);
  assert.equal(storage.items.has(KEY), false);
});

test("a discard of all batch drafts removes their stored copies", async () => {
  configure();
  const root = mount();
  await renderBatchesPage(root, batchContext({ service: { getBatchWorkspace: async () => workspaceFixture() } }));
  dom.setValue(inputLabelled(root, DEFECTIVE_LABEL), "3");
  await recovery.flushDraftWrites();
  assert.equal(storage.items.has(KEY), true);

  dom.window.dispatchEvent(new CustomEvent("masterqc:discard-operation-drafts"));

  assert.equal(storage.items.has(KEY), false);
  assert.equal(drafts.hasBatchDrafts("batch-1"), false);
});

test("Discard restored edits resets the inputs and removes the stored copy", async () => {
  configure();
  const service = { getBatchWorkspace: async () => workspaceFixture() };
  const root = mount();
  await renderBatchesPage(root, batchContext({ service }));
  dom.setValue(inputLabelled(root, DEFECTIVE_LABEL), "3");
  await recovery.flushDraftWrites();

  const reloaded = await reopen(service);
  dom.click(findButton(noticeIn(reloaded), "Discard restored edits"));
  await flush();

  assert.equal(inputLabelled(reloaded, DEFECTIVE_LABEL).value, "1");
  assert.equal(noticeIn(reloaded), null);
  assert.equal(storage.items.has(KEY), false);
  assert.equal(drafts.hasBatchDrafts("batch-1"), false);
});

test("with storage that throws, edits and departure still work from memory, and nothing is restored", async () => {
  configure({ failing: true });
  const service = { getBatchWorkspace: async () => workspaceFixture() };
  const root = mount();
  await renderBatchesPage(root, batchContext({ service }));

  dom.setValue(inputLabelled(root, DEFECTIVE_LABEL), "3");
  await recovery.flushDraftWrites();
  assert.equal(drafts.getRowDraft("batch-1", "row-1").defectiveQty, "3");

  const reloaded = await reopen(service);
  assert.equal(inputLabelled(reloaded, DEFECTIVE_LABEL).value, "1");
  assert.equal(noticeIn(reloaded), null);
});

test("drafts older than fourteen days are deleted at start-up, and newer ones survive", async () => {
  configure();
  const old = draftStorageKey({ origin: ORIGIN, workspace: "main", actor: "ann", kind: "batch", recordId: "old-batch" });
  storage.setItem(old, JSON.stringify({ savedAt: new Date(NOW - DRAFT_MAX_AGE_MS - DAY).toISOString(), baseRevision: 1, base: { rows: {} }, draft: { rows: {} } }));
  storage.setItem(KEY, JSON.stringify({ savedAt: new Date(NOW - 13 * DAY).toISOString(), baseRevision: 4, base: { rows: {} }, draft: { rows: {} } }));

  assert.equal(recovery.purgeExpiredStoredDrafts(), 1);
  assert.equal(storage.items.has(old), false);
  assert.equal(storage.items.has(KEY), true);
});

test("a save refused as stale says 'Not saved' in the header, marks the row 'Save failed', and raises no toast", async () => {
  configure();
  const context = batchContext({
    service: { getBatchWorkspace: async () => workspaceFixture() },
    run: async () => ({ ok: false, stale: true, reloadRequired: true, error: STALE }),
  });
  const root = mount();
  await renderBatchesPage(root, context);
  dom.setValue(inputLabelled(root, DEFECTIVE_LABEL), "3");
  const toastsBefore = dom.toastHost.children.length;

  const saved = await context.resolveManualChanges("leave for batches", () => {});
  await flush();

  assert.equal(saved, false);
  assert.equal(root.querySelector(".qc-ops-save-error").textContent, "Not saved — see message above");
  assert.deepEqual(root.querySelectorAll(".qc-ops-save-failed").map((node) => node.textContent), ["Save failed"], "only the row label says so");
  assert.equal(dom.toastHost.children.length, toastsBefore, "no toast for a stale save");
});

test("batch details restore field by field: a note is restored, a recorder someone else saved is not", async () => {
  configure();
  const service = { getBatchWorkspace: async () => workspaceFixture() };
  const root = mount();
  await renderBatchesPage(root, batchContext({ service }));
  const recorderInput = (scope) => scope.querySelectorAll("input").find((input) => input.getAttribute("aria-label") === "Recorded by 记录人员");
  const notesInput = (scope) => scope.querySelectorAll("textarea").find((input) => input.getAttribute("aria-label") === "Special notes 本批次特殊情况");
  dom.setValue(recorderInput(root), "Bea");
  dom.setValue(notesInput(root), "Check the second lot");
  await recovery.flushDraftWrites();
  assert.deepEqual(storedRecord().draft.details, { recorder: "Bea", notes: "Check the second lot" });

  // Another person has since recorded the batch as Cy. The notes are unchanged on the server.
  const changed = { getBatchWorkspace: async () => ({ ...workspaceFixture(), batch: { ...batchFixture(), recorder: "Cy" } }) };
  const reloaded = await reopen(changed);

  assert.equal(recorderInput(reloaded).value, "Cy");
  assert.equal(notesInput(reloaded).value, "Check the second lot");
  assert.deepEqual(drafts.getDetailDraft("batch-1"), { date: "2026-10-01", recorder: "Cy", notes: "Check the second lot" });
  const text = noticeIn(reloaded).textContent;
  assert.match(text, /Restored unsaved edits from /);
  assert.match(text, /Not restored because someone else changed it: Recorded by \(your value: Bea\)/);
});
