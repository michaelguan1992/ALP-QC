import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createQCService } from "../core/qc-service.js";
import { createSQLiteQCAdapter } from "../storage/sqlite-qc-adapter.mjs";

const FIRST_URL = "data:text/plain;base64,aGVsbG8=";
const SECOND_URL = "data:text/plain;base64,d29ybGQ=";

async function temporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "masterqc-web-sqlite-assets-"));
}

function stateWithAsset(dataUrl = FIRST_URL) {
  return {
    schemaVersion: 1,
    revision: 12,
    marker: "preserved",
    assets: [{
      id: "asset-1",
      name: "note.txt",
      mimeType: "text/plain",
      kind: "document",
      batchId: null,
      rowId: null,
      versionId: null,
      createdAt: "2026-09-30T12:00:00.000Z",
      dataUrl,
    }],
  };
}

test("SQLite asset payloads are separate in light reads and reconstruct the legacy full state", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "workspace.sqlite");
  const expected = stateWithAsset();
  const adapter = createSQLiteQCAdapter({ databasePath });
  await adapter.initialize();
  await adapter.transact(() => ({ state: expected, result: null }));

  const fullRead = await adapter.readState();
  assert.deepEqual(fullRead, expected);
  fullRead.assets[0].name = "mutated by reader.txt";
  assert.deepEqual(await adapter.readState(), expected);
  const lightState = await adapter.readState({ includeAssetContent: false });
  assert.equal(Object.hasOwn(lightState.assets[0], "dataUrl"), false);
  assert.equal(lightState.assets[0].contentRef, "masterqc-asset:v1:asset-1");
  assert.deepEqual(await adapter.readAsset("asset-1"), expected.assets[0]);
  assert.equal(await adapter.readAsset("missing-asset"), null);

  const trusted = adapter.getTrustedAssetValidation().get("asset-1");
  assert.equal(trusted.contentRef, lightState.assets[0].contentRef);
  assert.equal(trusted.mimeType, "text/plain");
  assert.equal(trusted.decodedBytes, 5);
  assert.equal(trusted.contentRevision, 1);

  await adapter.close();
  const reopened = createSQLiteQCAdapter({ databasePath });
  await reopened.initialize();
  assert.deepEqual(await reopened.readState(), expected);
  await reopened.close();
});

test("legacy aggregate migration is atomic and lossless in a temporary database copy", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacyPath = path.join(directory, "legacy.sqlite");
  const migratedPath = path.join(directory, "migrated-copy.sqlite");
  const expected = stateWithAsset();

  const legacy = new DatabaseSync(legacyPath);
  legacy.exec("PRAGMA journal_mode = DELETE;");
  legacy.exec("PRAGMA synchronous = FULL;");
  legacy.exec("CREATE TABLE qc_state (state_key TEXT PRIMARY KEY, revision INTEGER NOT NULL, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);");
  legacy.prepare("INSERT INTO qc_state VALUES (?, ?, ?, ?)").run("main", expected.revision, JSON.stringify(expected), "2026-09-30T12:00:00.000Z");
  legacy.close();
  await copyFile(legacyPath, migratedPath);

  const adapter = createSQLiteQCAdapter({ databasePath: migratedPath });
  const recoveryPath = `${migratedPath}.pre-attachment-payload-migration.sqlite`;
  await assert.rejects(adapter.initialize({ validateLegacyState: () => { throw new Error("reject migration"); } }), /reject migration/);
  assert.deepEqual(await adapter.readState(), expected);
  const recovery = new DatabaseSync(recoveryPath);
  assert.deepEqual(JSON.parse(recovery.prepare("SELECT value_json FROM qc_state WHERE state_key = ?").get("main").value_json), expected);
  recovery.close();

  await adapter.initialize({ validateLegacyState: (state) => assert.deepEqual(state, expected) });
  assert.deepEqual(await adapter.readState(), expected);
  assert.deepEqual((await adapter.readState({ includeAssetContent: false })).assets[0].id, expected.assets[0].id);
  await adapter.initialize({ validateLegacyState: () => { throw new Error("must not validate a repeated migration"); } });
  await adapter.close();

  const untouchedLegacy = new DatabaseSync(legacyPath);
  const originalJson = untouchedLegacy.prepare("SELECT value_json FROM qc_state WHERE state_key = ?").get("main").value_json;
  assert.deepEqual(JSON.parse(originalJson), expected);
  untouchedLegacy.close();

  const migrated = new DatabaseSync(migratedPath);
  const persistedJson = migrated.prepare("SELECT value_json FROM qc_state WHERE state_key = ?").get("main").value_json;
  assert.equal(persistedJson.includes(FIRST_URL), false);
  assert.equal(migrated.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
  assert.equal(migrated.prepare("PRAGMA synchronous").get().synchronous, 2);
  migrated.close();
});

test("direct adapter reads and transactions still work before initialize is called", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "direct.sqlite");
  const original = stateWithAsset();
  const seed = new DatabaseSync(databasePath);
  seed.exec("CREATE TABLE qc_state (state_key TEXT PRIMARY KEY, revision INTEGER NOT NULL, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);");
  seed.prepare("INSERT INTO qc_state VALUES (?, ?, ?, ?)").run("main", original.revision, JSON.stringify(original), "2026-09-30T12:00:00.000Z");
  seed.close();

  const adapter = createSQLiteQCAdapter({ databasePath });
  assert.deepEqual(await adapter.readState(), original);
  await adapter.transact((state) => {
    state.revision += 1;
    state.marker = "direct adapter write";
    return { state, result: null };
  });
  assert.deepEqual(await adapter.readState(), { ...original, revision: 13, marker: "direct adapter write" });
  await adapter.close();
});

test("adapter transaction state and result remain isolated from caller aliases", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const adapter = createSQLiteQCAdapter({ databasePath: path.join(directory, "aliases.sqlite") });
  const inputState = stateWithAsset();
  const inputResult = { detail: { saved: true } };
  const returned = await adapter.transact(() => ({ state: inputState, result: inputResult }));

  inputState.assets[0].name = "mutated after commit.txt";
  inputResult.detail.saved = false;
  assert.deepEqual(await adapter.readState(), stateWithAsset());
  assert.deepEqual(returned, { detail: { saved: true } });
  returned.detail.saved = false;
  assert.deepEqual(await adapter.readState(), stateWithAsset());
  await adapter.close();
});

test("payload and aggregate updates roll back together when serialization fails", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "workspace.sqlite");
  const adapter = createSQLiteQCAdapter({ databasePath });
  await adapter.initialize();
  const original = stateWithAsset();
  await adapter.transact(() => ({ state: original, result: null }));

  await assert.rejects(adapter.transact((state) => {
    state.revision += 1;
    state.marker = 1n;
    state.assets[0].dataUrl = SECOND_URL;
    return { state, result: null };
  }), /BigInt|serialize/i);
  assert.deepEqual(await adapter.readState(), original);
  assert.deepEqual(await adapter.readAsset("asset-1"), original.assets[0]);

  await adapter.close();
});

test("full reads and asset reads report corrupt or missing payloads", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "workspace.sqlite");
  let adapter = createSQLiteQCAdapter({ databasePath });
  await adapter.initialize();
  const state = stateWithAsset();
  await adapter.transact(() => ({ state, result: null }));
  await adapter.close();

  let direct = new DatabaseSync(databasePath);
  direct.prepare("UPDATE qc_asset_payloads SET data_url = ? WHERE asset_id = ?").run(SECOND_URL, "asset-1");
  direct.close();
  adapter = createSQLiteQCAdapter({ databasePath });
  await adapter.initialize();
  await assert.rejects(adapter.readState(), /corrupt/i);
  await assert.rejects(adapter.readAsset("asset-1"), /corrupt/i);
  await adapter.close();

  direct = new DatabaseSync(databasePath);
  direct.prepare("DELETE FROM qc_asset_payloads WHERE asset_id = ?").run("asset-1");
  direct.close();
  adapter = createSQLiteQCAdapter({ databasePath });
  await assert.rejects(adapter.initialize(), /missing/i);
  await adapter.close();
});

test("a second SQLite connection cannot make a light service read trust changed payload bytes", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "workspace.sqlite");
  const adapter = createSQLiteQCAdapter({ databasePath });
  const service = createQCService(adapter);
  const initial = await service.initialize();
  await service.command("addDocument", {
    name: "note.txt",
    mimeType: "text/plain",
    dataUrl: FIRST_URL,
  }, initial.revision);
  const saved = await service.getState({ mode: "lightweight" });
  assert.equal(Object.hasOwn(saved.assets[0], "dataUrl"), false);

  const secondConnection = new DatabaseSync(databasePath);
  secondConnection.prepare("UPDATE qc_asset_payloads SET data_url = ? WHERE asset_id = ?").run(SECOND_URL, saved.assets[0].id);
  secondConnection.close();

  await assert.rejects(service.getState(), /corrupt/i);
  const variant = saved.variants.find((item) => item.model === "S15" && item.color === "Red");
  await assert.rejects(service.command("createOrder", {
    number: "CORRUPT-ASSET-PO",
    date: "2026-09-30",
    supplier: "Supplier",
    notes: "This write must not commit.",
    lines: [{ variantId: variant.id, orderedQty: 10 }],
  }, saved.revision), /corrupt/i);
  await service.close();
});
