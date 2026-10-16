import test from "node:test";
import assert from "node:assert/strict";
import { installDomStub } from "./dom-stub.js";

const dom = installDomStub();
const drafts = await import("../qc-batch-drafts.js");

function row(overrides = {}) {
  return { id: "row-1", inspectedQty: 10, defectiveQty: 1, actualTimeSeconds: 12, remarks: "", ...overrides };
}

function draft(overrides = {}) {
  return { defectiveQty: "1", actualTimeSeconds: "12", remarks: "", invalidDefectiveQty: false, invalidActualTimeSeconds: false, ...overrides };
}

test("a save removes the stored draft only when it still equals the submitted snapshot", () => {
  drafts.clearBatchDrafts();
  const submitted = draft({ defectiveQty: "2" });
  drafts.setRowDraft("batch-1", "row-1", draft({ defectiveQty: "2" }));

  assert.equal(drafts.reconcileSavedRowDraft("batch-1", "row-1", submitted), true);
  assert.equal(drafts.getRowDraft("batch-1", "row-1"), undefined);
});

test("typing made while a save was in flight survives its acknowledgment", () => {
  drafts.clearBatchDrafts();
  const submitted = draft({ defectiveQty: "2" });
  drafts.setRowDraft("batch-1", "row-1", draft({ defectiveQty: "3" }));

  assert.equal(drafts.reconcileSavedRowDraft("batch-1", "row-1", submitted), false);
  assert.equal(drafts.getRowDraft("batch-1", "row-1").defectiveQty, "3");
});

test("detail drafts follow the same rule", () => {
  drafts.clearBatchDrafts();
  const submitted = { date: "2026-10-01", recorder: "Ann", notes: "" };
  drafts.setDetailDraft("batch-1", { date: "2026-10-01", recorder: "Bea", notes: "" });

  assert.equal(drafts.reconcileSavedDetailDraft("batch-1", submitted), false);
  assert.equal(drafts.reconcileSavedDetailDraft("batch-1", { date: "2026-10-01", recorder: "Bea", notes: "" }), true);
  assert.equal(drafts.getDetailDraft("batch-1"), undefined);
});

test("a render drops drafts that already match the persisted row and keeps real changes", () => {
  drafts.clearBatchDrafts();
  const batch = { id: "batch-1" };
  drafts.setRowDraft("batch-1", "row-1", draft());
  drafts.setRowDraft("batch-1", "row-2", draft({ defectiveQty: "4" }));
  drafts.setRowDraft("batch-1", "row-3", draft({ invalidDefectiveQty: true }));
  const rows = [row({ id: "row-1" }), row({ id: "row-2" }), row({ id: "row-3" })];

  drafts.pruneSavedBatchDrafts(batch, rows);

  assert.equal(drafts.getRowDraft("batch-1", "row-1"), undefined);
  assert.equal(drafts.getRowDraft("batch-1", "row-2").defectiveQty, "4");
  assert.equal(drafts.getRowDraft("batch-1", "row-3").invalidDefectiveQty, true);
});

test("pruning a historical row compares the inspected quantity as well", () => {
  const historicalRow = { id: "row-h", inspectedQty: 20, defectiveQty: 2, actualTimeSeconds: null };

  assert.equal(drafts.rowDraftMatchesSaved(historicalRow, { inspectedQty: "20", defectiveQty: "2", actualTimeSeconds: "" }, { historical: true }), true);
  assert.equal(drafts.rowDraftMatchesSaved(historicalRow, { inspectedQty: "21", defectiveQty: "2", actualTimeSeconds: "" }, { historical: true }), false);
  assert.equal(drafts.rowDraftMatchesSaved(historicalRow, { inspectedQty: "20", defectiveQty: "2", actualTimeSeconds: "" }, { historical: false }), true);
});

test("an untouched legacy time and an unparsable value are treated as the rules require", () => {
  const legacyRow = { id: "row-l", defectiveQty: 0 };

  assert.equal(drafts.rowDraftMatchesSaved(legacyRow, { defectiveQty: "0", actualTimeSeconds: undefined }), true);
  assert.equal(drafts.rowDraftMatchesSaved(legacyRow, { defectiveQty: "0", actualTimeSeconds: "5" }), false);
  assert.equal(drafts.rowDraftMatchesSaved(legacyRow, { defectiveQty: "abc" }), false);
});

test("drafts are isolated per batch and listed per batch", () => {
  drafts.clearBatchDrafts();
  drafts.setRowDraft("batch-1", "row-1", draft());
  drafts.setRowDraft("batch-2", "row-1", draft({ defectiveQty: "9" }));
  drafts.setDetailDraft("batch-2", { date: "2026-10-02", recorder: "Ann", notes: "" });

  assert.deepEqual(drafts.batchRowDrafts("batch-1").map(([rowId]) => rowId), ["row-1"]);
  assert.equal(drafts.batchRowDrafts("batch-1")[0][1].defectiveQty, "1");
  assert.deepEqual(drafts.pendingBatchIds().sort(), ["batch-1", "batch-2"]);
  assert.deepEqual(drafts.draftCounts(), { rows: 2, details: 1 });

  drafts.clearDraftsForBatch("batch-2");
  assert.equal(drafts.hasBatchDrafts("batch-2"), false);
  assert.equal(drafts.hasBatchDrafts("batch-1"), true);
});

test("the discard event clears every batch draft", () => {
  drafts.clearBatchDrafts();
  drafts.setRowDraft("batch-1", "row-1", draft());
  dom.window.dispatchEvent(new CustomEvent("masterqc:discard-operation-drafts"));

  assert.equal(drafts.hasAnyBatchDrafts(), false);
});

test("row controls receive the save status only when they still hold a draft", () => {
  drafts.clearBatchDrafts();
  drafts.setRowDraft("batch-1", "row-1", draft());
  const withDraft = dom.document.createElement("span");
  const withoutDraft = dom.document.createElement("span");
  const registry = drafts.createBatchRowRegistry();
  registry.register("row-1", withDraft, null, null);
  registry.register("row-2", withoutDraft, null, null);

  registry.applyStatus("batch-1", "Saving…");
  assert.equal(withDraft.textContent, "Saving…");
  assert.equal(withDraft.hidden, false);
  assert.equal(withoutDraft.textContent, "");

  registry.applyStatus("batch-1", "Saved");
  assert.equal(withDraft.hidden, true);
  assert.equal(withDraft.textContent, "");
});
