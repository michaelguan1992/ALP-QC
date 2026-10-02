import { factoryKey, isIsoTimestamp, normalizeStage } from "./qc-domain.js";
import { getBatchProducts, getBatchRowProduct } from "./qc-batch-products.js";

export const INSPECTION_HISTORY_LIMIT = 8;

const MODEL_CODES = new Set(["S11", "S12", "S13", "S14", "S15"]);
const INSPECTION_IDENTITY_ANOMALIES = new Set([
  "mixed-or-partial-product-allocation",
  "mixed-product-colors",
]);
const RELEVANT_CONFLICT_FIELDS = new Set([
  "title", "specification", "criteria", "devices", "method", "equipment",
  "samplingpercent", "samplingratio", "recordingrule", "recordingratio",
  "factory", "stage", "model", "color", "family", "batchquantity",
  "sourceinspectedqty", "defectiveqty", "sourcedefectiverate",
]);

function values(value) {
  return Array.isArray(value) ? value : [];
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validSavedAt(value) {
  return isIsoTimestamp(value);
}

/** Return a query-only value for a saved or draft operational inspection row. */
export function averageTimePerUnitSeconds(row) {
  const actualTime = row?.actualTimeSeconds;
  const inspectedQty = row?.inspectedQty;
  if (typeof actualTime !== "number" || !Number.isFinite(actualTime) || actualTime < 0 ||
      typeof inspectedQty !== "number" || !Number.isSafeInteger(inspectedQty) || inspectedQty <= 0) return null;
  return actualTime / inspectedQty;
}

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC")
    .replace(/[，]/gu, ",")
    .replace(/[（]/gu, "(")
    .replace(/[）]/gu, ")")
    .replace(/\s+/gu, "")
    .toLocaleLowerCase();
}

function normalizeDescriptiveText(value) {
  return normalizeText(value).replace(/[\/／](?=\p{Script=Han})/gu, "");
}

function normalizeRecordingRule(value) {
  const normalized = normalizeText(value);
  return normalized.replace(/^(\d+(?:\.\d+)?%)\+所有不良品$/u, "$1+allfailedunits");
}

function numberAndCodeSignature(value) {
  if (typeof value !== "string") return [];
  const normalized = value.normalize("NFKC").toLocaleUpperCase();
  return normalized.match(/(?:[A-Z]{1,4}\d+[A-Z0-9.-]*|\d+(?:\.\d+)?(?:[A-Z]+)?|>=|<=|[<>~=+\-±≠≥≤])/gu) ?? [];
}

function chineseCriterion(value) {
  const normalized = normalizeText(value);
  const firstChinese = /\p{Script=Han}/u.exec(normalized);
  return firstChinese ? normalized.slice(firstChinese.index) : "";
}

function criteriaMatch(left, right) {
  const leftFull = normalizeText(left);
  const rightFull = normalizeText(right);
  if (!leftFull || !rightFull) return false;
  if (leftFull === rightFull) return true;
  const leftChinese = chineseCriterion(left);
  const rightChinese = chineseCriterion(right);
  return Boolean(leftChinese && rightChinese && leftChinese === rightChinese &&
    JSON.stringify(numberAndCodeSignature(left)) === JSON.stringify(numberAndCodeSignature(right)));
}

function unscopedTitle(value) {
  if (typeof value !== "string") return "";
  const suffix = /\s*\[([^\]]+)\]\s*$/u.exec(value);
  if (!suffix || !/\b(?:AP|UI)\b/iu.test(suffix[1]) || !/\b(?:IQC|OQC)\b/iu.test(suffix[1])) return value;
  return value.slice(0, suffix.index);
}

function normalizedPair(row, mainField, secondaryField, stripScope = false) {
  const main = stripScope ? unscopedTitle(row?.[mainField]) : row?.[mainField];
  const parts = [main, row?.[secondaryField]].filter((part) => typeof part === "string" && part.trim());
  return normalizeDescriptiveText(parts.join("\n"));
}

function sameStandard(left, right, { requireKey = false } = {}) {
  if (!left || !right || left.status === "missing-from-source" || right.status === "missing-from-source") return false;
  if (requireKey && (typeof left.key !== "string" || !left.key.trim() || left.key !== right.key)) return false;
  const titleLeft = normalizedPair(left, "title", "titleZh", true);
  const titleRight = normalizedPair(right, "title", "titleZh", true);
  const specificationLeft = [left.specification, left.specificationZh].filter((part) => typeof part === "string" && part.trim()).join("\n");
  const specificationRight = [right.specification, right.specificationZh].filter((part) => typeof part === "string" && part.trim()).join("\n");
  const methodLeft = normalizedPair(left, "devices", "devicesZh");
  const methodRight = normalizedPair(right, "devices", "devicesZh");
  const recordingLeft = normalizeRecordingRule(left.recordingRule);
  const recordingRight = normalizeRecordingRule(right.recordingRule);
  return Boolean(titleLeft && titleLeft === titleRight &&
    criteriaMatch(specificationLeft, specificationRight) &&
    methodLeft && methodLeft === methodRight &&
    recordingLeft && recordingLeft === recordingRight &&
    typeof left.samplingPercent === "number" && Number.isFinite(left.samplingPercent) &&
    left.samplingPercent === right.samplingPercent);
}

function modelCodeTokens(value) {
  if (typeof value !== "string") return [];
  return [...new Set(value.toLocaleUpperCase().match(/\bS(?:11|12|13|14|15)\b/gu) ?? [])];
}

function appliesToModel(row, model) {
  if (!Array.isArray(row?.models)) return false;
  return row.models.length === 0 || row.models.includes(model);
}

function permitsCrossModelComparison(currentRow, candidateRow, currentModel, candidateModel) {
  if (currentModel === candidateModel) return true;
  const currentModels = currentRow?.models;
  const candidateModels = candidateRow?.models;
  if (!Array.isArray(currentModels) || !Array.isArray(candidateModels)) return false;
  if (![currentModel, candidateModel].every((model) => appliesToModel(currentRow, model) && appliesToModel(candidateRow, model))) return false;

  const modelSensitiveText = [
    currentRow.specification, currentRow.specificationZh, currentRow.devices, currentRow.devicesZh,
    currentRow.recordingRule, candidateRow.specification, candidateRow.specificationZh,
    candidateRow.devices, candidateRow.devicesZh, candidateRow.recordingRule,
  ].filter((value) => typeof value === "string").join("\n");
  if (modelCodeTokens(modelSensitiveText).length) return false;
  if (values(currentRow.specificationModelReferences).length || values(candidateRow.specificationModelReferences).length) return false;
  return true;
}

function productFor(state, batch, row, variantsById) {
  const product = getBatchRowProduct(batch, row);
  if (!product) return null;
  const variant = variantsById.get(product.variantId);
  if (!variant || typeof variant.model !== "string" || !variant.model.trim()) return null;
  return {
    ...product,
    familyId: product.familyId ?? variant.familyId ?? null,
    variant,
  };
}

function sameFamily(left, right) {
  return typeof left === "string" && left.length > 0 && left === right;
}

function hasValidOperationalResult(row, product) {
  if (!validSavedAt(row?.savedAt) || !Number.isSafeInteger(row.defectiveQty) || row.defectiveQty < 0 ||
      !Number.isSafeInteger(row.inspectedQty) || row.inspectedQty <= 0 || row.defectiveQty > row.inspectedQty ||
      !Number.isSafeInteger(product?.quantity) || product.quantity <= 0 || row.inspectedQty > product.quantity) return false;
  if (Object.hasOwn(row, "actualTimeSeconds") &&
      (typeof row.actualTimeSeconds !== "number" || !Number.isFinite(row.actualTimeSeconds) || row.actualTimeSeconds < 0)) return false;
  return true;
}

function isOlderOperationalBatch(candidate, current) {
  if (!validDate(candidate?.date) || !validDate(current?.date) || candidate.date > current.date) return false;
  if (candidate.date < current.date) return true;
  return isIsoTimestamp(candidate.createdAt) && isIsoTimestamp(current.createdAt) && candidate.createdAt < current.createdAt;
}

function operationalEntry(batch, row, product, displayNumbers) {
  const rate = Number(((row.defectiveQty / row.inspectedQty) * 100).toFixed(2));
  return {
    batchId: batch.id,
    batchNumber: displayNumbers.get(batch.id) ?? batch.number,
    date: batch.date,
    versionLabel: product.versionLabel ?? null,
    inspectedQty: row.inspectedQty,
    defectiveQty: row.defectiveQty,
    rate,
    savedAt: row.savedAt,
    sourceType: "batch",
    productVariantId: product.variant.id,
    productLabel: product.variant.label ?? product.variant.model,
    model: product.variant.model,
    color: product.variant.color ?? null,
  };
}

function sourceModel(inspection, historicalBatch) {
  const explicitValues = [inspection.model, historicalBatch.model]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim().toLocaleUpperCase());
  if (explicitValues.some((value) => !MODEL_CODES.has(value)) || new Set(explicitValues).size > 1) return null;
  const productLabels = [inspection.productLabel, historicalBatch.productLabel]
    .filter((value) => typeof value === "string" && value.trim());
  const tokens = new Set(productLabels.flatMap(modelCodeTokens));
  if (tokens.size > 1) return null;
  const explicit = explicitValues[0] ?? null;
  const labeled = [...tokens][0] ?? null;
  if (explicit && labeled && explicit !== labeled) return null;
  return explicit ?? labeled;
}

function normalizedColor(value) {
  return normalizeText(value);
}

function anomalyIsRelevant(anomaly) {
  const code = typeof anomaly?.code === "string" ? anomaly.code.toLocaleLowerCase() : "";
  if (INSPECTION_IDENTITY_ANOMALIES.has(code)) return true;
  if (["specification-model-mismatch", "source-inspected-quantity-exceeds-batch-quantity"].includes(code)) return true;
  const conflictFields = values(anomaly?.conflicts).map((conflict) => normalizeText(conflict?.field));
  return conflictFields.some((field) => RELEVANT_CONFLICT_FIELDS.has(field));
}

function anomalyBelongsToInspection(anomaly, source, inspection) {
  if (anomaly?.inspectionId) return anomaly.inspectionId === inspection.id;
  if (anomaly?.sourceId && anomaly.sourceId !== source.id) return false;
  if (anomaly?.sourceId && Number.isSafeInteger(anomaly.page) && anomaly.page !== inspection.page) return false;
  return Boolean(anomaly?.sourceId);
}

function anomalyBelongsToRow(anomaly, row) {
  return anomaly.rowNo === undefined || anomaly.rowNo === null || anomaly.rowNo === row.no;
}

function hasRelevantHistoricalAnomaly(state, source, inspection, row) {
  const packageAnomalies = values(state.history?.anomalies)
    .filter((anomaly) => anomalyBelongsToInspection(anomaly, source, inspection));
  const related = [
    ...packageAnomalies,
    ...values(source.anomalies),
    ...values(inspection.anomalies),
    ...values(row.anomalies),
  ];
  return related.some((anomaly) => anomalyBelongsToRow(anomaly, row) && anomalyIsRelevant(anomaly));
}

function validPdfAsset(asset, source, historicalBatch) {
  if (!asset || asset.id !== source.assetId || asset.name !== source.fileName || asset.kind !== "document" ||
      asset.mimeType !== "application/pdf" || !values(historicalBatch.attachmentIds).includes(source.assetId)) return false;
  return typeof asset.dataUrl === "string"
    ? asset.dataUrl.startsWith("data:application/pdf;base64,")
    : Number.isSafeInteger(asset.decodedBytes) && asset.decodedBytes > 0 &&
      Number.isSafeInteger(asset.contentRevision) && asset.contentRevision > 0;
}

function validHistoricalResult(inspection, row) {
  const batchQuantity = inspection?.batchQuantity;
  const inspectedQty = row?.sourceInspectedQty;
  const defectiveQty = row?.defectiveQty;
  if (row?.status === "missing-from-source" || !Number.isSafeInteger(batchQuantity) || batchQuantity <= 0 ||
      !Number.isSafeInteger(inspectedQty) || inspectedQty <= 0 || inspectedQty > batchQuantity ||
      !Number.isSafeInteger(defectiveQty) || defectiveQty < 0 || defectiveQty > inspectedQty) return false;
  if (row.sourceDefectiveRate === null || row.sourceDefectiveRate === undefined || row.sourceDefectiveRate === "") {
    const printedRate = row.sourceDefectiveRateRaw ?? row.raw?.printedRateText;
    return printedRate === null || printedRate === undefined || printedRate === "" || /^[-–—]+$/u.test(String(printedRate).trim());
  }
  if (typeof row.sourceDefectiveRate !== "number" || !Number.isFinite(row.sourceDefectiveRate) ||
      row.sourceDefectiveRate < 0 || row.sourceDefectiveRate > 100) return false;
  const expected = Number(((defectiveQty / inspectedQty) * 100).toFixed(2));
  if (Math.abs(row.sourceDefectiveRate - expected) >= 0.000001) return false;
  const printedRate = row.sourceDefectiveRateRaw ?? row.raw?.printedRateText;
  if (printedRate === null || printedRate === undefined || printedRate === "") return true;
  const printedMatch = /^\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))\s*%?\s*$/u.exec(String(printedRate));
  return Boolean(printedMatch && Math.abs(Number(printedMatch[1]) - row.sourceDefectiveRate) < 0.000001);
}

function isEarlierPdfInspection(inspection, currentBatch) {
  return validDate(inspection?.date) && validDate(currentBatch?.date) && inspection.date < currentBatch.date;
}

function historicalProjectionMatches(state, historicalBatch, source, inspection, sourceRow, sourcesById, assetsById) {
  if (historicalBatch.historyInspectionId !== inspection.id || historicalBatch.familyId !== source.family ||
      historicalBatch.date !== inspection.date || historicalBatch.model !== inspection.model ||
      historicalBatch.productLabel !== inspection.productLabel || historicalBatch.color !== inspection.color ||
      historicalBatch.quantity !== inspection.batchQuantity || historicalBatch.versionLabel !== inspection.printedVersion ||
      factoryKey(historicalBatch.factory) !== factoryKey(inspection.factory) ||
      normalizeStage(historicalBatch.stage) !== normalizeStage(inspection.stage) ||
      sourcesById.get(inspection.sourceId)?.id !== source.id || !validPdfAsset(assetsById.get(source.assetId), source, historicalBatch)) return false;

  const matchingRows = values(historicalBatch.rows).filter((row) => row.id === sourceRow.id);
  if (matchingRows.length !== 1) return false;
  const projected = matchingRows[0];
  return sameStandard(sourceRow, projected) &&
    sourceRow.sourceInspectedQty === projected.sourceInspectedQty &&
    sourceRow.defectiveQty === projected.defectiveQty &&
    sourceRow.sourceDefectiveRate === projected.sourceDefectiveRate;
}

function historicalEntry(historicalBatch, inspection, source, row, resolvedModel, displayNumbers) {
  const computedRate = Number(((row.defectiveQty / row.sourceInspectedQty) * 100).toFixed(2));
  return {
    batchId: historicalBatch.id,
    batchNumber: displayNumbers.get(historicalBatch.id) ?? historicalBatch.number,
    date: inspection.date,
    versionLabel: historicalBatch.versionLabel ?? inspection.printedVersion ?? null,
    inspectedQty: row.sourceInspectedQty,
    defectiveQty: row.defectiveQty,
    rate: row.sourceDefectiveRate ?? computedRate,
    sourceDefectiveRate: row.sourceDefectiveRate ?? null,
    savedAt: null,
    sourceType: "pdf",
    sourceFileName: source.fileName ?? null,
    sourcePage: inspection.page,
    productLabel: inspection.productLabel ?? null,
    model: resolvedModel,
    color: inspection.color ?? null,
  };
}

function collectOperationalHistory(context, currentProduct, currentRow) {
  const { state, batch: currentBatch, displayNumbers, variantsById, priorOperationalBatches } = context;
  const currentModel = currentProduct.variant.model.trim().toLocaleUpperCase();
  const currentFamily = currentProduct.familyId;
  if (!currentFamily || !currentModel || !Array.isArray(currentRow.models) || !appliesToModel(currentRow, currentModel)) return [];
  const entries = [];

  for (const candidateBatch of priorOperationalBatches) {
    const candidates = values(candidateBatch.rows).flatMap((candidateRow) => {
      if (!sameStandard(currentRow, candidateRow, { requireKey: true })) return [];
      const candidateProduct = productFor(state, candidateBatch, candidateRow, variantsById);
      if (!candidateProduct || !sameFamily(candidateProduct.familyId, currentFamily) ||
          !hasValidOperationalResult(candidateRow, candidateProduct)) return [];
      const candidateModel = candidateProduct.variant.model.trim().toLocaleUpperCase();
      if (!Array.isArray(candidateRow.models) || !appliesToModel(candidateRow, candidateModel)) return [];
      if (!permitsCrossModelComparison(currentRow, candidateRow, currentModel, candidateModel)) return [];
      return [{ row: candidateRow, product: candidateProduct }];
    });

    const sameVariant = candidates.filter(({ product }) => product.variantId === currentProduct.variantId);
    const match = sameVariant.length === 1
      ? sameVariant[0]
      : sameVariant.length > 1
        ? null
        : candidates.length === 1 ? candidates[0] : null;
    if (match) entries.push(operationalEntry(candidateBatch, match.row, match.product, displayNumbers));
  }
  return entries;
}

function collectPdfHistory(context, currentProduct, currentRow) {
  const { state, batch: currentBatch, displayNumbers, variantsById, inspectionsById, sourcesById, assetsById, historicalBatches } = context;
  const currentModel = currentProduct.variant.model.trim().toLocaleUpperCase();
  const currentFamily = currentProduct.familyId;
  if (!currentFamily || !MODEL_CODES.has(currentModel) || !appliesToModel(currentRow, currentModel)) return [];
  const entries = [];

  for (const historicalBatch of historicalBatches) {
    if (historicalBatch.familyId !== currentFamily || !isEarlierPdfInspection(
      inspectionsById.get(historicalBatch.historyInspectionId), currentBatch,
    )) continue;
    const inspection = inspectionsById.get(historicalBatch.historyInspectionId);
    const source = inspection ? sourcesById.get(inspection.sourceId) : null;
    if (!inspection || !source || source.family !== currentFamily ||
        factoryKey(historicalBatch.factory) !== factoryKey(currentBatch.factory) ||
        normalizeStage(historicalBatch.stage) !== normalizeStage(currentBatch.stage) ||
        factoryKey(inspection.factory) !== factoryKey(currentBatch.factory) ||
        normalizeStage(inspection.stage) !== normalizeStage(currentBatch.stage) ||
        sourceModel(inspection, historicalBatch) !== currentModel) continue;
    if (inspection.color && normalizedColor(inspection.color) !== normalizedColor(currentProduct.variant.color)) continue;
    if (!Array.isArray(inspection.rows) || !Array.isArray(historicalBatch.rows)) continue;

    const matchingRows = inspection.rows.filter((candidate) => sameStandard(currentRow, candidate));
    if (matchingRows.length !== 1) continue;
    const sourceRow = matchingRows[0];
    if (hasRelevantHistoricalAnomaly(state, source, inspection, sourceRow) ||
        !historicalProjectionMatches(state, historicalBatch, source, inspection, sourceRow, sourcesById, assetsById) ||
        !validHistoricalResult(inspection, sourceRow)) continue;
    entries.push(historicalEntry(historicalBatch, inspection, source, sourceRow, currentModel, displayNumbers));
  }
  return entries;
}

function compareHistory(left, right) {
  const date = String(right.date ?? "").localeCompare(String(left.date ?? ""));
  if (date) return date;
  const leftTime = validSavedAt(left.savedAt) ? Date.parse(left.savedAt) : Number.NEGATIVE_INFINITY;
  const rightTime = validSavedAt(right.savedAt) ? Date.parse(right.savedAt) : Number.NEGATIVE_INFINITY;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return String(right.batchId ?? "").localeCompare(String(left.batchId ?? ""));
}

export function createInspectionHistoryContext(state, batch, displayNumbers = new Map()) {
  const variantsById = new Map(values(state.variants).map((variant) => [variant.id, variant]));
  const sourcesById = new Map(values(state.history?.sources).map((source) => [source.id, source]));
  const inspectionsById = new Map(values(state.history?.inspections).map((inspection) => [inspection.id, inspection]));
  const assetsById = new Map(values(state.assets).map((asset) => [asset.id, asset]));
  return {
    state,
    batch,
    displayNumbers,
    variantsById,
    sourcesById,
    inspectionsById,
    assetsById,
    priorOperationalBatches: values(state.batches).filter((candidate) => candidate.id !== batch.id &&
      candidate.kind !== "historical" &&
      factoryKey(candidate.factory) === factoryKey(batch.factory) &&
      normalizeStage(candidate.stage) === normalizeStage(batch.stage) &&
      isOlderOperationalBatch(candidate, batch)),
    historicalBatches: values(state.batches).filter((candidate) => candidate.kind === "historical"),
  };
}

export function resolveInspectionHistory(context, currentProduct, currentRow) {
  if (!context || !currentProduct || !currentRow) return [];
  const entries = [
    ...collectOperationalHistory(context, currentProduct, currentRow),
    ...collectPdfHistory(context, currentProduct, currentRow),
  ];
  return entries.sort(compareHistory).slice(0, INSPECTION_HISTORY_LIMIT);
}
