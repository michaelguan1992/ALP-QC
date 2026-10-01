import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createQCService } from "../core/qc-service.js";
import { validateQCState } from "../core/qc-validation.js";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";

const DATE = "2026-09-30";
const PNG_URL = "data:image/png;base64,iVBORw0KGgo=";
const PDF_BYTES = Buffer.from("%PDF-1.4\n", "utf8");
const PDF_URL = `data:application/pdf;base64,${PDF_BYTES.toString("base64")}`;
const PDF_SHA256 = createHash("sha256").update(PDF_BYTES).digest("hex");
const SOURCE_TIME = "2026-09-14T12:00:00.000Z";

function makeHarness() {
  const base = createMemoryQCAdapter();
  let writes = 0;
  let idNumber = 0;
  let timeNumber = 0;
  const adapter = {
    initialize: () => base.initialize(),
    readState: () => base.readState(),
    transact(mutator) {
      return base.transact((state) => {
        const outcome = mutator(state);
        writes += 1;
        return outcome;
      });
    },
    close: () => base.close(),
  };
  const service = createQCService(adapter, {
    idFactory: () => `multi-product-test-${String(++idNumber).padStart(5, "0")}`,
    now: () => new Date(Date.UTC(2026, 8, 30, 12, 0, timeNumber++)).toISOString(),
  });
  return {
    service,
    get writes() { return writes; },
    async state() { return service.getState(); },
    async command(type, data = {}) {
      const state = await service.getState();
      return service.command(type, data, state.revision);
    },
  };
}

function variantFor(state, model, color = "Red") {
  const variant = state.variants.find((candidate) => candidate.model === model && candidate.color === color);
  assert.ok(variant, `missing ${model} ${color} variant`);
  return variant;
}

function versionFor(state, familyId) {
  const version = state.versions.find((candidate) => candidate.familyId === familyId && candidate.status === "published");
  assert.ok(version, `missing published version for ${familyId}`);
  return version;
}

async function prepare(harness) {
  await harness.service.initialize();
  await harness.command("installAPReferences");
  for (const version of (await harness.state()).versions) {
    await harness.command("publishVersion", { id: version.id });
  }
  const state = await harness.state();
  return {
    variants: {
      s11: variantFor(state, "S11"),
      s12: variantFor(state, "S12"),
      s13: variantFor(state, "S13"),
      s15Red: variantFor(state, "S15", "Red"),
      s15Yellow: variantFor(state, "S15", "Yellow"),
    },
    versions: {
      s11s14: versionFor(state, "s11-s14"),
      s15: versionFor(state, "s15"),
    },
  };
}

async function createOrder(harness, variants, { number = "PO-MULTI", orderedQty = 5000 } = {}) {
  const state = await harness.state();
  const selectedVariants = variants.map((variant) => state.variants.find((candidate) => candidate.id === variant.id));
  const result = await harness.command("createOrder", {
    number,
    date: DATE,
    supplier: "Supplier One",
    notes: "",
    lines: selectedVariants.map((variant) => ({ variantId: variant.id, orderedQty })),
  });
  const order = (await harness.state()).orders.find((candidate) => candidate.id === result.entityId);
  return {
    order,
    lineFor(variant) {
      const line = order.lines.find((candidate) => candidate.variantId === variant.id);
      assert.ok(line, `missing purchase order line for ${variant.label}`);
      return line;
    },
  };
}

async function createMultiBatch(harness, {
  order,
  products,
  number,
  date = DATE,
  countForPO,
  factory = "奥途莱 AP",
  stage = "OQC",
  recorder = "Inspector",
  notes = "",
}) {
  const command = {
    number,
    orderId: order.id,
    products: products.map(({ variant, quantity, versionId }) => ({
      lineId: order.lines.find((line) => line.variantId === variant.id)?.id,
      quantity,
      ...(versionId ? { versionId } : {}),
    })),
    factory,
    stage,
    date,
    recorder,
    notes,
  };
  if (countForPO !== undefined) command.countForPO = countForPO;
  const result = await harness.command("createBatch", command);
  return { id: result.entityId, order };
}

async function createLegacyBatch(harness, {
  order,
  line,
  variant,
  version,
  number,
  quantity,
  date,
  lotNumber,
  countForPO,
}) {
  const command = {
    number,
    orderId: order.id,
    lineId: line.id,
    quantity,
    factory: "奥途莱 AP",
    stage: "OQC",
    versionId: version.id,
    date,
    recorder: "Inspector",
    notes: "Legacy single-product entry.",
  };
  if (lotNumber !== undefined) command.lotNumber = lotNumber;
  if (countForPO !== undefined) command.countForPO = countForPO;
  const result = await harness.command("createBatch", command);
  return { id: result.entityId, order, line, variant, version };
}

async function saveRow(harness, batchId, row, defectiveQty = 0) {
  await harness.command("saveInspection", {
    batchId,
    rowId: row.id,
    defectiveQty,
    remarks: "Checked.",
  });
}

async function saveRows(harness, batchId, { exceptRowId = null } = {}) {
  const workspace = await harness.service.getBatchWorkspace(batchId);
  for (const row of workspace.rows) {
    if (row.id !== exceptRowId) await saveRow(harness, batchId, row);
  }
  return workspace;
}

function historicalPackage() {
  const source = {
    id: "history-source-multi-test",
    fileName: "S15-archive-test.pdf",
    sha256: PDF_SHA256,
    pageCount: 1,
    family: "s15",
    assetId: "history-asset-multi-test",
  };
  return {
    format: "masterqc-pdf-history",
    formatVersion: 1,
    sources: [source],
    inspections: [{
      id: "history-inspection-multi-test",
      sourceId: source.id,
      page: 1,
      printedVersion: "25.10.29",
      printedDate: "2026/09/14",
      date: "2026-09-14",
      productLabel: "S15",
      model: "S15",
      color: null,
      factory: "AP",
      stage: "IQC",
      batchQuantity: 10,
      recorder: null,
      notes: "Imported historical record.",
      rows: [{
        no: 1,
        title: "Historical visual check",
        specification: "Inspect the visible surface.",
        devices: "Visual inspection",
        samplingPercent: 100,
        recordingRule: "Record all defects.",
        timeSeconds: null,
        important: false,
        sourceInspectedQty: 10,
        defectiveQty: 0,
        sourceDefectiveRate: 0,
        remarks: "",
        raw: { sourceInspectedQtyText: "10" },
      }],
      anomalies: [],
      raw: { printedHeaderQuantity: "10" },
    }],
    assets: [{
      id: source.assetId,
      name: source.fileName,
      mimeType: "application/pdf",
      dataUrl: PDF_URL,
      kind: "document",
      batchId: null,
      rowId: null,
      versionId: null,
      createdAt: SOURCE_TIME,
    }],
    versions: [],
    anomalies: [],
  };
}

test("one batch locks standards and sample quantities separately for each PO product line", async () => {
  const harness = makeHarness();
  const { variants, versions } = await prepare(harness);
  const { order } = await createOrder(harness, [variants.s11, variants.s12, variants.s15Yellow]);
  const products = [
    { variant: variants.s11, quantity: 123, versionId: versions.s11s14.id },
    { variant: variants.s12, quantity: 47, versionId: versions.s11s14.id },
    { variant: variants.s15Yellow, quantity: 20, versionId: versions.s15.id },
  ];
  const created = await createMultiBatch(harness, { order, products, number: "B-MIXED-LOCK" });
  const state = await harness.state();
  const batch = state.batches.find((candidate) => candidate.id === created.id);
  const workspace = await harness.service.getBatchWorkspace(created.id);

  assert.equal(batch.quantity, 190);
  assert.deepEqual(batch.products, products.map(({ variant, quantity, versionId }) => ({
    lineId: order.lines.find((line) => line.variantId === variant.id).id,
    variantId: variant.id,
    familyId: variant.familyId,
    quantity,
    versionId,
    versionLabel: state.versions.find((version) => version.id === versionId).label,
  })));
  for (const field of ["lineId", "variantId", "familyId", "versionId", "versionLabel"]) assert.equal(batch[field], null);

  assert.equal(workspace.products.length, 3);
  for (const expected of products) {
    const line = order.lines.find((candidate) => candidate.variantId === expected.variant.id);
    const resolved = workspace.products.find((product) => product.lineId === line.id);
    assert.equal(resolved.variant.id, expected.variant.id);
    assert.equal(resolved.variant.label, expected.variant.label);
    assert.equal(resolved.version.id, expected.versionId);
    assert.equal(resolved.versionLabel, state.versions.find((version) => version.id === expected.versionId).label);
    assert.equal(resolved.quantity, expected.quantity);

    const rows = workspace.rows.filter((row) => row.productLineId === line.id);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => row.productLabel === expected.variant.label));
    assert.ok(rows.every((row) => row.productQuantity === expected.quantity));
    assert.ok(rows.every((row) => row.versionId === expected.versionId));
    assert.ok(rows.every((row) => row.versionLabel === resolved.version.label));
    assert.ok(rows.every((row) => row.sourceItemId && row.id !== row.sourceItemId));
    assert.ok(rows.every((row) => row.inspectedQty === Math.ceil(expected.quantity * row.samplingPercent / 100)));
  }

  const line11 = order.lines.find((line) => line.variantId === variants.s11.id);
  const line12 = order.lines.find((line) => line.variantId === variants.s12.id);
  const rows11 = workspace.rows.filter((row) => row.productLineId === line11.id);
  const rows12 = workspace.rows.filter((row) => row.productLineId === line12.id);
  assert.equal(rows11.find((row) => row.key === "air-pump").sourceItemId, rows12.find((row) => row.key === "air-pump").sourceItemId);
  assert.notEqual(rows11.find((row) => row.key === "air-pump").id, rows12.find((row) => row.key === "air-pump").id);
  assert.notEqual(rows11.find((row) => row.key === "air-pump").productLineId, rows12.find((row) => row.key === "air-pump").productLineId);
  assert.equal(rows11.find((row) => row.key === "power-test").specification.includes("32.3–34.0W"), true);
  assert.equal(rows12.find((row) => row.key === "power-test").specification.includes("30.1–31.8W"), true);
  assert.deepEqual(rows11.map((row) => row.inspectedQty), [13, 13, 13, 13]);
  assert.deepEqual(rows12.map((row) => row.inspectedQty), [5, 5, 5, 5]);

  const line15 = order.lines.find((line) => line.variantId === variants.s15Yellow.id);
  const rows15 = workspace.rows.filter((row) => row.productLineId === line15.id);
  assert.deepEqual(rows15.map((row) => row.inspectedQty), [2, 2, 2, 20]);
  assert.ok(rows15.every((row) => row.specification.includes("20 PSI") || row.key !== "leak-test"));
  assert.equal(new Set(workspace.rows.map((row) => row.id)).size, workspace.rows.length);
});

test("multi-product creation rejects invalid, foreign, or inapplicable product lines atomically", async () => {
  const harness = makeHarness();
  const { variants, versions } = await prepare(harness);
  const { order } = await createOrder(harness, [variants.s11, variants.s12, variants.s15Red]);
  const foreign = await createOrder(harness, [variants.s13], { number: "PO-FOREIGN" });
  const line11 = order.lines.find((line) => line.variantId === variants.s11.id);
  const line12 = order.lines.find((line) => line.variantId === variants.s12.id);
  const line15 = order.lines.find((line) => line.variantId === variants.s15Red.id);
  const valid = [
    { lineId: line11.id, quantity: 10, versionId: versions.s11s14.id },
    { lineId: line12.id, quantity: 10, versionId: versions.s11s14.id },
  ];
  const attempts = [
    [{ ...valid[0], quantity: 4 }, { ...valid[0], quantity: 5 }],
    [{ lineId: "missing-line", quantity: 10, versionId: versions.s11s14.id }],
    [{ lineId: foreign.order.lines[0].id, quantity: 10, versionId: versions.s11s14.id }],
    [{ ...valid[0], quantity: 1.5 }],
    [{ ...valid[0], quantity: 0 }],
    [{ lineId: line11.id, quantity: 10, versionId: versions.s15.id }],
  ];

  for (const products of attempts) {
    const before = await harness.state();
    const writesBefore = harness.writes;
    await assert.rejects(harness.command("createBatch", {
      number: `B-INVALID-${before.batches.length}-${before.revision}`,
      orderId: order.id,
      products,
      factory: "奥途莱 AP",
      stage: "OQC",
      date: DATE,
      recorder: "Inspector",
    }));
    assert.equal(harness.writes, writesBefore);
    assert.deepEqual(await harness.state(), before);
  }

  const beforeInapplicable = await harness.state();
  const writesBeforeInapplicable = harness.writes;
  await assert.rejects(harness.command("createBatch", {
    number: "B-NO-AP-IQC-STANDARDS",
    orderId: order.id,
    products: [{ lineId: line15.id, quantity: 10, versionId: versions.s15.id }],
    factory: "Factory B",
    stage: "IQC",
    date: DATE,
    recorder: "Inspector",
  }));
  assert.equal(harness.writes, writesBeforeInapplicable);
  assert.deepEqual(await harness.state(), beforeInapplicable);
});

test("release waits for every product row and closed issues, then counts each released product once", async () => {
  const harness = makeHarness();
  const { variants, versions } = await prepare(harness);
  const { order } = await createOrder(harness, [variants.s11, variants.s12, variants.s15Yellow]);
  const line11 = order.lines.find((line) => line.variantId === variants.s11.id);
  const main = await createMultiBatch(harness, {
    order,
    number: "B-RELEASE-MIXED",
    products: [
      { variant: variants.s11, quantity: 31, versionId: versions.s11s14.id },
      { variant: variants.s12, quantity: 13, versionId: versions.s11s14.id },
      { variant: variants.s15Yellow, quantity: 7, versionId: versions.s15.id },
    ],
  });
  const draft = await createMultiBatch(harness, {
    order,
    number: "B-RELEASE-DRAFT",
    products: [{ variant: variants.s11, quantity: 4, versionId: versions.s11s14.id }],
  });
  const legacyOptOut = await createMultiBatch(harness, {
    order,
    number: "B-RELEASE-LEGACY-OPTOUT",
    countForPO: false,
    products: [{ variant: variants.s12, quantity: 100, versionId: versions.s11s14.id }],
  });
  assert.equal((await harness.state()).batches.find((batch) => batch.id === legacyOptOut.id).countForPO, true);

  let progress = await harness.service.getPurchaseOrderProgress(order.id);
  assert.ok(progress.lines.every((line) => line.releasedQty === 0 && line.batches.length === 0));

  const workspace = await harness.service.getBatchWorkspace(main.id);
  const unsavedRow = workspace.rows.find((row) => row.productLineId === line11.id);
  await saveRows(harness, main.id, { exceptRowId: unsavedRow.id });
  let beforeRelease = await harness.state();
  await assert.rejects(harness.command("releaseBatch", { id: main.id }), /save all .* inspection rows/i);
  assert.deepEqual(await harness.state(), beforeRelease);

  await saveRow(harness, main.id, unsavedRow);
  const issueRow = (await harness.service.getBatchWorkspace(main.id)).rows.find((row) => row.productLineId !== line11.id);
  const issue = await harness.command("createIssue", { title: "Mixed batch issue", batchId: main.id, rowId: issueRow.id });
  beforeRelease = await harness.state();
  await assert.rejects(harness.command("releaseBatch", { id: main.id }), /close all linked issues/i);
  assert.deepEqual(await harness.state(), beforeRelease);

  await harness.command("saveIssue", {
    id: issue.entityId,
    owner: "Quality lead",
    disposition: "Replace the affected component.",
    confirmations: ["One", "Two", "Three"],
  });
  await harness.command("closeIssue", { id: issue.entityId });
  await harness.command("releaseBatch", { id: main.id });

  for (const row of (await harness.service.getBatchWorkspace(legacyOptOut.id)).rows) await saveRow(harness, legacyOptOut.id, row);
  await harness.command("releaseBatch", { id: legacyOptOut.id });

  progress = await harness.service.getPurchaseOrderProgress(order.id);
  for (const [variant, expectedQty] of [[variants.s11, 31], [variants.s12, 113], [variants.s15Yellow, 7]]) {
    const line = progress.lines.find((candidate) => candidate.variantId === variant.id);
    assert.equal(line.releasedQty, expectedQty);
    assert.equal(line.remainingQty, 5000 - expectedQty);
    assert.deepEqual(line.batches.map((item) => item.id), variant.id === variants.s12.id ? [main.id, legacyOptOut.id] : [main.id]);
  }

  const releasedRevision = (await harness.state()).revision;
  await harness.command("releaseBatch", { id: main.id });
  assert.equal((await harness.state()).revision, releasedRevision);
  assert.equal((await harness.service.getPurchaseOrderProgress(order.id)).lines.find((line) => line.variantId === variants.s11.id).releasedQty, 31);
  assert.equal((await harness.state()).batches.find((batch) => batch.id === draft.id).status, "draft");
});

test("row photos and issue snapshots stay attached to the selected product in a mixed batch", async () => {
  const harness = makeHarness();
  const { variants, versions } = await prepare(harness);
  const { order } = await createOrder(harness, [variants.s11, variants.s12, variants.s15Yellow]);
  const products = [
    { variant: variants.s11, quantity: 40, versionId: versions.s11s14.id },
    { variant: variants.s12, quantity: 20, versionId: versions.s11s14.id },
    { variant: variants.s15Yellow, quantity: 10, versionId: versions.s15.id },
  ];
  const batch = await createMultiBatch(harness, { order, products, number: "B-ISSUE-PRODUCTS" });
  await saveRows(harness, batch.id);
  let workspace = await harness.service.getBatchWorkspace(batch.id);
  const line11 = order.lines.find((line) => line.variantId === variants.s11.id);
  const line12 = order.lines.find((line) => line.variantId === variants.s12.id);
  const row11 = workspace.rows.find((row) => row.productLineId === line11.id && row.key === "air-pump");
  const row12 = workspace.rows.find((row) => row.productLineId === line12.id && row.key === "air-pump");
  await harness.command("addPhotos", {
    batchId: batch.id,
    rowId: row11.id,
    files: [{ name: "s11-evidence.png", mimeType: "image/png", dataUrl: PNG_URL }],
  });
  await harness.command("addPhotos", {
    batchId: batch.id,
    rowId: row12.id,
    files: [{ name: "s12-evidence.png", mimeType: "image/png", dataUrl: PNG_URL }],
  });
  const rowIssue = await harness.command("createIssue", { title: "S12 air pump review", batchId: batch.id, rowId: row12.id });
  const batchIssue = await harness.command("createIssue", { title: "Mixed batch review", batchId: batch.id });
  const state = await harness.state();
  const storedBatch = state.batches.find((candidate) => candidate.id === batch.id);
  const s11PhotoId = storedBatch.rows.find((row) => row.id === row11.id).photoIds[0];
  const s12PhotoId = storedBatch.rows.find((row) => row.id === row12.id).photoIds[0];
  assert.notEqual(s11PhotoId, s12PhotoId);

  const snapshot = state.issues.find((issue) => issue.id === rowIssue.entityId).sourceSnapshot;
  const s12Line = order.lines.find((line) => line.variantId === variants.s12.id);
  const expectedS12 = {
    lineId: s12Line.id,
    variantId: variants.s12.id,
    variantLabel: variants.s12.label,
    versionId: versions.s11s14.id,
    versionLabel: versions.s11s14.label,
    quantity: 20,
  };
  assert.equal(snapshot.lineId, null);
  assert.equal(snapshot.variantId, null);
  assert.equal(snapshot.variantLabel, null);
  assert.equal(snapshot.familyId, null);
  assert.equal(snapshot.versionId, null);
  assert.equal(snapshot.versionLabel, null);
  assert.deepEqual(snapshot.products.find((product) => product.lineId === s12Line.id), expectedS12);
  assert.equal(snapshot.row.productLineId, s12Line.id);
  assert.equal(snapshot.row.variantId, variants.s12.id);
  assert.equal(snapshot.row.variantLabel, variants.s12.label);
  assert.equal(snapshot.row.versionId, versions.s11s14.id);
  assert.equal(snapshot.row.versionLabel, versions.s11s14.label);
  assert.equal(snapshot.row.productQuantity, 20);
  assert.deepEqual(snapshot.row.photoIds, [s12PhotoId]);
  assert.ok(!snapshot.row.photoIds.includes(s11PhotoId));

  const mixedSnapshot = state.issues.find((issue) => issue.id === batchIssue.entityId).sourceSnapshot;
  assert.equal(mixedSnapshot.row, null);
  assert.equal(mixedSnapshot.lineId, null);
  assert.equal(mixedSnapshot.variantId, null);
  assert.equal(mixedSnapshot.versionId, null);
  assert.equal(mixedSnapshot.products.length, 3);
  assert.deepEqual(mixedSnapshot.products.map((product) => product.quantity), [40, 20, 10]);

  workspace = await harness.service.getBatchWorkspace(batch.id);
  assert.deepEqual(workspace.rows.find((row) => row.id === row11.id).photos.map((photo) => photo.id), [s11PhotoId]);
  assert.deepEqual(workspace.rows.find((row) => row.id === row12.id).photos.map((photo) => photo.id), [s12PhotoId]);
});

test("inspection history links legacy and multi-product batches by variant and keeps colors separate", async () => {
  const harness = makeHarness();
  const { variants, versions } = await prepare(harness);
  const { order } = await createOrder(harness, [variants.s11, variants.s12, variants.s15Red, variants.s15Yellow]);
  const line11 = order.lines.find((line) => line.variantId === variants.s11.id);
  const line12 = order.lines.find((line) => line.variantId === variants.s12.id);
  const line15Red = order.lines.find((line) => line.variantId === variants.s15Red.id);
  const line15Yellow = order.lines.find((line) => line.variantId === variants.s15Yellow.id);
  const oldS11 = await createLegacyBatch(harness, {
    order, line: line11, variant: variants.s11, version: versions.s11s14,
    number: "B-LEGACY-S11", quantity: 100, date: "2026-09-20",
  });
  const oldS15Red = await createLegacyBatch(harness, {
    order, line: line15Red, variant: variants.s15Red, version: versions.s15,
    number: "B-LEGACY-S15-RED", quantity: 100, date: "2026-09-20",
  });
  const olderS11Row = (await harness.service.getBatchWorkspace(oldS11.id)).rows.find((row) => row.key === "air-pump");
  const olderS15Row = (await harness.service.getBatchWorkspace(oldS15Red.id)).rows.find((row) => row.key === "air-pump");
  await saveRow(harness, oldS11.id, olderS11Row, 1);
  await saveRow(harness, oldS15Red.id, olderS15Row, 1);

  const mixed = await createMultiBatch(harness, {
    order,
    number: "B-MIXED-HISTORY",
    date: "2026-09-25",
    products: [
      { variant: variants.s11, quantity: 80, versionId: versions.s11s14.id },
      { variant: variants.s12, quantity: 70, versionId: versions.s11s14.id },
      { variant: variants.s15Red, quantity: 60, versionId: versions.s15.id },
      { variant: variants.s15Yellow, quantity: 50, versionId: versions.s15.id },
    ],
  });
  const mixedWorkspace = await harness.service.getBatchWorkspace(mixed.id);
  for (const [line, variant] of [[line11, variants.s11], [line12, variants.s12], [line15Red, variants.s15Red], [line15Yellow, variants.s15Yellow]]) {
    const row = mixedWorkspace.rows.find((candidate) => candidate.productLineId === line.id && candidate.key === "air-pump");
    await saveRow(harness, mixed.id, row);
    const refreshed = await harness.service.getBatchWorkspace(mixed.id);
    const history = refreshed.rows.find((candidate) => candidate.id === row.id).history;
    if (variant.id === variants.s11.id) assert.deepEqual(history.map((item) => item.batchId), [oldS11.id]);
    else if (variant.id === variants.s15Red.id) assert.deepEqual(history.map((item) => item.batchId), [oldS15Red.id]);
    else assert.deepEqual(history, []);
  }

  const newestS11 = await createLegacyBatch(harness, {
    order, line: line11, variant: variants.s11, version: versions.s11s14,
    number: "B-LEGACY-S11-LATER", quantity: 25, date: "2026-09-29",
  });
  const newestS11Workspace = await harness.service.getBatchWorkspace(newestS11.id);
  const newestHistory = newestS11Workspace.rows.find((row) => row.key === "air-pump").history;
  assert.deepEqual(newestHistory.map((item) => item.batchId), [mixed.id, oldS11.id]);
  assert.equal(newestHistory[0].inspectedQty, 8);
  assert.equal(newestHistory[1].inspectedQty, 10);
});

test("purchase order lines used by a multi-product batch keep their variant identity and cannot be removed", async () => {
  const harness = makeHarness();
  const { variants, versions } = await prepare(harness);
  const { order } = await createOrder(harness, [variants.s11, variants.s12]);
  await createMultiBatch(harness, {
    order,
    number: "B-LOCKS-PO-LINES",
    products: [
      { variant: variants.s11, quantity: 20, versionId: versions.s11s14.id },
      { variant: variants.s12, quantity: 20, versionId: versions.s11s14.id },
    ],
  });
  const before = await harness.state();
  const line11 = order.lines.find((line) => line.variantId === variants.s11.id);
  const line12 = order.lines.find((line) => line.variantId === variants.s12.id);
  const yellowS11 = variantFor(before, "S11", "Yellow");

  await assert.rejects(harness.command("saveOrder", {
    id: order.id,
    number: order.number,
    date: order.date,
    supplier: order.supplier,
    notes: order.notes,
    lines: [
      { ...line11, variantId: yellowS11.id },
      line12,
    ],
  }), /used by a batch|product variant/i);
  assert.deepEqual(await harness.state(), before);

  await assert.rejects(harness.command("saveOrder", {
    id: order.id,
    number: order.number,
    date: order.date,
    supplier: order.supplier,
    notes: order.notes,
    lines: [line12],
  }), /used by a batch|cannot be removed/i);
  assert.deepEqual(await harness.state(), before);
});

test("persisted multi-product batches reject broken totals, row ownership, source links, or product-based sampling", async () => {
  const harness = makeHarness();
  const { variants, versions } = await prepare(harness);
  const { order } = await createOrder(harness, [variants.s11, variants.s12, variants.s15Yellow]);
  const created = await createMultiBatch(harness, {
    order,
    number: "B-TAMPER-CHECK",
    products: [
      { variant: variants.s11, quantity: 100, versionId: versions.s11s14.id },
      { variant: variants.s12, quantity: 50, versionId: versions.s11s14.id },
      { variant: variants.s15Yellow, quantity: 20, versionId: versions.s15.id },
    ],
  });
  const canonical = await harness.state();
  const batch = canonical.batches.find((candidate) => candidate.id === created.id);
  const rowFor = (state, variant) => {
    const product = state.batches.find((candidate) => candidate.id === created.id).products
      .find((candidate) => candidate.variantId === variant.id);
    return state.batches.find((candidate) => candidate.id === created.id).rows
      .find((row) => row.productLineId === product.lineId && row.key === "air-pump");
  };
  assert.doesNotThrow(() => validateQCState(canonical));

  const invalidStates = [];
  const wrongTotal = structuredClone(canonical);
  wrongTotal.batches.find((candidate) => candidate.id === created.id).quantity += 1;
  invalidStates.push(wrongTotal);

  const missingProductLine = structuredClone(canonical);
  delete rowFor(missingProductLine, variants.s11).productLineId;
  invalidStates.push(missingProductLine);

  const wrongProductLine = structuredClone(canonical);
  rowFor(wrongProductLine, variants.s11).productLineId = order.lines.find((line) => line.variantId === variants.s12.id).id;
  invalidStates.push(wrongProductLine);

  const missingSourceItem = structuredClone(canonical);
  delete rowFor(missingSourceItem, variants.s15Yellow).sourceItemId;
  invalidStates.push(missingSourceItem);

  const totalBasedSample = structuredClone(canonical);
  const totalBasedRow = rowFor(totalBasedSample, variants.s15Yellow);
  totalBasedRow.inspectedQty = Math.ceil(batch.quantity * totalBasedRow.samplingPercent / 100);
  invalidStates.push(totalBasedSample);

  for (const invalid of invalidStates) assert.throws(() => validateQCState(invalid));
  assert.deepEqual(await harness.state(), canonical);
});

test("backup round-trip preserves legacy and historical batches while restoring full multi-product evidence", async () => {
  const harness = makeHarness();
  const { variants, versions } = await prepare(harness);
  await harness.service.importHistory(historicalPackage(), (await harness.state()).revision);
  const historicalBefore = (await harness.state()).batches.find((batch) => batch.kind === "historical");
  assert.ok(historicalBefore);
  const { order } = await createOrder(harness, [variants.s11, variants.s12, variants.s15Yellow]);
  const line11 = order.lines.find((line) => line.variantId === variants.s11.id);
  const legacy = await createLegacyBatch(harness, {
    order, line: line11, variant: variants.s11, version: versions.s11s14,
    number: "B-BACKUP-LEGACY", quantity: 40, date: "2026-09-20",
  });
  const legacyBefore = (await harness.state()).batches.find((batch) => batch.id === legacy.id);
  const multi = await createMultiBatch(harness, {
    order,
    number: "B-BACKUP-MULTI",
    products: [
      { variant: variants.s11, quantity: 30, versionId: versions.s11s14.id },
      { variant: variants.s12, quantity: 25, versionId: versions.s11s14.id },
      { variant: variants.s15Yellow, quantity: 15, versionId: versions.s15.id },
    ],
  });
  const sourceState = await harness.state();
  assert.deepEqual(sourceState.batches.find((batch) => batch.id === legacy.id), legacyBefore);
  assert.deepEqual(sourceState.batches.find((batch) => batch.id === historicalBefore.id), historicalBefore);
  assert.equal(sourceState.batches.find((batch) => batch.id === multi.id).products.length, 3);
  assert.equal(sourceState.batches.find((batch) => batch.id === multi.id).lotNumber == null, true);

  const backup = await harness.service.exportBackup();
  const target = makeHarness();
  await target.service.initialize();
  await target.service.importBackup(backup, 0);
  const restored = await target.state();
  assert.deepEqual(restored.batches, sourceState.batches);
  assert.deepEqual(restored.history, sourceState.history);
  assert.deepEqual(restored.assets, sourceState.assets);
  assert.deepEqual(restored.orders, sourceState.orders);
  assert.deepEqual(restored.batches.find((batch) => batch.id === legacy.id), legacyBefore);
  assert.deepEqual(restored.batches.find((batch) => batch.id === historicalBefore.id), historicalBefore);
  assert.deepEqual(restored.batches.find((batch) => batch.id === multi.id).products, sourceState.batches.find((batch) => batch.id === multi.id).products);
});
