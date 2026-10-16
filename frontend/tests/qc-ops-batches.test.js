import test from "node:test";
import assert from "node:assert/strict";
import { installDomStub, findButton, flush } from "./dom-stub.js";

const dom = installDomStub();
const { renderBatchesPage, inspectionControlName } = await import("../qc-ops-batches.js");
const { createManualSaveRegistry } = await import("../qc-manual-save-registry.js");
const { getRowDraft } = await import("../qc-batch-drafts.js");

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

function rowFixtures() {
  return [
    {
      id: "row-1", no: "1", title: "Check label", titleZh: "", inspectedQty: 10, defectiveQty: 1, actualTimeSeconds: 12,
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

function workspaceFixture(batch = batchFixture()) {
  return {
    batch: structuredClone(batch),
    rows: rowFixtures(),
    releaseBlockers: [],
    attachments: [],
    displayNumber: "S1-20261001-AP-OQC",
    order: { id: "order-1", number: "PO-7", lines: [] },
    issues: [],
  };
}

function savedResponse(request, revision) {
  const updated = batchFixture();
  updated.rows = rowFixtures().map((row) => {
    const change = request.rows.find((candidate) => candidate.rowId === row.id);
    return change ? { ...row, defectiveQty: change.defectiveQty, actualTimeSeconds: change.actualTimeSeconds ?? row.actualTimeSeconds } : row;
  });
  return { ok: true, revision, state: stateFixture({ batches: [updated], revision }) };
}

function batchContext({ service, state = stateFixture(), run = async () => ({ ok: true, state }), isCurrentRender = () => true, registerManualSaveController = null }) {
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
    isCurrentRender,
    registerManualSaveController: registerManualSaveController ?? ((controller) => saves.register(controller)),
    resolveManualChanges: (label, action, options) => saves.resolve(label, action, options),
    run: async (type, data, options = {}) => {
      context.commands.push({ type, data, options });
      return run(type, data, options);
    },
    saves,
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

test("a superseded batch render changes nothing: no DOM work, no toast, no controller registration", async () => {
  const root = mount();
  let resolveWorkspace;
  let current = true;
  let registrations = 0;
  const context = batchContext({
    service: { getBatchWorkspace: () => new Promise((resolve) => { resolveWorkspace = resolve; }) },
    isCurrentRender: () => current,
    registerManualSaveController: () => {
      registrations += 1;
      return () => {};
    },
  });

  const pending = renderBatchesPage(root, context);
  current = false;
  resolveWorkspace(workspaceFixture());
  await pending;

  assert.equal(registrations, 0);
  assert.equal(dom.toastHost.children.length, 0);
  assert.equal(root.textContent, "Loading batch workspace…");
});

test("a batch render whose root has left the document does nothing when its read fails", async () => {
  const root = mount();
  let rejectWorkspace;
  const context = batchContext({
    service: { getBatchWorkspace: () => new Promise((_resolve, reject) => { rejectWorkspace = reject; }) },
  });

  const pending = renderBatchesPage(root, context);
  root.remove();
  rejectWorkspace(new Error("That batch is no longer available."));
  await pending;

  assert.equal(dom.toastHost.children.length, 0);
});

test("deleting a batch does not re-render it and leaves for the list at once", async () => {
  const root = mount();
  let workspaceReads = 0;
  const context = batchContext({
    service: { getBatchWorkspace: async () => { workspaceReads += 1; return workspaceFixture(); } },
    state: stateFixture({ batches: [] }),
    run: async () => ({ ok: true, state: stateFixture({ batches: [] }) }),
  });

  await renderBatchesPage(root, context);
  dom.click(findButton(root, "Delete"));
  await flush();

  assert.equal(workspaceReads, 1);
  const deleteCommand = context.commands.find((command) => command.type === "deleteBatch");
  assert.equal(deleteCommand.options.render, false);
  assert.deepEqual(context.navigations.at(-1), ["batches", null, true]);
  assert.equal(dom.toastHost.children.length, 0);
});

test("the batch details form is marked for controller-managed saving, so it cannot raise a false prompt", async () => {
  const root = mount();
  await renderBatchesPage(root, batchContext({ service: { getBatchWorkspace: async () => workspaceFixture() } }));

  const detailsForm = root.querySelector("form.qc-ops-detail-form");
  assert.equal(detailsForm.dataset.autosaveForm, "true");
});

test("inspection table controls state their row and file slot", async () => {
  const root = mount();
  await renderBatchesPage(root, batchContext({ service: { getBatchWorkspace: async () => workspaceFixture() } }));

  const names = root.querySelectorAll("button").map((button) => button.getAttribute("aria-label"));
  for (const expected of [
    "Add Videos for Check label",
    "Add Log for Check label",
    "Replace Procedures for Check label",
    "Preview Procedures file procedure.pdf for Check label",
    "Download Procedures file procedure.pdf for Check label",
    "Remove Procedures file procedure.pdf for Check label",
    "Create issue for Check label",
    "Create issue for Check paint",
    "Add Videos for Check paint",
  ]) {
    assert.ok(names.includes(expected), `missing accessible name: ${expected}`);
  }

  for (const button of root.querySelectorAll(".qc-ops-inspection-table button")) {
    const label = button.getAttribute("aria-label");
    assert.ok(label, `table button without an accessible name: ${button.textContent}`);
    assert.ok(label.startsWith(button.textContent), `accessible name "${label}" does not begin with "${button.textContent}"`);
  }
});

test("inspectionControlName builds names from the action, slot, file and row", () => {
  const row = { title: "Check label" };
  assert.equal(inspectionControlName({ action: "Create issue" }, row), "Create issue for Check label");
  assert.equal(inspectionControlName({ action: "Add", slot: "Log" }, row), "Add Log for Check label");
  assert.equal(inspectionControlName({ action: "Remove", slot: "Videos", fileName: "clip.mp4" }, row), "Remove Videos file clip.mp4 for Check label");
  assert.equal(inspectionControlName({ action: "Add", slot: "Log" }, null), "Add Log for inspection row");
});

test("a departure save keeps typing made during the save and saves it before leaving", async () => {
  const root = mount();
  const requests = [];
  let releaseFirst;
  const context = batchContext({
    service: { getBatchWorkspace: async () => workspaceFixture() },
    run: async (type, data) => {
      if (type !== "saveBatchChanges") throw new Error(`unexpected command ${type}`);
      requests.push(data);
      if (requests.length === 1) return new Promise((resolve) => { releaseFirst = resolve; });
      return savedResponse(data, 5);
    },
  });

  await renderBatchesPage(root, context);
  const defective = inputLabelled(root, "Defective quantity for Check label");
  dom.setValue(defective, "2");

  let left = 0;
  const leaving = context.resolveManualChanges("leave for batches", () => { left += 1; });
  await flush(2);
  dom.setValue(defective, "3");
  releaseFirst(savedResponse(requests[0], 4));
  await leaving;
  await flush();

  assert.deepEqual(requests.map((request) => request.rows[0].defectiveQty), [2, 3]);
  assert.equal(left, 1);
  assert.equal(getRowDraft("batch-1", "row-1"), undefined);
  assert.equal(defective.value, "3");
});
