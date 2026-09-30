import assert from "node:assert/strict";
import test from "node:test";
import { resolveBatchDisplayNumbers } from "../core/qc-batch-display.js";
import { getBatchWorkspace } from "../core/qc-inspections.js";

function historicalBatch(id, overrides = {}) {
  return {
    id,
    kind: "historical",
    historyInspectionId: `inspection-${id}`,
    familyId: "s15",
    model: null,
    productLabel: null,
    color: "Red",
    date: "2026-05-21",
    factory: "UI",
    stage: "OQC",
    quantity: null,
    rows: [],
    attachmentIds: [],
    number: `HIST-${id}`,
    ...overrides,
  };
}

function inspectionFor(batch, overrides = {}) {
  return {
    id: batch.historyInspectionId,
    sourceId: `source-${batch.id}`,
    date: batch.date,
    model: batch.model,
    productLabel: batch.productLabel,
    color: batch.color,
    factory: batch.factory,
    stage: batch.stage,
    ...overrides,
  };
}

function stateFor(batches, inspectionOverrides = {}) {
  return {
    families: [
      { id: "s11-s14", name: "S11–S14", models: ["S11", "S12", "S13", "S14"] },
      { id: "s15", name: "S15", models: ["S15"] },
    ],
    variants: [],
    versions: [],
    orders: [],
    issues: [],
    assets: [],
    batches,
    history: {
      inspections: batches.filter((batch) => batch.kind === "historical").map((batch) => inspectionFor(batch, inspectionOverrides[batch.id])),
      sources: [],
    },
  };
}

function sortedEntries(map) {
  return [...map.entries()].sort(([left], [right]) => left.localeCompare(right, "en"));
}

test("historical display names use explicit models or known families and readable unknowns", () => {
  const explicitModel = historicalBatch("model", { model: "S15", color: "Normal Red" });
  const familyFallback = historicalBatch("family", { familyId: "s11-s14", model: null, productLabel: "S11 / S12", color: "Yellow" });
  const mixedModel = historicalBatch("mixed", { familyId: "s11-s14", model: "S11/S12", color: "Red" });
  const unknown = historicalBatch("unknown", { familyId: "unmapped", date: "not a date", factory: "", stage: "", model: null, productLabel: null, color: null });
  const originalNumber = historicalBatch("original", { model: "S15" });
  const state = stateFor([explicitModel, familyFallback, mixedModel, unknown, originalNumber], {
    mixed: { model: "S11/S12", raw: { originalBatchNumber: "DO-NOT-USE" } },
    original: { originalBatchNumber: "Recorded Batch 42" },
  });
  state.history.sources.push({ id: "source-model", fileName: "Original Batch 99.pdf" });

  const names = resolveBatchDisplayNumbers(state);

  assert.equal(names.get("model"), "S15-20260521-UI-OQC");
  assert.equal(names.get("family"), "S11-S14 Yellow-20260521-UI-OQC");
  assert.equal(names.get("mixed"), "S11-S14-20260521-UI-OQC");
  assert.equal(names.get("unknown"), "Unknown product-Unknown date-Unknown factory-Unknown stage");
  assert.equal(names.get("original"), "Recorded Batch 42");
  assert.ok(!names.get("model").includes("HIST"));
  assert.ok(!names.get("mixed").includes("DO-NOT-USE"));
  assert.ok(!names.get("model").includes("Original Batch 99"));
});

test("operational numbers remain exact and resolving names leaves stored state unchanged", () => {
  const operational = { id: "op-1", kind: "operational", number: "  Native-01  " };
  const historical = historicalBatch("hist-1", { number: "HIST-S15-20260521-UI-OQC-deadbeef-P1" });
  const state = stateFor([operational, historical]);
  const original = structuredClone(state);

  const names = resolveBatchDisplayNumbers(state);

  assert.equal(names.get("op-1"), "  Native-01  ");
  assert.equal(names.get("hist-1"), "S15-20260521-UI-OQC");
  assert.deepEqual(state, original);
  assert.equal(Object.hasOwn(state.batches[0], "displayNumber"), false);
  assert.equal(state.batches[1].number, "HIST-S15-20260521-UI-OQC-deadbeef-P1");
});

test("collisions are case-insensitive, stable by ID, and avoid native and natural suffix names", () => {
  const base = "S15-20260521-UI-OQC";
  const duplicateA = historicalBatch("a-duplicate");
  const duplicateB = historicalBatch("b-duplicate");
  const existingSuffix = historicalBatch("c-natural-suffix", { model: null });
  const operation = { id: "op-base", kind: "operational", number: base };
  const caseA = historicalBatch("d-case-a");
  const caseB = historicalBatch("e-case-b");
  const state = stateFor([duplicateB, existingSuffix, operation, duplicateA, caseB, caseA], {
    "c-natural-suffix": { originalBatchNumber: `${base}-01` },
    "d-case-a": { originalBatchNumber: "Archive-X" },
    "e-case-b": { originalBatchNumber: "archive-x" },
  });

  const first = resolveBatchDisplayNumbers(state);
  const reordered = resolveBatchDisplayNumbers({ ...state, batches: state.batches.slice().reverse() });

  assert.equal(first.get("op-base"), base);
  assert.equal(first.get("a-duplicate"), `${base}-02`);
  assert.equal(first.get("b-duplicate"), `${base}-03`);
  assert.equal(first.get("c-natural-suffix"), `${base}-01`);
  assert.equal(first.get("d-case-a"), "Archive-X-01");
  assert.equal(first.get("e-case-b"), "archive-x-02");
  assert.deepEqual(sortedEntries(first), sortedEntries(reordered));
  assert.equal(new Set([...first.values()].map((name) => name.toLowerCase())).size, first.size);
});

test("batch workspace exposes the display name outside the persisted batch", () => {
  const batch = historicalBatch("detail", { model: "S15", rows: [] });
  const state = stateFor([batch]);
  const originalBatch = structuredClone(batch);

  const workspace = getBatchWorkspace(state, batch.id);

  assert.equal(workspace.displayNumber, "S15-20260521-UI-OQC");
  assert.deepEqual(workspace.batch, originalBatch);
  assert.equal(Object.hasOwn(workspace.batch, "displayNumber"), false);
});
