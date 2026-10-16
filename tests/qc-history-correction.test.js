import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildHistoryPackage } from "../scripts/pdf-import/build_history_package.mjs";
import { importHistory, validateHistoryPackage, verifyHistoryPackage } from "../core/qc-history.js";
import { importBackup, makeBackup } from "../core/qc-backup.js";
import { clone, createInitialQCState, deepEqual, stableStringify } from "../core/qc-domain.js";
import { materializeHistoricalBatches } from "../core/qc-historical-batches.js";
import {
  correctHistoricalRecords,
  correctHistoryPackageRecords,
  deriveS15Color,
  HISTORY_CORRECTION_ACTION,
} from "../core/qc-history-correction.js";
import { createQCService } from "../core/qc-service.js";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";
import { validateQCState } from "../core/qc-validation.js";

const FIXED_TIME = "2026-09-29T00:00:00.000Z";
const PARITY = JSON.parse(readFileSync(new URL("./fixtures/s15-color-cases.json", import.meta.url), "utf8"));
const PARTIAL_NOTES = "Production: 832PCS. Remaining red: 384PCS.";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function row(no, overrides = {}) {
  return {
    no,
    title: "Visual inspection",
    specification: "Check visible surfaces.",
    devices: "Visual",
    samplingPercent: 10,
    recordingRule: "Record results.",
    timeSeconds: 30,
    important: true,
    importantFillRgb: "0.757,0.941,0.784",
    sourceInspectedQty: 832,
    sourceInspectedQtyRaw: "832",
    defectiveQty: 3,
    defectiveQtyRaw: "3",
    sourceDefectiveRate: 0.36,
    sourceDefectiveRateRaw: "0.36%",
    remarks: "",
    historicalComparisons: [],
    photoEvidence: [],
    raw: { tableRowIndex: no + 3, printedCells: [] },
    ...overrides,
  };
}

// Extraction output as the fixed Python extractor writes it: printed rates and zeros are read, and colors follow the quantity rule.
function extraction(fileName, sourceId, pages) {
  const bytes = Buffer.from(`%PDF-1.4\n${fileName}\n`, "utf8");
  const sha = sha256(bytes);
  const assetId = `asset-${sourceId}`;
  const inspections = [];
  const anomalies = [];
  pages.forEach((page, index) => {
    const pageNumber = index + 1;
    const inspectionId = `${sourceId}-p${pageNumber}`;
    const colour = deriveS15Color(page.notes ?? null, page.batchQuantity);
    const localAnomalies = colour.anomaly ? [colour.anomaly] : [];
    inspections.push({
      id: inspectionId,
      sourceId,
      page: pageNumber,
      printedVersion: "25.10.29",
      printedVersionRaw: "25.10.29",
      printedDate: "2026/09/15",
      printedDateRaw: "2026/09/15",
      date: page.date ?? "2026-09-15",
      printedPage: "1/1",
      productLabel: "S15",
      model: "S15",
      color: colour.color,
      colorBasis: colour.colorBasis,
      modelBasis: "source-folder-and-printed-S15-form-title",
      reportedProductQuantities: [],
      factory: page.factory,
      factoryRaw: null,
      stage: page.stage,
      batchQuantity: page.batchQuantity,
      batchQuantityRaw: String(page.batchQuantity),
      recorder: null,
      notes: page.notes ?? null,
      rows: page.rows,
      historyColumns: [],
      sourceColumnMap: {},
      sourceText: "",
      anomalies: localAnomalies,
    });
    for (const anomaly of localAnomalies) {
      anomalies.push({ sourceId, inspectionId, page: pageNumber, ...structuredClone(anomaly) });
    }
  });
  return {
    format: "masterqc-pdf-history",
    formatVersion: 1,
    family: "s15",
    summary: {},
    sources: [{
      id: sourceId,
      fileName,
      sha256: sha,
      pageCount: pages.length,
      family: "s15",
      assetId,
      inspectionPages: pages.map((_, index) => index + 1),
      nonInspectionPages: [],
    }],
    inspections,
    assets: [{
      id: assetId,
      name: fileName,
      mimeType: "application/pdf",
      dataUrl: `data:application/pdf;base64,${bytes.toString("base64")}`,
      kind: "document",
      batchId: null,
      rowId: null,
      versionId: null,
      createdAt: FIXED_TIME,
    }],
    anomalies,
  };
}

/** The regenerated package: the fixed builder applied to the fixed extraction. */
async function newPackage() {
  const sourceA = extraction("S15-A.pdf", "extract-a", [
    {
      factory: "AP",
      stage: "OQC",
      batchQuantity: 832,
      notes: PARTIAL_NOTES,
      rows: [row(1, {
        sourceDefectiveRate: 1.58,
        sourceDefectiveRateRaw: "1.58",
        historicalComparisons: [
          { printedDateRaw: "6.1", printedBatchQuantity: 800, sourceDefectiveRateRaw: "0", sourceDefectiveRate: 0, sourceColumn: 10 },
          { printedDateRaw: "6.2", printedBatchQuantity: 700, sourceDefectiveRateRaw: "0.32%", sourceDefectiveRate: 0.32, sourceColumn: 11 },
        ],
      })],
    },
    { factory: "UI", stage: "OQC", batchQuantity: 768, rows: [row(1, { samplingPercent: 20 })] },
  ]);
  const sourceB = extraction("S15-B.pdf", "extract-b", [
    { factory: "AP", stage: "OQC", batchQuantity: 768, date: "2026-09-20", rows: [row(1, { samplingPercent: 20 })] },
  ]);
  const built = buildHistoryPackage([sourceA, sourceB]).package;
  validateHistoryPackage(built);
  await verifyHistoryPackage(built);
  return built;
}

/**
 * The committed pre-correction package: each change the correction makes is reverted, with the
 * machine-specific fields restored and the mislabelled AP/UI duplicates added back.
 */
function legacyPackage(pkg) {
  const legacy = clone(pkg);
  for (const source of legacy.sources) {
    source.path = `/Users/example/MasterQC/${source.fileName}`;
    source.extractorSourceId = `source-${source.id}`;
    source.inventoryKey = "S15-01";
  }
  for (const inspection of legacy.inspections) {
    inspection.extractorInspectionId = `extract-${inspection.id}`;
    for (const item of inspection.rows) {
      item.extractorRowId = `extract-row-${item.id}`;
      if (item.sourceDefectiveRateRaw === "1.58") item.sourceDefectiveRate = null;
      for (const comparison of item.historicalComparisons ?? []) {
        if (comparison.sourceDefectiveRateRaw === "0") comparison.sourceDefectiveRate = null;
      }
    }
    if (inspection.colorBasis === "special-notes-partial-color-quantity") {
      inspection.color = "red";
      inspection.colorBasis = "special-notes-explicit-product-quantity";
      inspection.anomalies = inspection.anomalies.filter((anomaly) => anomaly.code !== "partial-color-allocation");
    }
  }
  legacy.anomalies = legacy.anomalies.filter((anomaly) => anomaly.code !== "partial-color-allocation");
  for (const anomaly of legacy.anomalies.filter((item) => /^same-task/u.test(item.code) && item.context?.includes("|"))) {
    legacy.anomalies.push({ ...structuredClone(anomaly), context: anomaly.context.split("|")[0] });
  }
  return legacy;
}

/** Store a package the way the earlier importer did: raw records with no correction, then the canonical batches. */
function storedState(pkg) {
  const state = createInitialQCState();
  state.assets.push(...clone(pkg.assets));
  state.versions.push(...clone(pkg.versions ?? []));
  state.history = {
    sources: clone(pkg.sources),
    inspections: clone(pkg.inspections),
    anomalies: clone(pkg.anomalies),
  };
  materializeHistoricalBatches(state);
  state.revision = 1;
  validateQCState(state);
  return state;
}

function ids(time = 0) {
  let number = 0;
  return {
    idFactory: () => `correction-${String(++number).padStart(4, "0")}`,
    now: () => new Date(Date.UTC(2026, 9, 16, 12, 0, time)).toISOString(),
  };
}

function byId(list, id) {
  return list.find((item) => item.id === id);
}

function sourceIdFor(pkg, fileName) {
  return pkg.sources.find((source) => source.fileName === fileName).id;
}

function sortedAnomalies(anomalies) {
  return anomalies.map((item) => stableStringify(item)).sort();
}

function historyView(state) {
  return {
    sources: [...state.history.sources].sort((left, right) => left.id.localeCompare(right.id)),
    inspections: [...state.history.inspections].sort((left, right) => left.id.localeCompare(right.id)),
    anomalies: sortedAnomalies(state.history.anomalies),
    batches: state.batches.filter((batch) => batch.kind === "historical").sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function nonHistoryRecords(state) {
  const copy = clone(state);
  delete copy.history;
  delete copy.batches;
  delete copy.audit;
  delete copy.revision;
  return copy;
}

test("the S15 colour rule matches the shared parity fixture", () => {
  for (const item of PARITY.cases) {
    const result = deriveS15Color(item.notes, item.batchQuantity);
    assert.deepEqual(result, {
      color: item.expected.color,
      colorBasis: item.expected.colorBasis,
      anomaly: item.expected.anomaly,
    }, item.name);
  }
});

test("the regenerated package has the corrected values and no machine-specific fields", async () => {
  const pkg = await newPackage();
  assert.ok(pkg.sources.every((source) => !("path" in source) && !("inventoryKey" in source) && !("extractorSourceId" in source)));
  assert.ok(pkg.inspections.every((inspection) => !("extractorInspectionId" in inspection)));
  assert.ok(pkg.inspections.flatMap((inspection) => inspection.rows).every((item) => !("extractorRowId" in item)));
  const inspectionA = byId(pkg.inspections, `${sourceIdFor(pkg, "S15-A.pdf")}-page-001`);
  assert.equal(inspectionA.rows[0].sourceDefectiveRate, 1.58);
  assert.equal(inspectionA.rows[0].historicalComparisons[0].sourceDefectiveRate, 0);
  assert.equal(inspectionA.color, null);
  assert.equal(inspectionA.colorBasis, "special-notes-partial-color-quantity");
  assert.equal(pkg.anomalies.filter((anomaly) => /^same-task/u.test(anomaly.code)).every((anomaly) => !anomaly.context || anomaly.context.includes("|")), true);
});

test("the correction changes exactly the known fields once, is idempotent, and writes its own audit entry", async () => {
  const pkg = await newPackage();
  const legacy = legacyPackage(pkg);
  const state = storedState(legacy);
  const duplicateCount = pkg.anomalies.filter((anomaly) => /^same-task/u.test(anomaly.code) && anomaly.context?.includes("|")).length;
  assert.ok(duplicateCount >= 1);

  const working = clone(state);
  const first = correctHistoricalRecords(working);
  assert.equal(first.changed, true);
  assert.deepEqual(first.counts.skipped, {});
  assert.deepEqual(
    {
      sourcesUpdated: first.counts.sourcesUpdated,
      sourceFieldsRemoved: first.counts.sourceFieldsRemoved,
      inspectionFieldsRemoved: first.counts.inspectionFieldsRemoved,
      rowFieldsRemoved: first.counts.rowFieldsRemoved,
      printedRatesRestored: first.counts.printedRatesRestored,
      comparisonRatesRestored: first.counts.comparisonRatesRestored,
      colorCorrections: first.counts.colorCorrections,
      fillCorrections: first.counts.fillCorrections,
      anomaliesRemoved: first.counts.anomaliesRemoved,
      anomaliesAdded: first.counts.anomaliesAdded,
      batchesUpdated: first.counts.batchesUpdated,
    },
    {
      sourcesUpdated: 2,
      sourceFieldsRemoved: 6,
      inspectionFieldsRemoved: 3,
      rowFieldsRemoved: 3,
      printedRatesRestored: 1,
      comparisonRatesRestored: 1,
      colorCorrections: 1,
      fillCorrections: 0,
      anomaliesRemoved: duplicateCount,
      anomaliesAdded: 1,
      batchesUpdated: 3,
    },
  );

  const colorInspection = byId(working.history.inspections, `${sourceIdFor(pkg, "S15-A.pdf")}-page-001`);
  assert.equal(colorInspection.colorBasis, "special-notes-partial-color-quantity");
  assert.equal(colorInspection.color, null);
  assert.deepEqual(colorInspection.anomalies.map((anomaly) => anomaly.code), ["partial-color-allocation"]);
  const colorBatch = byId(working.batches, colorInspection.id);
  assert.equal(colorBatch.color, null);
  assert.ok(colorBatch.rows.every((item) => !("extractorRowId" in item)));

  const second = correctHistoricalRecords(working);
  assert.equal(second.changed, false, "a second pass must not change anything");
  assert.deepEqual(second.counts.skipped, {});
});

test("the correction keeps staff-entered results, attachments, and other records unchanged", async () => {
  const pkg = await newPackage();
  const state = storedState(legacyPackage(pkg));
  const batch = state.batches.find((candidate) => candidate.kind === "historical" && candidate.color === "red");
  const staffRow = batch.rows[0];
  staffRow.inspectedQty = 800;
  staffRow.defectiveQty = 5;
  staffRow.actualTimeSeconds = 120;
  staffRow.attachmentIds = ["row-attachment-1"];
  batch.attachmentIds = [...batch.attachmentIds, "batch-attachment-1"];
  const before = clone(state);

  const working = clone(state);
  correctHistoricalRecords(working);
  assert.deepEqual(nonHistoryRecords(working), nonHistoryRecords(before));
  const correctedBatch = byId(working.batches, batch.id);
  assert.equal(correctedBatch.rows[0].inspectedQty, 800);
  assert.equal(correctedBatch.rows[0].defectiveQty, 5);
  assert.equal(correctedBatch.rows[0].actualTimeSeconds, 120);
  assert.deepEqual(correctedBatch.rows[0].attachmentIds, ["row-attachment-1"]);
  assert.deepEqual(correctedBatch.attachmentIds, batch.attachmentIds);
  assert.equal(correctedBatch.createdAt, batch.createdAt);
});

test("a batch that staff changed is skipped and counted, and its source inspection stays as stored", async () => {
  const pkg = await newPackage();
  const state = storedState(legacyPackage(pkg));
  const colorBatch = state.batches.find((candidate) => candidate.kind === "historical" && candidate.color === "red");
  colorBatch.color = "Yellow";
  const storedInspection = clone(byId(state.history.inspections, colorBatch.historyInspectionId));

  const working = clone(state);
  const result = correctHistoricalRecords(working);
  assert.equal(result.counts.skipped["batch-differs-from-source-evidence"], 1);
  assert.deepEqual(byId(working.history.inspections, colorBatch.historyInspectionId), storedInspection);
  assert.equal(byId(working.batches, colorBatch.id).color, "Yellow");
  assert.equal(result.counts.colorCorrections, 0);
});

test("initialize applies the correction once, writes one audit entry, and repeated starts change nothing", async () => {
  const pkg = await newPackage();
  const adapter = createMemoryQCAdapter({ initialState: storedState(legacyPackage(pkg)) });
  const { idFactory, now } = ids();
  const service = createQCService(adapter, { idFactory, now });

  const initialized = await service.initialize();
  const audits = initialized.audit.filter((entry) => entry.action === HISTORY_CORRECTION_ACTION);
  assert.equal(audits.length, 1);
  assert.match(audits[0].summary, /Corrected 2 printed defective-rate values/u);
  assert.match(audits[0].summary, /Staff-entered results, attachments, and Issues were not changed/u);
  const colorBatch = initialized.batches.find((batch) => batch.historyInspectionId === `${sourceIdFor(pkg, "S15-A.pdf")}-page-001`);
  assert.equal(colorBatch.color, null);
  assert.equal(colorBatch.kind, "historical");

  const snapshot = clone(initialized);
  const restarted = await service.initialize();
  assert.deepEqual(restarted, snapshot);
  assert.equal((await service.getState()).audit.filter((entry) => entry.action === HISTORY_CORRECTION_ACTION).length, 1);
});

test("an identical re-import after correction is a skip, and an empty workspace imports the same corrected history", async () => {
  const pkg = await newPackage();
  const legacy = legacyPackage(pkg);

  // Old package into an empty workspace: normalized on the way in, so it matches the regenerated import.
  const fromRegenerated = importHistory(null, clone(pkg), ids(1));
  const fromLegacy = importHistory(null, clone(legacy), ids(2));
  assert.deepEqual(historyView(fromLegacy.state), historyView(fromRegenerated.state));

  // Corrected stored state followed by the regenerated package: an identical skip with no conflict.
  const corrected = clone(storedState(legacy));
  correctHistoricalRecords(corrected);
  const reimport = importHistory(corrected, clone(pkg), ids(3));
  assert.equal(reimport.result.changed, false);
  assert.equal(reimport.result.counts.added.sources + reimport.result.counts.added.inspections + reimport.result.counts.added.anomalies, 0);
  assert.equal(reimport.result.counts.added.batches, 0);
  assert.deepEqual(historyView(reimport.state), historyView(corrected));

  // Corrected stored state with the old package still stored as raw records: the stored values are corrected first.
  const rawCorrected = importHistory(storedState(legacy), clone(pkg), ids(4));
  assert.equal(rawCorrected.result.changed, true);
  assert.deepEqual(historyView(rawCorrected.state), historyView(fromRegenerated.state));
});

test("restoring a backup that holds the old values is compatible with corrected and empty workspaces", async () => {
  const pkg = await newPackage();
  const legacy = legacyPackage(pkg);
  const oldState = storedState(legacy);
  const backup = makeBackup(oldState, () => FIXED_TIME);

  const corrected = clone(oldState);
  correctHistoricalRecords(corrected);
  const sameWorkspace = importBackup(corrected, backup, ids(5));
  assert.equal(sameWorkspace.result.changed, false);
  assert.deepEqual(historyView(sameWorkspace.state), historyView(corrected));

  const emptyWorkspace = importBackup(null, backup, ids(6));
  assert.equal(emptyWorkspace.result.changed, true);
  assert.deepEqual(historyView(emptyWorkspace.state), historyView(corrected));
  assert.equal(emptyWorkspace.state.audit.filter((entry) => entry.action === HISTORY_CORRECTION_ACTION).length, 1);
  assert.equal(emptyWorkspace.state.audit.filter((entry) => entry.action === "importBackup").length, 1);
  assert.deepEqual(sortedAnomalies(emptyWorkspace.state.history.anomalies), sortedAnomalies(corrected.history.anomalies));
});

test("a package from before the correction normalizes to the regenerated anomaly set", async () => {
  const pkg = await newPackage();
  const legacy = legacyPackage(pkg);
  const normalized = clone(legacy);
  correctHistoryPackageRecords(normalized);
  assert.deepEqual(sortedAnomalies(normalized.anomalies), sortedAnomalies(pkg.anomalies));
});
