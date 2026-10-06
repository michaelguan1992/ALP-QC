import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getSharedBatchVersionChoices } from "../core/qc-batch-versions.js";
import { resolveBatchDisplayNumbers } from "../core/qc-batch-display.js";
import { createQCService } from "../core/qc-service.js";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";

const LARK_PACKAGE = JSON.parse(readFileSync(new URL("../data/lark-import/version-history.v1.json", import.meta.url), "utf8"));
const DATE = "2026-10-01";
const TIMESTAMP = "2026-10-01T12:00:00.000Z";
const PDF_BYTES = Buffer.from("%PDF-1.4\n", "utf8");
const PDF_DATA_URL = `data:application/pdf;base64,${PDF_BYTES.toString("base64")}`;

function makeHarness() {
  let idNumber = 0;
  const service = createQCService(createMemoryQCAdapter(), {
    idFactory: () => `auto-number-test-${String(++idNumber).padStart(5, "0")}`,
    now: () => TIMESTAMP,
  });
  return {
    service,
    async state() { return service.getState(); },
    async command(type, data) {
      const state = await service.getState();
      return service.command(type, data, state.revision);
    },
  };
}

async function initializeWithRecordedVersions(harness) {
  await harness.service.initialize();
  await harness.command("importLarkVersionHistory", { package: LARK_PACKAGE });
  return harness.state();
}

function historicalPackage({ model = "S11", date = DATE, factory = "AP", stage = "OQC" } = {}) {
  const sourceId = "auto-number-history-source";
  const assetId = "auto-number-history-pdf";
  const inspectionId = "auto-number-history-inspection";
  return {
    format: "masterqc-pdf-history",
    formatVersion: 1,
    sources: [{
      id: sourceId,
      fileName: "auto-number-history.pdf",
      sha256: createHash("sha256").update(PDF_BYTES).digest("hex"),
      pageCount: 1,
      family: model === "S15" ? "s15" : "s11-s14",
      assetId,
      rawFileName: "auto-number-history.pdf",
    }],
    inspections: [{
      id: inspectionId,
      sourceId,
      page: 1,
      printedVersion: "26.4.24",
      printedDate: date,
      date,
      productLabel: model,
      model,
      color: null,
      factory,
      stage,
      batchQuantity: 10,
      recorder: null,
      notes: "",
      rows: [{
        no: 1,
        title: "Visual check",
        specification: "",
        devices: "",
        samplingPercent: null,
        recordingRule: "",
        timeSeconds: null,
        important: null,
        sourceInspectedQty: null,
        defectiveQty: null,
        sourceDefectiveRate: null,
        remarks: "",
        raw: {},
      }],
      anomalies: [],
      raw: {},
    }],
    assets: [{
      id: assetId,
      name: "auto-number-history.pdf",
      mimeType: "application/pdf",
      dataUrl: PDF_DATA_URL,
      kind: "document",
      batchId: null,
      rowId: null,
      versionId: null,
      createdAt: TIMESTAMP,
    }],
    versions: [],
    anomalies: [],
  };
}

async function addHistory(harness, options) {
  const state = await harness.state();
  return harness.service.importHistory(historicalPackage(options), state.revision);
}

async function createOrder(harness, variants, number = "PO-AUTO-NUMBER") {
  const result = await harness.command("createOrder", {
    number,
    date: DATE,
    supplier: "Supplier",
    notes: "",
    lines: variants.map((variant) => ({ variantId: variant.id, orderedQty: 500 })),
  });
  const state = await harness.state();
  return state.orders.find((order) => order.id === result.entityId);
}

function batchCommand(state, order, variants, { date = DATE, number, factory = "奥途莱 AP", stage = "OQC outgoing" } = {}) {
  const choices = getSharedBatchVersionChoices(state, variants.map((variant) => variant.id), factory, stage);
  assert.ok(choices.length, "the selected models should have a shared ready design version");
  const command = {
    orderId: order.id,
    products: variants.map((variant) => ({
      lineId: order.lines.find((line) => line.variantId === variant.id).id,
      quantity: 10,
    })),
    versionLabel: choices[0].label,
    factory,
    stage,
    date,
    recorder: "",
    notes: "",
  };
  if (number !== undefined) command.number = number;
  return command;
}

test("automatic numbers count each selected model once across colors and suffix actual collisions", async () => {
  const harness = makeHarness();
  let state = await initializeWithRecordedVersions(harness);
  const s11Red = state.variants.find((variant) => variant.model === "S11" && variant.color === "Red");
  const s11Yellow = state.variants.find((variant) => variant.model === "S11" && variant.color === "Yellow");
  const s12Red = state.variants.find((variant) => variant.model === "S12" && variant.color === "Red");
  const s13Red = state.variants.find((variant) => variant.model === "S13" && variant.color === "Red");
  const s14Red = state.variants.find((variant) => variant.model === "S14" && variant.color === "Red");
  const s15Red = state.variants.find((variant) => variant.model === "S15" && variant.color === "Red");
  const order = await createOrder(harness, [s15Red, s14Red, s13Red, s12Red, s11Yellow, s11Red]);

  const singleProduct = batchCommand(state, order, [s11Red]);
  const singleResult = await harness.command("createBatch", singleProduct);
  state = await harness.state();
  assert.equal(state.batches.find((batch) => batch.id === singleResult.entityId).number, "S1-20261001-AP-OQC");

  const twoColors = batchCommand(state, order, [s11Red, s11Yellow], { number: "  " });
  const twoColorsResult = await harness.command("createBatch", twoColors);
  state = await harness.state();
  assert.equal(state.batches.find((batch) => batch.id === twoColorsResult.entityId).number, "S1-20261001-AP-OQC-01");

  const repeat = batchCommand(state, order, [s11Red, s11Yellow], { number: "" });
  const repeatResult = await harness.command("createBatch", repeat);
  state = await harness.state();
  assert.equal(state.batches.find((batch) => batch.id === repeatResult.entityId).number, "S1-20261001-AP-OQC-02");

  const thirdCollision = batchCommand(state, order, [s11Red, s11Yellow]);
  const thirdResult = await harness.command("createBatch", thirdCollision);
  state = await harness.state();
  assert.equal(state.batches.find((batch) => batch.id === thirdResult.entityId).number, "S1-20261001-AP-OQC-03");

  const nextDate = batchCommand(state, order, [s11Red, s11Yellow], { date: "2026-10-02" });
  const nextDateResult = await harness.command("createBatch", nextDate);
  state = await harness.state();
  assert.equal(state.batches.find((batch) => batch.id === nextDateResult.entityId).number, "S1-20261002-AP-OQC");

  for (const [model, variant, date] of [
    ["S12", s12Red, "2026-10-03"],
    ["S13", s13Red, "2026-10-04"],
    ["S14", s14Red, "2026-10-05"],
  ]) {
    const result = await harness.command("createBatch", batchCommand(state, order, [variant], { date }));
    state = await harness.state();
    assert.equal(state.batches.find((batch) => batch.id === result.entityId).number, `S1-${date.replaceAll("-", "")}-AP-OQC`, `${model} should use the S1 prefix`);
  }

  const beforeMixedModel = await harness.state();
  await assert.rejects(harness.command("createBatch", batchCommand(beforeMixedModel, order, [s11Red, s15Red])), /one model only/i);
  assert.deepEqual(await harness.state(), beforeMixedModel);

  const backup = await harness.service.exportBackup();
  const restored = makeHarness();
  await restored.service.initialize();
  await restored.service.importBackup(backup, 0);
  assert.deepEqual((await restored.state()).batches, state.batches);
});

test("legacy explicit numbers are preserved and duplicate names reject atomically", async () => {
  const harness = makeHarness();
  const state = await initializeWithRecordedVersions(harness);
  const s11 = state.variants.find((variant) => variant.model === "S11" && variant.color === "Red");
  const order = await createOrder(harness, [s11], "PO-EXPLICIT-NUMBER");
  const explicit = {
    number: "Legacy-QC-Batch-7",
    orderId: order.id,
    lineId: order.lines[0].id,
    quantity: 10,
    factory: "AP",
    stage: "OQC",
    date: DATE,
    recorder: "",
    notes: "",
  };
  const result = await harness.command("createBatch", explicit);
  let saved = await harness.state();
  assert.equal(saved.batches.find((batch) => batch.id === result.entityId).number, "Legacy-QC-Batch-7");

  const beforeDuplicate = await harness.state();
  await assert.rejects(
    harness.command("createBatch", { ...explicit, number: "legacy-qc-batch-7" }),
    /Batch number must be unique/i,
  );
  assert.deepEqual(await harness.state(), beforeDuplicate);

  const explicitGeneratedBase = batchCommand(beforeDuplicate, order, [s11], { number: "s11-20261001-ap-oqc" });
  const explicitBaseResult = await harness.command("createBatch", explicitGeneratedBase);
  saved = await harness.state();
  assert.equal(saved.batches.find((batch) => batch.id === explicitBaseResult.entityId).number, "s11-20261001-ap-oqc");
  await assert.rejects(
    harness.command("createBatch", batchCommand(saved, order, [s11], { number: "S12-20261001-AP-OQC" })),
    /Batch number must be unique/i,
  );
  const automaticAfterCaseCollision = await harness.command("createBatch", batchCommand(saved, order, [s11]));
  assert.equal((await harness.state()).batches.find((batch) => batch.id === automaticAfterCaseCollision.entityId).number, "S1-20261001-AP-OQC-01");

  const beforeInvalid = await harness.state();
  await assert.rejects(
    harness.command("createBatch", batchCommand(beforeInvalid, order, [s11], { date: "2026-02-30" })),
    /real calendar date/i,
  );
  assert.deepEqual(await harness.state(), beforeInvalid);

  const invalidProduct = batchCommand(beforeInvalid, order, [s11]);
  invalidProduct.products[0].lineId = "not-a-line-in-this-order";
  await assert.rejects(harness.command("createBatch", invalidProduct), /Choose purchase order lines/i);
  assert.deepEqual(await harness.state(), beforeInvalid);
});

test("automatic and explicit numbers avoid resolved historical display names", async () => {
  const harness = makeHarness();
  let state = await initializeWithRecordedVersions(harness);
  await addHistory(harness, { model: "S11", date: DATE, factory: "AP", stage: "OQC" });
  state = await harness.state();
  const s11 = state.variants.find((variant) => variant.model === "S11" && variant.color === "Red");
  const order = await createOrder(harness, [s11], "PO-HISTORICAL-COLLISION");
  const historical = state.batches.find((batch) => batch.kind === "historical");
  const displayedHistoricalName = resolveBatchDisplayNumbers(state).get(historical.id);
  assert.equal(displayedHistoricalName, "S1-20261001-AP-OQC");

  const beforeExplicitCollision = await harness.state();
  await assert.rejects(
    harness.command("createBatch", batchCommand(beforeExplicitCollision, order, [s11], { number: displayedHistoricalName })),
    /Batch number must be unique/i,
  );
  assert.deepEqual(await harness.state(), beforeExplicitCollision);

  const result = await harness.command("createBatch", batchCommand(beforeExplicitCollision, order, [s11]));
  state = await harness.state();
  assert.equal(state.batches.find((batch) => batch.id === result.entityId).number, `${displayedHistoricalName}-01`);
});

test("automatic names reserve legacy raw numbers and all canonical operational displays", async () => {
  const harness = makeHarness();
  const state = await initializeWithRecordedVersions(harness);
  const s11 = state.variants.find((variant) => variant.model === "S11" && variant.color === "Red");
  const s12 = state.variants.find((variant) => variant.model === "S12" && variant.color === "Red");
  const order = await createOrder(harness, [s11, s12], "PO-LEGACY-DISPLAY-COLLISION");

  await harness.command("createBatch", batchCommand(state, order, [s11], { number: "S11-20261001-AP-OQC" }));
  let saved = await harness.state();
  await harness.command("createBatch", batchCommand(saved, order, [s12], { number: "S1-20261001-AP-OQC-01" }));
  saved = await harness.state();

  const result = await harness.command("createBatch", batchCommand(saved, order, [s11]));
  const finalState = await harness.state();
  assert.equal(finalState.batches.find((batch) => batch.id === result.entityId).number, "S1-20261001-AP-OQC-02");
  assert.deepEqual(
    finalState.batches.filter((batch) => batch.kind !== "historical").slice(0, 2).map((batch) => batch.number),
    ["S11-20261001-AP-OQC", "S1-20261001-AP-OQC-01"],
  );
});
