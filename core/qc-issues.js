import {
  fail,
  makeId,
  requireArray,
  requireRecord,
  requireString,
} from "./qc-domain.js";
import { requireBatch, requireEditableBatch } from "./qc-inspections.js";

function makeIssueNumber(id) {
  const suffix = id.replace(/[^a-z0-9]/gi, "").slice(-8).toUpperCase();
  return `ISS-${suffix || "LOCAL"}`;
}

function rowRate(row) {
  return row.defectiveQty == null || row.inspectedQty === 0
    ? null
    : Number(((row.defectiveQty / row.inspectedQty) * 100).toFixed(2));
}

function makeSourceSnapshot(batch, variant, row = null) {
  return {
    batchId: batch.id,
    batchNumber: batch.number,
    orderId: batch.orderId,
    lineId: batch.lineId,
    variantId: batch.variantId,
    variantLabel: variant.label,
    factory: batch.factory,
    stage: batch.stage,
    date: batch.date,
    versionId: batch.versionId,
    versionLabel: batch.versionLabel,
    row: row ? {
      id: row.id,
      key: row.key,
      no: row.no,
      title: row.title,
      titleZh: row.titleZh,
      specification: row.specification,
      specificationZh: row.specificationZh,
      inspectedQty: row.inspectedQty,
      defectiveQty: row.defectiveQty,
      defectiveRate: rowRate(row),
      remarks: row.remarks,
      savedAt: row.savedAt,
      photoIds: [...row.photoIds],
    } : null,
  };
}

export function createIssue(state, data, context) {
  const input = requireRecord(data, "Issue");
  const title = requireString(input.title, "Issue title", { maxLength: 300 });
  let batch = null;
  let row = null;
  let variant = null;
  let batchId = null;
  let rowId = null;
  let sourceSnapshot = null;

  if (input.batchId != null && String(input.batchId).trim() !== "") {
    batch = requireBatch(state, input.batchId);
    requireEditableBatch(batch);
    batchId = batch.id;
    variant = state.variants.find((candidate) => candidate.id === batch.variantId);
    if (input.rowId != null && String(input.rowId).trim() !== "") {
      rowId = requireString(input.rowId, "Inspection row ID", { maxLength: 120 });
      row = batch.rows.find((candidate) => candidate.id === rowId);
      if (!row) fail("That inspection row is not part of the selected batch.");
      if (row.savedAt === null) fail("Save the inspection row before creating an issue from it.");
      const existing = state.issues.find((issue) => issue.batchId === batchId && issue.rowId === rowId);
      if (existing) return { entityId: existing.id, changed: false, action: "createIssue", summary: `Issue ${existing.number} already exists for this inspection row.` };
    } else if (input.rowId != null) {
      fail("An inspection row cannot be linked without a batch.");
    }
    sourceSnapshot = makeSourceSnapshot(batch, variant, row);
  } else if (input.rowId != null && String(input.rowId).trim() !== "") {
    fail("An inspection row cannot be linked without a batch.");
  }

  const id = makeId(context.idFactory);
  const number = makeIssueNumber(id);
  if (state.issues.some((issue) => issue.number === number)) fail("The generated issue number already exists. Retry the action.");
  state.issues.push({
    id,
    number,
    title,
    batchId,
    rowId,
    sourceSnapshot,
    status: "open",
    owner: "",
    disposition: "",
    confirmations: ["", "", ""],
    discussion: [],
    createdAt: context.now(),
    closedAt: null,
  });
  return { entityId: id, action: "createIssue", summary: `Created open issue ${number}.` };
}

export function saveIssue(state, data) {
  const id = requireString(data.id, "Issue ID", { maxLength: 120 });
  const issue = state.issues.find((candidate) => candidate.id === id);
  if (!issue) fail("That issue is no longer available.");
  if (issue.status === "closed") fail("Closed issues are read-only.");
  const confirmations = requireArray(data.confirmations, "Issue confirmations");
  if (confirmations.length !== 3) fail("Enter exactly three confirmation names.");
  issue.owner = requireString(data.owner ?? "", "Disposition owner", { maxLength: 200, allowBlank: true });
  issue.disposition = requireString(data.disposition ?? "", "Formal disposition", { maxLength: 10000, allowBlank: true });
  issue.confirmations = confirmations.map((name, index) => requireString(name, `Confirmation ${index + 1}`, { maxLength: 200, allowBlank: true }));
  return { entityId: issue.id, action: "saveIssue", summary: `Saved disposition details for ${issue.number}.` };
}

export function addDiscussion(state, data, context) {
  const id = requireString(data.id, "Issue ID", { maxLength: 120 });
  const issue = state.issues.find((candidate) => candidate.id === id);
  if (!issue) fail("That issue is no longer available.");
  if (issue.status === "closed") fail("Closed issues are read-only.");
  const text = requireString(data.text, "Discussion entry", { maxLength: 5000 });
  const entryId = makeId(context.idFactory);
  issue.discussion.push({ id: entryId, text, createdAt: context.now() });
  return { entityId: issue.id, action: "addDiscussion", summary: `Added discussion to ${issue.number}.` };
}

export function closeIssue(state, data, context) {
  const id = requireString(data.id, "Issue ID", { maxLength: 120 });
  const issue = state.issues.find((candidate) => candidate.id === id);
  if (!issue) fail("That issue is no longer available.");
  if (issue.status === "closed") return { entityId: id, changed: false, action: "closeIssue", summary: `Issue ${issue.number} is already closed.` };
  if (!issue.owner.trim()) fail("Enter the disposition owner before closing this issue.");
  if (!issue.disposition.trim()) fail("Enter the formal disposition before closing this issue.");
  if (issue.confirmations.length !== 3 || issue.confirmations.some((name) => !name.trim())) {
    fail("Enter all three confirmation names before explicitly closing this issue.");
  }
  issue.status = "closed";
  issue.closedAt = context.now();
  return { entityId: id, action: "closeIssue", summary: `Closed issue ${issue.number} after explicit confirmation.` };
}
