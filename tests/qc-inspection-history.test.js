import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createHistoricalBatch } from "../core/qc-historical-batches.js";
import { averageTimePerUnitSeconds, createInspectionHistoryContext, resolveInspectionHistory } from "../core/qc-inspection-history.js";

const BUNDLE = JSON.parse(readFileSync(new URL("../data/pdf-import/masterqc-history.json", import.meta.url), "utf8"));
const CURRENT_DATE = "2026-10-01";
const CURRENT_CREATED_AT = `${CURRENT_DATE}T12:00:00.000Z`;

function standard(overrides = {}) {
  return {
    id: "current-row",
    key: "visual-check",
    no: 1,
    title: "Visual check",
    titleZh: "外观检查",
    specification: "Inspect the surface.",
    specificationZh: "检查表面",
    devices: "Visual inspection",
    devicesZh: "目测",
    samplingPercent: 10,
    recordingRule: "50% + all failed units",
    models: ["S15"],
    inspectedQty: 10,
    defectiveQty: 0,
    actualTimeSeconds: 4,
    savedAt: null,
    remarks: "",
    ...overrides,
  };
}

const redVariant = { id: "variant-s15-red", familyId: "s15", model: "S15", color: "Red", label: "HyperSmoke 15 Red" };
const yellowVariant = { id: "variant-s15-yellow", familyId: "s15", model: "S15", color: "Yellow", label: "HyperSmoke 15 Yellow" };

function operationalBatch({ id, date, variant = redVariant, row = standard(), createdAt = `${date}T09:00:00.000Z`, products = null, rows = null }) {
  const singleLineId = `${id}-line`;
  const batchProducts = products ?? [{
    lineId: singleLineId,
    variantId: variant.id,
    familyId: variant.familyId ?? "s15",
    quantity: 100,
    versionId: `${id}-version`,
    versionLabel: "V1",
  }];
  const batchRows = rows ?? [{
    ...structuredClone(row),
    id: `${id}-row`,
    productLineId: batchProducts[0].lineId,
    savedAt: row.savedAt ?? `${date}T10:00:00.000Z`,
  }];
  return {
    id,
    kind: "operational",
    number: id,
    factory: "AP",
    stage: "OQC",
    familyId: batchProducts[0]?.familyId ?? variant.familyId ?? "s15",
    date,
    createdAt,
    quantity: 100,
    versionId: `${id}-version`,
    versionLabel: "V1",
    lineId: batchProducts.length === 1 ? batchProducts[0].lineId : null,
    variantId: batchProducts.length === 1 ? batchProducts[0].variantId : null,
    products: batchProducts,
    rows: batchRows,
  };
}

function resolveOperationalHistory({ row = standard(), priorBatches = [], date = CURRENT_DATE, variants = [redVariant], currentColor = redVariant } = {}) {
  const currentLineId = "current-line";
  const familyId = currentColor.familyId ?? "s15";
  const currentBatch = {
    ...operationalBatch({
      id: "current-batch",
      date,
      createdAt: CURRENT_CREATED_AT,
      products: [{ lineId: currentLineId, variantId: currentColor.id, familyId, quantity: 100, versionId: "current-version", versionLabel: "V2" }],
      rows: [{ ...structuredClone(row), id: "current-row", productLineId: currentLineId }],
    }),
  };
  const state = {
    variants,
    batches: [...priorBatches, currentBatch],
    history: { sources: [], inspections: [], anomalies: [] },
    assets: [],
  };
  const product = {
    lineId: currentLineId,
    variantId: currentColor.id,
    familyId,
    quantity: 100,
    variant: currentColor,
  };
  const context = createInspectionHistoryContext(state, currentBatch);
  return { state, currentBatch, row: currentBatch.rows[0], entries: resolveInspectionHistory(context, product, currentBatch.rows[0]) };
}

function bundleState({ row, model, factory, stage, color = "Red", date = CURRENT_DATE } = {}) {
  const sourceById = new Map(BUNDLE.sources.map((source) => [source.id, source]));
  const historyBatches = BUNDLE.inspections.map((inspection) =>
    createHistoricalBatch(inspection, sourceById.get(inspection.sourceId), "2026-10-01T00:00:00.000Z"));
  const currentVariant = {
    id: `current-${model}-${color || "unknown"}`,
    familyId: model === "S15" ? "s15" : "s11-s14",
    model,
    color,
    label: `${model}${color ? ` ${color}` : ""}`,
  };
  const lineId = "current-pdf-line";
  const currentBatch = {
    id: "current-pdf-batch",
    kind: "operational",
    number: "CURRENT-PDF-COMPARISON",
    factory,
    stage,
    familyId: currentVariant.familyId,
    date,
    createdAt: `${date}T12:00:00.000Z`,
    lineId,
    variantId: currentVariant.id,
    quantity: 100,
    versionId: "current-standard-version",
    versionLabel: "current standard",
    products: [{ lineId, variantId: currentVariant.id, familyId: currentVariant.familyId, quantity: 100, versionId: "current-standard-version", versionLabel: "current standard" }],
    rows: [{ ...structuredClone(row), id: "current-pdf-row", key: "pdf-comparable-row", models: [model], productLineId: lineId, inspectedQty: 10, defectiveQty: 0, actualTimeSeconds: 0, savedAt: null }],
  };
  const state = {
    variants: [currentVariant],
    batches: [...historyBatches, currentBatch],
    history: structuredClone(BUNDLE),
    assets: BUNDLE.assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      mimeType: asset.mimeType,
      kind: asset.kind,
      decodedBytes: 1,
      contentRevision: 1,
    })),
  };
  const product = { lineId, variantId: currentVariant.id, familyId: currentVariant.familyId, quantity: 100, variant: currentVariant };
  const context = createInspectionHistoryContext(state, currentBatch);
  return { state, batch: currentBatch, row: currentBatch.rows[0], product, context };
}

test("average time per unit is a query-only ratio with null, zero, and decimal behavior", () => {
  assert.equal(averageTimePerUnitSeconds({ actualTimeSeconds: null, inspectedQty: 10 }), null);
  assert.equal(averageTimePerUnitSeconds({ actualTimeSeconds: "", inspectedQty: 10 }), null);
  assert.equal(averageTimePerUnitSeconds({ actualTimeSeconds: Number.NaN, inspectedQty: 10 }), null);
  assert.equal(averageTimePerUnitSeconds({ actualTimeSeconds: Number.POSITIVE_INFINITY, inspectedQty: 10 }), null);
  assert.equal(averageTimePerUnitSeconds({ actualTimeSeconds: -1, inspectedQty: 10 }), null);
  assert.equal(averageTimePerUnitSeconds({ actualTimeSeconds: 5, inspectedQty: 0 }), null);
  assert.equal(averageTimePerUnitSeconds({ actualTimeSeconds: 5, inspectedQty: 1.5 }), null);
  assert.equal(averageTimePerUnitSeconds({ actualTimeSeconds: 0, inspectedQty: 10 }), 0);
  assert.equal(averageTimePerUnitSeconds({ actualTimeSeconds: 1.75, inspectedQty: 4 }), 0.4375);
});

test("operational history returns the eight newest earlier saved comparable rows only", () => {
  const priorBatches = Array.from({ length: 10 }, (_, index) => {
    const day = String(index + 1).padStart(2, "0");
    return operationalBatch({
      id: `prior-${day}`,
      date: `2026-09-${day}`,
      row: standard({ defectiveQty: index % 2, inspectedQty: 10, actualTimeSeconds: 5 }),
    });
  });
  priorBatches.push(operationalBatch({ id: "same-day-earlier", date: CURRENT_DATE, createdAt: `${CURRENT_DATE}T10:00:00.000Z` }));
  priorBatches.push(operationalBatch({ id: "same-day-later", date: CURRENT_DATE, createdAt: `${CURRENT_DATE}T13:00:00.000Z` }));
  priorBatches.push(operationalBatch({ id: "future", date: "2026-10-02" }));
  priorBatches.push(operationalBatch({ id: "missing-time", date: "2026-09-30", row: standard({ actualTimeSeconds: null }) }));
  const result = resolveOperationalHistory({ priorBatches });

  assert.equal(result.entries.length, 8);
  assert.equal(result.entries[0].batchId, "same-day-earlier");
  assert.deepEqual(result.entries.slice(1).map((entry) => entry.batchId), [
    "prior-10", "prior-09", "prior-08", "prior-07", "prior-06", "prior-05", "prior-04",
  ]);
  assert.ok(result.entries.every((entry) => entry.batchId !== "same-day-later" && entry.batchId !== "future" && entry.batchId !== "missing-time"));
});

test("operational history rejects standards, applicability, and incomplete-result mismatches", () => {
  const changes = [
    { specification: "Inspect the full surface.\n检查表面" },
    { devices: "Magnifier" },
    { samplingPercent: 20 },
    { recordingRule: "0%" },
    { models: ["S11"] },
    { defectiveQty: null },
    { actualTimeSeconds: null },
  ];
  for (const [index, change] of changes.entries()) {
    const prior = operationalBatch({
      id: `mismatch-${index}`,
      date: "2026-09-01",
      row: standard(change),
    });
    assert.deepEqual(resolveOperationalHistory({ priorBatches: [prior] }).entries, [], `mismatch ${JSON.stringify(change)} must not contribute history`);
  }

  const chineseRecording = resolveOperationalHistory({
    row: standard({ recordingRule: "50%+所有不良品" }),
    priorBatches: [operationalBatch({ id: "english-recording", date: "2026-09-01" })],
  });
  assert.equal(chineseRecording.entries.length, 1, "the known same-percent all-defects translation is comparable");
  const zeroRecording = resolveOperationalHistory({
    row: standard({ recordingRule: "0%" }),
    priorBatches: [operationalBatch({ id: "zero-plus-all", date: "2026-09-01", row: standard({ recordingRule: "0%+all failed units" }) })],
  });
  assert.deepEqual(zeroRecording.entries, [], "0% remains distinct from 0% plus failed units");
});

test("model-coded composite power ranges do not share history across models", () => {
  const s11 = { id: "variant-s11-red", familyId: "s11-s14", model: "S11", color: "Red", label: "S11 Red" };
  const s12 = { id: "variant-s12-red", familyId: "s11-s14", model: "S12", color: "Red", label: "S12 Red" };
  const compositeRange = "S11/S13: 32.3–34.0W; S12/S14: 30.1–31.8W";
  const compositeCurrent = standard({ models: ["S11", "S12"], specification: compositeRange, specificationZh: "S11/S13：32.3–34.0W；S12/S14：30.1–31.8W" });
  const compositePrior = operationalBatch({
    id: "prior-s12-composite-power",
    date: "2026-09-01",
    variant: s12,
    row: { ...compositeCurrent, models: ["S11", "S12"] },
  });
  const composite = resolveOperationalHistory({
    row: compositeCurrent,
    priorBatches: [compositePrior],
    variants: [s11, s12],
    currentColor: s11,
  });
  assert.deepEqual(composite.entries, [], "the same printed composite text carries different model-specific limits");

  const currentS11 = standard({ models: ["S11"], specification: "Power test range 32.3–34.0W for S11/S13" });
  const priorS12 = operationalBatch({
    id: "prior-s12-power",
    date: "2026-09-01",
    variant: s12,
    row: standard({ models: ["S12"], specification: "Power test range 30.1–31.8W for S12/S14" }),
  });
  assert.deepEqual(resolveOperationalHistory({
    row: currentS11,
    priorBatches: [priorS12],
    variants: [s11, s12],
    currentColor: s11,
  }).entries, [], "S11's 32.3–34.0W limit does not match S12's 30.1–31.8W limit");
});

test("a comparable result in the same multi-product batch prefers the current variant", () => {
  const products = [
    { lineId: "red-line", variantId: redVariant.id, familyId: "s15", quantity: 100, versionId: "red-version", versionLabel: "V1" },
    { lineId: "yellow-line", variantId: yellowVariant.id, familyId: "s15", quantity: 100, versionId: "yellow-version", versionLabel: "V1" },
  ];
  const prior = operationalBatch({
    id: "prior-red-yellow",
    date: "2026-09-01",
    products,
    rows: [
      { ...standard({ defectiveQty: 1 }), id: "red-row", productLineId: "red-line", savedAt: "2026-09-01T10:00:00.000Z" },
      { ...standard({ defectiveQty: 2 }), id: "yellow-row", productLineId: "yellow-line", savedAt: "2026-09-01T10:00:00.000Z" },
    ],
  });
  const result = resolveOperationalHistory({ priorBatches: [prior] });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].batchId, prior.id);
  assert.equal(result.entries[0].color, "Red");
  assert.equal(result.entries[0].defectiveQty, 1);
});

test("bundled PDF history yields comparable positive and true-zero results without mutating source", () => {
  const targetInspection = BUNDLE.inspections.find((inspection) =>
    inspection.model === "S15" && inspection.factory === "AP" && inspection.stage === "OQC" &&
    inspection.date === "2026-05-25" && inspection.rows.some((row) => row.no === 4));
  const targetRow = targetInspection.rows.find((row) => row.no === 4);
  const fixture = bundleState({ row: targetRow, model: "S15", factory: "AP", stage: "OQC" });
  const before = structuredClone(fixture.state.history);
  const entries = resolveInspectionHistory(fixture.context, fixture.product, fixture.row);

  assert.equal(entries.length, 8);
  assert.deepEqual(entries.map((entry) => entry.date), [
    "2026-09-03", "2026-08-27", "2026-08-21", "2026-08-18", "2026-08-07", "2026-07-30", "2026-07-15", "2026-07-07",
  ]);
  assert.ok(entries.some((entry) => entry.defectiveQty > 0));
  assert.ok(entries.some((entry) => entry.defectiveQty === 0));
  assert.ok(entries.some((entry) => entry.color === null), "unknown source color stays unknown");
  assert.ok(entries.every((entry) => entry.inspectedQty > 0 && entry.model === "S15" && entry.sourceFileName));
  assert.equal(entries.find((entry) => entry.date === "2026-07-30").inspectedQty, 23, "source inspected quantity is retained");
  assert.deepEqual(fixture.state.history, before, "querying history does not rewrite imported source facts");
});

test("bundled PDF anomalies and ambiguous duplicate standards are excluded", () => {
  const quantityAnomaly = BUNDLE.anomalies.find((anomaly) =>
    anomaly.code === "source-inspected-quantity-exceeds-batch-quantity" &&
    BUNDLE.inspections.find((inspection) => inspection.id === anomaly.inspectionId)?.model === "S15");
  const anomalousInspection = BUNDLE.inspections.find((inspection) => inspection.id === quantityAnomaly.inspectionId);
  const anomalousRow = anomalousInspection.rows.find((row) => row.no === quantityAnomaly.rowNo);
  assert.equal(anomalousInspection.batchQuantity, 1152);
  assert.equal(anomalousRow.sourceInspectedQty, 4000);
  const anomalyFixture = bundleState({ row: anomalousRow, model: "S15", factory: "UI", stage: "IQC" });
  const sourceBefore = structuredClone(anomalyFixture.state.history);
  const anomalyEntries = resolveInspectionHistory(anomalyFixture.context, anomalyFixture.product, anomalyFixture.row);
  assert.ok(!anomalyEntries.some((entry) => entry.batchId === anomalousInspection.id));
  assert.deepEqual(anomalyFixture.state.history, sourceBefore);

  const targetInspection = BUNDLE.inspections.find((inspection) =>
    inspection.model === "S15" && inspection.factory === "AP" && inspection.stage === "OQC" &&
    inspection.date === "2026-05-25" && inspection.rows.some((row) => row.no === 4));
  const targetRow = targetInspection.rows.find((row) => row.no === 4);
  const ambiguousFixture = bundleState({ row: targetRow, model: "S15", factory: "AP", stage: "OQC" });
  const newestComparable = BUNDLE.inspections.find((inspection) =>
    inspection.model === "S15" && inspection.factory === "AP" && inspection.stage === "OQC" &&
    inspection.date === "2026-09-03" && inspection.rows.some((row) => row.no === 4));
  const baselineEntries = resolveInspectionHistory(ambiguousFixture.context, ambiguousFixture.product, ambiguousFixture.row);
  assert.ok(baselineEntries.some((entry) => entry.batchId === newestComparable.id), "the selected source is in the newest eight before adding ambiguity");
  const newestRow = newestComparable.rows.find((row) => row.no === 4);
  const duplicate = { ...structuredClone(newestRow), id: `${newestRow.id}-duplicate`, no: 99 };
  ambiguousFixture.state.history.inspections.find((inspection) => inspection.id === newestComparable.id).rows.push(duplicate);
  ambiguousFixture.state.batches.find((batch) => batch.id === newestComparable.id).rows.push(structuredClone(duplicate));
  const ambiguousEntries = resolveInspectionHistory(ambiguousFixture.context, ambiguousFixture.product, ambiguousFixture.row);
  assert.ok(!ambiguousEntries.some((entry) => entry.batchId === newestComparable.id), "duplicate comparable source rows are not first-matched");
  assert.ok(ambiguousEntries.some((entry) => entry.date < baselineEntries.at(-1).date), "a later eligible source fills the released history slot");

  const rateFixture = bundleState({ row: targetRow, model: "S15", factory: "AP", stage: "OQC" });
  const rateSourceRow = rateFixture.state.history.inspections.find((inspection) => inspection.id === newestComparable.id).rows.find((row) => row.no === 4);
  const baselineRateEntries = resolveInspectionHistory(rateFixture.context, rateFixture.product, rateFixture.row);
  assert.ok(baselineRateEntries.some((entry) => entry.batchId === newestComparable.id));
  rateSourceRow.sourceDefectiveRateRaw = "99.99%";
  const rateMutation = structuredClone(rateFixture.state.history);
  const rateEntries = resolveInspectionHistory(rateFixture.context, rateFixture.product, rateFixture.row);
  assert.ok(!rateEntries.some((entry) => entry.batchId === newestComparable.id), "a printed rate inconsistent with source counts is excluded");
  assert.deepEqual(rateFixture.state.history, rateMutation, "the mismatch remains in source history after the read-only query");
});
