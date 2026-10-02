import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const STATE_KEY = "main";
const DATA_URL_PATTERN = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/;

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
  database.prepare("INSERT OR IGNORE INTO qc_adapter_meta (meta_key, integer_value) VALUES ('asset_payload_generation', 0)").run();
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

  const readStatement = database.prepare("SELECT value_json FROM qc_state WHERE state_key = ?");
  const revisionStatement = database.prepare("SELECT revision FROM qc_state WHERE state_key = ?");
  const writeStatement = database.prepare(`
    INSERT INTO qc_state (state_key, revision, value_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(state_key) DO UPDATE SET
      revision = excluded.revision,
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `);
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

  function ensureOpen() {
    if (closed) throw new Error("SQLite QC adapter is closed.");
  }

  function getStoredState() {
    const row = readStatement.get(STATE_KEY);
    if (!row) return null;
    try {
      const state = JSON.parse(row.value_json);
      if (state === null || typeof state !== "object" || Array.isArray(state)) {
        throw new TypeError("QC state must be an object");
      }
      return state;
    } catch (error) {
      throw new Error("Stored QC state is not valid JSON.", { cause: error });
    }
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

  function ensureMigrationRecoveryCopy(expectedState) {
    const recoveryPath = `${resolvedPath}.pre-attachment-payload-migration.sqlite`;
    const existingRecovery = readRecoveryState(recoveryPath);
    if (existingRecovery !== null) {
      if (JSON.stringify(existingRecovery) !== JSON.stringify(expectedState)) {
        throw new Error(`The attachment migration recovery copy already exists and does not match this database: ${recoveryPath}`);
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
        throw new Error("SQLite did not create a complete attachment migration recovery copy.");
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
    const snapshot = getStoredState();
    if (snapshot === null) return;
    const assets = Array.isArray(snapshot.assets) ? snapshot.assets : [];
    const requiresMigration = assets.some((asset) => typeof asset.dataUrl === "string");
    if (!requiresMigration) {
      const metadata = new Map(readPayloadMetadataStatement.all().map((row) => [row.asset_id, row]));
      for (const asset of assets) {
        const payload = metadata.get(asset.id);
        if (!payload) throw new Error(`Stored attachment payload is missing for asset ${asset.id}.`);
        if (payload.content_ref !== contentRefFor(asset.id)) throw new Error(`Stored attachment reference is invalid for asset ${asset.id}.`);
      }
      return;
    }
    if (typeof validateLegacyState !== "function") {
      throw new Error("A full state validator is required before migrating embedded attachment payloads.");
    }
    ensureMigrationRecoveryCopy(snapshot);
    database.exec("BEGIN IMMEDIATE;");
    try {
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
    }
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
    },

    async readState({ includeAssetContent = true } = {}) {
      ensureOpen();
      const state = getStoredState();
      if (state === null) return null;
      return includeAssetContent ? withFullPayloads(state) : withLightPayloadMetadata(state);
    },

    async readAsset(assetId) {
      ensureOpen();
      if (typeof assetId !== "string" || !assetId) return null;
      const state = getStoredState();
      const asset = state?.assets?.find((candidate) => candidate.id === assetId);
      if (!asset) return null;
      const payload = requirePayloadRow(assetId);
      asset.dataUrl = verifyPayload(assetId, payload);
      delete asset.contentRef;
      return clone(asset);
    },

    getTrustedAssetValidation() {
      ensureOpen();
      ensureTrustedPayloadGeneration();
      return new Map(readPayloadMetadataStatement.all().map((row) => [row.asset_id, {
        contentRef: row.content_ref,
        contentSha256: row.content_sha256,
        decodedBytes: Number(row.decoded_bytes),
        mimeType: row.mime_type,
        contentRevision: Number(row.content_revision),
      }]));
    },

    async getRevision() {
      ensureOpen();
      const row = revisionStatement.get(STATE_KEY);
      return row ? Number(row.revision) : null;
    },

    async transact(mutator, { includeAssetContent = true } = {}) {
      ensureOpen();
      if (typeof mutator !== "function") throw new TypeError("QC transaction mutator must be a function");

      database.exec("BEGIN IMMEDIATE;");
      try {
        const stored = getStoredState();
        const current = includeAssetContent
          ? withFullPayloads(stored)
          : withLightPayloadMetadata(stored);
        const outcome = requireSynchronousOutcome(mutator(current));
        const nextState = cloneState(outcome.state);
        const result = clone(outcome.result);
        writePayloads(nextState, current);
        const serialized = JSON.stringify(stateWithoutPayloads(nextState));
        if (typeof serialized !== "string") throw new TypeError("QC state could not be serialized.");

        writeStatement.run(STATE_KEY, nextState.revision, serialized, new Date().toISOString());
        const committedPayloadGeneration = currentPayloadGeneration();
        database.exec("COMMIT;");
        verifiedPayloadGeneration = committedPayloadGeneration;
        return result;
      } catch (error) {
        try {
          database.exec("ROLLBACK;");
        } catch {
          // Preserve the original transaction failure.
        }
        throw error;
      }
    },

    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  });
}
