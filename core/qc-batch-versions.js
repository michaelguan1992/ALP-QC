import { isIsoTimestamp, normalizeFactory, normalizeStage } from "./qc-domain.js";

const SOURCE_FIELDS = Object.freeze({
  historyCode: "历史项目编号 History Item Code",
  factory: "工厂 Factory",
  stage: "工序 Stage",
  number: "序号 No.",
  samplingRatio: "抽检比例 Sampling Ratio",
  recordingRatio: "记录比例 Recording Ratio",
  equipment: "检验方法/设备 Method & Equipment",
  criteria: "规格/尺寸/检验要点 Spec & Criteria",
  procedureUrl: "视频/程序链接 Video / Procedure Link",
  title: "项目名称 Item Name",
});

const IMPORTANT_FIELDS = ["重要检测 Important Check", "重点检查 Important Check", "Important Check"];
const SELECTABLE_STATUSES = new Set(["recorded", "published", "superseded"]);

function validTimestamp(value) {
  if (!isIsoTimestamp(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function effectiveTimestamp(version) {
  if (version?.status === "recorded") return validTimestamp(version.source?.effectiveAtRaw);
  const date = version?.effectiveDate;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = validTimestamp(`${date}T00:00:00.000Z`);
  return parsed !== null && new Date(parsed).toISOString().slice(0, 10) === date ? parsed : null;
}

function sequenceValue(version) {
  return Number.isSafeInteger(version?.sequence) && version.sequence > 0 ? version.sequence : Number.NEGATIVE_INFINITY;
}

function compareVersions(left, right) {
  const leftDate = effectiveTimestamp(left);
  const rightDate = effectiveTimestamp(right);
  if (leftDate === null && rightDate !== null) return 1;
  if (leftDate !== null && rightDate === null) return -1;
  if (leftDate !== null && rightDate !== null && leftDate !== rightDate) return rightDate - leftDate;

  const leftSequence = sequenceValue(left);
  const rightSequence = sequenceValue(right);
  if (leftSequence !== rightSequence) {
    if (!Number.isFinite(leftSequence)) return 1;
    if (!Number.isFinite(rightSequence)) return -1;
    return rightSequence - leftSequence;
  }
  const leftId = String(left?.id ?? "");
  const rightId = String(right?.id ?? "");
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

/** Return published, superseded, and recorded versions for a family in explicit date order. */
export function getBatchVersions(state, familyId) {
  if (!Array.isArray(state?.versions)) return [];
  return state.versions
    .filter((version) => version?.familyId === familyId && SELECTABLE_STATUSES.has(version.status) &&
      typeof version.label === "string" && version.label.trim() !== "" && version.label.trim().toLocaleUpperCase() !== "VENTUS")
    .slice()
    .sort(compareVersions);
}

function uniqueNormalizedOption(value, normalize) {
  const values = Array.isArray(value) ? value : [value];
  const normalized = [...new Set(values.map((item) => normalize(item)).filter(Boolean))];
  return normalized.length === 1 ? normalized[0] : "";
}

function normalizeBatchStage(value) {
  const values = Array.isArray(value) ? value : [value];
  const normalized = [...new Set(values.map((item) => {
    if (typeof item !== "string") return "";
    const sourceLabel = item.trim().toLocaleLowerCase();
    if (["iqc来料 iqc incoming", "iqc incoming", "iqc incoming inspection"].includes(sourceLabel)) return "IQC";
    if (["oqc成品 oqc outgoing", "oqc outgoing", "oqc outgoing inspection"].includes(sourceLabel)) return "OQC";
    return normalizeStage(item);
  }).filter(Boolean))];
  return normalized.length === 1 ? normalized[0] : "";
}

function normalizeSourceStage(value) {
  return normalizeBatchStage(value);
}

function modelMap(version) {
  const source = version?.source;
  const productField = source?.productFieldMapping?.fieldLabel;
  const mapping = new Map();
  if (!Array.isArray(source?.familyProductFacts) || typeof productField !== "string") return mapping;
  for (const product of source.familyProductFacts) {
    const id = product?.sourceRecordId;
    const value = product?.fieldValues?.[productField];
    if (typeof id === "string" && typeof value === "string" && value.trim()) mapping.set(id, value.trim());
  }
  return mapping;
}

function parseHistoryKey(value) {
  if (typeof value !== "string") return "";
  return /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*(?:·|$)/u.exec(value)?.[1] ?? "";
}

function parseExplicitPercentage(value) {
  if (typeof value !== "string") return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(value);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
}

function rawString(value) {
  return typeof value === "string" ? value : "";
}

function sourceImportant(rawRecord) {
  for (const field of IMPORTANT_FIELDS) {
    const value = rawRecord?.[field];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLocaleLowerCase();
      if (["true", "yes", "是", "重要", "重点"].includes(normalized)) return true;
      if (["false", "no", "否", "普通", "不重要"].includes(normalized)) return false;
    }
  }
  return false;
}

function safeProcedureUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function makeDiagnostic(itemId, code, message, item = null) {
  return {
    itemId: typeof itemId === "string" ? itemId : null,
    code,
    message,
    factory: item?.factory || "",
    stage: item?.stage || "",
    models: Array.isArray(item?.models) ? [...item.models] : [],
  };
}

function projectRecordedVersion(version) {
  const items = [];
  const diagnostics = [];
  const rows = Array.isArray(version?.sourceRows) ? version.sourceRows : [];
  if (rows.length === 0) {
    diagnostics.push(makeDiagnostic(null, "no-linked-items", "This version has no linked inspection items. Complete its inspection standards before creating a batch."));
    return { items, diagnostics };
  }

  const products = modelMap(version);
  for (const row of rows) {
    const raw = row?.rawRecord && typeof row.rawRecord === "object" ? row.rawRecord : {};
    const code = parseHistoryKey(raw[SOURCE_FIELDS.historyCode]);
    const applicableProductIds = Array.isArray(row?.applicableProductIds) ? row.applicableProductIds : [];
    const modelIds = applicableProductIds.filter((id) => typeof id === "string");
    const models = [...new Set(modelIds.map((id) => products.get(id)).filter(Boolean))];
    const factory = uniqueNormalizedOption(raw[SOURCE_FIELDS.factory], normalizeFactory);
    const stage = normalizeSourceStage(raw[SOURCE_FIELDS.stage]);
    const title = rawString(raw[SOURCE_FIELDS.title]);
    const specification = rawString(raw[SOURCE_FIELDS.criteria]);
    const samplingPercent = parseExplicitPercentage(raw[SOURCE_FIELDS.samplingRatio]);
    const no = raw[SOURCE_FIELDS.number];
    const item = {
      id: typeof row?.sourceRecordId === "string" ? row.sourceRecordId : "",
      key: code,
      no: Number.isSafeInteger(no) && no > 0 ? no : null,
      title,
      titleZh: "",
      specification,
      specificationZh: "",
      devices: rawString(raw[SOURCE_FIELDS.equipment]),
      factory,
      stage,
      models,
      samplingPercent,
      recordingRule: rawString(raw[SOURCE_FIELDS.recordingRatio]),
      important: sourceImportant(raw),
      timeSeconds: null,
      procedureUrl: safeProcedureUrl(raw[SOURCE_FIELDS.procedureUrl]),
    };
    items.push(item);

    if (!code) diagnostics.push(makeDiagnostic(item.id, "missing-history-code", "An inspection item is missing its stable history code. Add the code before using this version.", item));
    if (item.no === null) diagnostics.push(makeDiagnostic(item.id, "invalid-item-number", "An inspection item is missing a positive item number. Add its number before using this version.", item));
    if (!title.trim()) diagnostics.push(makeDiagnostic(item.id, "missing-title", "An inspection item is missing its title. Add the title before using this version.", item));
    if (!specification.trim()) diagnostics.push(makeDiagnostic(item.id, "missing-criteria", "An inspection item is missing its criteria. Add the criteria before using this version.", item));
    if (!factory) diagnostics.push(makeDiagnostic(item.id, "missing-factory", "An inspection item has no single recognized factory. Complete its factory before using this version.", item));
    if (!stage) diagnostics.push(makeDiagnostic(item.id, "missing-stage", "An inspection item has no single recognized inspection stage. Complete its stage before using this version.", item));
    if (!models.length || modelIds.some((id) => !products.has(id)) || new Set(modelIds).size !== modelIds.length) {
      diagnostics.push(makeDiagnostic(item.id, "missing-model-mapping", "An inspection item has incomplete product-model applicability. Complete its applicable product mapping before using this version.", item));
    }
    if (samplingPercent === null) diagnostics.push(makeDiagnostic(item.id, "missing-sampling-percentage", "An inspection item has no explicit valid sampling percentage. Add a percentage such as 10% before using this version.", item));
  }
  return { items, diagnostics };
}

/** Return a defensive projection of the full standard set without changing its source record. */
export function getBatchVersionProjection(version) {
  if (version?.status === "recorded") return projectRecordedVersion(version);
  return {
    items: Array.isArray(version?.items) ? structuredClone(version.items) : [],
    diagnostics: [],
  };
}

export function getBatchVersionItems(version) {
  return getBatchVersionProjection(version).items;
}

/** Check a selected version against one batch's factory, stage, and model. */
export function getBatchVersionReadiness(version, factoryInput, stageInput, model) {
  const { items, diagnostics: allDiagnostics } = getBatchVersionProjection(version);
  const factory = normalizeFactory(factoryInput);
  const stage = normalizeBatchStage(stageInput);
  const modelName = typeof model === "string" ? model.trim() : "";
  const applicableItems = items.filter((item) => item.factory === factory && item.stage === stage &&
    (!Array.isArray(item.models) || item.models.length === 0 || item.models.includes(modelName)));
  const diagnostics = allDiagnostics.filter((diagnostic) => {
    if (diagnostic.code === "no-linked-items") return true;
    if (!diagnostic.factory || !diagnostic.stage) return true;
    if (diagnostic.factory !== factory || diagnostic.stage !== stage) return false;
    return diagnostic.models.length === 0 || diagnostic.models.includes(modelName);
  });
  if (items.length > 0 && applicableItems.length === 0) {
    diagnostics.push(makeDiagnostic(null, "no-applicable-items", `No ${factory || "selected factory"} ${stage || "selected stage"} inspection items apply to ${modelName || "the selected model"} in this version.`));
  }
  const ready = applicableItems.length > 0 && diagnostics.length === 0;
  const versionLabel = typeof version?.label === "string" && version.label.trim() ? version.label.trim() : "the selected version";
  const message = ready ? "" : diagnostics.length
    ? `Version ${versionLabel} cannot be used for ${factory || "the selected factory"} ${stage || "the selected stage"}${modelName ? ` ${modelName}` : ""}: ${diagnostics[0].message}`
    : `Version ${versionLabel} has no applicable inspection items for ${factory || "the selected factory"} ${stage || "the selected stage"}${modelName ? ` ${modelName}` : ""}. Complete its inspection standards before creating this batch.`;
  return { ready, items: applicableItems, diagnostics, message };
}
