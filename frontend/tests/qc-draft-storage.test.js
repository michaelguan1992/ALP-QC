import test from "node:test";
import assert from "node:assert/strict";
import { DRAFT_KEY_PREFIX, DRAFT_MAX_AGE_MS, browserLocalStorage, createDraftStorage, draftStorageKey, parseDraftRecord, purgeExpiredDrafts } from "../qc-draft-storage.js";

const ORIGIN = "http://127.0.0.1:4173";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-17T10:00:00.000Z");

// An in-memory stand-in for localStorage with the same methods and the same string semantics.
function fakeStorage({ failing = false } = {}) {
  const items = new Map();
  const guard = () => {
    if (failing) throw new Error("The storage is blocked.");
  };
  return {
    items,
    get length() {
      guard();
      return items.size;
    },
    key(index) {
      guard();
      return [...items.keys()][index] ?? null;
    },
    getItem(key) {
      guard();
      return items.has(key) ? items.get(key) : null;
    },
    setItem(key, value) {
      guard();
      items.set(key, String(value));
    },
    removeItem(key) {
      guard();
      items.delete(key);
    },
  };
}

function record(savedAt) {
  return { savedAt, baseRevision: 4, base: { rows: {} }, draft: { rows: {} } };
}

test("the key names the origin, workspace, actor, kind, and record", () => {
  assert.equal(
    draftStorageKey({ origin: ORIGIN, workspace: "main", actor: "ann", kind: "batch", recordId: "batch-1" }),
    "masterqc:draft:v1:http://127.0.0.1:4173:main:ann:batch:batch-1",
  );
  assert.ok(DRAFT_KEY_PREFIX.endsWith(":v1:"));
});

test("a record round-trips through storage and is removed on request", () => {
  const storage = fakeStorage();
  const drafts = createDraftStorage({ storage, origin: ORIGIN, workspace: "main", actor: "ann" });

  assert.equal(drafts.write("batch", "batch-1", record("2026-10-17T09:00:00.000Z")), true);
  assert.equal(drafts.read("batch", "batch-1").savedAt, "2026-10-17T09:00:00.000Z");
  assert.equal(drafts.read("batch", "missing"), null);
  assert.equal(drafts.remove("batch", "batch-1"), true);
  assert.equal(drafts.read("batch", "batch-1"), null);
});

test("records are scoped to their workspace and actor, so another user never reads them", () => {
  const storage = fakeStorage();
  createDraftStorage({ storage, origin: ORIGIN, workspace: "main", actor: "ann" }).write("issue", "issue-a", record("2026-10-17T09:00:00.000Z"));
  const other = createDraftStorage({ storage, origin: ORIGIN, workspace: "main", actor: "bea" });
  const demo = createDraftStorage({ storage, origin: ORIGIN, workspace: "demo", actor: "ann" });

  assert.equal(other.read("issue", "issue-a"), null);
  assert.equal(demo.read("issue", "issue-a"), null);
  assert.deepEqual(createDraftStorage({ storage, origin: ORIGIN, workspace: "main", actor: "ann" }).recordIds("issue"), ["issue-a"]);
  assert.deepEqual(createDraftStorage({ storage, origin: ORIGIN, workspace: "main", actor: "ann" }).recordIds("batch"), []);
});

test("a storage that throws is treated as unavailable: reads are empty and writes report failure", () => {
  const drafts = createDraftStorage({ storage: fakeStorage({ failing: true }), origin: ORIGIN, workspace: "main", actor: "ann" });

  assert.equal(drafts.read("batch", "batch-1"), null);
  assert.equal(drafts.write("batch", "batch-1", record("2026-10-17T09:00:00.000Z")), false);
  assert.equal(drafts.remove("batch", "batch-1"), false);
  assert.deepEqual(drafts.recordIds("batch"), []);
});

test("a missing storage makes every call a quiet no-op", () => {
  const drafts = createDraftStorage({ storage: null, origin: ORIGIN, workspace: "main", actor: "ann" });

  assert.equal(drafts.available, false);
  assert.equal(drafts.write("batch", "batch-1", record("2026-10-17T09:00:00.000Z")), false);
  assert.equal(drafts.read("batch", "batch-1"), null);
  assert.equal(purgeExpiredDrafts({ storage: null, now: NOW }), 0);
});

test("reading the browser's localStorage returns null when the browser withholds it", () => {
  const blocked = {};
  Object.defineProperty(blocked, "localStorage", { get() { throw new Error("Blocked by the browser."); } });
  assert.equal(browserLocalStorage(blocked), null);
  assert.equal(browserLocalStorage({}), null);
  assert.equal(browserLocalStorage({ localStorage: fakeStorage() }) !== null, true);
});

test("start-up removes drafts older than fourteen days and keeps newer ones", () => {
  const storage = fakeStorage();
  const fresh = draftStorageKey({ origin: ORIGIN, workspace: "main", actor: "ann", kind: "batch", recordId: "fresh" });
  const old = draftStorageKey({ origin: ORIGIN, workspace: "main", actor: "bea", kind: "issue", recordId: "old" });
  const unreadable = `${DRAFT_KEY_PREFIX}broken`;
  storage.setItem(fresh, JSON.stringify(record(new Date(NOW - 13 * DAY).toISOString())));
  storage.setItem(old, JSON.stringify(record(new Date(NOW - DRAFT_MAX_AGE_MS - DAY).toISOString())));
  storage.setItem(unreadable, "{not json");
  storage.setItem("unrelated:setting", "keep me");

  assert.equal(purgeExpiredDrafts({ storage, now: NOW }), 2);
  assert.notEqual(storage.getItem(fresh), null);
  assert.equal(storage.getItem(old), null, "another actor's expired draft is removed too");
  assert.equal(storage.getItem(unreadable), null);
  assert.equal(storage.getItem("unrelated:setting"), "keep me");
});

test("a record without its required fields is not usable", () => {
  assert.equal(parseDraftRecord("[]"), null);
  assert.equal(parseDraftRecord(JSON.stringify({ savedAt: "2026-10-17T09:00:00.000Z", base: {} })), null);
  assert.equal(parseDraftRecord(JSON.stringify({ base: {}, draft: {} })), null);
  assert.notEqual(parseDraftRecord(JSON.stringify(record("2026-10-17T09:00:00.000Z"))), null);
});
