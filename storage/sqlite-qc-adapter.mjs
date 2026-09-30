import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const STATE_KEY = "main";

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

/** Node-only durable aggregate adapter. Keep all QC rules in core/qc-service.js. */
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
  let closed = false;

  function ensureOpen() {
    if (closed) throw new Error("SQLite QC adapter is closed.");
  }

  return Object.freeze({
    async initialize() {
      ensureOpen();
    },

    async readState() {
      ensureOpen();
      const row = readStatement.get(STATE_KEY);
      return row ? clone(JSON.parse(row.value_json)) : null;
    },

    async getRevision() {
      ensureOpen();
      const row = revisionStatement.get(STATE_KEY);
      return row ? Number(row.revision) : null;
    },

    async transact(mutator) {
      ensureOpen();
      if (typeof mutator !== "function") throw new TypeError("QC transaction mutator must be a function");

      database.exec("BEGIN IMMEDIATE;");
      try {
        const row = readStatement.get(STATE_KEY);
        const current = row ? clone(JSON.parse(row.value_json)) : null;
        const outcome = requireSynchronousOutcome(mutator(current));
        const nextState = cloneState(outcome.state);
        const result = clone(outcome.result);
        const serialized = JSON.stringify(nextState);
        if (typeof serialized !== "string") throw new TypeError("QC state could not be serialized.");

        writeStatement.run(STATE_KEY, nextState.revision, serialized, new Date().toISOString());
        database.exec("COMMIT;");
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
