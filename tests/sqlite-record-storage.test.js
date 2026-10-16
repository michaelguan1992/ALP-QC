import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createQCService } from "../core/qc-service.js";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";
import { createSQLiteQCAdapter } from "../storage/sqlite-qc-adapter.mjs";

const DATE = "2026-10-16";
const FIXED_TIME = "2026-10-16T08:00:00.000Z";
const NOW = () => FIXED_TIME;
const TEXT_URL = "data:text/plain;base64,aGVsbG8=";
const OTHER_TEXT_URL = "data:text/plain;base64,d29ybGQ=";
const RECORD_STORAGE_VALUE = JSON.stringify("masterqc-record-storage:v2");
const ANOMALIES_PATH = '["history","anomalies"]';
const INSPECTIONS_PATH = '["history","inspections"]';
const FAMILIES_PATH = '["families"]';

// Schema of the previous release (format 1), including the attachment payload triggers.
const LEGACY_SCHEMA = `
  CREATE TABLE qc_state (state_key TEXT PRIMARY KEY, revision INTEGER NOT NULL, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE qc_asset_payloads (
    asset_id TEXT PRIMARY KEY,
    content_ref TEXT NOT NULL UNIQUE,
    data_url TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    decoded_bytes INTEGER NOT NULL,
    content_sha256 TEXT NOT NULL,
    content_revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE qc_adapter_meta (meta_key TEXT PRIMARY KEY, integer_value INTEGER NOT NULL);
  INSERT INTO qc_adapter_meta (meta_key, integer_value) VALUES ('asset_payload_generation', 0);
  CREATE TRIGGER qc_asset_payloads_after_insert AFTER INSERT ON qc_asset_payloads BEGIN
    UPDATE qc_adapter_meta SET integer_value = integer_value + 1 WHERE meta_key = 'asset_payload_generation';
  END;
  CREATE TRIGGER qc_asset_payloads_after_update AFTER UPDATE ON qc_asset_payloads BEGIN
    UPDATE qc_adapter_meta SET integer_value = integer_value + 1 WHERE meta_key = 'asset_payload_generation';
  END;
  CREATE TRIGGER qc_asset_payloads_after_delete AFTER DELETE ON qc_asset_payloads BEGIN
    UPDATE qc_adapter_meta SET integer_value = integer_value + 1 WHERE meta_key = 'asset_payload_generation';
  END;
`;

async function temporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "masterqc-web-record-storage-"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileDigest(filePath) {
  return sha256(await readFile(filePath));
}

function storedRows(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    const rowsOf = (sql, table) => {
      const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      return exists ? database.prepare(sql).all().map((row) => ({ ...row })) : [];
    };
    return {
      state: rowsOf("SELECT state_key, revision, value_json FROM qc_state ORDER BY state_key", "qc_state"),
      units: rowsOf("SELECT unit_key, value_json FROM qc_units ORDER BY unit_key", "qc_units"),
      records: rowsOf("SELECT collection, record_id, value_json FROM qc_records ORDER BY collection, record_id", "qc_records"),
      meta: rowsOf("SELECT meta_key, integer_value FROM qc_adapter_meta ORDER BY meta_key", "qc_adapter_meta"),
      payloads: rowsOf("SELECT * FROM qc_asset_payloads ORDER BY asset_id", "qc_asset_payloads"),
    };
  } finally {
    database.close();
  }
}

function storageFormat(databasePath) {
  const row = storedRows(databasePath).meta.find((item) => item.meta_key === "storage_format");
  return row ? row.integer_value : null;
}

// Adds a write log so tests can see every INSERT, UPDATE, and DELETE on the unit and record tables.
function installWriteLog(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE test_write_log (table_name TEXT NOT NULL, action TEXT NOT NULL, row_key TEXT NOT NULL);
      CREATE TRIGGER test_units_insert AFTER INSERT ON qc_units BEGIN
        INSERT INTO test_write_log VALUES ('qc_units', 'INSERT', NEW.unit_key); END;
      CREATE TRIGGER test_units_update AFTER UPDATE ON qc_units BEGIN
        INSERT INTO test_write_log VALUES ('qc_units', 'UPDATE', NEW.unit_key); END;
      CREATE TRIGGER test_units_delete AFTER DELETE ON qc_units BEGIN
        INSERT INTO test_write_log VALUES ('qc_units', 'DELETE', OLD.unit_key); END;
      CREATE TRIGGER test_records_insert AFTER INSERT ON qc_records BEGIN
        INSERT INTO test_write_log VALUES ('qc_records', 'INSERT', NEW.collection || ' ' || NEW.record_id); END;
      CREATE TRIGGER test_records_update AFTER UPDATE ON qc_records BEGIN
        INSERT INTO test_write_log VALUES ('qc_records', 'UPDATE', NEW.collection || ' ' || NEW.record_id); END;
      CREATE TRIGGER test_records_delete AFTER DELETE ON qc_records BEGIN
        INSERT INTO test_write_log VALUES ('qc_records', 'DELETE', OLD.collection || ' ' || OLD.record_id); END;
    `);
  } finally {
    database.close();
  }
}

function readAndClearWriteLog(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    const entries = database.prepare("SELECT table_name, action, row_key FROM test_write_log ORDER BY table_name, action, row_key")
      .all()
      .map((row) => ({ ...row }));
    database.exec("DELETE FROM test_write_log");
    return entries;
  } finally {
    database.close();
  }
}

// A record-shaped state with unique-id arrays, one ineligible array (duplicate ids), and scalars.
function sampleState(revision = 1) {
  return {
    schemaVersion: 1,
    revision,
    marker: "stable",
    families: [{ id: "family-a", name: "Family A" }, { id: "family-b", name: "Family B" }],
    orders: [{ id: "order-1", number: "PO-1", lines: [{ id: "line-1", orderedQty: 10 }] }],
    history: {
      sources: [{ id: "source-1", label: "S1" }],
      inspections: [
        { id: "inspection-1", rows: [{ id: "row-1", defectiveQty: 0 }] },
        { id: "inspection-2", rows: [] },
      ],
      anomalies: [{ id: "anomaly-1", note: "first" }, { id: "anomaly-1", note: "duplicate id" }],
    },
    audit: [{ id: "audit-1", action: "seed" }],
    assets: [],
  };
}

// Builds a valid QC state through the core service, including one attachment, for legacy fixtures.
async function legacyFixtureState() {
  const service = createQCService(createMemoryQCAdapter(), { now: NOW });
  const initial = await service.initialize();
  const variant = initial.variants.find((item) => item.model === "S15" && item.color === "Red");
  const ordered = await service.command("createOrder", {
    number: "LEGACY-PO-1",
    date: DATE,
    supplier: "Legacy supplier",
    notes: "Converted in place",
    lines: [{ variantId: variant.id, orderedQty: 25 }],
  }, initial.revision);
  await service.command("addDocument", {
    name: "legacy-note.txt",
    mimeType: "text/plain",
    dataUrl: TEXT_URL,
  }, ordered.revision);
  const state = await service.getState();
  await service.close();
  return state;
}

// Writes a format 1 database the way the previous release stored it: business JSON in qc_state
// with attachment content split into qc_asset_payloads.
function writeLegacyDatabase(databasePath, state) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(LEGACY_SCHEMA);
    const insertPayload = database.prepare(`
      INSERT INTO qc_asset_payloads
        (asset_id, content_ref, data_url, mime_type, decoded_bytes, content_sha256, content_revision, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `);
    const persisted = structuredClone(state);
    persisted.assets = persisted.assets.map((asset) => {
      if (typeof asset.dataUrl === "string") {
        const match = /^data:([^;,]+);base64,(.*)$/.exec(asset.dataUrl);
        const bytes = Buffer.from(match[2], "base64");
        insertPayload.run(asset.id, `masterqc-asset:v1:${asset.id}`, asset.dataUrl, match[1].toLocaleLowerCase(),
          bytes.length, sha256(bytes), FIXED_TIME);
      }
      const metadata = { ...asset };
      delete metadata.dataUrl;
      delete metadata.contentRef;
      return metadata;
    });
    database.prepare("INSERT INTO qc_state (state_key, revision, value_json, updated_at) VALUES ('main', ?, ?, ?)")
      .run(persisted.revision, JSON.stringify(persisted), FIXED_TIME);
  } finally {
    database.close();
  }
}

function sameJson(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

test("a brand-new database starts in record storage with units, records, and a non-object state marker", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "workspace.sqlite");
  const adapter = createSQLiteQCAdapter({ databasePath });
  await adapter.initialize();
  const state = sampleState(1);
  await adapter.transact(() => ({ state, result: null }));
  sameJson(await adapter.readState(), state);
  await adapter.close();

  const rows = storedRows(databasePath);
  assert.equal(storageFormat(databasePath), 2);
  assert.equal(rows.state[0].value_json, RECORD_STORAGE_VALUE);
  assert.equal(JSON.parse(rows.state[0].value_json), "masterqc-record-storage:v2");
  assert.equal(rows.units.find((row) => row.unit_key === ANOMALIES_PATH).value_json, JSON.stringify(state.history.anomalies));
  assert.equal(rows.records.some((row) => row.collection === ANOMALIES_PATH), false);
  assert.equal(rows.records.filter((row) => row.collection === FAMILIES_PATH).length, 2);
});

test("a format 1 database converts with exact equality, the same revision, intact attachments, and a verified recovery copy", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "legacy.sqlite");
  const recoveryPath = `${databasePath}.pre-record-storage-migration.sqlite`;
  const legacy = await legacyFixtureState();
  writeLegacyDatabase(databasePath, legacy);
  const payloadsBefore = storedRows(databasePath).payloads;

  const adapter = createSQLiteQCAdapter({ databasePath });
  const beforeJson = JSON.stringify(await adapter.readState());
  const beforeRevision = await adapter.getRevision();
  assert.equal(storageFormat(databasePath), null);

  await adapter.initialize();
  assert.equal(JSON.stringify(await adapter.readState()), beforeJson);
  assert.equal(await adapter.getRevision(), beforeRevision);
  assert.equal((await adapter.readAsset(legacy.assets[0].id)).dataUrl, TEXT_URL);
  await adapter.close();

  const rows = storedRows(databasePath);
  assert.equal(storageFormat(databasePath), 2);
  assert.equal(rows.state[0].revision, legacy.revision);
  assert.equal(rows.state[0].value_json, RECORD_STORAGE_VALUE);
  assert.equal(typeof JSON.parse(rows.state[0].value_json), "string");
  assert.deepEqual(rows.payloads, payloadsBefore);

  // The recovery copy keeps the previous release's persisted form: attachment metadata only, with
  // Data URLs in qc_asset_payloads.
  const persistedLegacy = { ...legacy, assets: legacy.assets.map(({ dataUrl, ...metadata }) => metadata) };
  const recovery = new DatabaseSync(recoveryPath);
  try {
    const recoveredJson = recovery.prepare("SELECT value_json FROM qc_state WHERE state_key = 'main'").get().value_json;
    assert.equal(recoveredJson, JSON.stringify(persistedLegacy));
    assert.equal(recovery.prepare("SELECT COUNT(*) AS count FROM qc_asset_payloads").get().count, 1);
  } finally {
    recovery.close();
  }
});

test("reopening a converted database changes nothing and does not validate the legacy state again", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "legacy.sqlite");
  const recoveryPath = `${databasePath}.pre-record-storage-migration.sqlite`;
  const legacy = await legacyFixtureState();
  writeLegacyDatabase(databasePath, legacy);
  let adapter = createSQLiteQCAdapter({ databasePath });
  await adapter.initialize();
  const convertedJson = JSON.stringify(await adapter.readState());
  await adapter.close();
  const databaseDigest = await fileDigest(databasePath);
  const recoveryDigest = await fileDigest(recoveryPath);

  adapter = createSQLiteQCAdapter({ databasePath });
  await adapter.initialize({ validateLegacyState: () => { throw new Error("A converted database must not be validated again."); } });
  assert.equal(JSON.stringify(await adapter.readState()), convertedJson);
  await adapter.close();
  assert.equal(await fileDigest(databasePath), databaseDigest);
  assert.equal(await fileDigest(recoveryPath), recoveryDigest);
});

test("a mismatching existing recovery copy blocks conversion and leaves the format 1 database unchanged", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "legacy.sqlite");
  const recoveryPath = `${databasePath}.pre-record-storage-migration.sqlite`;
  const legacy = await legacyFixtureState();
  writeLegacyDatabase(databasePath, legacy);
  writeLegacyDatabase(recoveryPath, { ...legacy, marker: "a different saved state" });
  const recoveryDigest = await fileDigest(recoveryPath);

  const adapter = createSQLiteQCAdapter({ databasePath });
  await assert.rejects(adapter.initialize(), /recovery copy already exists and does not match/);
  assert.deepEqual(await adapter.readState(), legacy);
  await adapter.close();
  assert.equal(storageFormat(databasePath), null);
  assert.equal(storedRows(databasePath).units.length, 0);
  assert.equal(await fileDigest(recoveryPath), recoveryDigest);
});

test("conversion stops when the stored revision column disagrees with the state", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "legacy.sqlite");
  const legacy = await legacyFixtureState();
  writeLegacyDatabase(databasePath, legacy);
  const direct = new DatabaseSync(databasePath);
  direct.exec("UPDATE qc_state SET revision = revision + 1");
  direct.close();

  const adapter = createSQLiteQCAdapter({ databasePath });
  await assert.rejects(adapter.initialize(), /revision does not match the stored state/);
  await adapter.close();
  assert.equal(storageFormat(databasePath), null);
  assert.equal(JSON.parse(storedRows(databasePath).state[0].value_json).revision, legacy.revision);
});

test("a single-record save writes only the changed record and the revision unit", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "workspace.sqlite");
  let adapter = createSQLiteQCAdapter({ databasePath });
  await adapter.initialize();
  await adapter.transact(() => ({ state: sampleState(1), result: null }));
  await adapter.close();
  installWriteLog(databasePath);

  adapter = createSQLiteQCAdapter({ databasePath });
  await adapter.initialize();
  const before = storedRows(databasePath);
  await adapter.transact((current) => {
    current.revision += 1;
    current.history.inspections[0].rows[0].defectiveQty = 1;
    return { state: current, result: null };
  });
  await adapter.close();

  assert.deepEqual(readAndClearWriteLog(databasePath), [
    { table_name: "qc_records", action: "UPDATE", row_key: `${INSPECTIONS_PATH} inspection-1` },
    { table_name: "qc_units", action: "UPDATE", row_key: '["revision"]' },
  ]);
  const after = storedRows(databasePath);
  assert.deepEqual(after.units.filter((row) => row.unit_key !== '["revision"]'),
    before.units.filter((row) => row.unit_key !== '["revision"]'));
  const changed = after.records.filter((row) => !before.records.some((other) => other.collection === row.collection &&
    other.record_id === row.record_id && other.value_json === row.value_json));
  assert.deepEqual(changed.map((row) => [row.collection, row.record_id]), [[INSPECTIONS_PATH, "inspection-1"]]);
  assert.equal(after.records.length, before.records.length);
});

test("adding, updating, deleting, and reordering records round-trip across reopen", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "workspace.sqlite");
  let adapter = createSQLiteQCAdapter({ databasePath });
  await adapter.initialize();
  let expected = sampleState(1);
  await adapter.transact(() => ({ state: structuredClone(expected), result: null }));

  expected = structuredClone(expected);
  expected.revision = 2;
  expected.families = [
    { id: "family-b", name: "Family B renamed" },
    { id: "family-c", name: "Family C" },
  ];
  expected.history.inspections = [{ id: "inspection-2", rows: [] }, { id: "inspection-3", rows: [] }];
  await adapter.transact((current) => {
    current.revision += 1;
    current.families = [
      { id: "family-b", name: "Family B renamed" },
      { id: "family-c", name: "Family C" },
    ];
    current.history.inspections.reverse();
    current.history.inspections = current.history.inspections.filter((item) => item.id !== "inspection-1");
    current.history.inspections.push({ id: "inspection-3", rows: [] });
    return { state: current, result: null };
  });
  await adapter.close();

  adapter = createSQLiteQCAdapter({ databasePath });
  sameJson(await adapter.readState(), expected);
  const rows = storedRows(databasePath);
  assert.deepEqual(rows.records.filter((row) => row.collection === FAMILIES_PATH).map((row) => row.record_id), ["family-b", "family-c"]);
  assert.deepEqual(rows.records.filter((row) => row.collection === INSPECTIONS_PATH).map((row) => row.record_id).sort(),
    ["inspection-2", "inspection-3"]);
  assert.deepEqual(rows.units.find((row) => row.unit_key === INSPECTIONS_PATH).value_json, '["inspection-2","inspection-3"]');

  await adapter.transact((current) => {
    current.revision += 1;
    current.history.inspections.reverse();
    return { state: current, result: null };
  });
  expected.revision = 3;
  expected.history.inspections.reverse();
  sameJson(await adapter.readState(), expected);
  await adapter.close();
});

test("an array that switches between record and whole-value storage round-trips", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "workspace.sqlite");
  const adapter = createSQLiteQCAdapter({ databasePath });
  await adapter.initialize();
  await adapter.transact(() => ({ state: sampleState(1), result: null }));
  let revision = 1;
  const saveStep = async (edit) => {
    await adapter.transact((current) => {
      revision += 1;
      current.revision = revision;
      edit(current);
      return { state: current, result: null };
    });
  };

  // history.anomalies: duplicate ids (whole value) -> unique ids (records) -> duplicate ids again (whole value).
  await saveStep((state) => {
    state.history.anomalies = [{ id: "anomaly-1", note: "first" }, { id: "anomaly-2", note: "second" }];
  });
  let expected = structuredClone(sampleState(2));
  expected.history.anomalies = [{ id: "anomaly-1", note: "first" }, { id: "anomaly-2", note: "second" }];
  sameJson(await adapter.readState(), expected);
  let rows = storedRows(databasePath);
  assert.equal(rows.records.filter((row) => row.collection === ANOMALIES_PATH).length, 2);
  assert.equal(rows.units.find((row) => row.unit_key === ANOMALIES_PATH).value_json, '["anomaly-1","anomaly-2"]');

  await saveStep((state) => {
    state.history.anomalies = [{ id: "anomaly-1", note: "first" }, { id: "anomaly-1", note: "duplicate again" }];
  });
  expected = structuredClone(sampleState(3));
  expected.history.anomalies = [{ id: "anomaly-1", note: "first" }, { id: "anomaly-1", note: "duplicate again" }];
  sameJson(await adapter.readState(), expected);
  rows = storedRows(databasePath);
  assert.equal(rows.records.some((row) => row.collection === ANOMALIES_PATH), false);
  assert.equal(rows.units.find((row) => row.unit_key === ANOMALIES_PATH).value_json, JSON.stringify(expected.history.anomalies));

  // families: record storage -> one element without an id (whole value) -> record storage again.
  await saveStep((state) => {
    state.families = [{ id: "family-a", name: "Family A" }, { name: "Unidentified family" }];
  });
  expected = structuredClone(sampleState(4));
  expected.families = [{ id: "family-a", name: "Family A" }, { name: "Unidentified family" }];
  expected.history.anomalies = [{ id: "anomaly-1", note: "first" }, { id: "anomaly-1", note: "duplicate again" }];
  sameJson(await adapter.readState(), expected);
  assert.equal(storedRows(databasePath).records.some((row) => row.collection === FAMILIES_PATH), false);

  await saveStep((state) => {
    state.families = [{ id: "family-a", name: "Family A" }, { id: "family-b", name: "Family B" }];
  });
  expected = structuredClone(sampleState(5));
  expected.history.anomalies = [{ id: "anomaly-1", note: "first" }, { id: "anomaly-1", note: "duplicate again" }];
  sameJson(await adapter.readState(), expected);
  await adapter.close();
});

test("a throwing or unserializable mutator rolls back every table", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "workspace.sqlite");
  const adapter = createSQLiteQCAdapter({ databasePath });
  await adapter.initialize();
  const state = sampleState(1);
  await adapter.transact(() => ({ state, result: null }));
  const before = storedRows(databasePath);

  await assert.rejects(adapter.transact((current) => {
    current.revision += 1;
    current.families.push({ id: "family-x", name: "Rolled back" });
    current.history.inspections[0].rows[0].defectiveQty = 9;
    throw new Error("rollback marker");
  }), /rollback marker/);
  assert.deepEqual(storedRows(databasePath), before);

  await assert.rejects(adapter.transact((current) => {
    current.revision += 1;
    current.families[0].name = "Changed before failure";
    current.marker = 1n;
    return { state: current, result: null };
  }), /BigInt|serialize/i);
  assert.deepEqual(storedRows(databasePath), before);
  sameJson(await adapter.readState(), sampleState(1));
  await adapter.close();
});

test("two adapter instances on one file see consistent state and revisions", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "workspace.sqlite");
  const first = createSQLiteQCAdapter({ databasePath });
  const second = createSQLiteQCAdapter({ databasePath });
  await first.initialize();
  await second.initialize();

  await first.transact(() => ({ state: sampleState(1), result: null }));
  assert.equal(await second.getRevision(), 1);
  sameJson(await second.readState(), sampleState(1));

  await second.transact((current) => {
    current.revision += 1;
    current.marker = "written by the second connection";
    return { state: current, result: null };
  });
  assert.equal(await first.getRevision(), 2);
  assert.equal((await first.readState()).marker, "written by the second connection");

  await first.transact((current) => {
    current.revision += 1;
    current.assets.push({
      id: "asset-1",
      name: "note.txt",
      mimeType: "text/plain",
      kind: "document",
      batchId: null,
      rowId: null,
      versionId: null,
      createdAt: FIXED_TIME,
      dataUrl: OTHER_TEXT_URL,
    });
    return { state: current, result: null };
  });
  assert.equal((await second.readAsset("asset-1")).dataUrl, OTHER_TEXT_URL);
  assert.equal((await second.readState({ includeAssetContent: false })).assets[0].contentRef, "masterqc-asset:v1:asset-1");
  assert.equal(second.getTrustedAssetValidation().get("asset-1").decodedBytes, 5);
  await first.close();
  await second.close();
});

test("full, lightweight, asset, and backup results are identical before and after conversion", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "legacy.sqlite");
  const legacy = await legacyFixtureState();
  writeLegacyDatabase(databasePath, legacy);
  const assetId = legacy.assets[0].id;
  const adapter = createSQLiteQCAdapter({ databasePath });

  // Core reads through this adapter view without initialize, so the format 1 state is read unconverted.
  const unconverted = createQCService({
    readState: adapter.readState,
    readAsset: adapter.readAsset,
    transact: adapter.transact,
    getRevision: adapter.getRevision,
    getTrustedAssetValidation: adapter.getTrustedAssetValidation,
    close: adapter.close,
  }, { now: NOW });
  const readAll = async (service) => ({
    full: await service.getState(),
    lightweight: await service.getState({ mode: "lightweight" }),
    asset: await service.getAsset(assetId),
    backup: await service.exportBackup(),
  });
  const before = await readAll(unconverted);
  assert.equal(storageFormat(databasePath), null);

  const service = createQCService(adapter, { now: NOW });
  await service.initialize();
  assert.equal(storageFormat(databasePath), 2);
  const after = await readAll(service);
  for (const key of Object.keys(before)) {
    assert.equal(JSON.stringify(after[key]), JSON.stringify(before[key]), `${key} changed during conversion`);
  }
  assert.equal(after.asset.dataUrl, TEXT_URL);
  await service.close();
});

test("a converted database rejects a state overwrite that does not use record storage", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "legacy.sqlite");
  writeLegacyDatabase(databasePath, await legacyFixtureState());
  let adapter = createSQLiteQCAdapter({ databasePath });
  await adapter.initialize();
  await adapter.close();

  const direct = new DatabaseSync(databasePath);
  direct.prepare("UPDATE qc_state SET value_json = ? WHERE state_key = 'main'").run(JSON.stringify(sampleState(99)));
  direct.close();

  adapter = createSQLiteQCAdapter({ databasePath });
  await assert.rejects(adapter.readState(), /unrecognized storage layout/);
  await assert.rejects(adapter.transact(() => ({ state: sampleState(100), result: null })), /unrecognized storage layout/);
  await adapter.close();
});
