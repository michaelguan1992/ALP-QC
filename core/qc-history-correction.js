import { addAudit, clone, deepEqual } from "./qc-domain.js";
import { createHistoricalBatch } from "./qc-historical-batches.js";

/**
 * Audited correction of original PDF history records imported before the
 * extractor fixes of 2026-10-16. Each rule applies only when the stored value
 * still equals the known incorrect value; anything else is skipped and counted.
 * The same rules normalize incoming JSON backups and history packages so that
 * older files with the incorrect values restore to the corrected records.
 */
export const HISTORY_CORRECTION_ACTION = "correctHistoricalPdfRecords";
export const HISTORY_CORRECTION_ENTITY_ID = "historical-pdf-record-correction";

// Absolute paths, inventory keys, and extractor identifiers depended on the machine or the run.
const SOURCE_MACHINE_FIELDS = ["path", "inventoryKey", "extractorSourceId"];
const INSPECTION_EXTRACTOR_FIELDS = ["extractorInspectionId"];
const ROW_EXTRACTOR_FIELDS = ["extractorRowId"];
// Staff-editable values on historical batch rows; projection comparisons ignore them, as the batch materializer does.
const BATCH_EDITABLE_ROW_FIELDS = ["inspectedQty", "defectiveQty", "actualTimeSeconds", "attachmentIds"];
const BATCH_PRESERVED_FIELDS = ["createdAt", "attachmentIds"];
const S15_EXPLICIT_BASIS = "special-notes-explicit-product-quantity";
const S15_COLOR_NAMES = ["red", "yellow"];
const S15_COLOR_LABELS = { red: "红色", yellow: "黄色" };
const MISLABELLED_CONTEXTS = ["AP", "UI"];

// The S1 self-made form printed rows 5 and 8 with stroke-only cell borders that were read as black fills.
// The rendered page shows these rows are not highlighted, so the correct fill is "none" and importance stays false.
const FILL_CORRECTIONS = [
  { sourceSha256: "e87f681e6b2b63735142f1c6ad9e98182dc651bb21ed9bb144ae906281a427d7", page: 1, tableRowIndex: 8, from: "0.000,0.000,0.000", to: "none" },
  { sourceSha256: "e87f681e6b2b63735142f1c6ad9e98182dc651bb21ed9bb144ae906281a427d7", page: 1, tableRowIndex: 11, from: "0.000,0.000,0.000", to: "none" },
];

const WORD_START = "(?<![\\p{L}\\p{N}_])";
const WORD_END = "(?![\\p{L}\\p{N}_])";
const QUANTITY = "(?<quantity>\\p{Nd}[\\p{Nd},]*)\\s*(?:pcs|件|台)";

// Mirrors scripts/pdf-import-s15/extract_s15.py. Python's \b and \d follow Unicode word and digit classes, so the lookarounds
// and \p{Nd} keep the two readings identical; tests/fixtures/s15-color-cases.json is the shared parity check.
function colorQuantityPatterns(name, chinese) {
  return [
    new RegExp(`${WORD_START}s15\\s*[-－–]\\s*${name}\\s*[:：]\\s*${QUANTITY}${WORD_END}`, "giu"),
    new RegExp(`${WORD_START}${name}\\s*[:：]\\s*${QUANTITY}${WORD_END}`, "giu"),
    new RegExp(`(?:剩余|remaining)\\s*${name}\\s*[:：]?\\s*${QUANTITY}${WORD_END}`, "giu"),
    new RegExp(`${QUANTITY}\\s*${chinese}`, "giu"),
    new RegExp(`${chinese}\\s*[:：]?\\s*${QUANTITY}`, "giu"),
  ];
}

const COLOR_QUANTITY_PATTERNS = Object.fromEntries(
  S15_COLOR_NAMES.map((name) => [name, colorQuantityPatterns(name, S15_COLOR_LABELS[name])]),
);
const COLOR_LABEL_PATTERNS = Object.fromEntries(
  S15_COLOR_NAMES.map((name) => [name, new RegExp(`${WORD_START}s15\\s*[-－–]\\s*${name}${WORD_END}`, "iu")]),
);

function flattened(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function statedColorQuantities(normalizedNotes) {
  const found = new Map();
  for (const name of S15_COLOR_NAMES) {
    let mentioned = COLOR_LABEL_PATTERNS[name].test(normalizedNotes);
    const quantities = new Set();
    for (const pattern of COLOR_QUANTITY_PATTERNS[name]) {
      for (const match of normalizedNotes.matchAll(pattern)) {
        mentioned = true;
        quantities.add(Number(match.groups.quantity.replace(/,/gu, "").normalize("NFKC")));
      }
    }
    if (mentioned) found.set(name, [...quantities].sort((left, right) => left - right));
  }
  return found;
}

/** Derive the S15 color from printed notes, exactly as the extractor does. Returns { color, colorBasis, anomaly }. */
export function deriveS15Color(notes, batchQuantity) {
  if (!notes) return { color: null, colorBasis: null, anomaly: null };
  const found = statedColorQuantities(flattened(notes));
  if (found.size > 1) return { color: null, colorBasis: "special-notes-mixed-color-quantities", anomaly: null };
  if (found.size === 0) return { color: null, colorBasis: null, anomaly: null };
  const [[color, quantities]] = [...found.entries()];
  if (quantities.length === 1 && quantities[0] === batchQuantity) {
    return { color, colorBasis: S15_EXPLICIT_BASIS, anomaly: null };
  }
  if (quantities.length > 0) {
    return {
      color: null,
      colorBasis: "special-notes-partial-color-quantity",
      anomaly: {
        code: "partial-color-allocation",
        message: "Special Notes state a color quantity that is not the whole page batch quantity; the color remains null and all source notes are preserved.",
        batchQuantity,
        statedColorQuantities: quantities.map((quantity) => ({ color, quantity })),
      },
    };
  }
  return {
    color: null,
    colorBasis: "special-notes-color-quantity-not-stated",
    anomaly: {
      code: "color-quantity-not-stated",
      message: "Special Notes name a color without a quantity; the batch color remains null because the whole-batch color cannot be established.",
      batchQuantity,
      statedColorQuantities: [],
    },
  };
}

function isBareRate(raw) {
  return typeof raw === "string" && /^\s*[-+]?\d+(?:\.\d+)?\s*$/u.test(raw);
}

function emptyCounts() {
  return {
    sourcesUpdated: 0,
    sourceFieldsRemoved: 0,
    inspectionFieldsRemoved: 0,
    rowFieldsRemoved: 0,
    printedRatesRestored: 0,
    comparisonRatesRestored: 0,
    colorCorrections: 0,
    fillCorrections: 0,
    anomaliesRemoved: 0,
    anomaliesAdded: 0,
    batchesUpdated: 0,
    skipped: {},
  };
}

function skip(counts, reason) {
  counts.skipped[reason] = (counts.skipped[reason] ?? 0) + 1;
}

function sameProjection(batch, expected) {
  return deepEqual(projectionComparable(batch), projectionComparable(expected));
}

// Same comparison as the batch materializer: staff-editable values and generated metadata are excluded.
function projectionComparable(batch) {
  const copy = clone(batch);
  delete copy.createdAt;
  delete copy.attachmentIds;
  for (const row of copy.rows ?? []) {
    for (const field of BATCH_EDITABLE_ROW_FIELDS) delete row[field];
  }
  return copy;
}

function projectedBatch(batch, expected) {
  const candidate = clone(batch);
  for (const key of Object.keys(candidate)) {
    if (!BATCH_PRESERVED_FIELDS.includes(key)) delete candidate[key];
  }
  for (const [key, value] of Object.entries(expected)) {
    if (!BATCH_PRESERVED_FIELDS.includes(key)) candidate[key] = clone(value);
  }
  const currentRows = new Map((batch.rows ?? []).map((row) => [row.id, row]));
  candidate.rows = (expected.rows ?? []).map((row) => {
    const next = clone(row);
    const current = currentRows.get(row.id);
    if (current) {
      for (const field of BATCH_EDITABLE_ROW_FIELDS) {
        if (Object.hasOwn(current, field)) next[field] = clone(current[field]);
      }
    }
    return next;
  });
  return candidate;
}

function fillCorrectionFor(source, inspection, row) {
  const tableRowIndex = row.raw?.tableRowIndex;
  if (!source || !Number.isSafeInteger(tableRowIndex)) return null;
  return FILL_CORRECTIONS.find((item) => item.sourceSha256 === String(source.sha256).toLowerCase() &&
    item.page === inspection.page && item.tableRowIndex === tableRowIndex) ?? null;
}

/** Correct one inspection in place. Returns what changed; the caller decides whether to keep it. */
function correctInspection(inspection, source, counts) {
  const outcome = { touched: false, packageAnomalies: [], skipped: [] };
  for (const field of INSPECTION_EXTRACTOR_FIELDS) {
    if (Object.hasOwn(inspection, field)) {
      delete inspection[field];
      counts.inspectionFieldsRemoved += 1;
      outcome.touched = true;
    }
  }
  for (const row of inspection.rows ?? []) {
    for (const field of ROW_EXTRACTOR_FIELDS) {
      if (Object.hasOwn(row, field)) {
        delete row[field];
        counts.rowFieldsRemoved += 1;
        outcome.touched = true;
      }
    }
    if (row.status === "missing-from-source") continue;
    if (row.sourceDefectiveRate === null && isBareRate(row.sourceDefectiveRateRaw)) {
      row.sourceDefectiveRate = Number(row.sourceDefectiveRateRaw.trim());
      counts.printedRatesRestored += 1;
      outcome.touched = true;
    }
    for (const comparison of row.historicalComparisons ?? []) {
      if (comparison.sourceDefectiveRate === null && isBareRate(comparison.sourceDefectiveRateRaw)) {
        comparison.sourceDefectiveRate = Number(comparison.sourceDefectiveRateRaw.trim());
        counts.comparisonRatesRestored += 1;
        outcome.touched = true;
      }
    }
    const fill = fillCorrectionFor(source, inspection, row);
    if (fill) {
      if (row.importantFillRgb === fill.from && row.important === false) {
        row.importantFillRgb = fill.to;
        counts.fillCorrections += 1;
        outcome.touched = true;
      } else if (row.importantFillRgb !== fill.to) {
        outcome.skipped.push("fill-differs-from-correction");
      }
    }
  }

  if (inspection.colorBasis === S15_EXPLICIT_BASIS && S15_COLOR_NAMES.includes(inspection.color)) {
    const derived = deriveS15Color(inspection.notes, inspection.batchQuantity);
    if (derived.color === null && derived.anomaly) {
      inspection.color = null;
      inspection.colorBasis = derived.colorBasis;
      inspection.anomalies = Array.isArray(inspection.anomalies) ? inspection.anomalies : [];
      if (!inspection.anomalies.some((item) => deepEqual(item, derived.anomaly))) inspection.anomalies.push(clone(derived.anomaly));
      outcome.packageAnomalies.push({ sourceId: inspection.sourceId, inspectionId: inspection.id, page: inspection.page, ...clone(derived.anomaly) });
      counts.colorCorrections += 1;
      outcome.touched = true;
    } else if (derived.color !== inspection.color) {
      outcome.skipped.push("color-differs-from-notes");
    }
  }
  return outcome;
}

function addUniqueAnomaly(anomalies, anomaly, counts) {
  if (anomalies.some((item) => deepEqual(item, anomaly))) return;
  anomalies.push(clone(anomaly));
  counts.anomaliesAdded += 1;
}

function withoutContext(anomaly) {
  const { context: _context, ...rest } = anomaly;
  return rest;
}

/** Remove an AP or UI scope label only when exactly one correctly labelled entry has the same content. */
function correctMislabelledAnomalies(anomalies, counts) {
  for (const anomaly of [...anomalies]) {
    if (!MISLABELLED_CONTEXTS.includes(anomaly?.context)) continue;
    const comparable = withoutContext(anomaly);
    const counterparts = anomalies.filter((candidate) => typeof candidate?.context === "string" &&
      candidate.context.startsWith(`${anomaly.context}|`) && deepEqual(withoutContext(candidate), comparable));
    if (counterparts.length === 1) {
      anomalies.splice(anomalies.indexOf(anomaly), 1);
      counts.anomaliesRemoved += 1;
    } else {
      skip(counts, counterparts.length > 1 ? "mislabelled-anomaly-has-several-counterparts" : "mislabelled-anomaly-has-no-counterpart");
    }
  }
}

/**
 * Apply the historical record corrections to target.history and, when present, target.batches.
 * The target must be a clone the caller owns: it is changed in place. Returns counts and whether anything changed.
 */
export function correctHistoricalRecords(target) {
  const counts = emptyCounts();
  const history = target?.history;
  if (!history || typeof history !== "object") return { changed: false, counts };
  const sources = Array.isArray(history.sources) ? history.sources : [];
  const inspections = Array.isArray(history.inspections) ? history.inspections : [];
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const historicalBatches = new Map((Array.isArray(target.batches) ? target.batches : [])
    .filter((batch) => batch?.kind === "historical")
    .map((batch) => [batch.historyInspectionId, batch]));

  for (const source of sources) {
    let removed = 0;
    for (const field of SOURCE_MACHINE_FIELDS) {
      if (Object.hasOwn(source, field)) {
        delete source[field];
        removed += 1;
      }
    }
    if (removed) {
      counts.sourceFieldsRemoved += removed;
      counts.sourcesUpdated += 1;
    }
  }

  for (let index = 0; index < inspections.length; index += 1) {
    const before = inspections[index];
    const source = sourcesById.get(before.sourceId);
    const after = clone(before);
    const local = emptyCounts();
    const outcome = correctInspection(after, source, local);
    for (const reason of outcome.skipped) skip(counts, reason);
    if (!outcome.touched) continue;

    const batch = historicalBatches.get(before.id);
    let rebuiltBatch = null;
    if (batch) {
      if (!source) {
        skip(counts, "historical-batch-source-missing");
        continue;
      }
      const expectedBefore = createHistoricalBatch(before, source, batch.createdAt);
      const expectedAfter = createHistoricalBatch(after, source, batch.createdAt);
      if (sameProjection(batch, expectedBefore)) {
        rebuiltBatch = projectedBatch(batch, expectedAfter);
        if (!sameProjection(rebuiltBatch, expectedAfter)) {
          skip(counts, "historical-batch-projection-mismatch");
          continue;
        }
      } else if (!sameProjection(batch, expectedAfter)) {
        skip(counts, "batch-differs-from-source-evidence");
        continue;
      }
    }

    // Accept the corrected inspection only together with its batch projection.
    inspections[index] = after;
    for (const field of Object.keys(local)) {
      if (typeof local[field] === "number") counts[field] += local[field];
    }
    if (outcome.packageAnomalies.length) {
      history.anomalies = Array.isArray(history.anomalies) ? history.anomalies : [];
      for (const anomaly of outcome.packageAnomalies) addUniqueAnomaly(history.anomalies, anomaly, counts);
    }
    if (rebuiltBatch) {
      // rebuiltBatch already carries the preserved createdAt and attachmentIds, copied from the stored batch.
      for (const key of Object.keys(batch)) delete batch[key];
      Object.assign(batch, rebuiltBatch);
      counts.batchesUpdated += 1;
    }
  }

  if (Array.isArray(history.anomalies)) correctMislabelledAnomalies(history.anomalies, counts);
  const changed = [
    counts.sourceFieldsRemoved,
    counts.inspectionFieldsRemoved,
    counts.rowFieldsRemoved,
    counts.printedRatesRestored,
    counts.comparisonRatesRestored,
    counts.colorCorrections,
    counts.fillCorrections,
    counts.anomaliesRemoved,
    counts.anomaliesAdded,
    counts.batchesUpdated,
  ].some((value) => value > 0);
  return { changed, counts };
}

/** Normalize an incoming history package (sources, inspections, anomalies) with the same rules; returns the counts. */
export function correctHistoryPackageRecords(historyPackage) {
  const target = {
    history: {
      sources: historyPackage.sources,
      inspections: historyPackage.inspections,
      anomalies: historyPackage.anomalies ?? [],
    },
  };
  const result = correctHistoricalRecords(target);
  if (historyPackage.anomalies !== undefined || target.history.anomalies.length) {
    historyPackage.anomalies = target.history.anomalies;
  }
  return result;
}

/** Combine correction results from the stored workspace and from incoming records into one audited total. */
export function combineHistoryCorrections(...results) {
  const counts = emptyCounts();
  for (const result of results) {
    for (const [field, value] of Object.entries(result?.counts ?? {})) {
      if (field === "skipped") {
        for (const [reason, count] of Object.entries(value)) counts.skipped[reason] = (counts.skipped[reason] ?? 0) + count;
      } else if (typeof value === "number") {
        counts[field] += value;
      }
    }
  }
  const changed = results.some((result) => result?.changed);
  return { changed, counts };
}

/** One audit entry, written with the same revision bump as the correction itself. */
export function recordHistoryCorrectionAudit(state, counts, context) {
  const skipped = Object.values(counts.skipped).reduce((total, count) => total + count, 0);
  const rates = counts.printedRatesRestored + counts.comparisonRatesRestored;
  const plural = (count, singular, pluralForm = `${singular}s`) => `${count} ${count === 1 ? singular : pluralForm}`;
  addAudit(state, {
    idFactory: context.idFactory,
    now: context.now,
    action: HISTORY_CORRECTION_ACTION,
    entityId: HISTORY_CORRECTION_ENTITY_ID,
    summary: `Corrected ${plural(rates, "printed defective-rate value", "printed defective-rate values")} (${plural(counts.printedRatesRestored, "printed rate")}, ${plural(counts.comparisonRatesRestored, "historical comparison")}); set ${counts.colorCorrections} S15 batch color${counts.colorCorrections === 1 ? "" : "s"} to unassigned as a partial color allocation; corrected ${plural(counts.fillCorrections, "row highlight")}; removed ${counts.anomaliesRemoved} mislabelled duplicate anomaly entr${counts.anomaliesRemoved === 1 ? "y" : "ies"} and added ${counts.anomaliesAdded}; removed machine-specific fields (${counts.sourceFieldsRemoved}) from ${counts.sourcesUpdated} PDF source record${counts.sourcesUpdated === 1 ? "" : "s"}; updated ${counts.batchesUpdated} historical batch record${counts.batchesUpdated === 1 ? "" : "s"}; skipped ${skipped} value${skipped === 1 ? "" : "s"} that no longer matched the known incorrect value. Staff-entered results, attachments, and Issues were not changed.`,
  });
}
