// In-memory record of the record keys that each committed revision changed. A command that is based on an older
// revision may proceed only when the records it changes were not changed since that revision. The log belongs to one
// service instance and is never persisted. A revision without an entry is unknown, so callers must reject the stale
// command instead of guessing.

// The revision counter and the append-only audit trail never make a save conflict.
const UNTRACKED_PROPERTIES = new Set(["revision", "audit"]);

export function createChangeLog({ maxEntries = 1000 } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new TypeError("Change log maxEntries must be a positive whole number.");
  }
  const entries = new Map();

  function evictOldest() {
    let oldest = Infinity;
    for (const revision of entries.keys()) {
      if (revision < oldest) oldest = revision;
    }
    entries.delete(oldest);
  }

  return Object.freeze({
    // Stores the keys changed by the commit that produced `revision`. A repeated revision replaces its entry.
    record(revision, keys) {
      if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new TypeError("Change log revision must be a non-negative whole number.");
      }
      if (!(keys instanceof Set)) throw new TypeError("Change log keys must be a Set.");
      entries.set(revision, new Set(keys));
      while (entries.size > maxEntries) evictOldest();
    },

    // Union of the keys changed by every revision after `baseRevision` through `currentRevision`, or null when any
    // revision in that range has no entry.
    changedSince(baseRevision, currentRevision) {
      if (!Number.isSafeInteger(baseRevision) || !Number.isSafeInteger(currentRevision)) return null;
      if (baseRevision >= currentRevision) return new Set();
      // A range longer than the number of entries cannot be complete, so this check avoids walking it.
      if (currentRevision - baseRevision > entries.size) return null;
      const changed = new Set();
      for (let revision = baseRevision + 1; revision <= currentRevision; revision += 1) {
        const keys = entries.get(revision);
        if (keys === undefined) return null;
        for (const key of keys) changed.add(key);
      }
      return changed;
    },

    clear() {
      entries.clear();
    },
  });
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Mirrors the storage rule: every element is a plain object with a unique, non-empty string ID.
function hasUniqueRecordIds(value) {
  const ids = new Set();
  for (const item of value) {
    if (!isPlainObject(item) || typeof item.id !== "string" || item.id === "" || ids.has(item.id)) return false;
    ids.add(item.id);
  }
  return true;
}

// Maps each record key to the JSON text of that record. Elements of record arrays are keyed `property:id`, and every
// other top-level value is keyed by its property name. The revision and audit trail are excluded.
export function recordKeysOf(state) {
  const index = new Map();
  for (const property of Object.keys(state)) {
    if (UNTRACKED_PROPERTIES.has(property)) continue;
    const value = state[property];
    if (value === undefined) continue;
    if (Array.isArray(value) && hasUniqueRecordIds(value)) {
      for (const item of value) index.set(`${property}:${item.id}`, JSON.stringify(item));
    } else {
      index.set(property, JSON.stringify(value));
    }
  }
  return index;
}

// Returns the record keys that were added, removed, or whose JSON text changed between `beforeIndex`, an index taken
// from the state before a handler ran, and `afterState`.
export function diffRecordKeys(beforeIndex, afterState) {
  const afterIndex = recordKeysOf(afterState);
  const changed = new Set();
  for (const [key, text] of beforeIndex) {
    if (afterIndex.get(key) !== text) changed.add(key);
  }
  for (const key of afterIndex.keys()) {
    if (!beforeIndex.has(key)) changed.add(key);
  }
  return changed;
}
