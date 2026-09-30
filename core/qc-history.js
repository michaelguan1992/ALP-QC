import {
  ASSET_TOTAL_MAX_BYTES,
  BACKUP_MAX_BYTES,
  addAudit,
  clone,
  createInitialQCState,
  deepEqual,
  fail,
  isIsoTimestamp,
  normalizeDataUrl,
  requireRecord,
  requireString,
  safeFilename,
  stableStringify,
} from "./qc-domain.js";
import { validateQCState } from "./qc-validation.js";
import { materializeHistoricalBatches } from "./qc-historical-batches.js";
import { supersedeOutdatedAPVersions } from "./qc-standards.js";
import { mergeSupersededAPVersionDuplicates, reconcileHistoricalVersionPackage } from "./qc-version-merge.js";

export const HISTORY_FORMAT = "masterqc-pdf-history";
export const HISTORY_FORMAT_VERSION = 1;

function assert(condition, message) {
  if (!condition) fail(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertJson(value, label) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail(`${label} must contain JSON-compatible values.`);
  }
  if (serialized === undefined) fail(`${label} must contain JSON-compatible values.`);
  return serialized;
}

function assertOptionalText(record, key, label, maxLength = 1000) {
  if (!Object.hasOwn(record, key)) fail(`${label} is missing ${key}.`);
  const value = record[key];
  if (value !== null && typeof value !== "string") fail(`${label} ${key} must be text or null.`);
  if (typeof value === "string" && value.length > maxLength) fail(`${label} ${key} is too long.`);
}

function assertSourceScalar(value, label) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  fail(`${label} must preserve a finite number, text, boolean, or null source value.`);
}

function assertHistoryRows(rows, inspectionLabel) {
  assert(Array.isArray(rows), `${inspectionLabel} rows must be a list.`);
  assert(rows.length <= 1000, `${inspectionLabel} contains too many rows.`);
  const rowNos = [];
  for (const [index, row] of rows.entries()) {
    requireRecord(row, `${inspectionLabel} row ${index + 1}`);
    assert(Number.isSafeInteger(row.no) && row.no > 0, `${inspectionLabel} row ${index + 1} needs a positive printed item number.`);
    assert(typeof row.title === "string" && row.title.length <= 500, `${inspectionLabel} row ${row.no} title must be text.`);
    for (const key of ["specification", "devices", "recordingRule", "remarks"]) {
      assertOptionalText(row, key, `${inspectionLabel} row ${row.no}`, 10000);
    }
    for (const key of ["samplingPercent", "timeSeconds", "important", "sourceInspectedQty", "defectiveQty", "sourceDefectiveRate"]) {
      assert(Object.hasOwn(row, key), `${inspectionLabel} row ${row.no} is missing ${key}.`);
      assertSourceScalar(row[key], `${inspectionLabel} row ${row.no} ${key}`);
    }
    if (row.status !== undefined) assertOptionalText(row, "status", `${inspectionLabel} row ${row.no}`, 80);
    if (row.status === "missing-from-source") {
      assert(row.sourceInspectedQty === null && row.defectiveQty === null && row.sourceDefectiveRate === null,
        `${inspectionLabel} missing-from-source rows must not contain copied results.`);
      assert(typeof row.missingEvidence === "string" && row.missingEvidence.trim(),
        `${inspectionLabel} missing-from-source rows need source evidence.`);
    }
    if (Object.hasOwn(row, "raw")) assertJson(row.raw, `${inspectionLabel} row ${row.no} raw values`);
    rowNos.push(row.no);
  }
  assert(new Set(rowNos).size === rowNos.length, `${inspectionLabel} printed item numbers must be unique.`);
}

/** Validate historical records stored inside an optional state.history object. */
export function validateHistoryState(history, assets) {
  if (history === undefined || history === null) return;
  requireRecord(history, "Historical PDF records");
  for (const key of ["sources", "inspections"]) assert(Array.isArray(history[key]), `Historical ${key} must be a list.`);
  if (history.anomalies !== undefined) assert(Array.isArray(history.anomalies), "Historical anomalies must be a list.");
  assertJson(history.anomalies ?? [], "Historical anomalies");

  const sourcesById = new Map();
  const assetIds = [];
  for (const source of history.sources) {
    requireRecord(source, "Historical PDF source");
    validateSourceFields(source);
    assert(!sourcesById.has(source.id), `Historical source ID ${source.id} is repeated.`);
    const asset = assets.get(source.assetId);
    assert(asset && asset.kind === "document" && asset.mimeType === "application/pdf" && asset.name === source.fileName,
      `Historical PDF ${source.fileName} must link to its original PDF document asset.`);
    if (source.anomalies !== undefined) assert(Array.isArray(source.anomalies), `Historical PDF ${source.fileName} anomalies must be a list.`);
    assertJson(source, `Historical PDF source ${source.id}`);
    sourcesById.set(source.id, source);
    assetIds.push(source.assetId);
  }
  assert(new Set(assetIds).size === assetIds.length, "Each historical PDF source must have its own document asset.");

  const inspectionIds = new Set();
  const sourcePages = new Set();
  for (const inspection of history.inspections) {
    requireRecord(inspection, "Historical inspection record");
    requireString(inspection.id, "Historical inspection ID", { maxLength: 160 });
    assert(!inspectionIds.has(inspection.id), "Historical inspection IDs must be unique.");
    inspectionIds.add(inspection.id);
    const source = sourcesById.get(inspection.sourceId);
    assert(source, `Historical inspection ${inspection.id} refers to a missing PDF source.`);
    assert(Number.isSafeInteger(inspection.page) && inspection.page > 0 && inspection.page <= source.pageCount,
      `Historical inspection ${inspection.id} has an invalid source page.`);
    const pageKey = `${inspection.sourceId}|${inspection.page}`;
    assert(!sourcePages.has(pageKey), `Historical PDF ${source.fileName} has duplicate records for page ${inspection.page}.`);
    sourcePages.add(pageKey);
    for (const [key, maxLength] of [["printedVersion", 300], ["printedDate", 300], ["date", 300], ["productLabel", 500], ["model", 120], ["color", 120], ["factory", 200], ["stage", 200], ["recorder", 300], ["notes", 10000]]) {
      assertOptionalText(inspection, key, `Historical inspection ${inspection.id}`, maxLength);
    }
    assert(Object.hasOwn(inspection, "batchQuantity"), `Historical inspection ${inspection.id} is missing batchQuantity.`);
    assertSourceScalar(inspection.batchQuantity, `Historical inspection ${inspection.id} batch quantity`);
    assertHistoryRows(inspection.rows, `Historical inspection ${inspection.id}`);
    if (inspection.anomalies !== undefined) assert(Array.isArray(inspection.anomalies), `Historical inspection ${inspection.id} anomalies must be a list.`);
    assertJson(inspection.anomalies ?? [], `Historical inspection ${inspection.id} anomalies`);
    assertJson(inspection, `Historical inspection ${inspection.id}`);
  }
}

function assertPackageShape(historyPackage) {
  requireRecord(historyPackage, "Historical PDF package");
  assert(historyPackage.format === HISTORY_FORMAT && historyPackage.formatVersion === HISTORY_FORMAT_VERSION,
    "This historical PDF package format is not supported.");
  const serialized = assertJson(historyPackage, "Historical PDF package");
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > BACKUP_MAX_BYTES) fail(`Historical PDF package exceeds the ${Math.floor(BACKUP_MAX_BYTES / (1024 * 1024))} MiB import limit.`);
  for (const key of ["sources", "inspections", "assets"]) assert(Array.isArray(historyPackage[key]), `Historical PDF package ${key} must be a list.`);
  if (historyPackage.versions !== undefined) assert(Array.isArray(historyPackage.versions), "Historical PDF package versions must be a list.");
  if (historyPackage.anomalies !== undefined) {
    assert(Array.isArray(historyPackage.anomalies), "Historical PDF package anomalies must be a list.");
    assertJson(historyPackage.anomalies, "Historical PDF package anomalies");
  }
  return bytes;
}

/** Synchronous shape and graph validation. PDF hashes are checked separately before a transaction. */
export function validateHistoryPackage(historyPackage) {
  assertPackageShape(historyPackage);
  const sourceIds = new Set();
  for (const source of historyPackage.sources) {
    requireRecord(source, "Historical PDF source");
    assert(!sourceIds.has(source.id), `Historical PDF source ID ${String(source.id)} is repeated.`);
    sourceIds.add(source.id);
  }

  const assetIds = new Set();
  let assetBytes = 0;
  for (const asset of historyPackage.assets) {
    requireRecord(asset, "Historical PDF asset");
    requireString(asset.id, "Historical PDF asset ID", { maxLength: 160 });
    assert(!assetIds.has(asset.id), `Historical PDF asset ID ${asset.id} is repeated.`);
    assetIds.add(asset.id);
    const parsed = normalizeDataUrl(asset.dataUrl, "Historical PDF asset");
    assert(parsed.mimeType === "application/pdf" && asset.mimeType === "application/pdf", `Historical asset ${asset.name} must be a PDF.`);
    assetBytes += parsed.decodedBytes;
  }
  if (assetBytes > ASSET_TOTAL_MAX_BYTES) fail(`Historical PDFs exceed the ${Math.floor(ASSET_TOTAL_MAX_BYTES / (1024 * 1024))} MiB total storage limit.`);

  const sourceAssetIds = new Set();
  const packageAssets = new Map(historyPackage.assets.map((asset) => [asset.id, asset]));
  for (const source of historyPackage.sources) {
    validateSourceFields(source, packageAssets);
    assert(assetIds.has(source.assetId), `Historical PDF ${source.fileName} is missing its original file asset.`);
    assert(!sourceAssetIds.has(source.assetId), "Each historical PDF source must have its own document asset.");
    sourceAssetIds.add(source.assetId);
  }
  assert(assetIds.size === sourceAssetIds.size, "Historical PDF package contains an asset that is not linked to a source record.");

  const inspectionIds = new Set();
  const pages = new Set();
  for (const inspection of historyPackage.inspections) {
    requireRecord(inspection, "Historical inspection record");
    requireString(inspection.id, "Historical inspection ID", { maxLength: 160 });
    assert(!inspectionIds.has(inspection.id), `Historical inspection ID ${inspection.id} is repeated.`);
    inspectionIds.add(inspection.id);
    assert(sourceIds.has(inspection.sourceId), `Historical inspection ${inspection.id} refers to a PDF source missing from this package.`);
    const source = historyPackage.sources.find((candidate) => candidate.id === inspection.sourceId);
    assert(Number.isSafeInteger(inspection.page) && inspection.page > 0 && inspection.page <= source.pageCount,
      `Historical inspection ${inspection.id} has an invalid source page.`);
    const pageKey = `${inspection.sourceId}|${inspection.page}`;
    assert(!pages.has(pageKey), `Historical PDF ${source.fileName} has duplicate records for page ${inspection.page}.`);
    pages.add(pageKey);
    assertHistoryRows(inspection.rows, `Historical inspection ${inspection.id}`);
  }

  const versions = historyPackage.versions ?? [];
  for (const version of versions) {
    requireRecord(version, "Historical standards draft");
    assert(version.status === "draft" && version.publishedAt === null, "Historical standards must be imported as unpublished drafts.");
  }

  const candidate = createInitialQCState();
  candidate.versions = clone(versions);
  candidate.assets = clone(historyPackage.assets);
  candidate.history = {
    sources: clone(historyPackage.sources),
    inspections: clone(historyPackage.inspections),
    anomalies: clone(historyPackage.anomalies ?? []),
  };
  validateQCState(candidate);
  return new TextEncoder().encode(JSON.stringify(historyPackage)).byteLength;
}

function validateSourceFields(source, assets = null) {
  requireString(source.id, "Historical source ID", { maxLength: 160 });
  const filename = requireString(source.fileName, "Historical PDF filename", { maxLength: 200 });
  safeFilename(filename);
  assert(/^[a-f\d]{64}$/i.test(source.sha256), `Historical PDF ${filename} needs a SHA-256 digest.`);
  assert(Number.isSafeInteger(source.pageCount) && source.pageCount > 0, `Historical PDF ${filename} needs a positive page count.`);
  assert(["s11-s14", "s15"].includes(source.family), `Historical PDF ${filename} has an unsupported inspection family.`);
  requireString(source.assetId, "Historical PDF asset ID", { maxLength: 160 });
  const asset = assets?.get(source.assetId);
  if (asset) {
    assert(asset.name === filename, `Historical PDF filename does not match asset ${asset.id}.`);
    assert(asset.kind === "document" && asset.batchId === null && asset.rowId === null && asset.versionId === null,
      `Historical PDF asset ${asset.id} must be an unlinked library document.`);
    assert(isIsoTimestamp(asset.createdAt), `Historical PDF asset ${asset.id} needs an ISO creation time.`);
  }
}

function bytesFromDataUrl(dataUrl) {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) fail("Historical PDF data is invalid.");
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) fail("This browser cannot verify historical PDF SHA-256 checksums.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Verify each original document against its recorded SHA-256 before writing any state. */
export async function verifyHistoryPackage(historyPackage) {
  validateHistoryPackage(historyPackage);
  const assets = new Map(historyPackage.assets.map((asset) => [asset.id, asset]));
  for (const source of historyPackage.sources) {
    const asset = assets.get(source.assetId);
    const digest = await sha256Hex(bytesFromDataUrl(asset.dataUrl));
    assert(digest.toLowerCase() === source.sha256.toLowerCase(), `SHA-256 does not match historical PDF ${source.fileName}.`);
  }
  return true;
}

/** Verify the same provenance relationship when restoring a whole-app backup. */
export async function verifyHistoryStateAssets(state) {
  validateQCState(state);
  if (!state.history?.sources?.length) return true;
  const assets = new Map(state.assets.map((asset) => [asset.id, asset]));
  for (const source of state.history.sources) {
    const asset = assets.get(source.assetId);
    assert(asset, `Backup is missing original historical PDF ${source.fileName}.`);
    const digest = await sha256Hex(bytesFromDataUrl(asset.dataUrl));
    assert(digest.toLowerCase() === source.sha256.toLowerCase(), `Backup SHA-256 does not match historical PDF ${source.fileName}.`);
  }
  return true;
}

function mergeById(current, incoming, label, counts) {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) {
    const existing = byId.get(item.id);
    if (!existing) {
      const copy = clone(item);
      current.push(copy);
      byId.set(copy.id, copy);
      counts.added[label] += 1;
    } else if (deepEqual(existing, item)) {
      counts.skipped[label] += 1;
    } else {
      fail(`Historical PDF import conflicts with existing ${label} record ${item.id}; no data was imported.`);
    }
  }
}

function mergeAnomalies(current, incoming, counts) {
  for (const anomaly of incoming) {
    if (current.some((existing) => deepEqual(existing, anomaly))) counts.skipped.anomalies += 1;
    else {
      current.push(clone(anomaly));
      counts.added.anomalies += 1;
    }
  }
}

export function importHistory(targetState, historyPackage, context) {
  const target = targetState === null ? createInitialQCState() : clone(targetState);
  const versionCorrection = supersedeOutdatedAPVersions(target);
  const versionMerge = mergeSupersededAPVersionDuplicates(target);
  const preparedMerge = reconcileHistoricalVersionPackage(target, historyPackage);
  historyPackage = preparedMerge.historyPackage;
  target.history ??= { sources: [], inspections: [], anomalies: [] };
  target.history.anomalies ??= [];
  const counts = {
    added: { sources: 0, inspections: 0, assets: 0, versions: 0, anomalies: 0, batches: 0, versionMergeEvidence: 0 },
    skipped: { sources: 0, inspections: 0, assets: 0, versions: 0, anomalies: 0, batches: 0, versionMergeEvidence: 0 },
  };
  counts.added.versionMergeEvidence = versionMerge.evidenceIds.length + preparedMerge.evidenceIds.length;
  mergeById(target.assets, historyPackage.assets, "assets", counts);
  mergeById(target.versions, historyPackage.versions ?? [], "versions", counts);
  mergeById(target.history.sources, historyPackage.sources, "sources", counts);
  mergeById(target.history.inspections, historyPackage.inspections, "inspections", counts);
  mergeAnomalies(target.history.anomalies, historyPackage.anomalies ?? [], counts);
  const projections = materializeHistoricalBatches(target);
  counts.added.batches = projections.added;
  counts.skipped.batches = projections.skipped;

  const addedCount = Object.values(counts.added).reduce((total, count) => total + count, 0);
  if (addedCount === 0 && versionCorrection.versionIds.length === 0 && !versionMerge.changed) {
    validateQCState(target);
    return { state: target, result: { entityId: "history-import", changed: false, counts, revision: target.revision } };
  }

  target.revision += 1;
  addAudit(target, {
    idFactory: context.idFactory,
    now: context.now,
    action: "importHistory",
    entityId: "history-import",
    summary: `Imported ${counts.added.sources} historical PDF sources and ${counts.added.inspections} inspection records into ${counts.added.batches} canonical historical batches; merged ${versionMerge.versionIds.length + preparedMerge.versionIds.length} duplicate AP version records and relinked ${versionMerge.assetIds.length + preparedMerge.assetIds.length} documents; no PO quantities were linked.`,
  });
  validateQCState(target);
  return { state: target, result: { entityId: "history-import", changed: true, counts, revision: target.revision } };
}

export function historyPackageFingerprint(value) {
  return stableStringify(value);
}
