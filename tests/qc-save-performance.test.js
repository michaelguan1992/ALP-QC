import test from "node:test";
import assert from "node:assert/strict";
import { createQCService } from "../core/qc-service.js";
import { createQCHttpService } from "../core/qc-http-service.js";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";

const DATE = "2026-09-28";
const PNG_URL = "data:image/png;base64,iVBORw0KGgo=";
const PDF_URL = "data:application/pdf;base64,JVBERi0xLjQK";

function makeServiceHarness() {
  const base = createMemoryQCAdapter();
  let commits = 0;
  let nextId = 0;
  let nextSecond = 0;
  const adapter = {
    initialize: () => base.initialize(),
    readState: (options) => base.readState(options),
    transact(mutator, options) {
      return base.transact(mutator, options).then((result) => {
        commits += 1;
        return result;
      });
    },
    close: () => base.close(),
  };
  const service = createQCService(adapter, {
    idFactory: () => `save-test-${String(++nextId).padStart(4, "0")}`,
    now: () => new Date(Date.UTC(2026, 8, 28, 12, 0, nextSecond++)).toISOString(),
  });
  return {
    service,
    get commits() { return commits; },
  };
}

async function makeBatch(harness) {
  const { service } = harness;
  await service.initialize();
  await service.command("installAPReferences");
  let state = await service.getState();
  const version = state.versions.find((candidate) => candidate.familyId === "s15");
  await service.command("publishVersion", { id: version.id });
  state = await service.getState();
  const variant = state.variants.find((candidate) => candidate.model === "S15" && candidate.color === "Red");
  const orderResult = await service.command("createOrder", {
    number: "PO-SAVE-TEST",
    date: DATE,
    supplier: "Supplier",
    notes: "",
    lines: [{ variantId: variant.id, orderedQty: 500 }],
  });
  const order = (await service.getState()).orders.find((candidate) => candidate.id === orderResult.entityId);
  const batchResult = await service.command("createBatch", {
    number: "B-SAVE-TEST",
    orderId: order.id,
    lineId: order.lines[0].id,
    quantity: 100,
    versionId: version.id,
    factory: "AP",
    stage: "OQC",
    date: DATE,
    recorder: "Inspector",
    notes: "Original notes",
  });
  const workspace = await service.getBatchWorkspace(batchResult.entityId);
  return { batchId: batchResult.entityId, rows: workspace.rows, orderId: order.id };
}

test("saveBatchChanges writes many rows and details in one revision with one audit projection", async () => {
  const harness = makeServiceHarness();
  const { service } = harness;
  const { batchId, rows } = await makeBatch(harness);
  const firstSaveState = await service.getState();
  const firstSave = await service.saveBatchChanges({
    batchId,
    rows: [{ rowId: rows[0].id, defectiveQty: 0, actualTimeSeconds: 1.25, remarks: "Source check" }],
  }, firstSaveState.revision);
  assert.equal(firstSave.revision, firstSaveState.revision + 1);

  const issueResult = await service.command("createIssue", {
    title: "Seal concern",
    reportedBy: "Inspector",
    batchId,
    rowId: rows[0].id,
    files: [{ name: "seal.png", mimeType: "image/png", dataUrl: PNG_URL, category: "photo" }],
  });
  const before = await service.getState();
  const commitsBefore = harness.commits;
  const result = await service.saveBatchChanges({
    batchId,
    details: { date: DATE, recorder: "Updated inspector", notes: "Updated notes" },
    rows: [
      { rowId: rows[0].id, defectiveQty: 1, actualTimeSeconds: 0, remarks: "Measured at zero seconds" },
      { rowId: rows[1].id, defectiveQty: null, actualTimeSeconds: null, remarks: "Partial" },
    ],
  }, before.revision);

  assert.equal(harness.commits, commitsBefore + 1);
  assert.equal(result.revision, before.revision + 1);
  assert.equal(result.entityId, batchId);
  assert.deepEqual(Object.keys(result.changes).sort(), ["audit", "batches", "issues"]);
  assert.equal(result.changes.batches.length, 1);
  const savedBatch = result.changes.batches[0];
  assert.equal(savedBatch.recorder, "Updated inspector");
  assert.equal(savedBatch.notes, "Updated notes");
  assert.equal(savedBatch.rows.find((row) => row.id === rows[0].id).actualTimeSeconds, 0);
  assert.equal(savedBatch.rows.find((row) => row.id === rows[0].id).defectiveQty, 1);
  assert.notEqual(savedBatch.rows.find((row) => row.id === rows[0].id).savedAt, null);
  assert.equal(savedBatch.rows.find((row) => row.id === rows[1].id).actualTimeSeconds, null);
  assert.equal(savedBatch.rows.find((row) => row.id === rows[1].id).defectiveQty, null);
  assert.equal(savedBatch.rows.find((row) => row.id === rows[1].id).savedAt, null);

  const linkedIssue = result.changes.issues.find((issue) => issue.id === issueResult.entityId);
  assert.ok(linkedIssue);
  assert.equal(linkedIssue.sourceSnapshot.row.defectiveQty, 0);
  assert.equal(linkedIssue.sourceSnapshot.row.actualTimeSeconds, 1.25);
  assert.equal(result.changes.audit.length, 1);
  assert.equal(result.changes.audit[0].action, "saveBatchChanges");
  const after = await service.getState();
  assert.equal(after.revision, result.revision);
  assert.deepEqual(after.audit.at(-1), result.changes.audit[0]);
});

test("saveBatchChanges rejects invalid and stale writes without partial data or audit changes", async () => {
  const harness = makeServiceHarness();
  const { service } = harness;
  const { batchId, rows } = await makeBatch(harness);
  const before = await service.getState();
  const commitsBefore = harness.commits;
  await assert.rejects(service.saveBatchChanges({
    batchId,
    details: { date: DATE, recorder: "Should roll back", notes: "Should roll back" },
    rows: [
      { rowId: rows[0].id, defectiveQty: 0, actualTimeSeconds: 0, remarks: "Valid first edit" },
      { rowId: rows[1].id, defectiveQty: rows[1].inspectedQty + 1, actualTimeSeconds: 2, remarks: "Invalid" },
    ],
  }, before.revision), /cannot exceed inspection quantity/i);
  assert.equal(harness.commits, commitsBefore);
  assert.deepEqual(await service.getState(), before);

  const successful = await service.saveBatchChanges({
    batchId,
    rows: [{ rowId: rows[0].id, defectiveQty: null, actualTimeSeconds: null, remarks: "Partial" }],
  }, before.revision);
  const after = await service.getState();
  await assert.rejects(service.saveBatchChanges({
    batchId,
    rows: [{ rowId: rows[0].id, defectiveQty: 0, actualTimeSeconds: 0, remarks: "Stale" }],
  }, before.revision), /changed since your last view/i);
  assert.deepEqual(await service.getState(), after);
  assert.equal(successful.revision, after.revision);
});

test("lightweight state and batch workspace expose metadata while getAsset returns full content", async () => {
  const harness = makeServiceHarness();
  const { service } = harness;
  const { batchId, rows } = await makeBatch(harness);
  await service.command("setRowAttachment", {
    batchId,
    rowId: rows[0].id,
    category: "procedures",
    file: { name: "procedure.pdf", mimeType: "application/pdf", dataUrl: PDF_URL },
  });
  const state = await service.getState();
  const assetId = state.assets[0].id;
  const lightweight = await service.getState({ mode: "lightweight" });
  assert.equal(Object.hasOwn(lightweight.assets[0], "dataUrl"), false);
  assert.equal(lightweight.assets[0].decodedBytes, 9);
  assert.equal((await service.initialize({ mode: "lightweight" })).assets[0].dataUrl, undefined);
  assert.equal((await service.getAsset(assetId)).dataUrl, PDF_URL);

  const fullWorkspace = await service.getBatchWorkspace(batchId);
  assert.equal(fullWorkspace.rows[0].attachments.procedures.dataUrl, PDF_URL);
  const lightWorkspace = await service.getBatchWorkspace(batchId, { mode: "lightweight" });
  assert.equal(Object.hasOwn(lightWorkspace.rows[0].attachments.procedures, "dataUrl"), false);
  assert.equal(lightWorkspace.rows[0].attachments.procedures.decodedBytes, 9);
});

test("HTTP facade exposes explicit lightweight modes, batch change saves, and asset reads", async () => {
  const requests = [];
  const service = createQCHttpService({
    baseUrl: "http://127.0.0.1:4173",
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });

  await service.initialize({ mode: "lightweight" });
  await service.getState({ mode: "lightweight" });
  await service.getBatchWorkspace("batch /1");
  await service.getAsset("asset /1");
  await service.saveBatchChanges({ batchId: "batch /1", rows: [] }, 4);

  assert.deepEqual(requests.map(({ url }) => url), [
    "http://127.0.0.1:4173/api/qc/main/initialize",
    "http://127.0.0.1:4173/api/qc/main/state/lightweight",
    "http://127.0.0.1:4173/api/qc/main/batches/batch%20%2F1/lightweight",
    "http://127.0.0.1:4173/api/qc/main/assets/asset%20%2F1",
    "http://127.0.0.1:4173/api/qc/main/command",
  ]);
  assert.deepEqual(JSON.parse(requests[0].options.body), { mode: "lightweight" });
  assert.deepEqual(JSON.parse(requests[4].options.body), {
    type: "saveBatchChanges",
    data: { batchId: "batch /1", rows: [] },
    expectedRevision: 4,
  });
});
