import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createQCService, QC_COMMAND_TYPES } from "../core/qc-service.js";
import { deleteIssue } from "../core/qc-issues.js";
import { validateBackup, validateQCState } from "../core/qc-validation.js";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";
import { createSQLiteQCAdapter } from "../storage/sqlite-qc-adapter.mjs";

const DATE = "2026-10-01";
const PNG_URL = "data:image/png;base64,iVBORw0KGgo=";
const PDF_URL = "data:application/pdf;base64,JVBERi0xLjQK";

function makeService(adapter = createMemoryQCAdapter(), prefix = "issue-reporter-delete") {
  let idNumber = 0;
  let timeNumber = 0;
  return createQCService(adapter, {
    idFactory: () => `${prefix}-${String(++idNumber).padStart(5, "0")}`,
    now: () => new Date(Date.UTC(2026, 9, 1, 12, 0, timeNumber++)).toISOString(),
  });
}

async function createIssue(service, { reportedBy = "Inspector", title = "Surface defect", batchId, rowId, requestId } = {}) {
  const state = await service.getState();
  return service.command("createIssue", {
    reportedBy,
    title,
    ...(requestId ? { requestId } : {}),
    ...(batchId ? { batchId } : {}),
    ...(rowId ? { rowId } : {}),
    files: [{ name: "issue-photo.png", mimeType: "image/png", dataUrl: PNG_URL, category: "photo" }],
  }, state.revision);
}

async function prepareDraftBatch(service, number, orderNumber, quantity = 100) {
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
    lines: [{ variantId: variant.id, orderedQty: quantity }],
  }, state.revision);
  state = await service.getState();
  const order = state.orders.find((candidate) => candidate.id === orderResult.entityId);
  const batchResult = await service.command("createBatch", {
    number,
    orderId: order.id,
    lineId: order.lines[0].id,
    quantity,
    versionId: version.id,
    factory: "AP",
    stage: "OQC",
    date: DATE,
    recorder: "Inspector",
  }, state.revision);
  const batch = (await service.getState()).batches.find((candidate) => candidate.id === batchResult.entityId);
  const workspace = await service.getBatchWorkspace(batch.id);
  for (const row of workspace.rows) {
    state = await service.getState();
    await service.command("saveInspection", {
      batchId: batch.id,
      rowId: row.id,
      actualTimeSeconds: 0,
      defectiveQty: 0,
      remarks: "",
    }, state.revision);
  }
  return { batch, order, version, rows: workspace.rows };
}

test("new Issues require a trimmed nonblank reporter and reject invalid names atomically", async () => {
  const service = makeService();
  await service.initialize();
  const before = await service.getState();
  const photo = [{ name: "issue-photo.png", mimeType: "image/png", dataUrl: PNG_URL, category: "photo" }];
  const invalid = [
    [{ title: "Missing reporter", files: photo }, /Reported by is required/i],
    [{ reportedBy: undefined, title: "Undefined reporter", files: photo }, /Reported by must be text/i],
    [{ reportedBy: null, title: "Null reporter", files: photo }, /Reported by must be text/i],
    [{ reportedBy: 42, title: "Numeric reporter", files: photo }, /Reported by must be text/i],
    [{ reportedBy: "", title: "Blank reporter", files: photo }, /Reported by is required/i],
    [{ reportedBy: " \t\n ", title: "Whitespace reporter", files: photo }, /Reported by is required/i],
    [{ reportedBy: "a".repeat(201), title: "Long reporter", files: photo }, /Reported by must be 200 characters or fewer/i],
  ];
  for (const [payload, message] of invalid) {
    await assert.rejects(service.command("createIssue", payload, before.revision), message);
    assert.deepEqual(await service.getState(), before);
  }
  assert.equal((await service.command("createIssue", {
    reportedBy: "  李明  ",
    title: "Unicode reporter",
    files: photo,
  }, before.revision)).revision, before.revision + 1);
  assert.equal((await service.getState()).issues[0].reportedBy, "李明");
  await service.close();
});

test("reporter survives SQLite reopen and backup restore while legacy backups keep it absent", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "masterqc-issue-reporter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, "source.sqlite");
  const targetPath = path.join(directory, "target.sqlite");

  let source = makeService(createSQLiteQCAdapter({ databasePath: sourcePath }), "reporter-source");
  await source.initialize();
  const created = await createIssue(source, { reportedBy: "  李明  ", title: "Unicode reporter" });
  const expected = (await source.getState()).issues.find((issue) => issue.id === created.entityId);
  assert.equal(expected.reportedBy, "李明");
  const backup = await source.exportBackup();
  validateBackup(backup);
  await source.close();

  source = makeService(createSQLiteQCAdapter({ databasePath: sourcePath }), "reporter-source-reopened");
  await source.initialize();
  assert.equal((await source.getState()).issues.find((issue) => issue.id === created.entityId).reportedBy, "李明");

  let target = makeService(createSQLiteQCAdapter({ databasePath: targetPath }), "reporter-target");
  await target.initialize();
  await target.importBackup(backup, 0);
  assert.equal((await target.getState()).issues.find((issue) => issue.id === created.entityId).reportedBy, "李明");
  await target.close();

  const legacyBackup = structuredClone(backup);
  delete legacyBackup.state.issues.find((issue) => issue.id === created.entityId).reportedBy;
  validateBackup(legacyBackup);
  target = makeService(createSQLiteQCAdapter({ databasePath: path.join(directory, "legacy.sqlite") }), "reporter-legacy");
  await target.initialize();
  await target.importBackup(legacyBackup, 0);
  const legacyIssue = (await target.getState()).issues.find((issue) => issue.id === created.entityId);
  assert.equal(Object.hasOwn(legacyIssue, "reportedBy"), false);
  await target.close();
  await source.close();
});

test("deleteIssue removes only owned evidence, preserves batch facts, and never releases implicitly", async () => {
  assert.ok(QC_COMMAND_TYPES.includes("deleteIssue"));
  const service = makeService();
  const { batch, order, version, rows } = await prepareDraftBatch(service, "B-ISSUE-DELETE", "PO-ISSUE-DELETE");
  const row = rows[0];
  let state = await service.getState();
  await service.command("addPhotos", {
    batchId: batch.id,
    rowId: row.id,
    files: [{ name: "source-photo.png", mimeType: "image/png", dataUrl: PNG_URL }],
  }, state.revision);
  state = await service.getState();
  await service.command("setRowAttachment", {
    batchId: batch.id,
    rowId: row.id,
    category: "procedures",
    file: { name: "procedure.pdf", mimeType: "application/pdf", dataUrl: PDF_URL },
  }, state.revision);
  state = await service.getState();
  const sharedDocument = await service.command("addDocument", {
    name: "shared.pdf",
    mimeType: "application/pdf",
    dataUrl: PDF_URL,
    versionId: version.id,
  }, state.revision);
  const issue = await createIssue(service, {
    reportedBy: "Inspector",
    title: "Linked issue",
    batchId: batch.id,
    rowId: row.id,
    requestId: "issue-delete-row-request",
  });
  state = await service.getState();
  await service.command("addIssueAttachments", {
    id: issue.entityId,
    files: [{ name: "issue-note.log", mimeType: "text/plain", dataUrl: "data:text/plain;base64,bm90ZQ==", category: "file" }],
  }, state.revision);
  const sibling = await createIssue(service, { title: "Keep this issue" });
  state = await service.getState();
  const sourcePhotoId = state.batches.find((candidate) => candidate.id === batch.id).rows.find((candidate) => candidate.id === row.id).photoIds[0];
  const rowAttachmentId = state.batches.find((candidate) => candidate.id === batch.id).rows.find((candidate) => candidate.id === row.id).attachmentIds.procedures;
  const deletedAssetIds = state.issues.find((candidate) => candidate.id === issue.entityId).attachmentIds;

  await service.command("deleteIssue", { id: issue.entityId }, state.revision);
  state = await service.getState();
  assert.equal(state.issues.some((candidate) => candidate.id === issue.entityId), false);
  assert.ok(state.issues.some((candidate) => candidate.id === sibling.entityId));
  assert.ok(deletedAssetIds.every((id) => !state.assets.some((asset) => asset.id === id)));
  assert.ok(state.assets.some((asset) => asset.id === sourcePhotoId && asset.kind === "photo"));
  assert.ok(state.assets.some((asset) => asset.id === rowAttachmentId && asset.kind === "rowAttachment"));
  assert.ok(state.assets.some((asset) => asset.id === sharedDocument.entityId && asset.versionId === version.id));
  assert.equal(state.batches.find((candidate) => candidate.id === batch.id).status, "draft");
  assert.equal((await service.getPurchaseOrderProgress(order.id)).lines[0].releasedQty, 0);
  assert.ok(state.audit.some((event) => event.action === "deleteIssue" && event.entityId === issue.entityId));
  validateQCState(state);

  const beforeClosedDelete = await service.getState();
  await service.command("saveIssue", {
    id: sibling.entityId,
    owner: "Lead",
    disposition: "Reviewed",
    confirmations: ["One", "Two", "Three"],
  }, beforeClosedDelete.revision);
  state = await service.getState();
  await service.command("closeIssue", { id: sibling.entityId }, state.revision);
  state = await service.getState();
  await service.command("deleteIssue", { id: sibling.entityId }, state.revision);
  state = await service.getState();
  assert.equal(state.issues.length, 0);
  assert.equal(state.batches.find((candidate) => candidate.id === batch.id).status, "draft");
  assert.ok(state.assets.some((asset) => asset.id === sourcePhotoId));
  assert.ok(state.assets.some((asset) => asset.id === rowAttachmentId));
  const backup = await service.exportBackup();
  validateBackup(backup);
  const restored = makeService();
  await restored.initialize();
  await restored.importBackup(backup, 0);
  const restoredState = await restored.getState();
  assert.deepEqual(restoredState.issues, []);
  assert.ok(restoredState.assets.some((asset) => asset.id === sourcePhotoId));
  assert.ok(restoredState.assets.some((asset) => asset.id === rowAttachmentId));

  state = await service.getState();
  await service.command("releaseBatch", { id: batch.id }, state.revision);
  assert.equal((await service.getState()).batches.find((candidate) => candidate.id === batch.id).status, "released");
  await restored.close();
  await service.close();
});

test("deleteIssue rejects released links and permits historical Issue cleanup", async () => {
  const service = makeService();
  const { batch, rows } = await prepareDraftBatch(service, "B-ISSUE-DELETE-LOCK", "PO-ISSUE-DELETE-LOCK");
  const issue = await createIssue(service, { title: "Protected issue", batchId: batch.id });
  let state = await service.getState();
  await service.command("saveIssue", {
    id: issue.entityId,
    owner: "Lead",
    disposition: "Reviewed",
    confirmations: ["One", "Two", "Three"],
  }, state.revision);
  state = await service.getState();
  await service.command("closeIssue", { id: issue.entityId }, state.revision);
  state = await service.getState();
  await service.command("releaseBatch", { id: batch.id }, state.revision);
  state = await service.getState();
  await assert.rejects(service.command("deleteIssue", { id: issue.entityId }, state.revision), /released batches cannot be deleted/i);
  assert.deepEqual(await service.getState(), state);

  const historicalState = {
    issues: [{ id: "issue-historical", number: "ISS-HISTORICAL", batchId: "batch-historical" }],
    batches: [{ id: "batch-historical", kind: "historical", status: "historical" }],
    assets: [],
  };
  const historicalBatchBefore = structuredClone(historicalState.batches);
  assert.equal(deleteIssue(historicalState, { id: "issue-historical" }).entityId, "issue-historical");
  assert.deepEqual(historicalState.issues, []);
  assert.deepEqual(historicalState.batches, historicalBatchBefore);
  assert.deepEqual(historicalState.assets, []);
  await service.close();
});
