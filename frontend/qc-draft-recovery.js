// Writes unsent batch and Issue edits to browser-local storage and removes them once they are saved or
// discarded. Edits are written after a short pause (debounced). Saves, discards, and page hiding write at
// once, so the stored copy matches the page at each of those moments. Without storage every call is a no-op,
// and the page keeps its in-memory drafts exactly as before.

import { browserLocalStorage, createDraftStorage, purgeExpiredDrafts } from "./qc-draft-storage.js";

export const DRAFT_WRITE_DELAY_MS = 400;

let store = null;
let rawStorage = null;
let clock = () => Date.now();
const pending = new Map();

function pendingKey(kind, recordId) {
  return `${kind}:${recordId}`;
}

/**
 * Connects the draft layer to browser storage for one origin, workspace, and actor. Calling it again
 * replaces the connection after flushing what is waiting. Without storage, drafts stay in memory only.
 */
export function configureDraftRecovery({ storage = browserLocalStorage(), origin, workspace, actor = "anonymous", now = () => Date.now() } = {}) {
  flushDraftWrites();
  clock = now;
  rawStorage = storage ?? null;
  store = rawStorage && typeof origin === "string" && origin !== ""
    ? createDraftStorage({ storage: rawStorage, origin, workspace, actor })
    : null;
  return draftRecoveryEnabled();
}

export function draftRecoveryEnabled() {
  return store !== null && store.available;
}

/** The current time as the ISO text stored with each record. */
export function draftTimestamp() {
  return new Date(clock()).toISOString();
}

/**
 * Writes one record. `serialize` returns the record, null when nothing is left to keep (which removes the
 * stored copy), or undefined when the caller cannot describe the record yet (which leaves storage alone).
 */
function runWrite(kind, recordId, serialize) {
  if (!store) return false;
  let record;
  try {
    record = serialize();
  } catch {
    return false;
  }
  if (record === undefined) return false;
  return record === null ? store.remove(kind, recordId) : store.write(kind, recordId, record);
}

function cancelPending(kind, recordId) {
  const key = pendingKey(kind, recordId);
  const entry = pending.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(key);
}

/** Schedules a debounced write, so typing does not write on every keystroke. */
export function scheduleDraftWrite(kind, recordId, serialize) {
  if (!store) return;
  const id = String(recordId);
  const key = pendingKey(kind, id);
  const entry = pending.get(key) ?? { kind, recordId: id, serialize, timer: null };
  entry.serialize = serialize;
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    pending.delete(key);
    runWrite(kind, id, serialize);
  }, DRAFT_WRITE_DELAY_MS);
  pending.set(key, entry);
}

/** Writes one record now and cancels any write still waiting for it. Used after a save is acknowledged. */
export function writeDraftNow(kind, recordId, serialize) {
  const id = String(recordId);
  cancelPending(kind, id);
  return runWrite(kind, id, serialize);
}

/** Removes a stored record now (after a discard), cancelling any write still waiting for it. */
export function discardStoredDraft(kind, recordId) {
  const id = String(recordId);
  cancelPending(kind, id);
  return store ? store.remove(kind, id) : false;
}

/** Removes every stored record of one kind, and cancels the waiting writes for that kind. */
export function discardAllStoredDrafts(kind) {
  for (const entry of [...pending.values()]) {
    if (entry.kind === kind) cancelPending(entry.kind, entry.recordId);
  }
  if (!store) return 0;
  let removed = 0;
  for (const recordId of store.recordIds(kind)) {
    if (store.remove(kind, recordId)) removed += 1;
  }
  return removed;
}

/** The stored record for one draft, or null. Unusable records read as null. */
export function readStoredDraft(kind, recordId) {
  return store ? store.read(kind, String(recordId)) : null;
}

/** Writes every waiting record at once. Runs when the page is hidden or closed, which cannot wait. */
export function flushDraftWrites() {
  for (const entry of [...pending.values()]) {
    clearTimeout(entry.timer);
    pending.delete(pendingKey(entry.kind, entry.recordId));
    runWrite(entry.kind, entry.recordId, entry.serialize);
  }
}

/** Deletes stored drafts older than the retention period. Runs once at start-up. */
export function purgeExpiredStoredDrafts() {
  return rawStorage ? purgeExpiredDrafts({ storage: rawStorage, now: clock() }) : 0;
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("pagehide", flushDraftWrites);
}
if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushDraftWrites();
  });
}
