import {
  fail,
  makeId,
  requireArray,
  requireRecord,
  requireString,
} from "./qc-domain.js";
import { appendIssueEvidence, prepareIssueEvidenceFiles } from "./qc-assets.js";
import { getBatchProducts, getBatchRowProduct } from "./qc-batch-products.js";
import { requireBatch, requireEditableBatch } from "./qc-inspections.js";

const ACTION_TYPES = new Set(["isolation", "rework", "scrap", "return", "design", "process", "other"]);

function makeIssueNumber(id) {
  const suffix = id.replace(/[^a-z0-9]/gi, "").slice(-8).toUpperCase();
  return `ISS-${suffix || "LOCAL"}`;
}

function rowRate(row) {
  return row.defectiveQty == null || row.inspectedQty === 0
    ? null
    : Number(((row.defectiveQty / row.inspectedQty) * 100).toFixed(2));
}

function makeSourceSnapshot(state, batch, row = null, rowProduct = null) {
  const products = getBatchProducts(batch).map((product) => {
    const variant = state.variants.find((candidate) => candidate.id === product.variantId);
    return {
      lineId: product.lineId,
      variantId: product.variantId,
      variantLabel: variant?.label ?? null,
      versionId: product.versionId,
      versionLabel: product.versionLabel,
      quantity: product.quantity,
    };
  });
  const product = products.length === 1 ? products[0] : null;
  const rowVariant = rowProduct
    ? state.variants.find((candidate) => candidate.id === rowProduct.variantId)
    : null;
  return {
    batchId: batch.id,
    batchNumber: batch.number,
    orderId: batch.orderId,
    lineId: product?.lineId ?? null,
    variantId: product?.variantId ?? null,
    variantLabel: product?.variantLabel ?? null,
    familyId: products.length === 1 ? getBatchProducts(batch)[0]?.familyId ?? null : null,
    factory: batch.factory,
    stage: batch.stage,
    date: batch.date,
    versionId: product?.versionId ?? null,
    versionLabel: product?.versionLabel ?? null,
    products,
    row: row ? {
      id: row.id,
      productLineId: rowProduct?.lineId ?? null,
      variantId: rowProduct?.variantId ?? null,
      variantLabel: rowVariant?.label ?? null,
      familyId: rowProduct?.familyId ?? null,
      versionId: rowProduct?.versionId ?? null,
      versionLabel: rowProduct?.versionLabel ?? null,
      productQuantity: rowProduct?.quantity ?? null,
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
      ...(Object.hasOwn(row, "actualTimeSeconds") ? { actualTimeSeconds: row.actualTimeSeconds } : {}),
      photoIds: [...row.photoIds],
    } : null,
  };
}

function issueRequestFingerprint({ title, description, reportedBy, initialOwner, batchId, rowId, files }) {
  let first = 2166136261;
  let second = 0x9e3779b9;
  const update = (value) => {
    const text = String(value);
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      first = Math.imul(first ^ code, 16777619);
      second = Math.imul(second ^ (code + index), 0x85ebca6b);
    }
    first = Math.imul(first ^ 0, 16777619);
    second = Math.imul(second ^ 0, 0x85ebca6b);
  };
  for (const value of [title, description, reportedBy]) update(value);
  if (initialOwner) {
    update("initialOwner");
    update(initialOwner);
  }
  for (const value of [batchId ?? "", rowId ?? ""]) update(value);
  for (const file of files) {
    for (const value of [file.category, file.name, file.mimeType, file.dataUrl]) update(value);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function actionLogRequestFingerprint({ submitterName, actionType, summary, result, files }) {
  let first = 2166136261;
  let second = 0x9e3779b9;
  const update = (value) => {
    const text = String(value);
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      first = Math.imul(first ^ code, 16777619);
      second = Math.imul(second ^ (code + index), 0x85ebca6b);
    }
    first = Math.imul(first ^ 0, 16777619);
    second = Math.imul(second ^ 0, 0x85ebca6b);
  };
  for (const value of [submitterName, actionType, summary, result]) update(value);
  for (const file of files) {
    for (const value of [file.category, file.name, file.mimeType, file.dataUrl]) update(value);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function requireWritableActionIssue(state, issue) {
  if (issue.status === "closed") fail("Closed issues are read-only.");
  if (issue.batchId === null) return;
  const batch = requireBatch(state, issue.batchId);
  if (batch.kind === "historical" || batch.status === "historical") fail("Historical batch issues are read-only.");
  if (batch.status === "released") fail("Released batch issues are read-only.");
}

function hasValidActionLog(issue) {
  return (issue.actionLogs ?? []).some((entry) =>
    typeof entry.submitterName === "string" && entry.submitterName.trim() &&
    typeof entry.actionType === "string" && ACTION_TYPES.has(entry.actionType) &&
    typeof entry.summary === "string" && entry.summary.trim() &&
    typeof entry.result === "string" && entry.result.trim() &&
    typeof entry.submittedAt === "string" && entry.submittedAt.trim(),
  );
}

export function createIssue(state, data, context) {
  const input = requireRecord(data, "Issue");
  const title = requireString(input.title, "Issue title", { maxLength: 300 });
  if (!Object.hasOwn(input, "reportedBy")) fail("Reported by is required.");
  const reportedBy = requireString(input.reportedBy, "Reported by", { maxLength: 200 });
  const initialOwner = Object.hasOwn(input, "owner")
    ? requireString(input.owner, "Initial disposition owner", { maxLength: 200, allowBlank: true })
    : "";
  const description = requireString(input.description ?? "", "Issue description", { maxLength: 10000, allowBlank: true });
  const requestId = input.requestId == null ? null : requireString(input.requestId, "Issue request ID", { maxLength: 120 });
  const files = prepareIssueEvidenceFiles(input.files ?? []);
  const batchIdInput = input.batchId == null || String(input.batchId).trim() === ""
    ? null
    : requireString(input.batchId, "Batch ID", { maxLength: 120 });
  const rowIdInput = input.rowId == null || String(input.rowId).trim() === ""
    ? null
    : requireString(input.rowId, "Inspection row ID", { maxLength: 120 });

  if (requestId !== null) {
    const requestFingerprint = issueRequestFingerprint({ title, description, reportedBy, initialOwner, batchId: batchIdInput, rowId: rowIdInput, files });
    const existingByRequest = state.issues.find((issue) => issue.requestId === requestId);
    if (existingByRequest) {
      if (existingByRequest.batchId !== batchIdInput || existingByRequest.rowId !== rowIdInput ||
          existingByRequest.title !== title ||
          existingByRequest.requestFingerprint !== requestFingerprint) {
        fail("That issue request ID was already used for different issue details or evidence.");
      }
      return { entityId: existingByRequest.id, changed: false, action: "createIssue", summary: `Issue ${existingByRequest.number} was already created for this request.` };
    }
  }

  let batch = null;
  let row = null;
  let rowProduct = null;
  let batchId = null;
  let rowId = null;
  let sourceSnapshot = null;

  if (batchIdInput !== null) {
    batch = requireBatch(state, batchIdInput);
    requireEditableBatch(batch);
    batchId = batch.id;
    if (rowIdInput !== null) {
      rowId = rowIdInput;
      row = batch.rows.find((candidate) => candidate.id === rowId);
      if (!row) fail("That inspection row is not part of the selected batch.");
      rowProduct = getBatchRowProduct(batch, row);
      if (!rowProduct) fail("That inspection row has no locked product allocation.");
      if (row.savedAt === null) fail("Save the inspection row before creating an issue from it.");
      if (requestId === null) {
        const existing = state.issues.find((issue) => issue.batchId === batchId && issue.rowId === rowId);
        if (existing) return { entityId: existing.id, changed: false, action: "createIssue", summary: `Issue ${existing.number} already exists for this inspection row.` };
      }
    } else if (input.rowId != null) {
      fail("An inspection row cannot be linked without a batch.");
    }
    sourceSnapshot = makeSourceSnapshot(state, batch, row, rowProduct);
  } else if (input.rowId != null && String(input.rowId).trim() !== "") {
    fail("An inspection row cannot be linked without a batch.");
  }

  if (!files.some((file) => file.category === "photo")) {
    fail("At least one uploaded photo is required to create an issue.");
  }

  const id = makeId(context.idFactory);
  const number = makeIssueNumber(id);
  if (state.issues.some((issue) => issue.number === number)) fail("The generated issue number already exists. Retry the action.");
  const issue = {
    id,
    number,
    title,
    reportedBy,
    description,
    ...(requestId !== null ? {
      requestId,
      requestFingerprint: issueRequestFingerprint({ title, description, reportedBy, initialOwner, batchId, rowId, files }),
    } : {}),
    batchId,
    rowId,
    sourceSnapshot,
    status: "open",
    owner: initialOwner,
    disposition: "",
    confirmations: ["", "", ""],
    discussion: [],
    attachmentIds: [],
    createdAt: context.now(),
    closedAt: null,
  };
  appendIssueEvidence(state, issue, files, context);
  state.issues.push(issue);
  return { entityId: id, action: "createIssue", summary: `Created open issue ${number}.` };
}

export function deleteIssue(state, data) {
  const id = requireString(data.id, "Issue ID", { maxLength: 120 });
  const issueIndex = state.issues.findIndex((candidate) => candidate.id === id);
  if (issueIndex < 0) fail("That issue is no longer available.");
  const issue = state.issues[issueIndex];
  if (issue.batchId !== null) {
    const batch = requireBatch(state, issue.batchId);
    if (batch.kind === "historical" || batch.status === "historical") {
      fail("Issues linked to historical batches cannot be deleted.");
    }
    if (batch.status === "released") {
      fail("Issues linked to released batches cannot be deleted.");
    }
  }

  state.issues.splice(issueIndex, 1);
  state.assets = state.assets.filter((asset) => !(asset.kind === "issueAttachment" && asset.issueId === issue.id));
  return {
    entityId: issue.id,
    action: "deleteIssue",
    summary: `Deleted issue ${issue.number} and its uploaded evidence.`,
  };
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
  if (Object.hasOwn(data, "description")) issue.description = requireString(data.description, "Issue description", { maxLength: 10000, allowBlank: true });
  return { entityId: issue.id, action: "saveIssue", summary: `Saved disposition details for ${issue.number}.` };
}

export function addActionLog(state, data, context) {
  const input = requireRecord(data, "Issue action record");
  const id = requireString(input.id, "Issue ID", { maxLength: 120 });
  const issue = state.issues.find((candidate) => candidate.id === id);
  if (!issue) fail("That issue is no longer available.");

  const submitterName = requireString(input.submitterName, "Action submitter name", { maxLength: 200 });
  const actionType = requireString(input.actionType, "Action type", { maxLength: 20 });
  if (!ACTION_TYPES.has(actionType)) fail("Choose a supported action type.");
  const summary = requireString(input.summary, "Action summary", { maxLength: 1200 });
  const result = requireString(input.result, "Action result", { maxLength: 1200 });
  const requestId = input.requestId == null ? null : requireString(input.requestId, "Action request ID", { maxLength: 120 });
  const files = prepareIssueEvidenceFiles(input.files ?? []);
  const requestFingerprint = requestId === null
    ? null
    : actionLogRequestFingerprint({ submitterName, actionType, summary, result, files });
  const actionLogs = issue.actionLogs ?? [];

  if (requestId !== null) {
    const existing = actionLogs.find((entry) => entry.requestId === requestId);
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        fail("That action request ID was already used for different action details or evidence.");
      }
      return {
        entityId: issue.id,
        actionLogId: existing.id,
        assetIds: [...(existing.attachmentIds ?? [])],
        changed: false,
        action: "addActionLog",
        summary: `Action record for issue ${issue.number} was already submitted for this request.`,
      };
    }
  }

  requireWritableActionIssue(state, issue);

  const actionLogId = makeId(context.idFactory);
  if (actionLogs.some((entry) => entry.id === actionLogId)) fail("The generated action record ID already exists. Retry the action.");
  const actionLog = {
    id: actionLogId,
    ...(requestId !== null ? { requestId, requestFingerprint } : {}),
    submitterName,
    actionType,
    summary,
    result,
    submittedAt: context.now(),
    attachmentIds: [],
  };
  issue.actionLogs = actionLogs;
  actionLog.attachmentIds = appendIssueEvidence(state, issue, files, context, actionLogId);
  issue.actionLogs.push(actionLog);
  return {
    entityId: issue.id,
    actionLogId,
    assetIds: [...actionLog.attachmentIds],
    action: "addActionLog",
    summary: `Submitted a ${actionType} action record for issue ${issue.number}.`,
  };
}

export function addDiscussion(state, data, context) {
  const id = requireString(data.id, "Issue ID", { maxLength: 120 });
  const issue = state.issues.find((candidate) => candidate.id === id);
  if (!issue) fail("That issue is no longer available.");
  if (issue.status === "closed") fail("Closed issues are read-only.");
  const text = requireString(data.text, "Discussion entry", { maxLength: 5000 });
  const authorName = typeof data.authorName === "string" ? data.authorName.trim() : "";
  if (!authorName) fail("You must enter your name before adding a discussion entry.");
  if (authorName.length > 200) fail("Your name must be 200 characters or fewer.");
  const entryId = makeId(context.idFactory);
  issue.discussion.push({ id: entryId, text, authorName, createdAt: context.now() });
  return { entityId: issue.id, action: "addDiscussion", summary: `Added discussion to ${issue.number}.` };
}

export function closeIssue(state, data, context) {
  const id = requireString(data.id, "Issue ID", { maxLength: 120 });
  const issue = state.issues.find((candidate) => candidate.id === id);
  if (!issue) fail("That issue is no longer available.");
  if (issue.status === "closed") return { entityId: id, changed: false, action: "closeIssue", summary: `Issue ${issue.number} is already closed.` };
  requireWritableActionIssue(state, issue);
  if (!issue.owner.trim()) fail("Enter the disposition owner before closing this issue.");
  if (!issue.disposition.trim() && !hasValidActionLog(issue)) fail("Enter a formal disposition or submit an action record before closing this issue.");
  if (issue.confirmations.length !== 3 || issue.confirmations.some((name) => !name.trim())) {
    fail("Enter all three confirmation names before explicitly closing this issue.");
  }
  issue.status = "closed";
  issue.closedAt = context.now();
  return { entityId: id, action: "closeIssue", summary: `Closed issue ${issue.number} after explicit confirmation.` };
}
