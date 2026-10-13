import { factoryKey, normalizeStage } from "./qc-domain.js";
import { getBatchRowProduct } from "./qc-batch-products.js";
import { getBatchVersionItems } from "./qc-batch-versions.js";

const IMPORTANCE_FIELDS = [
  "重要检测 Important Check",
  "重点检查 Important Check",
  "Important Check",
];
const IMPORTANCE_TRUE_VALUES = new Set(["true", "yes", "是", "重要", "重点"]);
const IMPORTANCE_FALSE_VALUES = new Set(["false", "no", "否", "普通", "不重要"]);
const MODEL_CODES = new Set(["S11", "S12", "S13", "S14", "S15"]);

function sourceImportance(rawRecord) {
  let hasUnrecognizedImportance = false;
  for (const field of IMPORTANCE_FIELDS) {
    if (!Object.hasOwn(rawRecord ?? {}, field)) continue;
    const value = rawRecord?.[field];
    if (typeof value === "boolean") return { value, hasUnrecognizedImportance: false };
    if (typeof value === "string") {
      const normalized = value.trim().toLocaleLowerCase();
      if (IMPORTANCE_TRUE_VALUES.has(normalized)) return { value: true, hasUnrecognizedImportance: false };
      if (IMPORTANCE_FALSE_VALUES.has(normalized)) return { value: false, hasUnrecognizedImportance: false };
      if (normalized) hasUnrecognizedImportance = true;
    } else if (value != null) {
      hasUnrecognizedImportance = true;
    }
  }
  if (Object.keys(rawRecord ?? {}).some((field) =>
    /importan(?:t|ce)|重要|重点/iu.test(field) && !IMPORTANCE_FIELDS.includes(field))) {
    hasUnrecognizedImportance = true;
  }
  return { value: null, hasUnrecognizedImportance };
}

function storedImportance(row) {
  return row?.important === true;
}

function normalizedText(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC")
    .replace(/[，]/gu, ",")
    .replace(/[（]/gu, "(")
    .replace(/[）]/gu, ")")
    .replace(/\s+/gu, "")
    .toLocaleLowerCase();
}

function unscopedTitle(value) {
  if (typeof value !== "string") return "";
  const suffix = /\s*\[([^\]]+)\]\s*$/u.exec(value);
  if (!suffix) return value;
  const scope = suffix[1];
  const hasFactory = /\b(?:AP|UI)\b/iu.test(scope);
  const hasStage = /\b(?:IQC|OQC)\b/iu.test(scope);
  return hasFactory && hasStage ? value.slice(0, suffix.index) : value;
}

function titleIdentity(value) {
  return normalizedText(unscopedTitle(value));
}

function modelCodes(value) {
  if (typeof value !== "string") return [];
  return [...new Set(value.toLocaleUpperCase().match(/\bS(?:11|12|13|14|15)\b/gu) ?? [])];
}

function sameModelScope(left, right) {
  const normalizedLeft = [...new Set(left.map((model) => model.toLocaleUpperCase()))].sort();
  const normalizedRight = [...new Set(right.map((model) => model.toLocaleUpperCase()))].sort();
  return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}

function modelScopesOverlap(left, right) {
  if (!Array.isArray(left) || left.length === 0 || !Array.isArray(right) || right.length === 0) return true;
  return left.some((model) => right.includes(model));
}

function rawSourceRow(state, batch, row) {
  const product = getBatchRowProduct(batch, row);
  if (!product) return null;
  const version = state.versions.find((candidate) => candidate.id === product.versionId);
  if (!version || version.status !== "recorded" || !Array.isArray(version.sourceRows)) return null;

  const sourceItemId = typeof row.sourceItemId === "string" && row.sourceItemId.trim()
    ? row.sourceItemId
    : row.id;
  const sourceRows = version.sourceRows.filter((candidate) => candidate?.sourceRecordId === sourceItemId);
  const sourceRow = sourceRows.length === 1 ? sourceRows[0] : null;
  if (!sourceRow || !sourceRow.rawRecord || typeof sourceRow.rawRecord !== "object" || Array.isArray(sourceRow.rawRecord)) return null;
  return { version, sourceRow };
}

function sourceStandardModels(state, version, row, sourceStandard) {
  const family = state.families.find((candidate) => candidate.id === version.familyId);
  if (!family || !Array.isArray(family.models) || !Array.isArray(sourceStandard?.models) || !sourceStandard.models.length) return null;
  const familyModels = family.models.map((model) => String(model).toLocaleUpperCase());
  const applicableModels = [...new Set(sourceStandard.models.map((model) => String(model).toLocaleUpperCase()))];
  if (applicableModels.some((model) => !MODEL_CODES.has(model) || !familyModels.includes(model))) return null;
  if (Array.isArray(row.models) && !sameModelScope(applicableModels, row.models)) return null;
  return applicableModels;
}

function hasAmbiguousSourceStandard(sourceItems, sourceStandard, models) {
  const identity = titleIdentity(sourceStandard.title);
  if (!identity) return true;
  return sourceItems.some((candidate) => candidate.id !== sourceStandard.id &&
    titleIdentity(candidate.title) === identity &&
    factoryKey(candidate.factory) === factoryKey(sourceStandard.factory) &&
    normalizeStage(candidate.stage) === normalizeStage(sourceStandard.stage) &&
    modelScopesOverlap(models, candidate.models));
}

function historicalModelContextMatches(batch, inspection, applicableModels) {
  const inspectionModel = modelCodes(inspection?.model);
  const batchModel = modelCodes(batch?.model);
  if (inspectionModel.length && batchModel.length && !sameModelScope(inspectionModel, batchModel)) return false;
  const inspectionLabelModels = modelCodes(inspection?.productLabel);
  const batchLabelModels = modelCodes(batch?.productLabel);
  if (inspectionLabelModels.length && batchLabelModels.length && !sameModelScope(inspectionLabelModels, batchLabelModels)) return false;
  const modelSets = [inspectionModel, batchModel, inspectionLabelModels, batchLabelModels].filter((models) => models.length);
  return modelSets.every((models) => models.every((model) => applicableModels.includes(model)));
}

function validInspectionDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function historicalMatches(state, batch, row, version, sourceStandard, applicableModels) {
  const familyId = version.familyId;
  const currentFactory = factoryKey(batch.factory);
  const currentStage = normalizeStage(batch.stage);
  const identity = titleIdentity(sourceStandard.title);
  if (!applicableModels.length || !identity || !familyId || !currentFactory || !currentStage ||
      factoryKey(sourceStandard.factory) !== currentFactory || normalizeStage(sourceStandard.stage) !== currentStage ||
      titleIdentity(row.title) !== identity) return [];

  const inspections = new Map((Array.isArray(state.history?.inspections) ? state.history.inspections : [])
    .map((inspection) => [inspection.id, inspection]));
  const sources = new Map((Array.isArray(state.history?.sources) ? state.history.sources : [])
    .map((source) => [source.id, source]));
  const assets = new Map((Array.isArray(state.assets) ? state.assets : []).map((asset) => [asset.id, asset]));
  const matches = [];
  for (const historicalBatch of state.batches) {
    if (historicalBatch.kind !== "historical" || historicalBatch.familyId !== familyId ||
        factoryKey(historicalBatch.factory) !== currentFactory || normalizeStage(historicalBatch.stage) !== currentStage) continue;

    const inspection = inspections.get(historicalBatch.historyInspectionId) ?? null;
    const source = inspection ? sources.get(inspection.sourceId) ?? null : null;
    const asset = source ? assets.get(source.assetId) ?? null : null;
    const isValidatedPdf = typeof asset?.dataUrl === "string"
      ? asset.dataUrl.startsWith("data:application/pdf;base64,")
      : Number.isSafeInteger(asset?.decodedBytes) && asset.decodedBytes > 0 &&
        Number.isSafeInteger(asset?.contentRevision) && asset.contentRevision > 0;
    if (!inspection || !source || !asset || source.id !== inspection.sourceId || source.family !== familyId ||
        asset.kind !== "document" || asset.mimeType !== "application/pdf" || !isValidatedPdf ||
        !Array.isArray(historicalBatch.attachmentIds) || !historicalBatch.attachmentIds.includes(source.assetId) ||
        !Array.isArray(inspection.rows) || factoryKey(inspection.factory) !== currentFactory ||
        normalizeStage(inspection.stage) !== currentStage || !historicalModelContextMatches(historicalBatch, inspection, applicableModels) ||
        !Array.isArray(historicalBatch.rows)) continue;

    const matchingRows = inspection.rows.filter((candidate) => titleIdentity(candidate?.title) === identity);
    if (matchingRows.length !== 1) continue;
    const historicalRow = matchingRows[0];
    if (historicalRow.status === "missing-from-source" || typeof historicalRow.important !== "boolean") continue;
    const projectedRow = historicalBatch.rows.find((candidate) => candidate.id === historicalRow.id);
    if (!projectedRow || titleIdentity(projectedRow.title) !== identity || projectedRow.important !== historicalRow.important) continue;
    matches.push({
      batchId: historicalBatch.id,
      rowId: historicalRow.id,
      inspectionId: historicalBatch.historyInspectionId,
      sourceId: inspection.sourceId,
      sourceFileName: source.fileName ?? null,
      page: inspection.page ?? null,
      date: inspection.date ?? historicalBatch.date ?? null,
      inspectionDate: validInspectionDate(inspection.date),
      versionLabel: historicalBatch.versionLabel ?? inspection.printedVersion ?? null,
      important: historicalRow.important,
    });
  }
  return matches;
}

/** Resolve display-only importance for one locked operational row. */
export function resolveInspectionImportance(state, batch, row) {
  const stored = storedImportance(row);
  if (!batch || batch.kind === "historical") return { displayImportant: stored, importanceEvidence: null };

  const resolved = rawSourceRow(state, batch, row);
  if (!resolved) return { displayImportant: stored, importanceEvidence: null };

  const sourceValue = sourceImportance(resolved.sourceRow.rawRecord);
  if (sourceValue.value !== null) return { displayImportant: sourceValue.value, importanceEvidence: null };
  if (sourceValue.hasUnrecognizedImportance) return { displayImportant: stored, importanceEvidence: null };

  const sourceItems = getBatchVersionItems(resolved.version);
  const sourceStandard = sourceItems.find((candidate) => candidate.id === resolved.sourceRow.sourceRecordId);
  if (!sourceStandard) return { displayImportant: stored, importanceEvidence: null };
  const applicableModels = sourceStandardModels(state, resolved.version, row, sourceStandard);
  if (!applicableModels || hasAmbiguousSourceStandard(sourceItems, sourceStandard, applicableModels)) {
    return { displayImportant: stored, importanceEvidence: null };
  }

  const matches = historicalMatches(state, batch, row, resolved.version, sourceStandard, applicableModels);
  if (matches.length === 0) return { displayImportant: stored, importanceEvidence: null };

  const datedMatches = matches.filter((match) => match.inspectionDate !== null);
  const selectedDate = datedMatches.length
    ? datedMatches.reduce((latest, match) => latest === null || match.inspectionDate > latest ? match.inspectionDate : latest, null)
    : null;
  const selectedMatches = selectedDate === null
    ? matches.filter((match) => match.inspectionDate === null)
    : datedMatches.filter((match) => match.inspectionDate === selectedDate);
  const otherMatches = matches.filter((match) => !selectedMatches.includes(match));
  const values = new Set(selectedMatches.map((match) => match.important));
  const agrees = values.size === 1;
  const important = agrees ? selectedMatches[0].important : false;
  return {
    displayImportant: important,
    importanceEvidence: {
      source: "historical-inspection-rows",
      status: agrees ? "consistent" : "conflict",
      important: agrees ? important : null,
      selectionPolicy: selectedDate === null ? "undated-consensus" : "newest-dated-inspection",
      selectedDate,
      matches: selectedMatches,
      otherMatches,
    },
  };
}
