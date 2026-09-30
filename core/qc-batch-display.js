const MODELS = new Set(["S11", "S12", "S13", "S14", "S15"]);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalized(value) {
  return text(value).normalize("NFKC").toLowerCase();
}

function modelCode(value) {
  const candidate = text(value).toUpperCase();
  return MODELS.has(candidate) ? candidate : null;
}

function familyCode(value) {
  const candidate = text(value).toUpperCase().replace(/[–—]/g, "-").replace(/\s+/g, "");
  if (["S11-S14", "S11S14"].includes(candidate)) return "S11-S14";
  if (candidate === "S15") return "S15";
  return null;
}

function sourceInspection(state, batch) {
  return (Array.isArray(state?.history?.inspections) ? state.history.inspections : [])
    .find((inspection) => inspection.id === batch.historyInspectionId) ?? null;
}

function historicalProduct(batch, inspection, state) {
  const explicitModel = modelCode(inspection?.model) || modelCode(batch.model);
  if (explicitModel) return explicitModel;

  const family = (Array.isArray(state?.families) ? state.families : [])
    .find((entry) => entry.id === batch.familyId || entry.id === inspection?.familyId);
  const knownFamily = familyCode(batch.familyId) || familyCode(inspection?.familyId) || familyCode(family?.name) ||
    familyCode(inspection?.productLabel) || familyCode(batch.productLabel);
  if (knownFamily) return knownFamily;

  return text(inspection?.model) || text(batch.model) || text(inspection?.productLabel) || text(batch.productLabel) || "Unknown product";
}

function compactDate(value) {
  const match = /^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(text(value));
  if (!match) return "Unknown date";
  const [, year, month, day] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month) || date.getUTCDate() !== Number(day)) {
    return "Unknown date";
  }
  return `${year}${month}${day}`;
}

function historicalBaseName(batch, state) {
  const inspection = sourceInspection(state, batch);
  // Only this explicitly named source field is an original batch number; raw transcription and filenames are provenance.
  const originalBatchNumber = text(inspection?.originalBatchNumber);
  if (originalBatchNumber) return originalBatchNumber;

  let product = historicalProduct(batch, inspection, state);
  const color = text(inspection?.color) || text(batch.color);
  const colorKey = color.toLowerCase().replace(/[\s_-]/g, "");
  if (color && !["red", "normalred"].includes(colorKey) && !product.toLowerCase().includes(color.toLowerCase())) {
    product = `${product} ${color}`;
  }
  const date = compactDate(text(batch.date) || inspection?.date);
  const factory = text(batch.factory) || text(inspection?.factory) || "Unknown factory";
  const stage = text(batch.stage) || text(inspection?.stage) || "Unknown stage";
  return `${product}-${date}-${factory}-${stage}`;
}

function compareIds(left, right) {
  const leftId = String(left.batch.id ?? "");
  const rightId = String(right.batch.id ?? "");
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

/** Resolve staff-facing batch names without changing persisted batch numbers or identities. */
export function resolveBatchDisplayNumbers(state) {
  const batches = Array.isArray(state?.batches) ? state.batches : [];
  const result = new Map();
  const historical = [];
  const operationalNames = new Set();

  for (const batch of batches) {
    if (batch.kind === "historical") {
      historical.push({ batch, base: historicalBaseName(batch, state) });
    } else {
      const number = typeof batch.number === "string" ? batch.number : "";
      result.set(batch.id, number || "Unknown batch");
      if (number) operationalNames.add(normalized(number));
    }
  }

  const groups = new Map();
  for (const entry of historical) {
    const key = normalized(entry.base);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  const usedNames = new Set(operationalNames);
  const colliding = [];
  for (const entries of groups.values()) {
    if (entries.length > 1 || operationalNames.has(normalized(entries[0].base))) {
      entries.sort(compareIds);
      colliding.push(...entries.map((entry, index) => ({ ...entry, ordinal: index + 1 })));
      continue;
    }
    result.set(entries[0].batch.id, entries[0].base);
    usedNames.add(normalized(entries[0].base));
  }

  colliding.sort(compareIds);
  for (const entry of colliding) {
    let ordinal = entry.ordinal;
    let displayNumber;
    do {
      displayNumber = `${entry.base}-${String(ordinal).padStart(2, "0")}`;
      ordinal += 1;
    } while (usedNames.has(normalized(displayNumber)));
    result.set(entry.batch.id, displayNumber);
    usedNames.add(normalized(displayNumber));
  }

  return result;
}
