import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const STATE_KEY = "main";
const DATA_URL_PATTERN = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/;
const LEGACY_STORAGE_FORMAT = 1;
const RECORD_STORAGE_FORMAT = 2;
// Format 2 keeps the aggregate in qc_units and qc_records. The qc_state row holds this JSON string,
// which format 1 readers reject because they require a JSON object.
const RECORD_STORAGE_STATE_VALUE = JSON.stringify("masterqc-record-storage:v2");
const LAYOUT_UNIT_KEY = "$layout";

function clone(value) {
  return structuredClone(value);
}

function cloneState(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("QC state must be an object");
  }
  return clone(value);
}

function requireSynchronousOutcome(value) {
  if (value !== null && (typeof value === "object" || typeof value === "function") && typeof value.then === "function") {
    throw new TypeError("QC transaction mutator must be synchronous");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("QC transaction mutator must return an object containing state and result");
  }
  return value;
}

function contentRefFor(assetId) {
  return `masterqc-asset:v1:${assetId}`;
}

function inspectDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") throw new TypeError("Attachment payload must be a base64 data URL.");
  const match = DATA_URL_PATTERN.exec(dataUrl);
  if (!match || match[2].length % 4 !== 0) throw new TypeError("Attachment payload must be a valid base64 data URL.");
  const base64 = match[2];
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const decodedBytes = Math.max(0, (base64.length * 3) / 4 - padding);
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length !== decodedBytes) throw new TypeError("Attachment payload has an invalid base64 length.");
  return {
    mimeType: match[1].toLocaleLowerCase(),
    decodedBytes,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function stateWithoutPayloads(state) {
  const persisted = { ...state };
  if (!Array.isArray(state.assets)) return persisted;
  persisted.assets = state.assets.map((asset) => {
    if (asset === null || typeof asset !== "object" || Array.isArray(asset)) return asset;
    const metadata = { ...asset };
    delete metadata.dataUrl;
    delete metadata.contentRef;
    delete metadata.contentValidation;
    delete metadata._contentValidation;
    return metadata;
  });
  return persisted;
}

function parseStoredJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("Stored QC state is not valid JSON.", { cause: error });
  }
}

function parseLegacyState(text) {
  const state = parseStoredJson(text);
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("Stored QC state is not valid JSON.", { cause: new TypeError("QC state must be an object") });
  }
  return state;
}

// Unit and collection keys are JSON arrays of path segments, so different paths cannot collide.
function pathKey(segments) {
  return JSON.stringify(segments);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Record arrays hold only plain objects with unique, non-empty string ids. Anything else stays one unit.
function hasUniqueRecordIds(value) {
  if (!Array.isArray(value)) return false;
  const ids = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isPlainObject(item) || typeof item.id !== "string" || item.id === "" || ids.has(item.id)) return false;
    ids.add(item.id);
  }
  return true;
}

// Places one value into the plan and returns its layout kind, or null when JSON omits the value.
function placeValue(segments, value, plan) {
  if (value === undefined) return null;
  const key = pathKey(segments);
  if (hasUniqueRecordIds(value)) {
    const ids = [];
    const rows = new Map();
    for (const item of value) {
      ids.push(item.id);
      rows.set(item.id, JSON.stringify(item));
    }
    plan.units.set(key, JSON.stringify(ids));
    plan.records.set(key, rows);
    return "records";
  }
  const text = JSON.stringify(value);
  if (text === undefined) return null;
  plan.units.set(key, text);
  return "value";
}

// Splits the persisted aggregate into serialized units and record rows. The layout keeps top-level and
// first-level key order, so reassembly reproduces the original JSON exactly.
function planRecordStorage(state) {
  const plan = { units: new Map(), records: new Map() };
  const layout = [];
  for (const key of Object.keys(state)) {
    const value = state[key];
    if (isPlainObject(value)) {
      const children = [];
      for (const childKey of Object.keys(value)) {
        const kind = placeValue([key, childKey], value[childKey], plan);
        if (kind !== null) children.push([childKey, kind]);
      }
      layout.push([key, "object", children]);
    } else {
      const kind = placeValue([key], value, plan);
      if (kind !== null) layout.push([key, kind]);
    }
  }
  plan.units.set(LAYOUT_UNIT_KEY, JSON.stringify(layout));
  return plan;
}

function assembleRecordState(units, records) {
  const layoutText = units.get(LAYOUT_UNIT_KEY);
  if (layoutText === undefined) throw new Error("Stored QC state layout is missing.");
  const layout = parseStoredJson(layoutText);
  if (!Array.isArray(layout)) throw new Error("Stored QC state layout is invalid.");
  let expectedRecords = 0;

  function readUnit(segments) {
    const text = units.get(pathKey(segments));
    if (text === undefined) throw new Error("Stored QC state is incomplete.");
    return parseStoredJson(text);
  }

  function readEntry(segments, kind) {
    if (kind === "value") return readUnit(segments);
    if (kind !== "records") throw new Error("Stored QC state layout is invalid.");
    const ids = readUnit(segments);
    if (!Array.isArray(ids)) throw new Error("Stored QC state layout is invalid.");
    const rows = records.get(pathKey(segments)) ?? new Map();
    expectedRecords += ids.length;
    return ids.map((id) => {
      const text = rows.get(id);
      if (text === undefined) throw new Error("Stored QC state is incomplete.");
      return parseStoredJson(text);
    });
  }

  const entries = layout.map(([key, kind, children]) => {
    if (kind !== "object") return [key, readEntry([key], kind)];
    return [key, Object.fromEntries(children.map(([childKey, childKind]) => [childKey, readEntry([key, childKey], childKind)]))];
  });
  let storedRecords = 0;
  for (const rows of records.values()) storedRecords += rows.size;
  if (storedRecords !== expectedRecords) throw new Error("Stored QC records do not match the state layout.");
  return Object.fromEntries(entries);
}

/** Node-only durable aggregate adapter. QC rules remain in core. */
export function createSQLiteQCAdapter({ databasePath } = {}) {
  if (typeof databasePath !== "string" || !databasePath.trim()) {
    throw new TypeError("SQLite QC adapter requires a databasePath.");
  }

  const resolvedPath = path.resolve(databasePath);
  mkdirSync(path.dirname(resolvedPath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(resolvedPath);
  chmodSync(resolvedPath, 0o600);
  database.exec("PRAGMA busy_timeout = 5000;");
  database.exec("PRAGMA journal_mode = DELETE;");
  database.exec("PRAGMA synchronous = FULL;");
  database.exec("CREATE TABLE IF NOT EXISTS qc_state (state_key TEXT PRIMARY KEY, revision INTEGER NOT NULL, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);");
  database.exec(`
    CREATE TABLE IF NOT EXISTS qc_asset_payloads (
      asset_id TEXT PRIMARY KEY,
      content_ref TEXT NOT NULL UNIQUE,
      data_url TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      decoded_bytes INTEGER NOT NULL,
      content_sha256 TEXT NOT NULL,
      content_revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  database.exec("CREATE TABLE IF NOT EXISTS qc_adapter_meta (meta_key TEXT PRIMARY KEY, integer_value INTEGER NOT NULL);");
  database.exec(`
    CREATE TABLE IF NOT EXISTS qc_units (
      unit_key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS qc_records (
      collection TEXT NOT NULL,
      record_id TEXT NOT NULL,
      value_json TEXT NOT NULL,
      PRIMARY KEY (collection, record_id)
    );
  `);
  database.prepare("INSERT OR IGNORE INTO qc_adapter_meta (meta_key, integer_value) VALUES ('asset_payload_generation', 0)").run();
  // A database with neither saved state nor a format marker is new, so it starts in the record format.
  database.prepare(`
    INSERT OR IGNORE INTO qc_adapter_meta (meta_key, integer_value)
    SELECT 'storage_format', ${RECORD_STORAGE_FORMAT}
    WHERE NOT EXISTS (SELECT 1 FROM qc_state WHERE state_key = '${STATE_KEY}')
      AND NOT EXISTS (SELECT 1 FROM qc_adapter_meta WHERE meta_key = 'storage_format')
  `).run();
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS qc_asset_payloads_after_insert
      AFTER INSERT ON qc_asset_payloads BEGIN
        UPDATE qc_adapter_meta SET integer_value = integer_value + 1 WHERE meta_key = 'asset_payload_generation';
      END;
    CREATE TRIGGER IF NOT EXISTS qc_asset_payloads_after_update
      AFTER UPDATE ON qc_asset_payloads BEGIN
        UPDATE qc_adapter_meta SET integer_value = integer_value + 1 WHERE meta_key = 'asset_payload_generation';
      END;
    CREATE TRIGGER IF NOT EXISTS qc_asset_payloads_after_delete
      AFTER DELETE ON qc_asset_payloads BEGIN
        UPDATE qc_adapter_meta SET integer_value = integer_value + 1 WHERE meta_key = 'asset_payload_generation';
      END;
  `);

  const readStateRowStatement = database.prepare("SELECT revision, value_json FROM qc_state WHERE state_key = ?");
  const revisionStatement = database.prepare("SELECT revision FROM qc_state WHERE state_key = ?");
  const writeStatement = database.prepare(`
    INSERT INTO qc_state (state_key, revision, value_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(state_key) DO UPDATE SET
      revision = excluded.revision,
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `);
  const readStorageFormatStatement = database.prepare("SELECT integer_value FROM qc_adapter_meta WHERE meta_key = 'storage_format'");
  const writeStorageFormatStatement = database.prepare("INSERT OR REPLACE INTO qc_adapter_meta (meta_key, integer_value) VALUES ('storage_format', ?)");
  const readUnitRowsStatement = database.prepare("SELECT unit_key, value_json FROM qc_units");
  const readRecordRowsStatement = database.prepare("SELECT collection, record_id, value_json FROM qc_records");
  const upsertUnitStatement = database.prepare(`
    INSERT INTO qc_units (unit_key, value_json) VALUES (?, ?)
    ON CONFLICT(unit_key) DO UPDATE SET value_json = excluded.value_json
  `);
  const deleteUnitStatement = database.prepare("DELETE FROM qc_units WHERE unit_key = ?");
  const insertRecordStatement = database.prepare("INSERT INTO qc_records (collection, record_id, value_json) VALUES (?, ?, ?)");
  const updateRecordStatement = database.prepare("UPDATE qc_records SET value_json = ? WHERE collection = ? AND record_id = ?");
  const deleteRecordStatement = database.prepare("DELETE FROM qc_records WHERE collection = ? AND record_id = ?");
  const readPayloadStatement = database.prepare(`
    SELECT asset_id, content_ref, data_url, mime_type, decoded_bytes, content_sha256, content_revision
    FROM qc_asset_payloads WHERE asset_id = ?
  `);
  const readPayloadMetadataStatement = database.prepare(`
    SELECT asset_id, content_ref, mime_type, decoded_bytes, content_sha256, content_revision
    FROM qc_asset_payloads ORDER BY asset_id
  `);
  const readPayloadMetadataByIdStatement = database.prepare(`
    SELECT asset_id, content_ref, mime_type, decoded_bytes, content_sha256, content_revision
    FROM qc_asset_payloads WHERE asset_id = ?
  `);
  const readPayloadIdsStatement = database.prepare("SELECT asset_id FROM qc_asset_payloads");
  const readAllPayloadsStatement = database.prepare(`
    SELECT asset_id, content_ref, data_url, mime_type, decoded_bytes, content_sha256, content_revision
    FROM qc_asset_payloads ORDER BY asset_id
  `);
  const payloadGenerationStatement = database.prepare("SELECT integer_value FROM qc_adapter_meta WHERE meta_key = 'asset_payload_generation'");
  const insertPayloadStatement = database.prepare(`
    INSERT INTO qc_asset_payloads
      (asset_id, content_ref, data_url, mime_type, decoded_bytes, content_sha256, content_revision, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updatePayloadStatement = database.prepare(`
    UPDATE qc_asset_payloads SET data_url = ?, mime_type = ?, decoded_bytes = ?, content_sha256 = ?,
      content_revision = ?, updated_at = ? WHERE asset_id = ?
  `);
  const deletePayloadStatement = database.prepare("DELETE FROM qc_asset_payloads WHERE asset_id = ?");
  let closed = false;
  let verifiedPayloadGeneration = null;
  let transactionOpen = false;

  function ensureOpen() {
    if (closed) throw new Error("SQLite QC adapter is closed.");
  }

  // Runs work between BEGIN and COMMIT and rolls every change back if work throws.
  function runTransaction(begin, work) {
    database.exec(begin);
    transactionOpen = true;
    try {
      const result = work();
      database.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK;");
      } catch {
        // Preserve the original transaction failure.
      }
      throw error;
    } finally {
      transactionOpen = false;
    }
  }

  // Multi-row reads run in one read transaction, so they see a single committed snapshot.
  function readSnapshot(read) {
    return transactionOpen ? read() : runTransaction("BEGIN;", read);
  }

  function readStorageFormat() {
    const row = readStorageFormatStatement.get();
    return row ? Number(row.integer_value) : LEGACY_STORAGE_FORMAT;
  }

  function readUnitRows() {
    return new Map(readUnitRowsStatement.all().map((row) => [row.unit_key, row.value_json]));
  }

  function readRecordRows() {
    const collections = new Map();
    for (const row of readRecordRowsStatement.all()) {
      if (!collections.has(row.collection)) collections.set(row.collection, new Map());
      collections.get(row.collection).set(row.record_id, row.value_json);
    }
    return collections;
  }

  // Reads the stored text in the current format. Call it inside a read or write transaction.
  function readStoredRows() {
    const format = readStorageFormat();
    if (format !== LEGACY_STORAGE_FORMAT && format !== RECORD_STORAGE_FORMAT) {
      throw new Error(`Unsupported QC storage format ${format}.`);
    }
    const stateRow = readStateRowStatement.get(STATE_KEY) ?? null;
    if (format === LEGACY_STORAGE_FORMAT) return { format, stateRow, units: null, records: null };
    return { format, stateRow, units: readUnitRows(), records: readRecordRows() };
  }

  function parseStoredState(stored) {
    if (stored.stateRow === null) {
      if (stored.format === RECORD_STORAGE_FORMAT && (stored.units.size > 0 || stored.records.size > 0)) {
        throw new Error("Stored QC state is incomplete.");
      }
      return null;
    }
    if (stored.format === LEGACY_STORAGE_FORMAT) return parseLegacyState(stored.stateRow.value_json);
    if (stored.stateRow.value_json !== RECORD_STORAGE_STATE_VALUE) {
      throw new Error("Stored QC state uses an unrecognized storage layout.");
    }
    return assembleRecordState(stored.units, stored.records);
  }

  function getStoredState() {
    return parseStoredState(readStoredRows());
  }

  function requirePayloadRow(assetId) {
    const payload = readPayloadStatement.get(assetId);
    if (!payload) throw new Error(`Stored attachment payload is missing for asset ${assetId}.`);
    if (payload.content_ref !== contentRefFor(assetId)) throw new Error(`Stored attachment reference is invalid for asset ${assetId}.`);
    return payload;
  }

  function verifyPayload(assetId, payload) {
    const parsed = inspectDataUrl(payload.data_url);
    if (parsed.mimeType !== payload.mime_type || parsed.decodedBytes !== Number(payload.decoded_bytes) ||
        parsed.contentSha256 !== payload.content_sha256) {
      throw new Error(`Stored attachment payload is corrupt for asset ${assetId}.`);
    }
    return payload.data_url;
  }

  function currentPayloadGeneration() {
    const row = payloadGenerationStatement.get();
    return row ? Number(row.integer_value) : 0;
  }

  function ensureTrustedPayloadGeneration() {
    return readSnapshot(() => {
      const generation = currentPayloadGeneration();
      if (generation === verifiedPayloadGeneration) return generation;
      const state = getStoredState();
      const stateAssets = new Map((state?.assets ?? []).map((asset) => [asset.id, asset]));
      const rows = readAllPayloadsStatement.all();
      const rowIds = new Set();
      for (const row of rows) {
        rowIds.add(row.asset_id);
        if (!stateAssets.has(row.asset_id)) throw new Error(`Stored attachment payload has no asset record for ${row.asset_id}.`);
        if (row.content_ref !== contentRefFor(row.asset_id)) throw new Error(`Stored attachment reference is invalid for asset ${row.asset_id}.`);
        verifyPayload(row.asset_id, row);
      }
      for (const asset of state?.assets ?? []) {
        if (typeof asset.dataUrl === "string") continue;
        if (!rowIds.has(asset.id)) throw new Error(`Stored attachment payload is missing for asset ${asset.id}.`);
      }
      verifiedPayloadGeneration = generation;
      return generation;
    });
  }

  function withFullPayloads(state) {
    if (state === null) return null;
    for (const asset of state.assets ?? []) {
      if (typeof asset.dataUrl === "string") {
        delete asset.contentRef;
        continue;
      }
      const payload = requirePayloadRow(asset.id);
      asset.dataUrl = verifyPayload(asset.id, payload);
      delete asset.contentRef;
    }
    return state;
  }

  function withLightPayloadMetadata(state) {
    if (state === null) return null;
    ensureTrustedPayloadGeneration();
    const metadataById = new Map(readPayloadMetadataStatement.all().map((row) => [row.asset_id, row]));
    for (const asset of state.assets ?? []) {
      if (typeof asset.dataUrl === "string") {
        asset.contentRef = contentRefFor(asset.id);
        delete asset.dataUrl;
        continue;
      }
      const metadata = metadataById.get(asset.id);
      if (!metadata) throw new Error(`Stored attachment payload is missing for asset ${asset.id}.`);
      if (metadata.content_ref !== contentRefFor(asset.id)) throw new Error(`Stored attachment reference is invalid for asset ${asset.id}.`);
      asset.contentRef = metadata.content_ref;
      delete asset.dataUrl;
    }
    return state;
  }

  function readRecoveryState(recoveryPath) {
    if (!existsSync(recoveryPath)) return null;
    const recovery = new DatabaseSync(recoveryPath);
    try {
      const row = recovery.prepare("SELECT value_json FROM qc_state WHERE state_key = ?").get(STATE_KEY);
      return row ? JSON.parse(row.value_json) : null;
    } finally {
      recovery.close();
    }
  }

  // Copies the database with VACUUM INTO and links the verified copy into place. Call it outside transactions.
  function ensureRecoveryCopy(recoveryPath, expectedState, label) {
    const existingRecovery = readRecoveryState(recoveryPath);
    if (existingRecovery !== null) {
      if (JSON.stringify(existingRecovery) !== JSON.stringify(expectedState)) {
        throw new Error(`The ${label} recovery copy already exists and does not match this database: ${recoveryPath}`);
      }
      return recoveryPath;
    }

    const temporaryPath = `${recoveryPath}.${randomUUID()}.tmp`;
    try {
      const escapedPath = temporaryPath.replaceAll("'", "''");
      database.exec(`VACUUM INTO '${escapedPath}'`);
      chmodSync(temporaryPath, 0o600);
      const copiedState = readRecoveryState(temporaryPath);
      if (copiedState === null || JSON.stringify(copiedState) !== JSON.stringify(expectedState)) {
        throw new Error(`SQLite did not create a complete ${label} recovery copy.`);
      }
      try {
        linkSync(temporaryPath, recoveryPath);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const racedState = readRecoveryState(recoveryPath);
        if (racedState === null || JSON.stringify(racedState) !== JSON.stringify(expectedState)) throw error;
      }
      return recoveryPath;
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  }

  async function migrateLegacyPayloads(validateLegacyState) {
    const snapshot = readSnapshot(getStoredState);
    if (snapshot === null) return;
    const assets = Array.isArray(snapshot.assets) ? snapshot.assets : [];
    const requiresMigration = assets.some((asset) => typeof asset.dataUrl === "string");
    if (!requiresMigration) {
      readSnapshot(() => {
        const metadata = new Map(readPayloadMetadataStatement.all().map((row) => [row.asset_id, row]));
        for (const asset of assets) {
          const payload = metadata.get(asset.id);
          if (!payload) throw new Error(`Stored attachment payload is missing for asset ${asset.id}.`);
          if (payload.content_ref !== contentRefFor(asset.id)) throw new Error(`Stored attachment reference is invalid for asset ${asset.id}.`);
        }
      });
      return;
    }
    if (typeof validateLegacyState !== "function") {
      throw new Error("A full state validator is required before migrating embedded attachment payloads.");
    }
    ensureRecoveryCopy(`${resolvedPath}.pre-attachment-payload-migration.sqlite`, snapshot, "attachment migration");
    database.exec("BEGIN IMMEDIATE;");
    transactionOpen = true;
    try {
      if (readStorageFormat() !== LEGACY_STORAGE_FORMAT) {
        throw new Error("QC storage changed while preparing the attachment migration; restart the migration.");
      }
      const state = getStoredState();
      if (JSON.stringify(state) !== JSON.stringify(snapshot)) {
        throw new Error("QC state changed while preparing the attachment migration; restart the migration.");
      }
      await validateLegacyState(clone(state));
      const legacyAssets = Array.isArray(state.assets) ? state.assets : [];
      const referenced = new Set(legacyAssets.map((asset) => asset.id));
      for (const asset of legacyAssets) {
        const existing = readPayloadStatement.get(asset.id);
        if (typeof asset.dataUrl === "string") {
          const metadata = inspectDataUrl(asset.dataUrl);
          if (existing) {
            if (existing.data_url !== asset.dataUrl || existing.content_ref !== contentRefFor(asset.id)) {
              throw new Error(`Attachment payload migration found conflicting content for asset ${asset.id}.`);
            }
            verifyPayload(asset.id, existing);
          } else {
            insertPayloadStatement.run(asset.id, contentRefFor(asset.id), asset.dataUrl, metadata.mimeType,
              metadata.decodedBytes, metadata.contentSha256, 1, new Date().toISOString());
          }
        } else {
          if (!existing) throw new Error(`Attachment payload migration cannot recover missing asset ${asset.id}.`);
          if (existing.content_ref !== contentRefFor(asset.id)) throw new Error(`Stored attachment reference is invalid for asset ${asset.id}.`);
          verifyPayload(asset.id, existing);
        }
      }
      for (const row of readPayloadIdsStatement.all()) {
        if (!referenced.has(row.asset_id)) deletePayloadStatement.run(row.asset_id);
      }
      const serialized = JSON.stringify(stateWithoutPayloads(state));
      if (typeof serialized !== "string") throw new TypeError("QC state could not be serialized.");
      writeStatement.run(STATE_KEY, state.revision, serialized, new Date().toISOString());
      const migratedGeneration = currentPayloadGeneration();
      database.exec("COMMIT;");
      verifiedPayloadGeneration = migratedGeneration;
    } catch (error) {
      try {
        database.exec("ROLLBACK;");
      } catch {
        // Preserve the original migration failure.
      }
      throw error;
    } finally {
      transactionOpen = false;
    }
  }

  // Writes only the units and record rows whose serialized text differs from the rows in `stored`,
  // which were read at the start of the same transaction.
  function writeRecordState(state, stored, revision, now) {
    const plan = planRecordStorage(state);
    for (const [unitKey, text] of plan.units) {
      if (stored.units.get(unitKey) !== text) upsertUnitStatement.run(unitKey, text);
    }
    for (const unitKey of stored.units.keys()) {
      if (!plan.units.has(unitKey)) deleteUnitStatement.run(unitKey);
    }
    for (const [collection, rows] of plan.records) {
      const previousRows = stored.records.get(collection);
      for (const [recordId, text] of rows) {
        const previousText = previousRows?.get(recordId);
        if (previousText === undefined) insertRecordStatement.run(collection, recordId, text);
        else if (previousText !== text) updateRecordStatement.run(text, collection, recordId);
      }
    }
    for (const [collection, rows] of stored.records) {
      const nextRows = plan.records.get(collection);
      for (const recordId of rows.keys()) {
        if (!nextRows?.has(recordId)) deleteRecordStatement.run(collection, recordId);
      }
    }
    writeStatement.run(STATE_KEY, revision, RECORD_STORAGE_STATE_VALUE, now);
  }

  // Converts a format 1 database once. The recovery copy is made first, and the conversion commits only
  // when the rebuilt aggregate equals the legacy state, including its revision.
  function convertToRecordStorage() {
    if (readStorageFormat() !== LEGACY_STORAGE_FORMAT) return;
    const legacyRows = readSnapshot(readStoredRows);
    if (legacyRows.format !== LEGACY_STORAGE_FORMAT) return;
    const legacyState = parseStoredState(legacyRows);
    if (legacyState !== null) {
      ensureRecoveryCopy(`${resolvedPath}.pre-record-storage-migration.sqlite`, legacyState, "record storage migration");
    }
    runTransaction("BEGIN IMMEDIATE;", () => {
      const stored = readStoredRows();
      if (stored.format !== LEGACY_STORAGE_FORMAT) return;
      const state = parseStoredState(stored);
      if (JSON.stringify(state) !== JSON.stringify(legacyState)) {
        throw new Error("QC state changed while preparing the record storage migration; restart the migration.");
      }
      if (state !== null) {
        if (Number(stored.stateRow.revision) !== state.revision) {
          throw new Error("The stored QC revision does not match the stored state; the record storage migration was stopped.");
        }
        writeRecordState(state, { units: readUnitRows(), records: readRecordRows() }, state.revision, new Date().toISOString());
        const rebuilt = assembleRecordState(readUnitRows(), readRecordRows());
        if (JSON.stringify(rebuilt) !== JSON.stringify(state) ||
            rebuilt.revision !== Number(readStateRowStatement.get(STATE_KEY).revision)) {
          throw new Error("Record storage migration did not reproduce the stored state; nothing was changed.");
        }
      }
      writeStorageFormatStatement.run(RECORD_STORAGE_FORMAT);
    });
  }

  function writePayloads(nextState, previousState) {
    const previousIds = new Set((previousState?.assets ?? []).map((asset) => asset.id));
    const nextIds = new Set();
    const now = new Date().toISOString();
    for (const asset of nextState.assets ?? []) {
      nextIds.add(asset.id);
      if (typeof asset.dataUrl === "string") {
        const existing = readPayloadStatement.get(asset.id);
        const metadata = inspectDataUrl(asset.dataUrl);
        const expectedRef = contentRefFor(asset.id);
        if (asset.contentRef !== undefined && asset.contentRef !== expectedRef) {
          throw new Error(`Attachment ${asset.id} changed its stable content reference.`);
        }
        if (!existing) {
          insertPayloadStatement.run(asset.id, expectedRef, asset.dataUrl, metadata.mimeType,
            metadata.decodedBytes, metadata.contentSha256, 1, now);
        } else {
          const changed = existing.content_ref !== expectedRef || existing.content_sha256 !== metadata.contentSha256 ||
            existing.mime_type !== metadata.mimeType || Number(existing.decoded_bytes) !== metadata.decodedBytes;
          if (existing.content_ref !== expectedRef) throw new Error(`Stored attachment reference is invalid for asset ${asset.id}.`);
          if (changed || existing.data_url !== asset.dataUrl) {
            const contentRevision = Number(existing.content_revision) + (changed ? 1 : 0);
            updatePayloadStatement.run(asset.dataUrl, metadata.mimeType, metadata.decodedBytes,
              metadata.contentSha256, contentRevision, now, asset.id);
          }
        }
      } else {
        const reference = asset.contentRef ?? (previousIds.has(asset.id) ? contentRefFor(asset.id) : null);
        if (reference !== contentRefFor(asset.id)) throw new Error(`Attachment ${asset.id} has no stable content reference.`);
        const metadata = readPayloadMetadataByIdStatement.get(asset.id);
        if (!metadata) throw new Error(`Attachment payload is missing for asset ${asset.id}.`);
        if (metadata.content_ref !== reference) throw new Error(`Stored attachment reference is invalid for asset ${asset.id}.`);
      }
    }
    for (const row of readPayloadIdsStatement.all()) {
      if (!nextIds.has(row.asset_id)) deletePayloadStatement.run(row.asset_id);
    }
  }

  return Object.freeze({
    async initialize({ validateLegacyState } = {}) {
      ensureOpen();
      await migrateLegacyPayloads(validateLegacyState);
      convertToRecordStorage();
    },

    async readState({ includeAssetContent = true } = {}) {
      ensureOpen();
      return readSnapshot(() => {
        const state = getStoredState();
        if (state === null) return null;
        return includeAssetContent ? withFullPayloads(state) : withLightPayloadMetadata(state);
      });
    },

    async readAsset(assetId) {
      ensureOpen();
      if (typeof assetId !== "string" || !assetId) return null;
      return readSnapshot(() => {
        const state = getStoredState();
        const asset = state?.assets?.find((candidate) => candidate.id === assetId);
        if (!asset) return null;
        const payload = requirePayloadRow(assetId);
        asset.dataUrl = verifyPayload(assetId, payload);
        delete asset.contentRef;
        return clone(asset);
      });
    },

    getTrustedAssetValidation() {
      ensureOpen();
      return readSnapshot(() => {
        ensureTrustedPayloadGeneration();
        return new Map(readPayloadMetadataStatement.all().map((row) => [row.asset_id, {
          contentRef: row.content_ref,
          contentSha256: row.content_sha256,
          decodedBytes: Number(row.decoded_bytes),
          mimeType: row.mime_type,
          contentRevision: Number(row.content_revision),
        }]));
      });
    },

    async getRevision() {
      ensureOpen();
      const row = revisionStatement.get(STATE_KEY);
      return row ? Number(row.revision) : null;
    },

    async transact(mutator, { includeAssetContent = true } = {}) {
      ensureOpen();
      if (typeof mutator !== "function") throw new TypeError("QC transaction mutator must be a function");

      const committed = runTransaction("BEGIN IMMEDIATE;", () => {
        const stored = readStoredRows();
        const storedState = parseStoredState(stored);
        const current = includeAssetContent
          ? withFullPayloads(storedState)
          : withLightPayloadMetadata(storedState);
        const outcome = requireSynchronousOutcome(mutator(current));
        const nextState = cloneState(outcome.state);
        const result = clone(outcome.result);
        writePayloads(nextState, current);
        const persisted = stateWithoutPayloads(nextState);
        const now = new Date().toISOString();
        if (stored.format === LEGACY_STORAGE_FORMAT) {
          const serialized = JSON.stringify(persisted);
          if (typeof serialized !== "string") throw new TypeError("QC state could not be serialized.");
          writeStatement.run(STATE_KEY, nextState.revision, serialized, now);
        } else {
          writeRecordState(persisted, stored, nextState.revision, now);
        }
        return { result, generation: currentPayloadGeneration() };
      });
      verifiedPayloadGeneration = committed.generation;
      return committed.result;
    },

    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  });
}
