import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addActionLog } from "../core/qc-issues.js";
import { createQCService, QC_COMMAND_TYPES } from "../core/qc-service.js";
import { validateBackup, validateQCState } from "../core/qc-validation.js";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";
import { createSQLiteQCAdapter } from "../storage/sqlite-qc-adapter.mjs";

const PNG_URL = "data:image/png;base64,iVBORw0KGgo=";
const PDF_URL = "data:application/pdf;base64,JVBERi0xLjQK";
const LOG_URL = "data:text/plain;base64,YWN0aW9u";

function makeService(adapter = createMemoryQCAdapter(), prefix = "action-log") {
  let idNumber = 0;
  let timeNumber = 0;
  return createQCService(adapter, {
    idFactory: () => `${prefix}-${String(++idNumber).padStart(5, "0")}`,
    now: () => new Date(Date.UTC(2026, 9, 2, 12, 0, timeNumber++)).toISOString(),
  });
}

async function createIssue(service) {
  const state = await service.getState();
  return service.command("createIssue", {
    title: "Surface defect",
    reportedBy: "Inspector",
    files: [{ name: "issue-photo.png", mimeType: "image/png", dataUrl: PNG_URL, category: "photo" }],
  }, state.revision);
}

function actionData(id, overrides = {}) {
  return {
    id,
    submitterName: "  李明  ",
    actionType: "rework",
    summary: "  Replaced the seal  ",
    result: "  Pressure test passed  ",
    requestId: "action-request-1",
    files: [{ name: "work-note.pdf", mimeType: "application/pdf", dataUrl: PDF_URL }],
    ...overrides,
  };
}

test("addActionLog stores multiple trimmed immutable entries and projects owned attachments", async () => {
  const service = makeService();
  await service.initialize();
  const created = await createIssue(service);
  let state = await service.getState();

  assert.ok(QC_COMMAND_TYPES.includes("addActionLog"));
  const first = await service.command("addActionLog", actionData(created.entityId), state.revision);
  state = await service.getState();
  const issue = state.issues.find((candidate) => candidate.id === created.entityId);
  const firstLog = issue.actionLogs[0];
  assert.equal(firstLog.submitterName, "李明");
  assert.equal(firstLog.actionType, "rework");
  assert.equal(firstLog.summary, "Replaced the seal");
  assert.equal(firstLog.result, "Pressure test passed");
  assert.equal(firstLog.submittedAt, "2026-10-02T12:00:03.000Z");
  assert.equal(firstLog.requestId, "action-request-1");
  assert.match(firstLog.requestFingerprint, /^[0-9a-f]{16}$/);
  assert.equal(firstLog.attachmentIds.length, 1);
  const ownedAsset = state.assets.find((asset) => asset.id === firstLog.attachmentIds[0]);
  assert.equal(ownedAsset.kind, "issueAttachment");
  assert.equal(ownedAsset.issueId, issue.id);
  assert.equal(ownedAsset.actionLogId, firstLog.id);
  assert.equal(ownedAsset.category, "file");

  const projectedIssue = first.changes.issues.find((item) => item.id === issue.id);
  const projectedAsset = first.changes.assets.find((asset) => asset.id === ownedAsset.id);
  assert.equal(projectedIssue.actionLogs[0].id, firstLog.id);
  assert.equal(projectedAsset.actionLogId, firstLog.id);
  assert.equal(Object.hasOwn(projectedAsset, "dataUrl"), false);

  const secondState = await service.getState();
  await service.command("addActionLog", actionData(issue.id, {
    submitterName: "Sam",
    actionType: "process",
    summary: "Adjusted the fixture",
    result: "The next run is stable",
    requestId: undefined,
    files: [],
  }), secondState.revision);
  const saved = (await service.getState()).issues.find((candidate) => candidate.id === issue.id);
  assert.equal(saved.actionLogs.length, 2);
  assert.equal(saved.actionLogs[1].submitterName, "Sam");
  assert.equal(saved.actionLogs[1].actionType, "process");
  assert.deepEqual(saved.actionLogs[1].attachmentIds, []);
  validateQCState(await service.getState());
  await service.close();
});

test("action log validation, evidence, stale revisions, and request mismatches fail atomically", async () => {
  const service = makeService();
  await service.initialize();
  const created = await createIssue(service);
  const before = await service.getState();
  const invalid = [
    [actionData(created.entityId, { submitterName: "  " }), /Action submitter name is required/i],
    [actionData(created.entityId, { submitterName: "x".repeat(201) }), /200 characters or fewer/i],
    [actionData(created.entityId, { actionType: "unknown" }), /supported action type/i],
    [actionData(created.entityId, { summary: " \t " }), /Action summary is required/i],
    [actionData(created.entityId, { result: "" }), /Action result is required/i],
    [actionData(created.entityId, { summary: "x".repeat(1201) }), /1200 characters or fewer/i],
    [actionData(created.entityId, { files: [
      { name: "valid.png", mimeType: "image/png", dataUrl: PNG_URL, category: "photo" },
      { name: "bad.svg", mimeType: "image/png", dataUrl: PNG_URL, category: "photo" },
    ] }), /cannot be an executable, HTML, or SVG/i],
  ];
  for (const [payload, expected] of invalid) {
    await assert.rejects(service.command("addActionLog", payload, before.revision), expected);
    assert.deepEqual(await service.getState(), before);
  }

  await assert.rejects(service.command("addActionLog", actionData(created.entityId), before.revision - 1), /changed since your last view/i);
  assert.deepEqual(await service.getState(), before);

  const saved = await service.command("addActionLog", actionData(created.entityId), before.revision);
  const afterSave = await service.getState();
  const replay = await service.command("addActionLog", actionData(created.entityId), afterSave.revision);
  assert.equal(replay.revision, saved.revision);
  assert.equal(replay.changed, false);
  assert.equal(replay.actionLogId, saved.actionLogId);
  assert.equal((await service.getState()).issues[0].actionLogs.length, 1);

  const mismatchedReplay = await service.getState();
  await assert.rejects(service.command("addActionLog", actionData(created.entityId, { result: "Different result" }), mismatchedReplay.revision), /already used for different action details/i);
  assert.deepEqual(await service.getState(), mismatchedReplay);
  await service.close();
});

test("closure accepts an action record with owner and confirmations and exact retries after closure", async () => {
  const service = makeService();
  await service.initialize();
  const created = await createIssue(service);
  let state = await service.getState();
  await service.command("addActionLog", actionData(created.entityId), state.revision);
  state = await service.getState();
  await assert.rejects(service.command("closeIssue", { id: created.entityId }, state.revision), /disposition owner/i);
  assert.deepEqual(await service.getState(), state);
  await service.command("saveIssue", {
    id: created.entityId,
    owner: "Lead",
    disposition: "",
    confirmations: ["One", "", "Three"],
  }, state.revision);
  state = await service.getState();
  await assert.rejects(service.command("closeIssue", { id: created.entityId }, state.revision), /all three confirmation names/i);
  assert.deepEqual(await service.getState(), state);
  await service.command("saveIssue", {
    id: created.entityId,
    owner: "Lead",
    disposition: "",
    confirmations: ["One", "Two", "Three"],
  }, state.revision);
  state = await service.getState();
  await service.command("closeIssue", { id: created.entityId }, state.revision);
  const closed = (await service.getState()).issues[0];
  assert.equal(closed.status, "closed");
  assert.equal(closed.disposition, "");
  validateQCState(await service.getState());

  const replay = await service.command("addActionLog", actionData(created.entityId), (await service.getState()).revision);
  assert.equal(replay.changed, false);
  assert.equal(replay.actionLogId, closed.actionLogs[0].id);
  const afterReplay = await service.getState();
  await assert.rejects(service.command("addActionLog", actionData(created.entityId, {
    requestId: "new-after-close",
    summary: "A new action",
  }), afterReplay.revision), /Closed issues are read-only/i);
  assert.deepEqual(await service.getState(), afterReplay);
  await service.close();
});

test("action evidence cannot be removed and Issue deletion removes owned log evidence", async () => {
  const service = makeService();
  await service.initialize();
  const created = await createIssue(service);
  let state = await service.getState();
  await service.command("addActionLog", actionData(created.entityId, {
    files: [{ name: "action.log", mimeType: "text/plain", dataUrl: LOG_URL }],
  }), state.revision);
  state = await service.getState();
  const issue = state.issues.find((candidate) => candidate.id === created.entityId);
  const logAssetId = issue.actionLogs[0].attachmentIds[0];
  await assert.rejects(service.command("removeIssueAttachment", { id: issue.id, assetId: logAssetId }, state.revision), /submitted action record cannot be removed/i);
  assert.deepEqual(await service.getState(), state);

  await service.command("deleteIssue", { id: issue.id }, state.revision);
  const deleted = await service.getState();
  assert.equal(deleted.issues.some((candidate) => candidate.id === issue.id), false);
  assert.equal(deleted.assets.some((asset) => asset.id === logAssetId), false);
  assert.ok(deleted.audit.some((entry) => entry.action === "deleteIssue" && entry.entityId === issue.id));
  validateQCState(deleted);
  await service.close();
});

test("action log writes reject released and historical batch Issues", () => {
  let ids = 0;
  const issue = {
    id: "issue-1", number: "ISS-1", status: "open", batchId: "batch-1",
    actionLogs: [], attachmentIds: [],
  };
  const data = actionData(issue.id, { files: [], requestId: "new-request" });
  for (const batch of [
    { id: "batch-1", kind: "operational", status: "released" },
    { id: "batch-1", kind: "historical", status: "historical" },
  ]) {
    const state = { issues: [structuredClone(issue)], batches: [batch], assets: [] };
    const before = structuredClone(state);
    assert.throws(() => addActionLog(state, data, {
      idFactory: () => `guard-${++ids}`,
      now: () => "2026-10-02T12:00:00.000Z",
    }), batch.kind === "historical" ? /Historical batch issues are read-only/i : /Released batch issues are read-only/i);
    assert.deepEqual(state, before);
  }
});

test("older backups without action logs remain valid and SQLite preserves logs across restart and restore", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "masterqc-action-log-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, "source.sqlite");
  const targetPath = path.join(directory, "target.sqlite");

  let source = makeService(createSQLiteQCAdapter({ databasePath: sourcePath }), "action-source");
  await source.initialize();
  const created = await createIssue(source);
  let state = await source.getState();
  await source.command("addActionLog", actionData(created.entityId), state.revision);
  const expected = await source.getState();
  const backup = await source.exportBackup();
  validateBackup(backup);
  await source.close();

  source = makeService(createSQLiteQCAdapter({ databasePath: sourcePath }), "action-source-reopened");
  await source.initialize();
  assert.deepEqual(await source.getState(), expected);
  await source.close();

  let target = makeService(createSQLiteQCAdapter({ databasePath: targetPath }), "action-target");
  await target.initialize();
  await target.importBackup(backup, 0);
  const restored = await target.getState();
  assert.deepEqual(restored.issues, expected.issues);
  assert.deepEqual(restored.assets, expected.assets);
  await target.close();

  const legacyBackup = structuredClone(backup);
  const legacyIssue = legacyBackup.state.issues.find((candidate) => candidate.id === created.entityId);
  delete legacyIssue.actionLogs;
  legacyIssue.attachmentIds = [];
  legacyBackup.state.assets = legacyBackup.state.assets.filter((asset) => asset.issueId !== created.entityId);
  validateBackup(legacyBackup);
  target = makeService(createSQLiteQCAdapter({ databasePath: path.join(directory, "legacy.sqlite") }), "action-legacy");
  await target.initialize();
  await target.importBackup(legacyBackup, 0);
  const restoredLegacy = (await target.getState()).issues.find((candidate) => candidate.id === created.entityId);
  assert.equal(Object.hasOwn(restoredLegacy, "actionLogs"), false);
  await target.close();
});
