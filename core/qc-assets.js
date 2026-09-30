import {
  ASSET_TOTAL_MAX_BYTES,
  DOCUMENT_MAX_BYTES,
  fail,
  makeId,
  normalizeDataUrl,
  PHOTO_MAX_BYTES,
  requireArray,
  requireRecord,
  requireString,
  safeFilename,
} from "./qc-domain.js";
import { requireBatch, requireEditableBatch } from "./qc-inspections.js";

const PHOTO_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "text/plain",
  "text/csv",
  "text/markdown",
]);
const DANGEROUS_EXTENSIONS = /\.(?:html?|xhtml|svg|js|mjs|cjs|wasm|hta|jar|exe|bat|cmd|sh|ps1)$/i;
const TEXT_EXTENSIONS = new Set([".txt", ".csv", ".md", ".markdown", ".log"]);
const DOCUMENT_EXTENSIONS = new Map([
  ["application/pdf", new Set([".pdf"])],
  ["image/png", new Set([".png"])],
  ["image/jpeg", new Set([".jpg", ".jpeg"])],
  ["image/webp", new Set([".webp"])],
  ["image/gif", new Set([".gif"])],
  ["text/csv", new Set([".csv"])],
  ["text/markdown", new Set([".md", ".markdown"])],
]);

function extensionOf(name) {
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index).toLocaleLowerCase();
}

function currentAssetBytes(state) {
  return state.assets.reduce((total, asset) => total + normalizeDataUrl(asset.dataUrl, "Stored attachment").decodedBytes, 0);
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
  const allowedExtensions = DOCUMENT_EXTENSIONS.get(declaredMime);
  if (allowedExtensions && !allowedExtensions.has(extensionOf(normalizedName))) {
    fail(`${label} filename extension must match ${declaredMime}.`);
  }
  return { name: normalizedName, mimeType: declaredMime, dataUrl, decodedBytes: parsed.decodedBytes };
}

function requireTotalCapacity(state, incomingBytes) {
  if (currentAssetBytes(state) + incomingBytes > ASSET_TOTAL_MAX_BYTES) {
    fail(`Attachments exceed the ${Math.floor(ASSET_TOTAL_MAX_BYTES / (1024 * 1024))} MiB total storage limit.`);
  }
}

export function addPhotos(state, data, context) {
  const batch = requireBatch(state, data.batchId);
  requireEditableBatch(batch);
  const rowId = requireString(data.rowId, "Inspection row ID", { maxLength: 120 });
  const row = batch.rows.find((candidate) => candidate.id === rowId);
  if (!row) fail("That inspection row is not part of this batch.");
  const files = requireArray(data.files, "Photo files");
  if (!files.length) fail("Choose at least one photo to add.");
  const normalized = files.map((file) => validateAssetPayload(requireRecord(file, "Photo file"), PHOTO_MIME_TYPES, PHOTO_MAX_BYTES, "Photo"));
  requireTotalCapacity(state, normalized.reduce((total, file) => total + file.decodedBytes, 0));
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
  const file = validateAssetPayload(input, DOCUMENT_MIME_TYPES, DOCUMENT_MAX_BYTES, "Library document");
  requireTotalCapacity(state, file.decodedBytes);
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
  }, DOCUMENT_MIME_TYPES, DOCUMENT_MAX_BYTES, "Batch attachment");
  requireTotalCapacity(state, file.decodedBytes);

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
