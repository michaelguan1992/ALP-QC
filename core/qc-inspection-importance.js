import { factoryKey, normalizeStage } from "./qc-domain.js";
import { getBatchRowProduct } from "./qc-batch-products.js";

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

function numberAndCodeSignature(value) {
  if (typeof value !== "string") return [];
  const normalized = value.normalize("NFKC").toLocaleUpperCase();
  const tokens = normalized.match(/(?:[A-Z]{1,4}\d+[A-Z0-9.-]*|\d+(?:\.\d+)?(?:[A-Z]+)?|>=|<=|[<>~=+\-±≠≥≤])/gu);
  return tokens ?? [];
}

function chineseCriterion(value) {
  if (typeof value !== "string") return "";
  const normalized = value.normalize("NFKC")
    .replace(/[，]/gu, ",")
    .replace(/[（]/gu, "(")
    .replace(/[）]/gu, ")")
    .replace(/\s+/gu, "")
    .toLocaleLowerCase();
  const firstChinese = /\p{Script=Han}/u.exec(normalized);
  return firstChinese ? normalized.slice(firstChinese.index) : "";
}

function criteriaMatch(current, historical) {
  const currentFull = normalizedText(current);
  const historicalFull = normalizedText(historical);
  if (!currentFull || !historicalFull) return false;
  if (currentFull === historicalFull) return true;

  const currentChinese = chineseCriterion(current);
  const historicalChinese = chineseCriterion(historical);
  return Boolean(currentChinese && historicalChinese && currentChinese === historicalChinese &&
    JSON.stringify(numberAndCodeSignature(current)) === JSON.stringify(numberAndCodeSignature(historical)));
}

function modelContextMatches(batch, inspection, expectedModel) {
  const explicitModel = typeof inspection?.model === "string" && inspection.model.trim()
    ? inspection.model.trim()
    : typeof batch?.model === "string" && batch.model.trim()
      ? batch.model.trim()
      : "";
  if (explicitModel) return explicitModel.toLocaleUpperCase() === expectedModel;

  const productLabel = typeof inspection?.productLabel === "string" && inspection.productLabel.trim()
    ? inspection.productLabel.trim()
    : typeof batch?.productLabel === "string" && batch.productLabel.trim()
      ? batch.productLabel.trim()
      : "";
  const modelCodes = [...new Set((productLabel.toLocaleUpperCase().match(/\bS(?:11|12|13|14|15)\b/gu) ?? []))];
  if (modelCodes.length === 0) return true;
  return modelCodes.length === 1 && modelCodes[0] === expectedModel;
}

function rawSourceRow(state, batch, row) {
  const product = getBatchRowProduct(batch, row);
  if (!product) return null;
  const version = state.versions.find((candidate) => candidate.id === product.versionId);
  if (!version || version.status !== "recorded" || !Array.isArray(version.sourceRows)) return null;

  const sourceItemId = typeof row.sourceItemId === "string" && row.sourceItemId.trim()
    ? row.sourceItemId
    : row.id;
  const sourceRow = version.sourceRows.find((candidate) => candidate?.sourceRecordId === sourceItemId);
  if (!sourceRow || !sourceRow.rawRecord || typeof sourceRow.rawRecord !== "object" || Array.isArray(sourceRow.rawRecord)) return null;
  return { product, version, sourceRow };
}

function sameStandard(currentRow, historicalRow) {
  return historicalRow.status !== "missing-from-source" &&
    normalizedText(unscopedTitle(historicalRow.title)) === normalizedText(unscopedTitle(currentRow.title)) &&
    criteriaMatch(currentRow.specification, historicalRow.specification) &&
    normalizedText(currentRow.devices) === normalizedText(historicalRow.devices) &&
    typeof currentRow.samplingPercent === "number" && currentRow.samplingPercent === historicalRow.samplingPercent &&
    normalizedText(currentRow.recordingRule) === normalizedText(historicalRow.recordingRule);
}

function historicalMatches(state, batch, row, product, version) {
  const variant = state.variants.find((candidate) => candidate.id === product.variantId);
  const model = typeof variant?.model === "string" ? variant.model.trim().toLocaleUpperCase() : "";
  const familyId = product.familyId ?? version.familyId;
  const currentFactory = factoryKey(batch.factory);
  const currentStage = normalizeStage(batch.stage);
  if (!model || !MODEL_CODES.has(model) || !familyId || !currentFactory || !currentStage) return [];

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
    if (!inspection || !source || !asset || source.id !== inspection.sourceId || source.family !== familyId ||
        asset.kind !== "document" || asset.mimeType !== "application/pdf" ||
        typeof asset.dataUrl !== "string" || !asset.dataUrl.startsWith("data:application/pdf;base64,") ||
        !Array.isArray(historicalBatch.attachmentIds) || !historicalBatch.attachmentIds.includes(source.assetId) ||
        !Array.isArray(inspection.rows) || inspection.factory !== historicalBatch.factory || inspection.stage !== historicalBatch.stage ||
        factoryKey(inspection.factory) !== currentFactory || normalizeStage(inspection.stage) !== currentStage) continue;
    if (!modelContextMatches(historicalBatch, inspection, model)) continue;
    if (!Array.isArray(historicalBatch.rows)) continue;
    for (const historicalRow of inspection.rows) {
      if (!sameStandard(row, historicalRow) || typeof historicalRow.important !== "boolean") continue;
      const projectedRow = historicalBatch.rows.find((candidate) => candidate.id === historicalRow.id);
      if (!projectedRow || !sameStandard(historicalRow, projectedRow) || projectedRow.important !== historicalRow.important) continue;
      matches.push({
        batchId: historicalBatch.id,
        rowId: historicalRow.id,
        inspectionId: historicalBatch.historyInspectionId,
        sourceId: inspection?.sourceId ?? null,
        sourceFileName: source.fileName ?? null,
        page: inspection?.page ?? null,
        date: historicalBatch.date ?? inspection?.date ?? null,
        versionLabel: historicalBatch.versionLabel ?? inspection?.printedVersion ?? null,
        important: historicalRow.important,
      });
    }
  }
  return matches;
}

/** Resolve display-only importance for one locked operational row. */
export function resolveInspectionImportance(state, batch, row) {
  const stored = storedImportance(row);
  if (!batch || batch.kind === "historical") {
    return { displayImportant: stored, importanceEvidence: null };
  }

  const resolved = rawSourceRow(state, batch, row);
  if (!resolved) return { displayImportant: stored, importanceEvidence: null };

  const sourceValue = sourceImportance(resolved.sourceRow.rawRecord);
  if (sourceValue.value !== null) {
    return { displayImportant: sourceValue.value, importanceEvidence: null };
  }
  if (sourceValue.hasUnrecognizedImportance) {
    return { displayImportant: stored, importanceEvidence: null };
  }

  const matches = historicalMatches(state, batch, row, resolved.product, resolved.version);
  if (matches.length === 0) return { displayImportant: stored, importanceEvidence: null };

  const values = new Set(matches.map((match) => match.important));
  const agrees = values.size === 1;
  const important = agrees ? matches[0].important : false;
  return {
    displayImportant: important,
    importanceEvidence: {
      source: "historical-inspection-rows",
      status: agrees ? "consistent" : "conflict",
      important: agrees ? important : null,
      matches,
    },
  };
}
