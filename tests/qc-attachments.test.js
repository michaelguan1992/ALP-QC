import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ASSET_TOTAL_MAX_BYTES, BACKUP_MAX_BYTES, DOCUMENT_MAX_BYTES, PHOTO_MAX_BYTES, createQCService, QC_COMMAND_TYPES } from "../core/qc-service.js";
import { validateBackup } from "../core/qc-validation.js";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";
import { createSQLiteQCAdapter } from "../storage/sqlite-qc-adapter.mjs";

const DATE = "2026-10-01";
const PNG_URL = "data:image/png;base64,iVBORw0KGgo=";
const PDF_URL = "data:application/pdf;base64,JVBERi0xLjQK";
const adapters = new WeakMap();

function fileDataUrl(mimeType, bytes, fill = 65) {
  return `data:${mimeType};base64,${Buffer.alloc(bytes, fill).toString("base64")}`;
}

function makeService(adapter = createMemoryQCAdapter()) {
  let id = 0;
  let second = 0;
  const service = createQCService(adapter, {
    idFactory: () => `attachment-test-${String(++id).padStart(7, "0")}`,
    now: () => new Date(Date.UTC(2026, 9, 1, 12, 0, second++)).toISOString(),
  });
  adapters.set(service, adapter);
  return service;
}

async function mutateStoredState(service, mutate) {
  return adapters.get(service).transact((state) => {
    mutate(state);
    return { state, result: null };
  });
}

async function command(service, type, data = {}) {
  const state = await service.getState();
  return service.command(type, data, state.revision);
}

async function prepareBatch(service, suffix = "ONE") {
  await service.initialize();
  await command(service, "installAPReferences");
  let state = await service.getState();
  for (const version of state.versions) await command(service, "publishVersion", { id: version.id });
  state = await service.getState();
  const variant = state.variants.find((item) => item.model === "S15" && item.color === "Red");
  const orderResult = await command(service, "createOrder", {
    number: `ATTACH-PO-${suffix}`,
    date: DATE,
    supplier: "Attachment supplier",
    notes: "",
    lines: [{ variantId: variant.id, orderedQty: 100 }],
  });
  state = await service.getState();
  const order = state.orders.find((candidate) => candidate.id === orderResult.entityId);
  const version = state.versions.find((candidate) => candidate.familyId === variant.familyId && candidate.status === "published");
  const batchResult = await command(service, "createBatch", {
    number: `ATTACH-B-${suffix}`,
    orderId: order.id,
    lineId: order.lines[0].id,
    quantity: 60,
    factory: "AP",
    stage: "OQC",
    versionId: version.id,
    date: DATE,
    recorder: "Inspector",
    notes: "",
  });
  const batchId = batchResult.entityId;
  const workspace = await service.getBatchWorkspace(batchId);
  for (const row of workspace.rows) {
    await command(service, "saveInspection", {
      batchId,
      rowId: row.id,
      defectiveQty: 0,
      actualTimeSeconds: 0,
      remarks: "Preserved earlier remark.",
    });
  }
  return { batchId, rowId: workspace.rows[0].id };
}

test("row attachment slots are isolated, replace atomically, and resolve in batch workspace", async () => {
  const service = makeService();
  const { batchId, rowId } = await prepareBatch(service, "ROW-SLOTS");
  const state = await service.getState();
  const secondRowId = state.batches.find((batch) => batch.id === batchId).rows[1].id;
  await command(service, "setRowAttachment", {
    batchId, rowId, category: "videos", file: { name: "proof.mp4", mimeType: "video/mp4", dataUrl: fileDataUrl("video/mp4", 3) },
  });
  const secondVideo = await command(service, "setRowAttachment", {
    batchId, rowId: secondRowId, category: "videos", file: { name: "other.webm", mimeType: "video/webm", dataUrl: fileDataUrl("video/webm", 3, 66) },
  });
  await command(service, "setRowAttachment", {
    batchId, rowId, category: "procedures", file: { name: "procedure.pdf", mimeType: "application/pdf", dataUrl: PDF_URL },
  });
  await command(service, "setRowAttachment", {
    batchId, rowId, category: "log", file: { name: "line.log", mimeType: "text/plain", dataUrl: "data:text/plain;base64,bG9n" },
  });

  let current = await service.getState();
  const firstRow = current.batches.find((batch) => batch.id === batchId).rows.find((row) => row.id === rowId);
  const otherRow = current.batches.find((batch) => batch.id === batchId).rows.find((row) => row.id === secondRowId);
  assert.deepEqual(Object.keys(firstRow.attachmentIds).sort(), ["log", "procedures", "videos"]);
  assert.ok(current.assets.some((asset) => asset.id === firstRow.attachmentIds.videos && asset.kind === "rowAttachment"));
  assert.notEqual(firstRow.attachmentIds.videos, otherRow.attachmentIds.videos);
  const workspace = await service.getBatchWorkspace(batchId);
  assert.equal(workspace.rows.find((row) => row.id === rowId).attachments.videos.name, "proof.mp4");
  assert.equal(workspace.rows.find((row) => row.id === rowId).attachments.procedures.name, "procedure.pdf");
  assert.equal(workspace.rows.find((row) => row.id === rowId).attachments.log.name, "line.log");
  assert.equal(workspace.rows.find((row) => row.id === secondRowId).attachments.videos.name, "other.webm");

  const originalVideoId = firstRow.attachmentIds.videos;
  const beforeInvalid = current;
  await assert.rejects(command(service, "setRowAttachment", {
    batchId, rowId, category: "videos", file: { name: "wrong.pdf", mimeType: "application/pdf", dataUrl: PDF_URL },
  }), /supported file types|category/i);
  assert.deepEqual(await service.getState(), beforeInvalid);

  await command(service, "setRowAttachment", {
    batchId, rowId, category: "videos", file: { name: "replacement.mov", mimeType: "video/quicktime", dataUrl: "data:video/quicktime;base64,bW92" },
  });
  current = await service.getState();
  assert.equal(current.assets.some((asset) => asset.id === originalVideoId), false);
  assert.equal(current.assets.filter((asset) => asset.kind === "rowAttachment" && asset.batchId === batchId && asset.rowId === rowId && asset.category === "videos").length, 1);
  await command(service, "removeRowAttachment", { batchId, rowId, category: "log" });
  const afterRemove = await service.getBatchWorkspace(batchId);
  assert.equal(afterRemove.rows.find((row) => row.id === rowId).attachments.log, null);
  await command(service, "releaseBatch", { id: batchId });
  await assert.rejects(command(service, "setRowAttachment", {
    batchId, rowId, category: "log", file: { name: "late.log", mimeType: "text/plain", dataUrl: "data:text/plain;base64,bGF0ZQ==" },
  }), /released.*read-only/i);
  await assert.rejects(command(service, "removeRowAttachment", { batchId, rowId: secondRowId, category: "videos" }), /released.*read-only/i);
  await service.close();
});

test("multiple row Issues have request-key idempotency and atomic evidence uploads", async () => {
  const service = makeService();
  const { batchId, rowId } = await prepareBatch(service, "MULTI-ISSUE");
  await command(service, "addPhotos", { batchId, rowId, files: [{ name: "legacy-row.png", mimeType: "image/png", dataUrl: PNG_URL }] });
  const request = {
    title: "Seal wear",
    description: "Visible marks around the seal.",
    requestId: "11111111-1111-4111-8111-111111111111",
    batchId,
    rowId,
    files: [
      { name: "close-up.png", mimeType: "image/png", dataUrl: PNG_URL, category: "photo" },
      { name: "inspection.pdf", mimeType: "application/pdf", dataUrl: PDF_URL, category: "file" },
    ],
  };
  const first = await command(service, "createIssue", request);
  const second = await command(service, "createIssue", {
    title: "Separate review",
    description: "A second issue for the same inspection item.",
    requestId: "22222222-2222-4222-8222-222222222222",
    batchId,
    rowId,
    files: [{ name: "separate-review.png", mimeType: "image/png", dataUrl: PNG_URL, category: "photo" }],
  });
  assert.notEqual(first.entityId, second.entityId);
  let current = await service.getState();
  const firstPersisted = current.issues.find((issue) => issue.id === first.entityId);
  const snapshotPhotoIds = [...firstPersisted.sourceSnapshot.row.photoIds];
  assert.equal(firstPersisted.attachmentIds.length, 2);
  assert.deepEqual(firstPersisted.sourceSnapshot.row.photoIds, current.batches.find((batch) => batch.id === batchId).rows.find((row) => row.id === rowId).photoIds);

  await command(service, "addIssueAttachments", {
    id: first.entityId,
    files: [{ name: "follow-up.log", mimeType: "text/plain", dataUrl: "data:text/plain;base64,Zm9sbG93LXVw", category: "file" }],
  });
  current = await service.getState();
  const extraAssetId = current.issues.find((candidate) => candidate.id === first.entityId).attachmentIds.at(-1);
  await command(service, "saveIssue", {
    id: first.entityId,
    owner: "",
    disposition: "",
    confirmations: ["", "", ""],
    description: "Updated description after creation.",
  });
  const beforeRetry = current;
  const beforeRetryAfterDescriptionEdit = await service.getState();
  const retry = await command(service, "createIssue", request);
  assert.equal(retry.entityId, first.entityId);
  assert.equal(retry.revision, beforeRetryAfterDescriptionEdit.revision);
  assert.ok(beforeRetry.revision < beforeRetryAfterDescriptionEdit.revision);
  assert.equal((await service.getState()).assets.filter((asset) => asset.kind === "issueAttachment" && asset.issueId === first.entityId).length, 3);
  await assert.rejects(command(service, "createIssue", { ...request, title: "Different payload" }), /request ID.*different/i);

  const workspace = await service.getBatchWorkspace(batchId);
  const issues = workspace.rows.find((row) => row.id === rowId).issues;
  assert.equal(issues.length, 2);
  assert.equal(issues.find((issue) => issue.id === first.entityId).attachments.length, 3);
  assert.equal(issues.find((issue) => issue.id === second.entityId).attachments.length, 1);

  await command(service, "removePhoto", { batchId, rowId, assetId: snapshotPhotoIds[0] });
  current = await service.getState();
  assert.equal(current.assets.some((asset) => asset.id === snapshotPhotoIds[0]), true);
  assert.deepEqual(current.issues.find((issue) => issue.id === first.entityId).sourceSnapshot.row.photoIds, snapshotPhotoIds);

  const beforeBadCreate = await service.getState();
  await assert.rejects(command(service, "createIssue", {
    title: "Invalid evidence must not partially create",
    requestId: "33333333-3333-4333-8333-333333333333",
    batchId,
    rowId,
    files: [
      { name: "valid.png", mimeType: "image/png", dataUrl: PNG_URL, category: "photo" },
      { name: "bad.html", mimeType: "text/html", dataUrl: "data:text/html;base64,PGI+", category: "file" },
    ],
  }), /supported file type|HTML|SVG/i);
  assert.deepEqual(await service.getState(), beforeBadCreate);

  await command(service, "saveIssue", { id: first.entityId, owner: "Lead", disposition: "Corrected", confirmations: ["A", "B", "C"] });
  await command(service, "closeIssue", { id: first.entityId });
  const beforeClosedRemoval = await service.getState();
  await assert.rejects(command(service, "removeIssueAttachment", { id: first.entityId, assetId: extraAssetId }), /closed.*read-only/i);
  assert.deepEqual(await service.getState(), beforeClosedRemoval);
  await service.close();
});

test("photo and general file limits accept the exact boundary and reject one byte above it", async () => {
  const service = makeService();
  const { batchId, rowId } = await prepareBatch(service, "BOUNDARY");
  const photo = fileDataUrl("image/png", PHOTO_MAX_BYTES);
  const photoResult = await command(service, "createIssue", {
    title: "Maximum photo",
    requestId: "44444444-4444-4444-8444-444444444444",
    batchId,
    rowId,
    files: [{ name: "maximum.png", mimeType: "image/png", dataUrl: photo, category: "photo" }],
  });
  assert.ok(photoResult.entityId);
  const generalImage = fileDataUrl("image/png", DOCUMENT_MAX_BYTES, 66);
  await command(service, "addIssueAttachments", {
    id: photoResult.entityId,
    files: [{ name: "general-image.png", mimeType: "image/png", dataUrl: generalImage, category: "file" }],
  });
  assert.ok((await service.getState()).assets.some((asset) => asset.kind === "issueAttachment" && asset.category === "file" && asset.name === "general-image.png"));
  const beforeMismatchedCategory = await service.getState();
  await assert.rejects(command(service, "addIssueAttachments", {
    id: photoResult.entityId,
    files: [{ name: "not-photo.mp4", mimeType: "video/mp4", dataUrl: "data:video/mp4;base64,AAAA", category: "photo" }],
  }), /photo.*images/i);
  assert.deepEqual(await service.getState(), beforeMismatchedCategory);
  const oversizedPhoto = fileDataUrl("image/png", PHOTO_MAX_BYTES + 1);
  const beforePhotoReject = await service.getState();
  await assert.rejects(command(service, "addIssueAttachments", {
    id: photoResult.entityId,
    files: [{ name: "too-large.png", mimeType: "image/png", dataUrl: oversizedPhoto, category: "photo" }],
  }), /5 MiB/i);
  assert.deepEqual(await service.getState(), beforePhotoReject);

  const maxFile = fileDataUrl("video/mp4", DOCUMENT_MAX_BYTES, 66);
  await command(service, "setRowAttachment", {
    batchId, rowId, category: "videos", file: { name: "maximum.mp4", mimeType: "video/mp4", dataUrl: maxFile },
  });
  const atCapacity = await service.getState();
  const row = atCapacity.batches.find((batch) => batch.id === batchId).rows.find((candidate) => candidate.id === rowId);
  const replace = fileDataUrl("video/webm", DOCUMENT_MAX_BYTES, 67);
  await command(service, "setRowAttachment", {
    batchId, rowId, category: "videos", file: { name: "replacement.webm", mimeType: "video/webm", dataUrl: replace },
  });
  assert.equal((await service.getState()).assets.some((asset) => asset.id === row.attachmentIds.videos), false);
  const overFile = fileDataUrl("video/mp4", DOCUMENT_MAX_BYTES + 1, 68);
  const beforeFileReject = await service.getState();
  await assert.rejects(command(service, "setRowAttachment", {
    batchId, rowId, category: "videos", file: { name: "too-large.mp4", mimeType: "video/mp4", dataUrl: overFile },
  }), /10 MiB/i);
  assert.deepEqual(await service.getState(), beforeFileReject);
  assert.equal(ASSET_TOTAL_MAX_BYTES, 30 * 1024 * 1024);
  assert.equal(BACKUP_MAX_BYTES, 50 * 1024 * 1024);
  await service.close();
});

test("attachments survive backup restore, SQLite reopen, and older field-omitting backups", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "masterqc-attachments-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "workspace.sqlite");
  let service = makeService(createSQLiteQCAdapter({ databasePath }));
  const { batchId, rowId } = await prepareBatch(service, "PERSIST");
  await command(service, "setRowAttachment", {
    batchId, rowId, category: "procedures", file: { name: "procedure.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", dataUrl: "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,eA==" },
  });
  const issue = await command(service, "createIssue", {
    title: "Durable issue",
    description: "Stored with evidence.",
    requestId: "55555555-5555-4555-8555-555555555555",
    batchId,
    rowId,
    files: [{ name: "issue-photo.png", mimeType: "image/png", dataUrl: PNG_URL, category: "photo" }],
  });
  const expected = await service.getState();
  const backup = await service.exportBackup();
  validateBackup(backup);

  const rowAttachmentId = backup.state.batches.find((batch) => batch.id === batchId).rows.find((row) => row.id === rowId).attachmentIds.procedures;
  const linkedToAnotherRow = structuredClone(backup);
  const otherRow = linkedToAnotherRow.state.batches.find((batch) => batch.id === batchId).rows.find((row) => row.id !== rowId);
  otherRow.attachmentIds = { videos: null, procedures: rowAttachmentId, log: null };
  assert.throws(() => validateBackup(linkedToAnotherRow), /owned by this inspection row category|referenced by its inspection row slot/i);
  const linkedToIssue = structuredClone(backup);
  linkedToIssue.state.issues.find((candidate) => candidate.id === issue.entityId).attachmentIds.push(rowAttachmentId);
  assert.throws(() => validateBackup(linkedToIssue), /missing or out-of-scope attachment|referenced by its issue/i);

  const restored = makeService();
  await restored.initialize();
  await restored.importBackup(backup, 0);
  const restoredState = await restored.getState();
  assert.deepEqual(restoredState.batches, expected.batches);
  assert.deepEqual(restoredState.issues, expected.issues);
  assert.deepEqual(restoredState.assets, expected.assets);
  assert.equal((await restored.getBatchWorkspace(batchId)).rows.find((row) => row.id === rowId).attachments.procedures.name, "procedure.docx");
  assert.equal((await restored.getBatchWorkspace(batchId)).rows.find((row) => row.id === rowId).issues[0].attachments[0].name, "issue-photo.png");

  const oldBackup = structuredClone(backup);
  const oldBatch = oldBackup.state.batches.find((batch) => batch.id === batchId);
  for (const row of oldBatch.rows) delete row.attachmentIds;
  const oldIssue = oldBackup.state.issues.find((candidate) => candidate.id === issue.entityId);
  delete oldIssue.description;
  delete oldIssue.requestId;
  delete oldIssue.requestFingerprint;
  delete oldIssue.attachmentIds;
  oldBackup.state.assets = oldBackup.state.assets.filter((asset) => !["rowAttachment", "issueAttachment"].includes(asset.kind));
  validateBackup(oldBackup);
  const oldTarget = makeService();
  await oldTarget.initialize();
  await oldTarget.importBackup(oldBackup, 0);
  const oldState = await oldTarget.getState();
  assert.equal(Object.hasOwn(oldState.batches.find((batch) => batch.id === batchId).rows[0], "attachmentIds"), false);
  assert.equal(Object.hasOwn(oldState.issues.find((candidate) => candidate.id === issue.entityId), "description"), false);
  assert.equal(Object.hasOwn(oldState.issues.find((candidate) => candidate.id === issue.entityId), "attachmentIds"), false);

  await service.close();
  service = makeService(createSQLiteQCAdapter({ databasePath }));
  await service.initialize();
  assert.deepEqual(await service.getState(), expected);
  await service.close();
  await restored.close();
  await oldTarget.close();
});

test("new Issues require an uploaded photo for standalone and row-linked creation", async () => {
  const service = makeService();
  await service.initialize();
  const emptyState = await service.getState();
  for (const payload of [
    { title: "Empty standalone issue" },
    { title: "Empty list standalone issue", files: [] },
    { title: "General-file-only standalone issue", files: [{ name: "evidence.pdf", mimeType: "application/pdf", dataUrl: PDF_URL, category: "file" }] },
  ]) {
    await assert.rejects(command(service, "createIssue", payload), /at least one uploaded photo/i);
    assert.deepEqual(await service.getState(), emptyState);
  }
  await assert.rejects(command(service, "createIssue", {
    title: "Invalid photo standalone issue",
    files: [{ name: "evidence.pdf", mimeType: "application/pdf", dataUrl: PDF_URL, category: "photo" }],
  }), /issue photos must be/i);
  assert.deepEqual(await service.getState(), emptyState);

  const standalone = await command(service, "createIssue", {
    title: "Standalone issue with photo",
    files: [{ name: "standalone.png", mimeType: "image/png", dataUrl: PNG_URL }],
  });
  let state = await service.getState();
  const standaloneIssue = state.issues.find((issue) => issue.id === standalone.entityId);
  assert.equal(state.assets.find((asset) => asset.id === standaloneIssue.attachmentIds[0]).category, "photo");

  const { batchId, rowId } = await prepareBatch(service, "PHOTO-REQUIRED");
  await command(service, "addPhotos", {
    batchId, rowId, files: [{ name: "legacy-row-photo.png", mimeType: "image/png", dataUrl: PNG_URL }],
  });
  const beforeRowReject = await service.getState();
  await assert.rejects(command(service, "createIssue", {
    title: "Legacy row photo is not an upload",
    requestId: "66666666-6666-4666-8666-666666666666",
    batchId,
    rowId,
    files: [{ name: "supporting-file.pdf", mimeType: "application/pdf", dataUrl: PDF_URL, category: "file" }],
  }), /at least one uploaded photo/i);
  assert.deepEqual(await service.getState(), beforeRowReject);

  const request = {
    title: "Row issue with uploaded photo",
    requestId: "77777777-7777-4777-8777-777777777777",
    batchId,
    rowId,
    files: [{ name: "row-issue.png", mimeType: "image/png", dataUrl: PNG_URL, category: "photo" }],
  };
  const rowIssue = await command(service, "createIssue", request);
  state = await service.getState();
  const createdRowIssue = state.issues.find((issue) => issue.id === rowIssue.entityId);
  assert.equal(createdRowIssue.sourceSnapshot.row.photoIds.length, 1);
  assert.equal(createdRowIssue.attachmentIds.length, 1);
  const beforeRetry = await service.getState();
  const retry = await command(service, "createIssue", request);
  assert.equal(retry.entityId, rowIssue.entityId);
  assert.deepEqual(await service.getState(), beforeRetry);
  await service.close();
});

test("legacy autosaves may omit measured time only when the stored row lacks that field", async () => {
  const service = makeService();
  const { batchId, rowId } = await prepareBatch(service, "LEGACY-TIME");
  await mutateStoredState(service, (state) => {
    const row = state.batches.find((batch) => batch.id === batchId).rows.find((candidate) => candidate.id === rowId);
    delete row.actualTimeSeconds;
  });
  const before = await service.getState();
  const row = before.batches.find((batch) => batch.id === batchId).rows.find((candidate) => candidate.id === rowId);
  assert.equal(Object.hasOwn(row, "actualTimeSeconds"), false);
  const result = await command(service, "autosaveInspection", {
    batchId,
    rowId,
    defectiveQty: 1,
    remarks: row.remarks,
  });
  assert.ok(result.revision > before.revision);
  const saved = (await service.getState()).batches.find((batch) => batch.id === batchId).rows.find((candidate) => candidate.id === rowId);
  assert.equal(Object.hasOwn(saved, "actualTimeSeconds"), false);
  assert.equal(saved.savedAt !== null, true);

  const modern = (await service.getBatchWorkspace(batchId)).rows.find((candidate) => candidate.id !== rowId);
  const current = await service.getState();
  const modernRow = current.batches.find((batch) => batch.id === batchId).rows.find((candidate) => candidate.id === modern.id);
  assert.equal(Object.hasOwn(modernRow, "actualTimeSeconds"), true);
  await assert.rejects(command(service, "autosaveInspection", {
    batchId,
    rowId: modern.id,
    defectiveQty: modernRow.defectiveQty,
    remarks: modernRow.remarks,
  }), /actualTimeSeconds/i);
  await service.close();
});

test("new attachment commands are explicitly allowlisted", () => {
  for (const type of ["setRowAttachment", "removeRowAttachment", "addIssueAttachments", "removeIssueAttachment"]) {
    assert.ok(QC_COMMAND_TYPES.includes(type), `${type} should be a public command`);
  }
});
