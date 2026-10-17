import test from "node:test";
import assert from "node:assert/strict";
import { installDomStub, findButton, flush } from "./dom-stub.js";

const dom = installDomStub();
const recovery = await import("../qc-draft-recovery.js");
const { draftStorageKey, DRAFT_MAX_AGE_MS } = await import("../qc-draft-storage.js");
const { createManualSaveRegistry } = await import("../qc-manual-save-registry.js");
const { closeDialog } = await import("../qc-ui.js");
let dialogModule = await import("../qc-issue-dialog.js");

const ORIGIN = "http://127.0.0.1:4173";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-17T10:00:00.000Z");
const KEY = draftStorageKey({ origin: ORIGIN, workspace: "main", actor: "ann", kind: "issue", recordId: "issue-a" });

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
  storage = fakeStorage(options);
  recovery.configureDraftRecovery({ storage, origin: ORIGIN, workspace: "main", actor: "ann", now: () => NOW });
}

function issueFixture(overrides = {}) {
  return {
    id: "issue-a",
    number: "ISS-1",
    title: "Dent",
    status: "open",
    owner: "",
    disposition: "",
    confirmations: ["", "", ""],
    reportedBy: "Ann",
    batchId: null,
    description: "",
    attachmentIds: [],
    discussion: [],
    sourceSnapshot: {},
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function stateFixture(issues, revision = 3) {
  return { revision, issues, batches: [], assets: [], variants: [], families: [], orders: [], versions: [] };
}

function issueContext({ state, run }) {
  const saves = createManualSaveRegistry();
  const context = {
    service: {},
    state,
    selectedId: null,
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

function fieldNamed(root, name) {
  return [...root.querySelectorAll("input"), ...root.querySelectorAll("textarea")].find((node) => node.name === name) ?? null;
}

function saveStatusText() {
  return dom.dialog()?.querySelector(".qc-ops-issue-save-status")?.textContent ?? "";
}

function noticeIn() {
  return dom.dialog()?.querySelector(".qc-draft-notice") ?? null;
}

/** Opens the Issue in a fresh copy of the dialog module, as a reloaded page would. Nothing is held in memory. */
async function reopenAfterReload(issue, state, context) {
  closeDialog(true);
  dialogModule = await import(`../qc-issue-dialog.js?reload=${Math.random()}`);
  dialogModule.openIssueDialog(issue, state, context);
}

test("an unsaved disposition edit is written to storage, without any attachment body", async () => {
  configure();
  dialogModule.clearIssueDrafts();
  const issue = issueFixture({ attachments: [{ id: "att-1", name: "scan.pdf", mimeType: "application/pdf", category: "file", dataUrl: "data:application/pdf;base64,JVBERi0=" }] });
  const state = stateFixture([issue]);
  const context = issueContext({ state, run: async () => ({ ok: true, state }) });

  dialogModule.openIssueDialog(issue, state, context);
  dom.setValue(fieldNamed(dom.dialog(), "owner"), "Ann");
  await recovery.flushDraftWrites();

  const stored = JSON.parse(storage.items.get(KEY));
  assert.deepEqual(stored.draft, { owner: "Ann" });
  assert.deepEqual(stored.base, { owner: "" });
  assert.equal(stored.baseRevision, 3);
  assert.equal(storage.items.get(KEY).includes("data:"), false);
  closeDialog(true);
});

test("a reload restores the edit into the form, still unsaved, with a notice", async () => {
  configure();
  dialogModule.clearIssueDrafts();
  const issue = issueFixture();
  const state = stateFixture([issue]);
  const context = issueContext({ state, run: async () => ({ ok: true, state }) });
  dialogModule.openIssueDialog(issue, state, context);
  dom.setValue(fieldNamed(dom.dialog(), "owner"), "Ann");
  await recovery.flushDraftWrites();

  await reopenAfterReload(issue, state, context);

  assert.equal(fieldNamed(dom.dialog(), "owner").value, "Ann");
  assert.equal(saveStatusText(), "Unsaved changes");
  assert.match(noticeIn().textContent, /Restored unsaved edits from /);
  assert.ok(findButton(noticeIn(), "Discard restored edits"));
  closeDialog(true);
});

test("Discard restored edits resets the form and removes the stored copy", async () => {
  configure();
  dialogModule.clearIssueDrafts();
  const issue = issueFixture();
  const state = stateFixture([issue]);
  const context = issueContext({ state, run: async () => ({ ok: true, state }) });
  dialogModule.openIssueDialog(issue, state, context);
  dom.setValue(fieldNamed(dom.dialog(), "owner"), "Ann");
  await recovery.flushDraftWrites();
  await reopenAfterReload(issue, state, context);

  dom.click(findButton(noticeIn(), "Discard restored edits"));
  await flush();

  assert.equal(fieldNamed(dom.dialog(), "owner").value, "");
  assert.equal(noticeIn(), null);
  assert.equal(storage.items.has(KEY), false);
  assert.equal(dialogModule.hasUnsavedIssueWork(), false);
  closeDialog(true);
});

test("a saved disposition removes its stored copy as soon as the save is acknowledged", async () => {
  configure();
  dialogModule.clearIssueDrafts();
  const issue = issueFixture();
  const state = stateFixture([issue]);
  const context = issueContext({
    state,
    run: async (type, data) => ({ ok: true, state: stateFixture([{ ...issue, owner: data.owner }], 4), revision: 4 }),
  });
  dialogModule.openIssueDialog(issue, state, context);
  dom.setValue(fieldNamed(dom.dialog(), "owner"), "Ann");
  await recovery.flushDraftWrites();
  assert.equal(storage.items.has(KEY), true);

  dom.click(findButton(dom.dialog(), "Save changes"));
  await flush();

  assert.equal(storage.items.has(KEY), false);
  assert.equal(saveStatusText(), "Saved");
  closeDialog(true);
});

test("an edit whose field someone else has since changed is not restored, and the notice names it", async () => {
  configure();
  dialogModule.clearIssueDrafts();
  const issue = issueFixture();
  const state = stateFixture([issue]);
  const context = issueContext({ state, run: async () => ({ ok: true, state }) });
  dialogModule.openIssueDialog(issue, state, context);
  dom.setValue(fieldNamed(dom.dialog(), "owner"), "Ann");
  await recovery.flushDraftWrites();

  const changed = issueFixture({ owner: "Bea" });
  await reopenAfterReload(changed, stateFixture([changed], 5), context);

  assert.equal(fieldNamed(dom.dialog(), "owner").value, "Bea");
  assert.equal(saveStatusText(), "Saved");
  assert.match(noticeIn().textContent, /Not restored because someone else changed it: Disposition owner \(your value: Ann\)/);
  assert.equal(storage.items.has(KEY), false);
  closeDialog(true);
});

test("an Issue that is closed is shown as saved and restores nothing", async () => {
  configure();
  dialogModule.clearIssueDrafts();
  const issue = issueFixture();
  const state = stateFixture([issue]);
  const context = issueContext({ state, run: async () => ({ ok: true, state }) });
  dialogModule.openIssueDialog(issue, state, context);
  dom.setValue(fieldNamed(dom.dialog(), "owner"), "Ann");
  await recovery.flushDraftWrites();

  const closed = issueFixture({ status: "closed", owner: "Bea", disposition: "Scrap", confirmations: ["Ann", "Bea", "Cy"] });
  await reopenAfterReload(closed, stateFixture([closed], 5), context);

  assert.equal(fieldNamed(dom.dialog(), "owner").value, "Bea");
  assert.equal(noticeIn(), null);
  assert.equal(storage.items.has(KEY), false, "an edit that can no longer be saved is not kept");
  closeDialog(true);
});

test("with storage that throws, the dialog still edits and saves from memory and restores nothing", async () => {
  configure({ failing: true });
  dialogModule.clearIssueDrafts();
  const issue = issueFixture();
  const state = stateFixture([issue]);
  const context = issueContext({ state, run: async () => ({ ok: true, state }) });
  dialogModule.openIssueDialog(issue, state, context);
  dom.setValue(fieldNamed(dom.dialog(), "owner"), "Ann");
  await recovery.flushDraftWrites();
  assert.equal(dialogModule.storedIssueDraft("issue-a").owner, "Ann");

  await reopenAfterReload(issue, state, context);

  assert.equal(fieldNamed(dom.dialog(), "owner").value, "");
  assert.equal(noticeIn(), null);
  closeDialog(true);
});

test("an Issue draft older than fourteen days is deleted at start-up", () => {
  configure();
  storage.setItem(KEY, JSON.stringify({ savedAt: new Date(NOW - DRAFT_MAX_AGE_MS - DAY).toISOString(), baseRevision: 3, base: { owner: "" }, draft: { owner: "Ann" } }));

  assert.equal(recovery.purgeExpiredStoredDrafts(), 1);
  assert.equal(storage.items.has(KEY), false);
});
