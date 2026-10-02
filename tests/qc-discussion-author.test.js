import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createQCService } from "../core/qc-service.js";
import { validateQCState } from "../core/qc-validation.js";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";
import { createSQLiteQCAdapter } from "../storage/sqlite-qc-adapter.mjs";

const PNG_URL = "data:image/png;base64,iVBORw0KGgo=";

function createService(adapter) {
  let id = 0;
  return createQCService(adapter, {
    idFactory: () => `discussion-author-test-${++id}`,
    now: () => "2026-10-01T12:00:00.000Z",
  });
}

async function createIssueWithDiscussion(service) {
  await service.initialize();
  const issue = await service.command("createIssue", {
    title: "Review the replacement",
    files: [{ name: "discussion-evidence.png", mimeType: "image/png", dataUrl: PNG_URL, category: "photo" }],
  }, 0);
  await service.command("addDiscussion", {
    id: issue.entityId,
    text: "  The replacement passed.  ",
    authorName: "  林佳怡  ",
  });
  await service.command("addDiscussion", {
    id: issue.entityId,
    text: "Confirmed at the next inspection.",
    authorName: "  Zoë García  ",
  });
  return issue.entityId;
}

test("discussion entries require a name and rejected names leave revision and audit unchanged", async () => {
  const service = createService(createMemoryQCAdapter());
  await service.initialize();
  const issue = await service.command("createIssue", {
    title: "Review the replacement",
    files: [{ name: "discussion-evidence.png", mimeType: "image/png", dataUrl: PNG_URL, category: "photo" }],
  }, 0);
  const before = await service.getState();

  for (const payload of [
    { id: issue.entityId, text: "No name supplied." },
    { id: issue.entityId, text: "Blank name supplied.", authorName: "" },
    { id: issue.entityId, text: "Whitespace name supplied.", authorName: " \t\n " },
  ]) {
    await assert.rejects(
      service.command("addDiscussion", payload, before.revision),
      { message: "You must enter your name before adding a discussion entry." },
    );
  }

  const after = await service.getState();
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.audit, before.audit);
  assert.deepEqual(after.issues.find((item) => item.id === issue.entityId).discussion, []);
  assert.deepEqual(after, before);
});

test("discussion author names are trimmed, Unicode-safe, distinct, and capped at 200 characters", async () => {
  const service = createService(createMemoryQCAdapter());
  const issueId = await createIssueWithDiscussion(service);
  const state = await service.getState();
  const issue = state.issues.find((item) => item.id === issueId);

  assert.deepEqual(issue.discussion.map(({ text, authorName }) => ({ text, authorName })), [
    { text: "The replacement passed.", authorName: "林佳怡" },
    { text: "Confirmed at the next inspection.", authorName: "Zoë García" },
  ]);
  assert.notEqual(issue.discussion[0].authorName, issue.discussion[1].authorName);
  assert.doesNotThrow(() => validateQCState(state));

  const before = await service.getState();
  await assert.rejects(service.command("addDiscussion", {
    id: issueId,
    text: "This name is too long.",
    authorName: "a".repeat(201),
  }, before.revision), /200 characters or fewer/i);
  assert.deepEqual(await service.getState(), before);

  for (const authorName of ["", "  \n", "a".repeat(201), ` ${"a".repeat(200)} `, 42]) {
    const invalid = structuredClone(state);
    invalid.issues.find((item) => item.id === issueId).discussion[0].authorName = authorName;
    assert.throws(() => validateQCState(invalid), /discussion author name/i);
  }
});

test("discussion authors survive SQLite reopen and validated backup import", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "masterqc-discussion-author-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, "source.sqlite");
  const targetPath = path.join(directory, "target.sqlite");

  let source = createService(createSQLiteQCAdapter({ databasePath: sourcePath }));
  const issueId = await createIssueWithDiscussion(source);
  const expected = (await source.getState()).issues.find((item) => item.id === issueId).discussion;
  const backup = await source.exportBackup();
  await source.close();

  source = createService(createSQLiteQCAdapter({ databasePath: sourcePath }));
  await source.initialize();
  assert.deepEqual((await source.getState()).issues.find((item) => item.id === issueId).discussion, expected);

  let target = createService(createSQLiteQCAdapter({ databasePath: targetPath }));
  await target.initialize();
  await target.importBackup(backup, 0);
  assert.deepEqual((await target.getState()).issues.find((item) => item.id === issueId).discussion, expected);
  await target.close();

  target = createService(createSQLiteQCAdapter({ databasePath: targetPath }));
  await target.initialize();
  assert.deepEqual((await target.getState()).issues.find((item) => item.id === issueId).discussion, expected);
  await source.close();
  await target.close();
});

test("legacy backups without discussion author names remain valid and import unchanged", async () => {
  const source = createService(createMemoryQCAdapter());
  const issueId = await createIssueWithDiscussion(source);
  const legacyBackup = structuredClone(await source.exportBackup());
  const legacyIssue = legacyBackup.state.issues.find((item) => item.id === issueId);
  for (const entry of legacyIssue.discussion) delete entry.authorName;
  assert.doesNotThrow(() => validateQCState(legacyBackup.state));

  const target = createService(createMemoryQCAdapter());
  await target.initialize();
  await target.importBackup(legacyBackup, 0);
  const importedIssue = (await target.getState()).issues.find((item) => item.id === issueId);
  assert.deepEqual(importedIssue.discussion, legacyIssue.discussion);
  assert.ok(importedIssue.discussion.every((entry) => !Object.hasOwn(entry, "authorName")));
});
