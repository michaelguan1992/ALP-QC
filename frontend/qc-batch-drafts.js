// Batch inspection drafts shared by the operational and historical batch pages.
//
// Drafts live outside the DOM, so a re-rendered page, or a departure while a replacement page is
// still loading, can still see and save them. A saved commit removes a stored draft only when the
// stored value still equals what was submitted, so typing made during a save survives. A page
// render also drops drafts that already match the persisted values.
//
// Each changed field also keeps its base: the saved text the user started editing from. When the page
// renders from fresh data, a field whose saved value has moved on since its base is not applied, and the
// user is told (see openBatchDrafts). Unsent edits are mirrored to browser-local storage through
// qc-draft-recovery.js and removed once they are saved or discarded.

import { DETAIL_FIELDS as DETAIL_FIELD_SPECS, ROW_FIELDS as ROW_FIELD_SPECS, classifyFields, pickFields, rowFieldNames, savedTextOf, textOf } from "./qc-draft-model.js";
import { discardAllStoredDrafts, discardStoredDraft, draftTimestamp, readStoredDraft, scheduleDraftWrite, storedDraftIds, writeDraftNow } from "./qc-draft-recovery.js";

const KEY_SEPARATOR = "::";
const DRAFT_KIND = "batch";
const ROW_DRAFT_FIELDS = [
  "inspectedQty", "defectiveQty", "actualTimeSeconds", "remarks",
  "invalidInspectedQty", "invalidDefectiveQty", "invalidActualTimeSeconds",
];
const DETAIL_FIELDS = ["date", "recorder", "notes"];

const rowDrafts = new Map();
const batchDetailDrafts = new Map();
// Bases of the changed fields: the saved text each one was edited from. Keyed like the drafts.
const rowBases = new Map();
const detailBases = new Map();
// The saved rows and details the page last rendered from, by batch id. Saves update these same objects.
const views = new Map();
// Restore notices awaiting the user, and the time of each batch's latest in-memory edit.
const notices = new Map();
const touchedAt = new Map();

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function rowKey(batchId, rowId) {
  return `${batchId}${KEY_SEPARATOR}${rowId}`;
}

function detailKey(batchId) {
  return String(batchId);
}

function isInvalidRowField(draft, name) {
  const flag = ROW_FIELD_SPECS[name].invalidFlag;
  return Boolean(flag) && draft[flag] === true;
}

function defaultDescribeRow(row) {
  return textOf(row.title);
}

function rowLabel(view, row) {
  const title = view.describeRow(row) || "";
  const number = textOf(row.no);
  return [number ? `Row ${number}` : "", title].filter(Boolean).join(": ") || "Inspection row";
}

function viewOf(batchId) {
  return views.get(String(batchId)) ?? null;
}

export function getRowDraft(batchId, rowId) {
  return rowDrafts.get(rowKey(batchId, rowId));
}

export function setRowDraft(batchId, rowId, draft) {
  rowDrafts.set(rowKey(batchId, rowId), draft);
  refreshRowBases(batchId, rowId);
  noteBatchChange(batchId);
}

export function deleteRowDraft(batchId, rowId) {
  rowDrafts.delete(rowKey(batchId, rowId));
  rowBases.delete(rowKey(batchId, rowId));
  scheduleBatchWrite(batchId);
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
  refreshDetailBases(batchId);
  noteBatchChange(batchId);
}

export function deleteDetailDraft(batchId) {
  batchDetailDrafts.delete(detailKey(batchId));
  detailBases.delete(detailKey(batchId));
  scheduleBatchWrite(batchId);
}

export function hasBatchDrafts(batchId) {
  return batchRowDrafts(batchId).length > 0 || batchDetailDrafts.has(detailKey(batchId));
}

/**
 * Whether any batch holds unsent edits, in memory or only in browser storage. A stored copy counts as much as a
 * draft in memory: after a reload the edits are still unsaved, so leaving the page must still warn about them.
 */
export function hasAnyBatchDrafts() {
  return rowDrafts.size > 0 || batchDetailDrafts.size > 0 || storedDraftIds(DRAFT_KIND).length > 0;
}

export function draftCounts() {
  return { rows: rowDrafts.size, details: batchDetailDrafts.size };
}

/** Batch ids that still hold row or detail drafts in memory. */
export function pendingBatchIds() {
  const ids = new Set(batchDetailDrafts.keys());
  for (const key of rowDrafts.keys()) ids.add(key.slice(0, key.indexOf(KEY_SEPARATOR)));
  return [...ids];
}

/**
 * The unsent edits of every batch, by batch id, as the number of rows and detail sets each holds. A batch's edits in
 * memory take precedence. A batch with only a stored copy (after a reload, or a tab closed with edits) is counted from
 * storage, so the batch list can show its unsent edits before the batch is opened again.
 */
export function unsentBatchEdits() {
  const edits = new Map();
  for (const batchId of pendingBatchIds()) {
    edits.set(batchId, { rows: batchRowDrafts(batchId).length, details: batchDetailDrafts.has(detailKey(batchId)) ? 1 : 0 });
  }
  for (const batchId of storedDraftIds(DRAFT_KIND)) {
    if (edits.has(batchId)) continue;
    const record = readStoredDraft(DRAFT_KIND, batchId);
    if (!record) continue;
    const rows = Object.keys(plainObject(record.draft.rows)).length;
    const details = Object.keys(plainObject(record.draft.details)).length > 0 ? 1 : 0;
    if (rows || details) edits.set(batchId, { rows, details });
  }
  return edits;
}

/** Forgets a batch's drafts, notice, and stored copy. Used after a discard or a delete. */
export function clearDraftsForBatch(batchId) {
  const id = String(batchId);
  for (const [rowId] of batchRowDrafts(id)) {
    rowDrafts.delete(rowKey(id, rowId));
    rowBases.delete(rowKey(id, rowId));
  }
  batchDetailDrafts.delete(detailKey(id));
  detailBases.delete(detailKey(id));
  notices.delete(id);
  touchedAt.delete(id);
  discardStoredDraft(DRAFT_KIND, id);
}

export function clearBatchDrafts() {
  rowDrafts.clear();
  batchDetailDrafts.clear();
  rowBases.clear();
  detailBases.clear();
  notices.clear();
  touchedAt.clear();
  discardAllStoredDrafts(DRAFT_KIND);
}

/**
 * Drops what this module holds in memory: drafts, bases, notices, and the saved views. Stored copies are kept.
 * This is the state a page reload leaves behind, so the restore path can be run again without reloading.
 */
export function forgetBatchDraftsInMemory() {
  rowDrafts.clear();
  batchDetailDrafts.clear();
  rowBases.clear();
  detailBases.clear();
  notices.clear();
  touchedAt.clear();
  views.clear();
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

/**
 * Drops drafts that already match the persisted batch and keeps real changes. Batch pages use
 * openBatchDrafts, which also restores stored drafts and reconciles them with their bases.
 */
export function pruneSavedBatchDrafts(batch, rows, { historical = false, savedDetails = null } = {}) {
  openBatchDrafts(batch.id, { rows, details: savedDetails, historical });
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

/** Forgets the restore notice of a batch, once the user has dismissed it or its edits were saved. */
export function dismissBatchDraftNotice(batchId) {
  notices.delete(String(batchId));
}

/**
 * After an acknowledged save the page's saved rows and details hold the saved values. The base of every field
 * that is still changed becomes that saved value, so typing made during the save is judged against it.
 */
export function rebaseBatchDrafts(batchId) {
  const id = String(batchId);
  for (const [rowId] of batchRowDrafts(id)) {
    rowBases.delete(rowKey(id, rowId));
    refreshRowBases(id, rowId);
  }
  detailBases.delete(detailKey(id));
  refreshDetailBases(id);
}

/**
 * Called when a batch page renders from loaded data. The page's saved rows and details become the view
 * that drafts are compared with. A page with no drafts of its own restores the stored ones. Then every
 * draft field is reconciled: one whose saved value no longer matches its base (another person changed it
 * since the edit) is not applied, and the notice lists it. Returns the notice to show, or null.
 */
export function openBatchDrafts(batchId, { rows = [], details = null, revision = null, historical = false, readOnly = false, describeRow = defaultDescribeRow } = {}) {
  const id = String(batchId);
  const rowList = Array.isArray(rows) ? rows : [];
  views.set(id, {
    rowsById: new Map(rowList.map((row) => [row.id, row])),
    details: details ?? null,
    revision: revision ?? null,
    historical: Boolean(historical),
    describeRow,
  });
  const view = views.get(id);
  const hadDrafts = hasBatchDrafts(id);
  // A released batch cannot take saves, so a stored copy for it is no longer of any use.
  if (readOnly && !hadDrafts) discardStoredDraft(DRAFT_KIND, id);
  const restoredAt = !readOnly && !hadDrafts ? loadStoredBatchDrafts(id, view) : null;
  if (!hadDrafts && restoredAt === null) notices.delete(id);

  let applied = 0;
  const conflicts = [];
  for (const [rowId] of batchRowDrafts(id)) {
    const outcome = reconcileRowDraft(id, rowId, view);
    applied += outcome.applied;
    conflicts.push(...outcome.conflicts);
  }
  const detailOutcome = reconcileDetailDraft(id, view);
  applied += detailOutcome.applied;
  conflicts.push(...detailOutcome.conflicts);

  if (restoredAt !== null || conflicts.length) {
    if (applied > 0 || conflicts.length) {
      notices.set(id, { savedAt: restoredAt ?? touchedAt.get(id) ?? draftTimestamp(), applied, conflicts });
    }
    persistBatchDraftsNow(id);
  }
  return notices.get(id) ?? null;
}

/** Writes a batch's stored copy at once. Used after a save is acknowledged, so the copy matches the page. */
export function persistBatchDraftsNow(batchId) {
  return writeDraftNow(DRAFT_KIND, String(batchId), () => serializeBatchDrafts(batchId));
}

function noteBatchChange(batchId) {
  touchedAt.set(String(batchId), draftTimestamp());
  scheduleBatchWrite(batchId);
}

function scheduleBatchWrite(batchId) {
  scheduleDraftWrite(DRAFT_KIND, String(batchId), () => serializeBatchDrafts(batchId));
}

/**
 * Keeps the base of each changed row field. A field that has just become changed takes the saved value as
 * its base. A field with an existing base keeps it, and a field that matches the saved value again loses it.
 */
function refreshRowBases(batchId, rowId) {
  const id = String(batchId);
  const key = rowKey(id, rowId);
  const draft = rowDrafts.get(key);
  if (!draft) {
    rowBases.delete(key);
    return;
  }
  const view = viewOf(id);
  const row = view?.rowsById.get(rowId);
  if (!view || !row) return;
  const previous = rowBases.get(key) ?? {};
  const next = {};
  for (const name of rowFieldNames(view.historical)) {
    const field = ROW_FIELD_SPECS[name];
    if (draft[name] === undefined || isInvalidRowField(draft, name)) continue;
    const saved = field.read(row);
    if (field.same(draft[name], saved)) continue;
    next[name] = previous[name] !== undefined ? previous[name] : saved;
  }
  if (Object.keys(next).length) rowBases.set(key, next);
  else rowBases.delete(key);
}

function refreshDetailBases(batchId) {
  const id = String(batchId);
  const key = detailKey(id);
  const draft = batchDetailDrafts.get(key);
  if (!draft) {
    detailBases.delete(key);
    return;
  }
  const view = viewOf(id);
  if (!view?.details) return;
  const previous = detailBases.get(key) ?? {};
  const next = {};
  for (const name of DETAIL_FIELDS) {
    const field = DETAIL_FIELD_SPECS[name];
    const saved = field.read(view.details);
    if (field.same(draft[name], saved)) continue;
    next[name] = previous[name] !== undefined ? previous[name] : saved;
  }
  if (Object.keys(next).length) detailBases.set(key, next);
  else detailBases.delete(key);
}

/**
 * The stored form of a batch's unsent edits: only the fields that differ from the saved record, each with its
 * base. Returns null when nothing is left to keep, and undefined while the saved view is unknown, which leaves
 * the stored copy alone.
 */
function serializeBatchDrafts(batchId) {
  const id = String(batchId);
  const view = viewOf(id);
  if (!view) return undefined;
  const rows = {};
  const rowBaseValues = {};
  for (const [rowId, draft] of batchRowDrafts(id)) {
    const row = view.rowsById.get(rowId);
    if (!row) continue;
    const bases = rowBases.get(rowKey(id, rowId)) ?? {};
    const changes = {};
    const baseChanges = {};
    for (const name of rowFieldNames(view.historical)) {
      const field = ROW_FIELD_SPECS[name];
      if (draft[name] === undefined || isInvalidRowField(draft, name)) continue;
      const saved = field.read(row);
      if (field.same(draft[name], saved)) continue;
      changes[name] = draft[name];
      baseChanges[name] = bases[name] !== undefined ? bases[name] : saved;
    }
    if (Object.keys(changes).length) {
      rows[rowId] = changes;
      rowBaseValues[rowId] = baseChanges;
    }
  }
  const details = {};
  const detailBaseValues = {};
  const detailDraft = batchDetailDrafts.get(detailKey(id));
  if (detailDraft && view.details) {
    const bases = detailBases.get(detailKey(id)) ?? {};
    for (const name of DETAIL_FIELDS) {
      const field = DETAIL_FIELD_SPECS[name];
      const saved = field.read(view.details);
      if (detailDraft[name] === undefined || field.same(detailDraft[name], saved)) continue;
      details[name] = detailDraft[name];
      detailBaseValues[name] = bases[name] !== undefined ? bases[name] : saved;
    }
  }
  if (!Object.keys(rows).length && !Object.keys(details).length) return null;
  const record = { savedAt: draftTimestamp(), baseRevision: view.revision, base: {}, draft: {} };
  if (Object.keys(rows).length) {
    record.draft.rows = rows;
    record.base.rows = rowBaseValues;
  }
  if (Object.keys(details).length) {
    record.draft.details = details;
    record.base.details = detailBaseValues;
  }
  return record;
}

/** A row draft for a saved row, as the inputs would hold it. */
function rowDraftFromRow(row, historical) {
  const draft = {};
  for (const name of rowFieldNames(historical)) {
    const value = ROW_FIELD_SPECS[name].read(row);
    if (value !== undefined) draft[name] = value;
  }
  return draft;
}

function textBases(source, names) {
  const bases = {};
  for (const name of names) {
    if (typeof source[name] === "string") bases[name] = source[name];
  }
  return bases;
}

/**
 * Loads the stored draft of a batch into memory, on top of the saved values, and returns its saved time. The
 * fields are only candidates here; reconcileRowDraft and reconcileDetailDraft decide which are applied.
 */
function loadStoredBatchDrafts(id, view) {
  const record = readStoredDraft(DRAFT_KIND, id);
  if (!record) return null;
  const names = rowFieldNames(view.historical);
  const storedRows = plainObject(record.draft.rows);
  const storedRowBases = plainObject(record.base.rows);
  for (const [rowId, storedChanges] of Object.entries(storedRows)) {
    const row = view.rowsById.get(rowId);
    const changes = plainObject(storedChanges);
    const restorable = names.filter((name) => typeof changes[name] === "string");
    if (!row || !restorable.length) continue;
    const draft = rowDraftFromRow(row, view.historical);
    for (const name of restorable) draft[name] = changes[name];
    rowDrafts.set(rowKey(id, rowId), draft);
    const bases = textBases(plainObject(storedRowBases[rowId]), restorable);
    if (Object.keys(bases).length) rowBases.set(rowKey(id, rowId), bases);
  }
  const storedDetails = plainObject(record.draft.details);
  const detailNames = DETAIL_FIELDS.filter((name) => typeof storedDetails[name] === "string");
  if (view.details && detailNames.length) {
    const draft = savedTextOf(DETAIL_FIELD_SPECS, view.details);
    for (const name of detailNames) draft[name] = storedDetails[name];
    batchDetailDrafts.set(detailKey(id), draft);
    const bases = textBases(plainObject(record.base.details), detailNames);
    if (Object.keys(bases).length) detailBases.set(detailKey(id), bases);
  }
  return typeof record.savedAt === "string" ? record.savedAt : draftTimestamp();
}

/**
 * Reconciles one row draft with the saved row. Kept fields stay in the draft, with the saved row as their
 * new base. Fields the user changed that someone else has since changed are listed as conflicts, and the draft
 * shows the saved value for them. Invalid entries are left as they are, so they still block saving.
 */
function reconcileRowDraft(id, rowId, view) {
  const key = rowKey(id, rowId);
  const draft = rowDrafts.get(key);
  const row = view.rowsById.get(rowId);
  if (!draft || !row) return { applied: 0, conflicts: [] };
  const names = rowFieldNames(view.historical);
  const fields = pickFields(ROW_FIELD_SPECS, names);
  const saved = savedTextOf(fields, row);
  const bases = rowBases.get(key) ?? {};
  const { keep, conflicts } = classifyFields(fields, {
    draft,
    saved,
    bases,
    skip: (name) => isInvalidRowField(draft, name),
  });
  const next = { ...draft };
  const nextBases = {};
  for (const name of names) {
    if (isInvalidRowField(draft, name)) {
      if (bases[name] !== undefined) nextBases[name] = bases[name];
      continue;
    }
    if (draft[name] === undefined) continue;
    if (Object.hasOwn(keep, name)) {
      next[name] = keep[name];
      nextBases[name] = saved[name];
    } else {
      next[name] = saved[name];
    }
  }
  const applied = Object.keys(keep).length;
  const dirty = applied > 0 || names.some((name) => isInvalidRowField(draft, name));
  if (dirty) {
    rowDrafts.set(key, next);
    if (Object.keys(nextBases).length) rowBases.set(key, nextBases);
    else rowBases.delete(key);
  } else {
    rowDrafts.delete(key);
    rowBases.delete(key);
  }
  return {
    applied,
    conflicts: conflicts.map((conflict) => ({ ...conflict, label: `${rowLabel(view, row)} · ${conflict.label}` })),
  };
}

/** The same reconciliation as reconcileRowDraft, for the batch details. */
function reconcileDetailDraft(id, view) {
  const key = detailKey(id);
  const draft = batchDetailDrafts.get(key);
  if (!draft || !view.details) return { applied: 0, conflicts: [] };
  const saved = savedTextOf(DETAIL_FIELD_SPECS, view.details);
  const bases = detailBases.get(key) ?? {};
  const { keep, conflicts } = classifyFields(DETAIL_FIELD_SPECS, { draft, saved, bases });
  const next = {};
  const nextBases = {};
  for (const name of DETAIL_FIELDS) {
    if (Object.hasOwn(keep, name)) {
      next[name] = keep[name];
      nextBases[name] = saved[name];
    } else {
      next[name] = saved[name];
    }
  }
  const applied = Object.keys(keep).length;
  if (applied > 0) {
    batchDetailDrafts.set(key, next);
    if (Object.keys(nextBases).length) detailBases.set(key, nextBases);
    else detailBases.delete(key);
  } else {
    batchDetailDrafts.delete(key);
    detailBases.delete(key);
  }
  return { applied, conflicts };
}

window.addEventListener("masterqc:discard-operation-drafts", clearBatchDrafts);
