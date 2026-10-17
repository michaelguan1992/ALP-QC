// Browser-local storage for unsent batch and Issue edits. Every call is guarded: when localStorage is
// missing, blocked, full, or throws, reads return null and writes report failure, so the page keeps
// working with in-memory drafts alone. Only draft records are written, under the v1 key scheme.

export const DRAFT_KEY_PREFIX = "masterqc:draft:v1:";
export const DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** `masterqc:draft:v1:<origin>:<workspace>:<actor>:<kind>:<recordId>` */
export function draftStorageKey({ origin, workspace, actor, kind, recordId = "" }) {
  return `${DRAFT_KEY_PREFIX}${origin}:${workspace}:${actor}:${kind}:${recordId}`;
}

/** The browser's localStorage, or null when the browser withholds it. Reading the property can itself throw. */
export function browserLocalStorage(scope = globalThis) {
  try {
    const storage = scope.localStorage;
    return storage && typeof storage.getItem === "function" && typeof storage.setItem === "function" &&
      typeof storage.removeItem === "function" ? storage : null;
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A stored record is usable only when it has the fields every reader depends on. */
export function parseDraftRecord(raw) {
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(record) || typeof record.savedAt !== "string" || !isPlainObject(record.base) || !isPlainObject(record.draft)) return null;
  return record;
}

/** A record is expired when it is older than the retention period or cannot be read at all. */
function isExpired(raw, now) {
  const record = parseDraftRecord(raw);
  const savedAt = record ? Date.parse(record.savedAt) : Number.NaN;
  return !Number.isFinite(savedAt) || now - savedAt > DRAFT_MAX_AGE_MS;
}

function storedKeys(storage) {
  const keys = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (typeof key === "string") keys.push(key);
  }
  return keys;
}

/**
 * Draft records for one origin, workspace, and actor. No method throws: reads return null for a missing
 * or unusable record, and writes and removals return false when the browser refuses them.
 */
export function createDraftStorage({ storage, origin, workspace, actor }) {
  const keyFor = (kind, recordId) => draftStorageKey({ origin, workspace, actor, kind, recordId: String(recordId) });
  const kindPrefix = (kind) => draftStorageKey({ origin, workspace, actor, kind });

  return Object.freeze({
    available: Boolean(storage),
    read(kind, recordId) {
      if (!storage) return null;
      try {
        const raw = storage.getItem(keyFor(kind, recordId));
        return raw === null ? null : parseDraftRecord(raw);
      } catch {
        return null;
      }
    },
    write(kind, recordId, record) {
      if (!storage) return false;
      try {
        storage.setItem(keyFor(kind, recordId), JSON.stringify(record));
        return true;
      } catch {
        return false;
      }
    },
    remove(kind, recordId) {
      if (!storage) return false;
      try {
        storage.removeItem(keyFor(kind, recordId));
        return true;
      } catch {
        return false;
      }
    },
    /** Record ids of one kind that hold a stored draft for this origin, workspace, and actor. */
    recordIds(kind) {
      if (!storage) return [];
      const prefix = kindPrefix(kind);
      try {
        return storedKeys(storage).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
      } catch {
        return [];
      }
    },
  });
}

/** Deletes every draft record older than the retention period, for every workspace and actor. Returns the count. */
export function purgeExpiredDrafts({ storage, now = Date.now() } = {}) {
  if (!storage) return 0;
  let removed = 0;
  try {
    for (const key of storedKeys(storage).filter((candidate) => candidate.startsWith(DRAFT_KEY_PREFIX))) {
      if (!isExpired(storage.getItem(key), now)) continue;
      storage.removeItem(key);
      removed += 1;
    }
  } catch {
    // Cleanup is best effort. A storage that cannot be read is left as it is.
  }
  return removed;
}
