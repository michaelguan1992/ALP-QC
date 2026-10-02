import {
  ASSET_TOTAL_MAX_BYTES,
  DANGEROUS_EXTENSIONS,
  DOCUMENT_MIMES,
  DOCUMENT_MAX_BYTES,
  fail,
  makeId,
  MIME_EXTENSIONS,
  normalizeDataUrl,
  PHOTO_MIMES,
  PHOTO_MAX_BYTES,
  requireArray,
  requireRecord,
  requireString,
  ROW_ATTACHMENT_CATEGORIES,
  safeFilename,
  TEXT_EXTENSIONS,
  VIDEO_MIMES,
} from "./qc-domain.js";
import { requireBatch, requireEditableBatch } from "./qc-inspections.js";

function extensionOf(name) {
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index).toLocaleLowerCase();
}

function storedAssetBytes(asset, trustedAssetValidation) {
  if (typeof asset.dataUrl === "string") return normalizeDataUrl(asset.dataUrl, "Stored attachment").decodedBytes;
  const trusted = trustedAssetValidation?.get?.(asset.id);
  if (!trusted || trusted.contentRef !== asset.contentRef || trusted.mimeType !== asset.mimeType ||
      !Number.isSafeInteger(trusted.decodedBytes) || trusted.decodedBytes < 0) {
    fail(`Stored attachment ${asset.name} is missing trusted content metadata.`);
  }
  return trusted.decodedBytes;
}

function currentAssetBytes(state, trustedAssetValidation) {
  return state.assets.reduce((total, asset) => total + storedAssetBytes(asset, trustedAssetValidation), 0);
}

function validateAssetPayload({ name, mimeType, dataUrl }, allowedMimes, maxBytes, label) {
  const normalizedName = safeFilename(name);
  const declaredMime = requireString(mimeType, `${label} type`, { maxLength: 100 }).toLocaleLowerCase();
  const parsed = normalizeDataUrl(dataUrl, label);
  if (!allowedMimes.has(declaredMime) || parsed.mimeType !== declaredMime) fail(`${label} must use one of the supported file types.`);
  if (parsed.decodedBytes <= 0 || parsed.decodedBytes > maxBytes) fail(`${label} must be non-empty and no larger than ${Math.floor(maxBytes / (1024 * 1024))} MiB.`);
  if (DANGEROUS_EXTENSIONS.test(normalizedName)) fail(`${label} cannot be an executable, HTML, or SVG file.`);
  if (declaredMime === "text/plain" && !TEXT_EXTENSIONS.has(extensionOf(normalizedName))) {
    fail("Plain-text library files must use .txt, .csv, .md, or .log filenames.");
  }
  const allowedExtensions = MIME_EXTENSIONS.get(declaredMime);
  if (allowedExtensions && !allowedExtensions.has(extensionOf(normalizedName))) {
    fail(`${label} filename extension must match ${declaredMime}.`);
  }
  return { name: normalizedName, mimeType: declaredMime, dataUrl, decodedBytes: parsed.decodedBytes };
}

function requireTotalCapacity(state, incomingBytes, replacedAssetId = null, trustedAssetValidation = undefined) {
  const replacedAsset = replacedAssetId && state.assets.find((asset) => asset.id === replacedAssetId);
  const replacedBytes = replacedAsset ? storedAssetBytes(replacedAsset, trustedAssetValidation) : 0;
  if (currentAssetBytes(state, trustedAssetValidation) - replacedBytes + incomingBytes > ASSET_TOTAL_MAX_BYTES) {
    fail(`Attachments exceed the ${Math.floor(ASSET_TOTAL_MAX_BYTES / (1024 * 1024))} MiB total storage limit.`);
  }
}

function normalizedIssueEvidenceFile(value) {
  const input = requireRecord(value, "Issue evidence file");
  const mimeType = requireString(input.mimeType, "Issue evidence file type", { maxLength: 100 }).toLocaleLowerCase();
  const category = input.category == null || String(input.category).trim() === ""
    ? (PHOTO_MIMES.has(mimeType) ? "photo" : "file")
    : requireString(input.category, "Issue evidence category", { maxLength: 20 });
  if (!new Set(["photo", "file"]).has(category)) fail("Issue evidence category must be photo or file.");
  const image = PHOTO_MIMES.has(mimeType);
  if (category === "photo" && !image) fail("Issue photos must be PNG, JPEG, WebP, or GIF images.");
  if (category === "file" && !DOCUMENT_MIMES.has(mimeType)) fail("Issue evidence must use a supported file type.");
  const maxBytes = category === "photo" ? PHOTO_MAX_BYTES : DOCUMENT_MAX_BYTES;
  const file = validateAssetPayload(input, category === "photo" ? PHOTO_MIMES : DOCUMENT_MIMES, maxBytes, "Issue evidence");
  return { ...file, category };
}

export function prepareIssueEvidenceFiles(files) {
  const list = requireArray(files, "Issue evidence files");
  return list.map(normalizedIssueEvidenceFile);
}

export function appendIssueEvidence(state, issue, files, context) {
  if (!files.length) return [];
  requireTotalCapacity(state, files.reduce((total, file) => total + file.decodedBytes, 0), null, context.trustedAssetValidation);
  issue.attachmentIds ??= [];
  const ids = [];
  for (const file of files) {
    const id = makeId(context.idFactory);
    const { decodedBytes, ...assetFile } = file;
    state.assets.push({
      id,
      ...assetFile,
      kind: "issueAttachment",
      batchId: issue.batchId,
      rowId: issue.rowId,
      versionId: null,
      issueId: issue.id,
      createdAt: context.now(),
    });
    issue.attachmentIds.push(id);
    ids.push(id);
  }
  return ids;
}

export function setRowAttachment(state, data, context) {
  const input = requireRecord(data, "Inspection row attachment");
  const batch = requireBatch(state, input.batchId);
  requireEditableBatch(batch);
  const rowId = requireString(input.rowId, "Inspection row ID", { maxLength: 120 });
  const row = batch.rows.find((candidate) => candidate.id === rowId);
  if (!row) fail("That inspection row is not part of this batch.");
  const category = requireString(input.category, "Attachment category", { maxLength: 20 }).toLocaleLowerCase();
  if (!ROW_ATTACHMENT_CATEGORIES.has(category)) fail("Choose Videos, Procedures, or Log as the attachment category.");
  const allowedMimes = category === "videos"
    ? VIDEO_MIMES
    : new Set([...DOCUMENT_MIMES].filter((mimeType) => !VIDEO_MIMES.has(mimeType)));
  const file = validateAssetPayload(requireRecord(input.file, "Inspection row attachment file"), allowedMimes, DOCUMENT_MAX_BYTES, "Inspection row attachment");
  const currentId = row.attachmentIds?.[category] ?? null;
  requireTotalCapacity(state, file.decodedBytes, currentId, context.trustedAssetValidation);

  const id = makeId(context.idFactory);
  const { decodedBytes, ...assetFile } = file;
  state.assets.push({
    id,
    ...assetFile,
    kind: "rowAttachment",
    batchId: batch.id,
    rowId: row.id,
    versionId: null,
    issueId: null,
    category,
    createdAt: context.now(),
  });
  row.attachmentIds ??= { videos: null, procedures: null, log: null };
  const previousId = row.attachmentIds[category] ?? null;
  row.attachmentIds[category] = id;
  if (previousId) state.assets = state.assets.filter((asset) => asset.id !== previousId);
  return { entityId: batch.id, action: "setRowAttachment", summary: `Attached ${file.name} to ${row.title} (${category}).`, assetIds: [id] };
}

export function removeRowAttachment(state, data) {
  const input = requireRecord(data, "Inspection row attachment removal");
  const batch = requireBatch(state, input.batchId);
  requireEditableBatch(batch);
  const rowId = requireString(input.rowId, "Inspection row ID", { maxLength: 120 });
  const row = batch.rows.find((candidate) => candidate.id === rowId);
  if (!row) fail("That inspection row is not part of this batch.");
  const category = requireString(input.category, "Attachment category", { maxLength: 20 }).toLocaleLowerCase();
  if (!ROW_ATTACHMENT_CATEGORIES.has(category)) fail("Choose Videos, Procedures, or Log as the attachment category.");
  const assetId = row.attachmentIds?.[category] ?? null;
  if (!assetId) fail("There is no attachment in that inspection row category.");
  row.attachmentIds[category] = null;
  state.assets = state.assets.filter((asset) => asset.id !== assetId);
  return { entityId: batch.id, action: "removeRowAttachment", summary: `Removed the ${category} attachment from ${row.title}.` };
}

export function addIssueAttachments(state, data, context) {
  const input = requireRecord(data, "Issue attachments");
  const id = requireString(input.id, "Issue ID", { maxLength: 120 });
  const issue = state.issues.find((candidate) => candidate.id === id);
  if (!issue) fail("That issue is no longer available.");
  if (issue.status === "closed") fail("Closed issues are read-only.");
  if (issue.batchId !== null) {
    const batch = requireBatch(state, issue.batchId);
    if (batch.status === "released") fail("Released batch issues are read-only.");
  }
  const files = prepareIssueEvidenceFiles(input.files);
  if (!files.length) fail("Choose at least one issue attachment to add.");
  const assetIds = appendIssueEvidence(state, issue, files, context);
  return { entityId: issue.id, action: "addIssueAttachments", summary: `Added ${assetIds.length} file${assetIds.length === 1 ? "" : "s"} to issue ${issue.number}.`, assetIds };
}

export function removeIssueAttachment(state, data) {
  const input = requireRecord(data, "Issue attachment removal");
  const id = requireString(input.id, "Issue ID", { maxLength: 120 });
  const issue = state.issues.find((candidate) => candidate.id === id);
  if (!issue) fail("That issue is no longer available.");
  if (issue.status === "closed") fail("Closed issues are read-only.");
  if (issue.batchId !== null) {
    const batch = requireBatch(state, issue.batchId);
    if (batch.status === "released") fail("Released batch issues are read-only.");
  }
  const assetId = requireString(input.assetId, "Issue attachment ID", { maxLength: 160 });
  if (!(issue.attachmentIds ?? []).includes(assetId)) fail("That file is not attached to this issue.");
  issue.attachmentIds = issue.attachmentIds.filter((candidate) => candidate !== assetId);
  state.assets = state.assets.filter((asset) => asset.id !== assetId);
  return { entityId: issue.id, action: "removeIssueAttachment", summary: `Removed a file from issue ${issue.number}.` };
}

export function addPhotos(state, data, context) {
  const batch = requireBatch(state, data.batchId);
  requireEditableBatch(batch);
  const rowId = requireString(data.rowId, "Inspection row ID", { maxLength: 120 });
  const row = batch.rows.find((candidate) => candidate.id === rowId);
  if (!row) fail("That inspection row is not part of this batch.");
  const files = requireArray(data.files, "Photo files");
  if (!files.length) fail("Choose at least one photo to add.");
  const normalized = files.map((file) => validateAssetPayload(requireRecord(file, "Photo file"), PHOTO_MIMES, PHOTO_MAX_BYTES, "Photo"));
  requireTotalCapacity(state, normalized.reduce((total, file) => total + file.decodedBytes, 0), null, context.trustedAssetValidation);
  const ids = [];
  for (const file of normalized) {
    const id = makeId(context.idFactory);
    const { decodedBytes, ...assetFile } = file;
    state.assets.push({
      id,
      ...assetFile,
      kind: "photo",
      batchId: batch.id,
      rowId: row.id,
      versionId: null,
      createdAt: context.now(),
    });
    row.photoIds.push(id);
    ids.push(id);
  }
  return { entityId: batch.id, action: "addPhotos", summary: `Added ${ids.length} photo${ids.length === 1 ? "" : "s"} to ${row.title}.`, assetIds: ids };
}

export function removePhoto(state, data) {
  const batch = requireBatch(state, data.batchId);
  requireEditableBatch(batch);
  const rowId = requireString(data.rowId, "Inspection row ID", { maxLength: 120 });
  const assetId = requireString(data.assetId, "Photo ID", { maxLength: 120 });
  const row = batch.rows.find((candidate) => candidate.id === rowId);
  if (!row || !row.photoIds.includes(assetId)) fail("That photo is not attached to this inspection row.");
  row.photoIds = row.photoIds.filter((id) => id !== assetId);
  const isIssueEvidence = state.issues.some((issue) => issue.sourceSnapshot?.row?.photoIds?.includes(assetId));
  if (!isIssueEvidence) state.assets = state.assets.filter((asset) => asset.id !== assetId);
  return { entityId: batch.id, action: "removePhoto", summary: isIssueEvidence ? "Removed the row photo while keeping the issue evidence snapshot." : "Removed the photo from the inspection row." };
}

export function addDocument(state, data, context) {
  const input = requireRecord(data, "Library document");
  const file = validateAssetPayload(input, DOCUMENT_MIMES, DOCUMENT_MAX_BYTES, "Library document");
  requireTotalCapacity(state, file.decodedBytes, null, context.trustedAssetValidation);
  let versionId = null;
  if (input.versionId != null && String(input.versionId).trim() !== "") {
    versionId = requireString(input.versionId, "Version ID", { maxLength: 120 });
    if (!state.versions.some((version) => version.id === versionId)) fail("Choose an available design version for this document.");
  }
  const id = makeId(context.idFactory);
  state.assets.push({
    id,
    name: file.name,
    mimeType: file.mimeType,
    dataUrl: file.dataUrl,
    kind: "document",
    batchId: null,
    rowId: null,
    versionId,
    createdAt: context.now(),
  });
  return { entityId: id, action: "addDocument", summary: `Added library document ${file.name}.` };
}

export function removeVersionAttachment(state, data) {
  const input = requireRecord(data, "Version attachment removal");
  const versionId = requireString(input.versionId, "Version ID", { maxLength: 120 });
  const version = state.versions.find((candidate) => candidate.id === versionId);
  if (!version) fail("That design version is no longer available.");

  const assetId = requireString(input.assetId, "Version attachment ID", { maxLength: 160 });
  const asset = state.assets.find((candidate) => candidate.id === assetId);
  if (!asset || asset.kind !== "document" || asset.versionId !== version.id) {
    fail("That document is not attached to this version.");
  }

  const referencedByBatch = (state.batches ?? []).some((batch) => (batch.attachmentIds ?? []).includes(asset.id));
  const referencedByHistory = (state.history?.sources ?? []).some((source) => source.assetId === asset.id);
  if (referencedByBatch || referencedByHistory) {
    asset.versionId = null;
  } else {
    state.assets = state.assets.filter((candidate) => candidate.id !== asset.id);
  }

  return {
    entityId: version.id,
    action: "removeVersionAttachment",
    summary: `Removed ${asset.name} from version ${version.label}.`,
  };
}

export function addBatchAttachment(state, data, context) {
  const input = requireRecord(data, "Batch attachment");
  const batch = requireBatch(state, input.batchId);
  if (batch.kind !== "historical" && batch.status === "released") {
    fail("This batch is released and its attachments are read-only.");
  }
  const detectedMimeType = normalizeDataUrl(input.dataUrl, "Batch attachment").mimeType;
  if (input.mimeType != null && String(input.mimeType).toLocaleLowerCase() !== detectedMimeType) {
    fail("Batch attachment type must match its data URL.");
  }
  const file = validateAssetPayload({
    name: input.name,
    mimeType: input.mimeType ?? detectedMimeType,
    dataUrl: input.dataUrl,
  }, DOCUMENT_MIMES, DOCUMENT_MAX_BYTES, "Batch attachment");
  requireTotalCapacity(state, file.decodedBytes, null, context.trustedAssetValidation);

  const id = makeId(context.idFactory);
  state.assets.push({
    id,
    name: file.name,
    mimeType: file.mimeType,
    dataUrl: file.dataUrl,
    kind: "document",
    batchId: null,
    rowId: null,
    versionId: null,
    createdAt: context.now(),
  });
  batch.attachmentIds ??= [];
  batch.attachmentIds.push(id);
  return { entityId: batch.id, action: "addBatchAttachment", summary: `Added ${file.name} to batch ${batch.number}.`, assetIds: [id] };
}

export function removeBatchAttachment(state, data) {
  const batch = requireBatch(state, data.batchId);
  if (batch.kind !== "historical" && batch.status === "released") {
    fail("This batch is released and its attachments are read-only.");
  }
  const assetId = requireString(data.assetId, "Batch attachment ID", { maxLength: 160 });
  if (!(batch.attachmentIds ?? []).includes(assetId)) fail("That document is not attached to this batch.");

  if (batch.kind === "historical") {
    const inspection = state.history?.inspections?.find((candidate) => candidate.id === batch.historyInspectionId);
    const source = inspection && state.history.sources.find((candidate) => candidate.id === inspection.sourceId);
    if (source?.assetId === assetId) fail("The original historical PDF must remain attached as source evidence.");
  }

  batch.attachmentIds = batch.attachmentIds.filter((id) => id !== assetId);
  return {
    entityId: batch.id,
    action: "removeBatchAttachment",
    summary: `Removed the document link from batch ${batch.number}; the library document remains available.`,
  };
}
