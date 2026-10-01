import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createInitialQCState } from "../core/qc-domain.js";
import { getBatchVersions, getSharedBatchVersionChoices } from "../core/qc-batch-versions.js";
import { createQCService } from "../core/qc-service.js";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";

const LARK_PACKAGE = JSON.parse(readFileSync(new URL("../data/lark-import/version-history.v1.json", import.meta.url), "utf8"));
const DATE = "2026-10-01";

function makeHarness() {
  const adapter = createMemoryQCAdapter();
  let idNumber = 0;
  let timeNumber = 0;
  const service = createQCService(adapter, {
    idFactory: () => `shared-version-test-${String(++idNumber).padStart(5, "0")}`,
    now: () => new Date(Date.UTC(2026, 9, 1, 12, 0, timeNumber++)).toISOString(),
  });
  return {
    service,
    async state() { return service.getState(); },
    async command(type, data = {}) {
      const state = await service.getState();
      return service.command(type, data, state.revision);
    },
  };
}

async function importHistory(harness) {
  await harness.service.initialize();
  await harness.command("importLarkVersionHistory", { package: LARK_PACKAGE });
  return harness.state();
}

function makeReadyVersion(state, { id, familyId, model, label, sequence, effectiveDate }) {
  return {
    id,
    familyId,
    label,
    sequence,
    effectiveDate,
    status: "published",
    items: [{
      id: `${id}-item`,
      key: `${id}-key`,
      no: 1,
      title: "Inspection check",
      titleZh: "",
      specification: "Required criteria",
      specificationZh: "",
      devices: "",
      factory: "AP",
      stage: "OQC",
      models: [model],
      samplingPercent: 10,
      recordingRule: "",
      important: false,
      timeSeconds: null,
      procedureUrl: "",
    }],
  };
}

function orderVersionsByFamily(choice) {
  return new Map(choice.versions.map(({ familyId, versionId }) => [familyId, versionId]));
}

test("shared choices use each family's dated version history, then sequence, not labels or unrelated counts", () => {
  const state = createInitialQCState();
  state.versions.push(
    makeReadyVersion(state, { id: "s11-a", familyId: "s11-s14", model: "S11", label: "A", sequence: 1, effectiveDate: "2026-04-28" }),
    makeReadyVersion(state, { id: "s15-a", familyId: "s15", model: "S15", label: "A", sequence: 1, effectiveDate: "2026-04-20" }),
    makeReadyVersion(state, { id: "s11-z", familyId: "s11-s14", model: "S11", label: "Z", sequence: 8, effectiveDate: "2026-04-21" }),
    makeReadyVersion(state, { id: "s15-z", familyId: "s15", model: "S15", label: "Z", sequence: 7, effectiveDate: "2026-04-23" }),
    makeReadyVersion(state, { id: "s11-b", familyId: "s11-s14", model: "S11", label: "B", sequence: 5, effectiveDate: "2026-04-22" }),
    makeReadyVersion(state, { id: "s15-b", familyId: "s15", model: "S15", label: "B", sequence: 5, effectiveDate: "2026-04-21" }),
    makeReadyVersion(state, { id: "s11-unknown-date", familyId: "s11-s14", model: "S11", label: "Unknown date", sequence: 99, effectiveDate: null }),
    makeReadyVersion(state, { id: "s15-unknown-date", familyId: "s15", model: "S15", label: "Unknown date", sequence: 99, effectiveDate: "2026-09-25" }),
  );
  for (let index = 0; index < 40; index += 1) {
    state.versions.push(makeReadyVersion(state, {
      id: `unrelated-${index}`,
      familyId: "s11-s14",
      model: "S11",
      label: `Unrelated ${index}`,
      sequence: 100 + index,
      effectiveDate: "2026-09-01",
    }));
  }

  const s11 = state.variants.find((variant) => variant.model === "S11" && variant.color === "Red");
  const s15 = state.variants.find((variant) => variant.model === "S15" && variant.color === "Red");
  const labels = getSharedBatchVersionChoices(state, [s11.id, s15.id], "AP", "OQC").map((choice) => choice.label);
  assert.deepEqual(labels, ["Z", "B", "A", "Unknown date"]);
});

test("shared choices are empty when selected families have no common label", () => {
  const state = createInitialQCState();
  state.versions.push(
    makeReadyVersion(state, { id: "s11-only", familyId: "s11-s14", model: "S11", label: "Only S11", sequence: 1, effectiveDate: "2026-04-24" }),
    makeReadyVersion(state, { id: "s15-only", familyId: "s15", model: "S15", label: "Only S15", sequence: 1, effectiveDate: "2026-04-24" }),
  );
  const s11 = state.variants.find((variant) => variant.model === "S11" && variant.color === "Red");
  const s15 = state.variants.find((variant) => variant.model === "S15" && variant.color === "Red");

  assert.deepEqual(getSharedBatchVersionChoices(state, [s11.id, s15.id], "AP", "OQC"), []);
});

test("shared choices hide a recorded version with overlapping projected inspection items", async () => {
  const harness = makeHarness();
  const state = await importHistory(harness);
  const s11 = state.variants.find((variant) => variant.model === "S11" && variant.color === "Red");
  const s15 = state.variants.find((variant) => variant.model === "S15" && variant.color === "Red");
  const choices = getSharedBatchVersionChoices(state, [s11.id, s15.id], "AP", "OQC");

  assert.deepEqual(choices.map((choice) => choice.label), ["26.4.24"]);
  assert.ok(!choices.some((choice) => choice.label === "25.10.29"));
  const versionIds = orderVersionsByFamily(choices[0]);
  assert.notEqual(versionIds.get("s11-s14"), versionIds.get("s15"));
  assert.equal(state.versions.find((version) => version.id === versionIds.get("s11-s14")).label, choices[0].label);
  assert.equal(state.versions.find((version) => version.id === versionIds.get("s15")).label, choices[0].label);
});

test("shared createBatch locks the selected model color lines and keeps an older choice selectable", async () => {
  const harness = makeHarness();
  const state = await importHistory(harness);
  const variants = {
    s11: state.variants.find((variant) => variant.model === "S11" && variant.color === "Red"),
    s11Yellow: state.variants.find((variant) => variant.model === "S11" && variant.color === "Yellow"),
  };
  const choices = getSharedBatchVersionChoices(state, [variants.s11.id, variants.s11Yellow.id], "AP", "OQC");
  const manualChoice = choices.find((choice) => choice.label === "26.4.24");
  assert.ok(manualChoice);
  assert.ok(getBatchVersions(state, "s11-s14")[0].label !== manualChoice.label);
  const familyVersionIds = orderVersionsByFamily(manualChoice);
  const orderResult = await harness.command("createOrder", {
    number: "PO-SHARED-VERSION",
    date: DATE,
    supplier: "Supplier",
    notes: "",
    lines: [
      { variantId: variants.s11.id, orderedQty: 500 },
      { variantId: variants.s11Yellow.id, orderedQty: 500 },
    ],
  });
  const order = (await harness.state()).orders.find((candidate) => candidate.id === orderResult.entityId);
  const lineFor = (variant) => order.lines.find((line) => line.variantId === variant.id);
  const batchResult = await harness.command("createBatch", {
    number: "B-SHARED-VERSION",
    orderId: order.id,
    products: [
      { lineId: lineFor(variants.s11).id, quantity: 23 },
      { lineId: lineFor(variants.s11Yellow).id, quantity: 47 },
    ],
    versionLabel: manualChoice.label,
    factory: "AP",
    stage: "OQC",
    date: DATE,
    recorder: "Inspector",
  });
  let saved = await harness.state();
  const batch = saved.batches.find((candidate) => candidate.id === batchResult.entityId);
  const sourceVersions = new Map(saved.versions.map((version) => [version.id, structuredClone(version)]));
  assert.equal(batch.versionId, null);
  assert.equal(batch.versionLabel, manualChoice.label);
  assert.deepEqual(batch.products.map((product) => product.versionId), [familyVersionIds.get("s11-s14"), familyVersionIds.get("s11-s14")]);
  assert.equal(batch.products[0].versionId, batch.products[1].versionId);
  assert.ok(batch.products.every((product) => product.versionLabel === manualChoice.label));

  const workspace = await harness.service.getBatchWorkspace(batch.id);
  assert.deepEqual(workspace.products.map((product) => product.version.id), [familyVersionIds.get("s11-s14"), familyVersionIds.get("s11-s14")]);
  for (const expected of batch.products) {
    const rows = workspace.rows.filter((row) => row.productLineId === expected.lineId);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => row.versionId === expected.versionId));
    assert.ok(rows.every((row) => row.productQuantity === expected.quantity));
    assert.ok(rows.every((row) => row.inspectedQty === Math.ceil(expected.quantity * row.samplingPercent / 100)));
  }
  let progress = await harness.service.getPurchaseOrderProgress(order.id);
  assert.ok(progress.lines.every((line) => line.releasedQty === 0));
  for (const row of workspace.rows) {
    await harness.command("saveInspection", { batchId: batch.id, rowId: row.id, actualTimeSeconds: 0, defectiveQty: 0, remarks: "" });
  }
  await harness.command("releaseBatch", { id: batch.id });
  progress = await harness.service.getPurchaseOrderProgress(order.id);
  assert.equal(progress.lines.find((line) => line.variantId === variants.s11.id).releasedQty, 23);
  assert.equal(progress.lines.find((line) => line.variantId === variants.s11Yellow.id).releasedQty, 47);
  saved = await harness.state();
  for (const [versionId, sourceVersion] of sourceVersions) {
    assert.deepEqual(saved.versions.find((version) => version.id === versionId), sourceVersion);
  }
});

test("shared createBatch rejects missing labels and conflicting family IDs atomically", async () => {
  const harness = makeHarness();
  const state = await importHistory(harness);
  const s11 = state.variants.find((variant) => variant.model === "S11" && variant.color === "Red");
  const s11Yellow = state.variants.find((variant) => variant.model === "S11" && variant.color === "Yellow");
  const s15 = state.variants.find((variant) => variant.model === "S15" && variant.color === "Red");
  const selected = getSharedBatchVersionChoices(state, [s11.id, s11Yellow.id], "AP", "OQC").find((choice) => choice.label === "26.4.24");
  const latestS11 = getBatchVersions(state, "s11-s14")[0];
  const orderResult = await harness.command("createOrder", {
    number: "PO-SHARED-REJECTIONS",
    date: DATE,
    supplier: "Supplier",
    notes: "",
    lines: [{ variantId: s11.id, orderedQty: 100 }, { variantId: s11Yellow.id, orderedQty: 100 }, { variantId: s15.id, orderedQty: 100 }],
  });
  const order = (await harness.state()).orders.find((candidate) => candidate.id === orderResult.entityId);
  const lineFor = (variant) => order.lines.find((line) => line.variantId === variant.id);
  const baseCommand = {
    number: "B-SHARED-REJECTED",
    orderId: order.id,
    products: [{ lineId: lineFor(s11).id, quantity: 10 }, { lineId: lineFor(s11Yellow).id, quantity: 10 }],
    versionLabel: selected.label,
    factory: "AP",
    stage: "OQC",
    date: DATE,
    recorder: "Inspector",
  };
  const attempts = [
    { ...baseCommand, number: "B-SHARED-MISSING", versionLabel: "No common version" },
    { ...baseCommand, number: "B-SHARED-OVERLAPPING", versionLabel: "25.10.29" },
    { ...baseCommand, number: "B-SHARED-PRODUCT-ID", products: [{ ...baseCommand.products[0], versionId: latestS11.id }, baseCommand.products[1]] },
    { ...baseCommand, number: "B-SHARED-TOP-ID", versionId: latestS11.id },
  ];
  for (const command of attempts) {
    const before = await harness.state();
    await assert.rejects(harness.command("createBatch", command));
    assert.deepEqual(await harness.state(), before);
  }
});

test("new mixed-model batches reject atomically while imported legacy snapshots remain editable and releasable", async () => {
  const harness = makeHarness();
  const state = await importHistory(harness);
  const s11 = state.variants.find((variant) => variant.model === "S11" && variant.color === "Red");
  const s11Yellow = state.variants.find((variant) => variant.model === "S11" && variant.color === "Yellow");
  const s15 = state.variants.find((variant) => variant.model === "S15" && variant.color === "Red");
  const version11 = getBatchVersions(state, "s11-s14")[0];
  const version15 = getBatchVersions(state, "s15")[0];
  const orderResult = await harness.command("createOrder", {
    number: "PO-LEGACY-MIXED-VERSIONS",
    date: DATE,
    supplier: "Supplier",
    notes: "",
    lines: [{ variantId: s11.id, orderedQty: 100 }, { variantId: s11Yellow.id, orderedQty: 100 }, { variantId: s15.id, orderedQty: 100 }],
  });
  const order = (await harness.state()).orders.find((candidate) => candidate.id === orderResult.entityId);
  const line11 = order.lines.find((line) => line.variantId === s11.id);
  const line15 = order.lines.find((line) => line.variantId === s15.id);
  const original11Result = await harness.command("createBatch", {
    number: "B-LEGACY-S11-SOURCE",
    orderId: order.id,
    lineId: line11.id,
    quantity: 10,
    versionId: version11.id,
    factory: "AP",
    stage: "OQC",
    date: DATE,
    recorder: "Inspector",
  });
  const original15Result = await harness.command("createBatch", {
    number: "B-LEGACY-S15-SOURCE",
    orderId: order.id,
    lineId: line15.id,
    quantity: 10,
    versionId: version15.id,
    factory: "AP",
    stage: "OQC",
    date: DATE,
    recorder: "Inspector",
  });
  const afterSingles = await harness.state();
  const original11 = afterSingles.batches.find((candidate) => candidate.id === original11Result.entityId);
  const original15 = afterSingles.batches.find((candidate) => candidate.id === original15Result.entityId);

  const beforeMixedAttempt = await harness.state();
  const mixedAttempt = {
    number: "B-NEW-MIXED-MODEL-REJECTED",
    orderId: order.id,
    products: [
      { lineId: line11.id, quantity: 10, versionId: version11.id },
      { lineId: line15.id, quantity: 10, versionId: version15.id },
    ],
    factory: "AP",
    stage: "OQC",
    date: DATE,
    recorder: "Inspector",
  };
  await assert.rejects(harness.command("createBatch", mixedAttempt), /one model only/i);
  assert.deepEqual(await harness.state(), beforeMixedAttempt);
  const mixedId = "legacy-mixed-model-batch";
  const mixed = {
    ...structuredClone(original11),
    id: mixedId,
    number: "B-IMPORTED-MIXED-MODEL",
    lineId: null,
    variantId: null,
    familyId: null,
    versionId: null,
    versionLabel: null,
    quantity: original11.quantity + original15.quantity,
    products: [
      { lineId: line11.id, variantId: s11.id, familyId: "s11-s14", quantity: original11.quantity, versionId: version11.id, versionLabel: version11.label },
      { lineId: line15.id, variantId: s15.id, familyId: "s15", quantity: original15.quantity, versionId: version15.id, versionLabel: version15.label },
    ],
    rows: [
      ...original11.rows.map((row, index) => ({ ...structuredClone(row), id: `legacy-mixed-s11-${index}`, sourceItemId: row.id, productLineId: line11.id })),
      ...original15.rows.map((row, index) => ({ ...structuredClone(row), id: `legacy-mixed-s15-${index}`, sourceItemId: row.id, productLineId: line15.id })),
    ],
    attachmentIds: [],
  };
  const legacyBackup = await harness.service.exportBackup();
  legacyBackup.state.batches.push(mixed);
  const restoredService = createQCService(createMemoryQCAdapter());
  await restoredService.initialize();
  await restoredService.importBackup(legacyBackup, 0);
  let restored = await restoredService.getState();
  const imported = restored.batches.find((candidate) => candidate.id === mixedId);
  assert.equal(imported.versionLabel, null);
  assert.notEqual(imported.products[0].versionLabel, imported.products[1].versionLabel);
  const workspace = await restoredService.getBatchWorkspace(mixedId);
  assert.deepEqual(workspace.products.map((product) => product.variant.model), ["S11", "S15"]);
  assert.equal(workspace.rows.length, original11.rows.length + original15.rows.length);

  for (const row of workspace.rows) {
    await restoredService.command("saveInspection", {
      batchId: mixedId,
      rowId: row.id,
      actualTimeSeconds: 1.5,
      defectiveQty: 0,
      remarks: "Imported legacy row correction.",
    }, (await restoredService.getState()).revision);
  }
  await restoredService.command("releaseBatch", { id: mixedId }, (await restoredService.getState()).revision);
  restored = await restoredService.getState();
  assert.equal(restored.batches.find((candidate) => candidate.id === mixedId).status, "released");
  const progress = await restoredService.getPurchaseOrderProgress(order.id);
  assert.equal(progress.lines.find((line) => line.variantId === s11.id).releasedQty, 10);
  assert.equal(progress.lines.find((line) => line.variantId === s15.id).releasedQty, 10);

  const roundTripBackup = await restoredService.exportBackup();
  const roundTrip = createQCService(createMemoryQCAdapter());
  await roundTrip.initialize();
  await roundTrip.importBackup(roundTripBackup, 0);
  assert.deepEqual((await roundTrip.getState()).batches.find((candidate) => candidate.id === mixedId),
    (await restoredService.getState()).batches.find((candidate) => candidate.id === mixedId));
});
