// Batch inspection drafts shared by the operational and historical batch pages.
//
// Drafts live outside the DOM, so a re-rendered page, or a departure while a replacement page is
// still loading, can still see and save them. A saved commit removes a stored draft only when the
// stored value still equals what was submitted, so typing made during a save survives. A page
// render also drops drafts that already match the persisted values.

const KEY_SEPARATOR = "::";
const ROW_DRAFT_FIELDS = [
  "inspectedQty", "defectiveQty", "actualTimeSeconds", "remarks",
  "invalidInspectedQty", "invalidDefectiveQty", "invalidActualTimeSeconds",
];
const DETAIL_FIELDS = ["date", "recorder", "notes"];

const rowDrafts = new Map();
const batchDetailDrafts = new Map();

export function rowKey(batchId, rowId) {
  return `${batchId}${KEY_SEPARATOR}${rowId}`;
}

function detailKey(batchId) {
  return String(batchId);
}

export function getRowDraft(batchId, rowId) {
  return rowDrafts.get(rowKey(batchId, rowId));
}

export function setRowDraft(batchId, rowId, draft) {
  rowDrafts.set(rowKey(batchId, rowId), draft);
}

export function deleteRowDraft(batchId, rowId) {
  rowDrafts.delete(rowKey(batchId, rowId));
}

/** [rowId, draft] pairs held for one batch. */
export function batchRowDrafts(batchId) {
  const prefix = `${batchId}${KEY_SEPARATOR}`;
  return [...rowDrafts]
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, draft]) => [key.slice(prefix.length), draft]);
}

export function getDetailDraft(batchId) {
  return batchDetailDrafts.get(detailKey(batchId));
}

export function setDetailDraft(batchId, draft) {
  batchDetailDrafts.set(detailKey(batchId), draft);
}

export function deleteDetailDraft(batchId) {
  batchDetailDrafts.delete(detailKey(batchId));
}

export function hasBatchDrafts(batchId) {
  return batchRowDrafts(batchId).length > 0 || batchDetailDrafts.has(detailKey(batchId));
}

export function hasAnyBatchDrafts() {
  return rowDrafts.size > 0 || batchDetailDrafts.size > 0;
}

export function draftCounts() {
  return { rows: rowDrafts.size, details: batchDetailDrafts.size };
}

/** Batch ids that still hold row or detail drafts. */
export function pendingBatchIds() {
  const ids = new Set(batchDetailDrafts.keys());
  for (const key of rowDrafts.keys()) ids.add(key.slice(0, key.indexOf(KEY_SEPARATOR)));
  return [...ids];
}

export function clearDraftsForBatch(batchId) {
  for (const [rowId] of batchRowDrafts(batchId)) deleteRowDraft(batchId, rowId);
  deleteDetailDraft(batchId);
}

export function clearBatchDrafts() {
  rowDrafts.clear();
  batchDetailDrafts.clear();
}

export function sameRowDraft(left, right) {
  return ROW_DRAFT_FIELDS.every((field) => left?.[field] === right?.[field]);
}

export function sameDetailDraft(left, right) {
  return DETAIL_FIELDS.every((field) => (left?.[field] ?? "") === (right?.[field] ?? ""));
}

/**
 * After an acknowledged save: removes the stored row draft only if it still equals the submitted
 * snapshot. Returns true when a draft was removed.
 */
export function reconcileSavedRowDraft(batchId, rowId, submittedDraft) {
  const stored = getRowDraft(batchId, rowId);
  if (!stored || !submittedDraft || !sameRowDraft(stored, submittedDraft)) return false;
  deleteRowDraft(batchId, rowId);
  return true;
}

/** Same rule as reconcileSavedRowDraft, for the batch details draft. */
export function reconcileSavedDetailDraft(batchId, submittedDetails) {
  const stored = getDetailDraft(batchId);
  if (!stored || !submittedDetails || !sameDetailDraft(stored, submittedDetails)) return false;
  deleteDetailDraft(batchId);
  return true;
}

function draftNumber(value) {
  return value === "" || value === null || value === undefined ? null : Number(value);
}

/** True when a row draft holds exactly the persisted values, so it no longer represents a change. */
export function rowDraftMatchesSaved(row, draft, { historical = false } = {}) {
  if (!row || !draft || draft.invalidInspectedQty || draft.invalidDefectiveQty || draft.invalidActualTimeSeconds) return false;
  if (historical && draftNumber(draft.inspectedQty) !== (row.inspectedQty ?? null)) return false;
  if (draftNumber(draft.defectiveQty) !== (row.defectiveQty ?? null)) return false;
  if (draft.actualTimeSeconds !== undefined && draftNumber(draft.actualTimeSeconds) !== (row.actualTimeSeconds ?? null)) return false;
  return true;
}

/** Drops drafts that already match the persisted batch. Called when a page renders from fresh data. */
export function pruneSavedBatchDrafts(batch, rows, { historical = false, savedDetails = null } = {}) {
  for (const [rowId, draft] of batchRowDrafts(batch.id)) {
    const row = rows.find((candidate) => candidate.id === rowId);
    if (row && rowDraftMatchesSaved(row, draft, { historical })) deleteRowDraft(batch.id, rowId);
  }
  const detail = getDetailDraft(batch.id);
  if (detail && savedDetails && sameDetailDraft(detail, savedDetails)) deleteDetailDraft(batch.id);
}

/** The save status shown on batch inspection controls. Other statuses stay hidden. */
export function visibleSaveStatus(status) {
  return status === "Saving…" || status === "Save failed" ? status : "";
}

export function applySaveStatus(element, status) {
  const visible = visibleSaveStatus(status);
  element.textContent = visible;
  element.hidden = !visible;
  element.className = visible === "Saving…" ? "qc-ops-save-pending"
    : visible === "Save failed" ? "qc-ops-save-failed" : "";
}

/**
 * Per-render registry of inspection row controls, so that save status reaches every row that still
 * holds a draft and post-save resets reach the matching row inputs.
 */
export function createBatchRowRegistry() {
  const statusEntries = new Map(); // rowId -> { status, createIssueButton }
  const inputStates = new Map(); // rowId -> row input state (see qc-batch-rows.js)
  return {
    register(rowId, status, createIssueButton, inputState) {
      statusEntries.set(rowId, { status, createIssueButton });
      inputStates.set(rowId, inputState);
    },
    inputState(rowId) {
      return inputStates.get(rowId) ?? null;
    },
    inputEntries() {
      return [...inputStates];
    },
    applyStatus(batchId, status) {
      for (const [rowId, entry] of statusEntries) {
        if (!getRowDraft(batchId, rowId)) continue;
        applySaveStatus(entry.status, status);
      }
    },
  };
}

window.addEventListener("masterqc:discard-operation-drafts", clearBatchDrafts);
