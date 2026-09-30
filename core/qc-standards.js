import {
  fail,
  factoryKey,
  makeId,
  normalizeFactory,
  normalizeStage,
  requireArray,
  requireBoolean,
  requireDate,
  requirePositiveInteger,
  requireRecord,
  requireString,
} from "./qc-domain.js";

const SOURCE_REFERENCE_MARKER = "masterqc-ap-oqc-reference-25.10.29";
const SOURCE_VERSION_IDS = {
  "s11-s14": "20000000-0000-4000-8000-000000251029",
  s15: "20000000-0000-4000-8000-00000025102a",
};

function familyById(state, familyId) {
  const family = state.families.find((candidate) => candidate.id === familyId);
  if (!family) fail("Choose an available inspection family.");
  return family;
}

function normalizeProcedureUrl(value) {
  const url = requireString(value ?? "", "Procedure URL", { maxLength: 2000, allowBlank: true });
  if (!url) return "";
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail("Procedure URL must be an absolute HTTP or HTTPS link.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) fail("Procedure URL must use HTTP or HTTPS.");
  return parsed.toString();
}

export function normalizeStandardItem(input, family, idFactory, previousItems = []) {
  const item = requireRecord(input, "Standard item");
  let id = item.id;
  if (id == null || String(id).trim() === "") {
    const existing = previousItems.find((candidate) =>
      candidate.key === String(item.key ?? "").trim() &&
      candidate.factory === normalizeFactory(item.factory) &&
      candidate.stage === normalizeStage(item.stage) &&
      candidate.no === item.no &&
      JSON.stringify(candidate.models) === JSON.stringify(Array.isArray(item.models) ? [...item.models].sort() : []));
    id = existing?.id ?? makeId(idFactory);
  } else {
    id = requireString(String(id), "Standard item ID", { maxLength: 120 });
  }

  const modelsInput = item.models ?? [];
  requireArray(modelsInput, "Applicable models");
  const models = modelsInput.map((model) => requireString(model, "Applicable model", { maxLength: 30 }));
  if (new Set(models).size !== models.length) fail("Applicable models must not contain duplicates.");
  if (models.some((model) => !family.models.includes(model))) fail(`Applicable models must belong to the ${family.name} family.`);

  const factory = normalizeFactory(item.factory);
  if (!factory) fail("Factory is required and must be at most 100 characters.");
  const stage = normalizeStage(item.stage);
  if (!stage) fail("Inspection stage must be IQC or OQC.");
  if (factory === "AP" && stage === "IQC") fail("AP inspections are OQC only; AP IQC standards cannot be saved.");

  const samplingPercent = item.samplingPercent;
  if (typeof samplingPercent !== "number" || !Number.isFinite(samplingPercent) || samplingPercent < 0 || samplingPercent > 100) {
    fail("Inspection sampling percentage must be a number from 0 to 100.");
  }
  const timeSeconds = item.timeSeconds ?? null;
  if (timeSeconds !== null && (!Number.isSafeInteger(timeSeconds) || timeSeconds < 0)) {
    fail("Inspection time must be a whole number of zero or more, or blank.");
  }

  return {
    id,
    key: requireString(item.key, "Stable history key", { maxLength: 120 }),
    no: requirePositiveInteger(item.no, "Inspection item number"),
    title: requireString(item.title, "Inspection title", { maxLength: 300 }),
    titleZh: requireString(item.titleZh ?? "", "Chinese inspection title", { maxLength: 300, allowBlank: true }),
    specification: requireString(item.specification, "Inspection specification", { maxLength: 5000 }),
    specificationZh: requireString(item.specificationZh ?? "", "Chinese inspection specification", { maxLength: 5000, allowBlank: true }),
    devices: requireString(item.devices ?? "", "Inspection equipment", { maxLength: 1000, allowBlank: true }),
    factory,
    stage,
    models,
    samplingPercent,
    recordingRule: requireString(item.recordingRule ?? "", "Recording rule", { maxLength: 500, allowBlank: true }),
    important: requireBoolean(item.important ?? false, "Important check"),
    timeSeconds,
    procedureUrl: normalizeProcedureUrl(item.procedureUrl ?? ""),
  };
}

export function normalizeStandardItems(itemsInput, family, idFactory, previousItems = []) {
  const items = requireArray(itemsInput, "Standard items");
  if (items.length > 500) fail("A version cannot contain more than 500 standard items.");
  const normalized = items.map((item) => normalizeStandardItem(item, family, idFactory, previousItems));
  const ids = normalized.map((item) => item.id);
  if (new Set(ids).size !== ids.length) fail("Standard item IDs must be unique within a version.");

  for (const model of family.models) {
    const applicable = normalized.filter((item) => item.models.length === 0 || item.models.includes(model));
    const seenNos = new Set();
    const seenKeys = new Set();
    for (const item of applicable) {
      const context = `${factoryKey(item.factory)}|${item.stage}|${model}`;
      const noKey = `${context}|${item.no}`;
      const itemKey = `${context}|${item.key}`;
      if (seenNos.has(noKey) || seenKeys.has(itemKey)) {
        fail(`Standard items have overlapping applicability for ${model}, ${item.factory} ${item.stage}; item numbers and history keys must be unique in each applicable set.`);
      }
      seenNos.add(noKey);
      seenKeys.add(itemKey);
    }
  }
  return normalized;
}

function nextSequence(state, familyId) {
  return Math.max(0, ...state.versions.filter((item) => item.familyId === familyId && item.status !== "recorded").map((item) => item.sequence)) + 1;
}

function validateVersionDetails(state, family, data, exceptId = null) {
  const label = requireString(data.label, "Version label", { maxLength: 160 });
  const sequence = requirePositiveInteger(data.sequence, "Version sequence");
  if (state.versions.some((version) => version.familyId === family.id && version.sequence === sequence && version.id !== exceptId)) {
    fail("Version sequence must be unique within its inspection family.");
  }
  return {
    label,
    sequence,
    effectiveDate: requireDate(data.effectiveDate, "Effective date"),
    notes: requireString(data.notes ?? "", "Version notes", { maxLength: 5000, allowBlank: true }),
  };
}

export function createVersion(state, data, context) {
  const family = familyById(state, data.familyId);
  const details = validateVersionDetails(state, family, data);
  const items = normalizeStandardItems(data.items, family, context.idFactory);
  const id = makeId(context.idFactory);
  state.versions.push({
    id,
    familyId: family.id,
    ...details,
    status: "draft",
    items,
    createdAt: context.now(),
    publishedAt: null,
  });
  return { entityId: id, action: "createVersion", summary: `Created draft version ${details.label}.` };
}

export function saveVersion(state, data, context) {
  const id = requireString(data.id, "Version ID", { maxLength: 120 });
  const version = state.versions.find((candidate) => candidate.id === id);
  if (!version) fail("That design version is no longer available.");
  if (version.status === "recorded") fail("Archived versions are immutable and cannot be edited.");
  if (version.status !== "draft") fail("Published design versions are immutable. Clone this version to make changes.");
  const family = familyById(state, version.familyId);
  const details = validateVersionDetails(state, family, data, id);
  const items = normalizeStandardItems(data.items, family, context.idFactory, version.items);
  Object.assign(version, details, { items });
  return { entityId: id, action: "saveVersion", summary: `Updated draft version ${details.label}.` };
}

export function cloneVersion(state, data, context) {
  const id = requireString(data.id, "Version ID", { maxLength: 120 });
  const source = state.versions.find((candidate) => candidate.id === id);
  if (!source) fail("Choose an available design version to clone.");
  if (source.status === "recorded") fail("Archived versions cannot be cloned into operational drafts.");
  const family = familyById(state, source.familyId);
  const details = validateVersionDetails(state, family, {
    label: data.label,
    sequence: data.sequence,
    effectiveDate: data.effectiveDate,
    notes: source.notes,
  });
  const cloneId = makeId(context.idFactory);
  state.versions.push({
    ...structuredClone(source),
    id: cloneId,
    ...details,
    status: "draft",
    createdAt: context.now(),
    publishedAt: null,
  });
  return { entityId: cloneId, action: "cloneVersion", summary: `Cloned ${source.label} as draft ${details.label}.` };
}

export function publishVersion(state, data, context) {
  const id = requireString(data.id, "Version ID", { maxLength: 120 });
  const version = state.versions.find((candidate) => candidate.id === id);
  if (!version) fail("That design version is no longer available.");
  if (version.status === "recorded") fail("Archived versions cannot be published for new operational batches.");
  if (version.status === "published") {
    return { entityId: id, changed: false, action: "publishVersion", summary: `Version ${version.label} was already published.` };
  }
  const family = familyById(state, version.familyId);
  version.items = normalizeStandardItems(version.items, family, context.idFactory, version.items);
  const uncoveredModels = family.models.filter((model) => !version.items.some((item) => item.models.length === 0 || item.models.includes(model)));
  if (uncoveredModels.length) fail(`Add at least one applicable inspection item for each family model before publication. Missing: ${uncoveredModels.join(", ")}.`);
  version.status = "published";
  version.publishedAt = context.now();
  return { entityId: id, action: "publishVersion", summary: `Published version ${version.label}.` };
}

function sourceItem({ id, key, no, title, titleZh, specification, specificationZh, devices, devicesZh, models, samplingPercent, recordingRule, timeSeconds }) {
  return {
    id,
    key,
    no,
    title,
    titleZh,
    specification,
    specificationZh,
    devices: devicesZh ? `${devices} / ${devicesZh}` : devices,
    factory: "AP",
    stage: "OQC",
    models,
    samplingPercent,
    recordingRule,
    important: true,
    timeSeconds,
    procedureUrl: "",
  };
}

function apReferenceItems(familyId) {
  if (familyId === "s11-s14") {
    return [
      sourceItem({
        id: "21000000-0000-4000-8000-000000000111", key: "air-pump", no: 1,
        title: "Air Pump Test", titleZh: "气泵测试",
        specification: "Power on to check whether the air pump and EVAP knob are working properly.",
        specificationZh: "通电检查气泵、气压调节钮是否正常工作",
        devices: "DC power supply", devicesZh: "直流电源", models: ["S11", "S12", "S13", "S14"], samplingPercent: 10, recordingRule: "0%", timeSeconds: 15,
      }),
      sourceItem({
        id: "21000000-0000-4000-8000-000000000112", key: "power-test", no: 2,
        title: "Power Test", titleZh: "功率测试",
        specification: "At 12.7V, check at 3 seconds. Passing power consumption: 32.3–34.0W.",
        specificationZh: "12.7V电源通电测试，开机3秒功耗在32.3~34.0W范围内则为合格",
        devices: "DC power supply", devicesZh: "直流电源", models: ["S11", "S13"], samplingPercent: 10, recordingRule: "50% + all failed units", timeSeconds: 80,
      }),
      sourceItem({
        id: "21000000-0000-4000-8000-000000000113", key: "power-test", no: 2,
        title: "Power Test", titleZh: "功率测试",
        specification: "At 12.7V, check at 3 seconds. Passing power consumption: 30.1–31.8W.",
        specificationZh: "12.7V电源通电测试，开机3秒功耗在30.1~31.8W范围内则为合格",
        devices: "DC power supply", devicesZh: "直流电源", models: ["S12", "S14"], samplingPercent: 10, recordingRule: "50% + all failed units", timeSeconds: 80,
      }),
      sourceItem({
        id: "21000000-0000-4000-8000-000000000114", key: "leak-test", no: 3,
        title: "Smoke Machine Leak Test", titleZh: "发烟器漏气测试",
        specification: "12 PSI pressure decay test to check seal: after 30 seconds, pressure must remain at least 11.8 PSI.",
        specificationZh: "S11–S14：12PSI气压衰减测试，30秒后气压不能低于11.8PSI。",
        devices: "Differential pressure gauge / air pump", devicesZh: "差压计/气泵", models: ["S11", "S12", "S13", "S14"], samplingPercent: 10, recordingRule: "50% + all failed units", timeSeconds: 80,
      }),
      sourceItem({
        id: "21000000-0000-4000-8000-000000000115", key: "final-packaging", no: 4,
        title: "Final Packaging", titleZh: "最终包装检查",
        specification: "EVAP knob pointing to EVAP; check accessory placement and support sticker.",
        specificationZh: "旋钮位置指向EVAP，物品放置位置，贴纸",
        devices: "Visual inspection", devicesZh: "目测", models: ["S11", "S12", "S13", "S14"], samplingPercent: 10, recordingRule: "0%", timeSeconds: 8,
      }),
    ];
  }
  return [
    sourceItem({
      id: "22000000-0000-4000-8000-000000000121", key: "air-pump", no: 1,
      title: "Air Pump Test", titleZh: "气泵测试",
      specification: "Power on to check whether the air pump and EVAP knob are working properly.",
      specificationZh: "通电检查气泵、气压调节钮是否正常工作",
      devices: "DC power supply", devicesZh: "直流电源", models: ["S15"], samplingPercent: 10, recordingRule: "0%", timeSeconds: 15,
    }),
    sourceItem({
      id: "22000000-0000-4000-8000-000000000122", key: "power-test", no: 2,
      title: "Power Test", titleZh: "功率测试",
      specification: "At 12.7V, check at 3 seconds. Passing power consumption: 30.1–31.8W.",
      specificationZh: "12.7V电源通电测试，开机3秒功耗在30.1~31.8W范围内（S15）则为合格",
      devices: "DC power supply", devicesZh: "直流电源", models: ["S15"], samplingPercent: 10, recordingRule: "50% + all failed units", timeSeconds: 80,
    }),
    sourceItem({
      id: "22000000-0000-4000-8000-000000000123", key: "leak-test", no: 3,
      title: "Smoke Machine Leak Test", titleZh: "发烟器漏气测试",
      specification: "20 PSI pressure decay test to check seal: after 30 seconds, pressure must remain at least 19.8 PSI.",
      specificationZh: "S15：20PSI气压衰减测试，30秒后气压不能低于19.8PSI。",
      devices: "Differential pressure gauge / air pump", devicesZh: "差压计/气泵", models: ["S15"], samplingPercent: 10, recordingRule: "50% + all failed units", timeSeconds: 80,
    }),
    sourceItem({
      id: "22000000-0000-4000-8000-000000000124", key: "final-packaging", no: 4,
      title: "Final Packaging", titleZh: "最终包装检查",
      specification: "EVAP knob pointing to EVAP; check accessory placement and support sticker.",
      specificationZh: "旋钮位置指向EVAP，物品放置位置，贴纸",
      devices: "Visual inspection", devicesZh: "目测", models: ["S15"], samplingPercent: 100, recordingRule: "0%", timeSeconds: 8,
    }),
  ];
}

export function installAPReferences(state, _data, context) {
  const existingById = new Map(state.versions.map((version) => [version.id, version]));
  const installedIds = [];
  let added = 0;
  for (const family of state.families) {
    const id = SOURCE_VERSION_IDS[family.id];
    const existing = existingById.get(id);
    if (existing) {
      if (existing.familyId !== family.id) fail("A reserved AP source-reference ID is already used by another inspection family.");
      installedIds.push(existing.id);
      continue;
    }
    const sequence = nextSequence(state, family.id);
    const label = `AP OQC Source Reference 25.10.29 — ${family.name}`;
    const version = {
      id,
      familyId: family.id,
      label,
      sequence,
      effectiveDate: "2025-10-29",
      status: "draft",
      notes: `${SOURCE_REFERENCE_MARKER}. Source: AP OQC reference PDF, page 3, header revision 25.10.29. Review these reference rows before publication; this sequence does not assume the source is latest.`,
      items: normalizeStandardItems(apReferenceItems(family.id), family, context.idFactory),
      createdAt: context.now(),
      publishedAt: null,
    };
    state.versions.push(version);
    installedIds.push(id);
    added += 1;
  }
  if (!added) return { entityId: installedIds[0] || "", changed: false, action: "installAPReferences", summary: "AP OQC source-reference drafts were already installed." };
  return { entityId: installedIds[0], action: "installAPReferences", summary: `Installed ${added} AP OQC source-reference draft version${added === 1 ? "" : "s"}.` };
}

export function selectApplicableItems(version, factory, stage, model) {
  return version.items
    .filter((item) => factoryKey(item.factory) === factoryKey(factory) && item.stage === normalizeStage(stage) && (item.models.length === 0 || item.models.includes(model)))
    .sort((left, right) => left.no - right.no || left.id.localeCompare(right.id));
}

export function latestPublishedVersion(state, familyId) {
  return state.versions
    .filter((version) => version.familyId === familyId && version.status === "published")
    .sort((left, right) => right.sequence - left.sequence)[0] || null;
}
