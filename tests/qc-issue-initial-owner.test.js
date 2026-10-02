import test from "node:test";
import assert from "node:assert/strict";
import { createQCService } from "../core/qc-service.js";
import { validateBackup } from "../core/qc-validation.js";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";

const PNG_URL = "data:image/png;base64,iVBORw0KGgo=";

function makeService(prefix) {
  let idNumber = 0;
  let timeNumber = 0;
  return createQCService(createMemoryQCAdapter(), {
    idFactory: () => `${prefix}-${String(++idNumber).padStart(5, "0")}`,
    now: () => new Date(Date.UTC(2026, 9, 1, 12, 0, timeNumber++)).toISOString(),
  });
}

async function createIssue(service, overrides = {}) {
  const state = await service.getState();
  return service.command("createIssue", {
    reportedBy: "Inspector",
    title: "Surface defect",
    files: [{ name: "issue-photo.png", mimeType: "image/png", dataUrl: PNG_URL, category: "photo" }],
    ...overrides,
  }, state.revision);
}

test("initial disposition owner is optional, trimmed, and validated atomically", async () => {
  const service = makeService("issue-owner-validation");
  await service.initialize();
  const base = {
    reportedBy: "Inspector",
    title: "Surface defect",
    requestId: "issue-owner-validation-request",
    files: [{ name: "issue-photo.png", mimeType: "image/png", dataUrl: PNG_URL, category: "photo" }],
  };
  const before = await service.getState();
  const invalidOwners = [
    [undefined, /Initial disposition owner must be text/i],
    [null, /Initial disposition owner must be text/i],
    [42, /Initial disposition owner must be text/i],
    ["x".repeat(201), /Initial disposition owner must be 200 characters or fewer/i],
  ];
  for (const [owner, error] of invalidOwners) {
    await assert.rejects(service.command("createIssue", { ...base, owner }, before.revision), error);
    assert.deepEqual(await service.getState(), before);
  }

  const created = await createIssue(service, { requestId: base.requestId });
  let state = await service.getState();
  assert.equal(state.issues.find((issue) => issue.id === created.entityId).owner, "");
  const retryWithBlank = await createIssue(service, { requestId: base.requestId, owner: " \t\n " });
  assert.equal(retryWithBlank.entityId, created.entityId);
  assert.equal(retryWithBlank.revision, state.revision);

  const unicodeOwner = "  李明 · 品质组  ";
  const unicode = await createIssue(service, { requestId: "issue-owner-unicode", owner: unicodeOwner });
  state = await service.getState();
  assert.equal(state.issues.find((issue) => issue.id === unicode.entityId).owner, "李明 · 品质组");

  const maxLengthOwner = "李".repeat(200);
  const maximum = await createIssue(service, { requestId: "issue-owner-max-length", owner: maxLengthOwner });
  state = await service.getState();
  assert.equal(state.issues.find((issue) => issue.id === maximum.entityId).owner, maxLengthOwner);
  await service.close();
});

test("initial owner is fingerprinted across retries and survives save edits and backup restore", async () => {
  const source = makeService("issue-owner-source");
  await source.initialize();
  const requestId = "issue-owner-retry-request";
  const originalOwner = "  李明  ";
  const created = await createIssue(source, { requestId, owner: originalOwner });
  let state = await source.getState();
  const originalIssue = state.issues.find((issue) => issue.id === created.entityId);
  const originalFingerprint = originalIssue.requestFingerprint;
  assert.equal(originalIssue.owner, "李明");

  const normalizedRetry = await createIssue(source, { requestId, owner: "李明" });
  assert.equal(normalizedRetry.entityId, created.entityId);
  assert.equal(normalizedRetry.revision, state.revision);

  await source.command("saveIssue", {
    id: created.entityId,
    owner: "Disposition lead",
    disposition: "Review pending",
    confirmations: ["", "", ""],
  }, state.revision);
  state = await source.getState();
  const editedIssue = state.issues.find((issue) => issue.id === created.entityId);
  assert.equal(editedIssue.owner, "Disposition lead");
  assert.equal(editedIssue.requestFingerprint, originalFingerprint);

  const retryAfterEdit = await createIssue(source, { requestId, owner: originalOwner });
  assert.equal(retryAfterEdit.entityId, created.entityId);
  assert.equal(retryAfterEdit.revision, state.revision);
  assert.equal((await source.getState()).issues.find((issue) => issue.id === created.entityId).owner, "Disposition lead");
  const beforeMismatch = await source.getState();
  await assert.rejects(createIssue(source, { requestId, owner: "Different owner" }), /request ID.*different/i);
  assert.deepEqual(await source.getState(), beforeMismatch);

  const backup = await source.exportBackup();
  validateBackup(backup);
  const target = makeService("issue-owner-target");
  await target.initialize();
  await target.importBackup(backup, (await target.getState()).revision);
  state = await target.getState();
  const restoredIssue = state.issues.find((issue) => issue.id === created.entityId);
  assert.equal(restoredIssue.owner, "Disposition lead");
  assert.equal(restoredIssue.requestFingerprint, originalFingerprint);
  const restoredRetry = await createIssue(target, { requestId, owner: "李明" });
  assert.equal(restoredRetry.entityId, created.entityId);
  assert.equal(restoredRetry.revision, state.revision);
  assert.equal((await target.getState()).issues.find((issue) => issue.id === created.entityId).owner, "Disposition lead");

  await source.close();
  await target.close();
});
