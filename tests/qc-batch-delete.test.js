import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createQCService, QC_COMMAND_TYPES } from "../core/qc-service.js";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";

const DATE = "2026-10-01";
const PNG_URL = "data:image/png;base64,iVBORw0KGgo=";
const PDF_BYTES = Buffer.from("%PDF-1.4\n", "utf8");
const PDF_URL = `data:application/pdf;base64,${PDF_BYTES.toString("base64")}`;

function makeService() {
  let idNumber = 0;
  let timeNumber = 0;
  return createQCService(createMemoryQCAdapter(), {
    idFactory: () => `batch-delete-${String(++idNumber).padStart(5, "0")}`,
    now: () => new Date(Date.UTC(2026, 9, 1, 12, 0, timeNumber++)).toISOString(),
  });
}

async function prepareDraft(service, { batchNumber = "B-DELETE", orderNumber = "PO-DELETE" } = {}) {
  let state = await service.initialize();
  await service.command("installAPReferences", {}, state.revision);
  state = await service.getState();
  const version = state.versions.find((candidate) => candidate.familyId === "s15");
  await service.command("publishVersion", { id: version.id }, state.revision);
  state = await service.getState();
  const variant = state.variants.find((candidate) => candidate.model === "S15" && candidate.color === "Red");
  const orderResult = await service.command("createOrder", {
    number: orderNumber,
    date: DATE,
    supplier: "Supplier",
    notes: "",
    lines: [{ variantId: variant.id, orderedQty: 100 }],
  }, state.revision);
  state = await service.getState();
  const order = state.orders.find((candidate) => candidate.id === orderResult.entityId);
  const batchResult = await service.command("createBatch", {
    number: batchNumber,
    orderId: order.id,
    lineId: order.lines[0].id,
    quantity: 100,
    versionId: version.id,
    factory: "AP",
    stage: "OQC",
    date: DATE,
    recorder: "Inspector",
  }, state.revision);
  const batch = (await service.getState()).batches.find((candidate) => candidate.id === batchResult.entityId);
  return { batch, order, variant, version };
}

function historicalPackage() {
  const sourceId = "batch-delete-history-source";
  const assetId = "batch-delete-history-pdf";
  const inspectionId = "batch-delete-history-inspection";
  return {
    format: "masterqc-pdf-history",
    formatVersion: 1,
    sources: [{
      id: sourceId,
      fileName: "archived.pdf",
      sha256: createHash("sha256").update(PDF_BYTES).digest("hex"),
      pageCount: 1,
      family: "s15",
      assetId,
    }],
    inspections: [{
      id: inspectionId,
      sourceId,
      page: 1,
      printedVersion: "25.10.29",
      printedDate: "2026/09/20",
      date: "2026-09-20",
      productLabel: "S15",
      model: "S15",
      color: null,
      factory: "AP",
      stage: "OQC",
      batchQuantity: 10,
      recorder: null,
      notes: "Archived original.",
      rows: [{
        no: 1,
        title: "Visual inspection",
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
        raw: {},
      }],
      anomalies: [],
      raw: {},
    }],
    assets: [{
      id: assetId,
      name: "archived.pdf",
      mimeType: "application/pdf",
      dataUrl: PDF_URL,
      kind: "document",
      batchId: null,
      rowId: null,
      versionId: null,
      createdAt: "2026-09-20T12:00:00.000Z",
    }],
    versions: [],
    anomalies: [],
  };
}

test("deleteBatch is allowlisted, removes owned draft photos, and preserves batch library documents", async () => {
  assert.ok(QC_COMMAND_TYPES.includes("deleteBatch"));
  const source = makeService();
  const { batch, version } = await prepareDraft(source);
  const row = (await source.getBatchWorkspace(batch.id)).rows[0];
  await source.command("addPhotos", {
    batchId: batch.id,
    rowId: row.id,
    files: [{ name: "owned-evidence.png", mimeType: "image/png", dataUrl: PNG_URL }],
  }, (await source.getState()).revision);
  await source.command("setRowAttachment", {
    batchId: batch.id,
    rowId: row.id,
    category: "procedures",
    file: { name: "owned-procedure.pdf", mimeType: "application/pdf", dataUrl: PDF_URL },
  }, (await source.getState()).revision);
  await source.command("addBatchAttachment", {
    batchId: batch.id,
    name: "batch-note.pdf",
    mimeType: "application/pdf",
    dataUrl: PDF_URL,
  }, (await source.getState()).revision);
  const attachmentAssetId = (await source.getState()).assets.find((asset) => asset.name === "batch-note.pdf")?.id;
  assert.ok(attachmentAssetId);
  const libraryResult = await source.command("addDocument", {
    name: "version-reference.pdf",
    mimeType: "application/pdf",
    dataUrl: PDF_URL,
    versionId: version.id,
  }, (await source.getState()).revision);
  const backup = await source.exportBackup();
  backup.state.batches.find((candidate) => candidate.id === batch.id).attachmentIds.push(libraryResult.entityId);

  const restored = makeService();
  await restored.initialize();
  await restored.importBackup(backup, 0);
  const beforeDelete = await restored.getState();
  const photo = beforeDelete.assets.find((asset) => asset.kind === "photo" && asset.batchId === batch.id);
  const rowAttachment = beforeDelete.assets.find((asset) => asset.kind === "rowAttachment" && asset.batchId === batch.id);
  assert.ok(photo);
  assert.ok(rowAttachment);
  assert.ok(beforeDelete.assets.some((asset) => asset.id === attachmentAssetId));
  assert.ok(beforeDelete.assets.some((asset) => asset.id === libraryResult.entityId));

  const deleted = await restored.command("deleteBatch", { id: batch.id }, beforeDelete.revision);
  const afterDelete = await restored.getState();
  assert.equal(deleted.entityId, batch.id);
  assert.equal(afterDelete.batches.some((candidate) => candidate.id === batch.id), false);
  assert.equal(afterDelete.assets.some((asset) => asset.id === photo.id), false);
  assert.equal(afterDelete.assets.some((asset) => asset.id === rowAttachment.id), false);
  const attachedLibraryDocument = afterDelete.assets.find((asset) => asset.id === attachmentAssetId);
  const sharedVersionDocument = afterDelete.assets.find((asset) => asset.id === libraryResult.entityId);
  assert.ok(attachedLibraryDocument);
  assert.equal(attachedLibraryDocument.versionId, null);
  assert.ok(sharedVersionDocument);
  assert.equal(sharedVersionDocument.versionId, version.id);
  assert.ok(afterDelete.audit.some((event) => event.action === "deleteBatch" && event.entityId === batch.id && event.summary.includes(batch.number)));

  const beforeRepeat = await restored.getState();
  await assert.rejects(restored.command("deleteBatch", { id: batch.id }, beforeRepeat.revision), /no longer available/i);
  assert.deepEqual(await restored.getState(), beforeRepeat);
});

test("deleteBatch blocks linked issues, released batches, and historical source records atomically", async () => {
  const issueService = makeService();
  const { batch } = await prepareDraft(issueService, { batchNumber: "B-DELETE-ISSUE", orderNumber: "PO-DELETE-ISSUE" });
  let issueState = await issueService.getState();
  const issueWorkspace = await issueService.getBatchWorkspace(batch.id);
  const issueRow = issueWorkspace.rows[0];
  await issueService.command("saveInspection", {
    batchId: batch.id,
    rowId: issueRow.id,
    actualTimeSeconds: 0,
    defectiveQty: 0,
    remarks: "",
  }, issueState.revision);
  issueState = await issueService.getState();
  const issue = await issueService.command("createIssue", {
    reportedBy: "Inspector",
    title: "Retained issue",
    batchId: batch.id,
    rowId: issueRow.id,
    files: [{ name: "issue-dependency.png", mimeType: "image/png", dataUrl: PNG_URL, category: "photo" }],
  }, issueState.revision);
  issueState = await issueService.getState();
  await issueService.command("addIssueAttachments", {
    id: issue.entityId,
    files: [{ name: "issue-dependency.log", mimeType: "text/plain", dataUrl: "data:text/plain;base64,ZGVwZW5kZW5jeQ==", category: "file" }],
  }, issueState.revision);
  issueState = await issueService.getState();
  await assert.rejects(issueService.command("deleteBatch", { id: batch.id }, issueState.revision), /linked issue records/i);
  assert.deepEqual(await issueService.getState(), issueState);

  const releasedService = makeService();
  const { batch: releasedBatch } = await prepareDraft(releasedService, { batchNumber: "B-DELETE-RELEASED", orderNumber: "PO-DELETE-RELEASED" });
  let releasedState = await releasedService.getState();
  const releasedWorkspace = await releasedService.getBatchWorkspace(releasedBatch.id);
  for (const row of releasedWorkspace.rows) {
    await releasedService.command("saveInspection", {
      batchId: releasedBatch.id,
      rowId: row.id,
      actualTimeSeconds: 0,
      defectiveQty: 0,
      remarks: "",
    }, (await releasedService.getState()).revision);
  }
  await releasedService.command("releaseBatch", { id: releasedBatch.id }, (await releasedService.getState()).revision);
  releasedState = await releasedService.getState();
  await assert.rejects(releasedService.command("deleteBatch", { id: releasedBatch.id }, releasedState.revision), /released batches cannot be deleted/i);
  assert.deepEqual(await releasedService.getState(), releasedState);

  const historicalService = makeService();
  let historicalState = await historicalService.initialize();
  await historicalService.importHistory(historicalPackage(), historicalState.revision);
  historicalState = await historicalService.getState();
  const historicalBatch = historicalState.batches.find((candidate) => candidate.kind === "historical");
  await assert.rejects(historicalService.command("deleteBatch", { id: historicalBatch.id }, historicalState.revision), /historical.*cannot be deleted/i);
  assert.deepEqual(await historicalService.getState(), historicalState);
});
