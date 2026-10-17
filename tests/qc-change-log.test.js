import test from "node:test";
import assert from "node:assert/strict";
import { createChangeLog, diffRecordKeys, recordKeysOf } from "../core/qc-change-log.js";

function sorted(keys) {
  return [...keys].sort();
}

test("changedSince returns the union of keys for every revision after the base through the current revision", () => {
  const log = createChangeLog();
  log.record(1, new Set(["batches:a"]));
  log.record(2, new Set(["issues:i", "batches:a"]));
  log.record(3, new Set(["orders:o"]));

  assert.deepEqual(sorted(log.changedSince(0, 3)), ["batches:a", "issues:i", "orders:o"]);
  assert.deepEqual(sorted(log.changedSince(1, 3)), ["batches:a", "issues:i", "orders:o"]);
  assert.deepEqual(sorted(log.changedSince(2, 3)), ["orders:o"]);
  assert.deepEqual(sorted(log.changedSince(3, 3)), []);
  assert.deepEqual(sorted(log.changedSince(5, 3)), [], "a base at or after the current revision has no later changes");
});

test("a missing revision anywhere in the range makes the change set unknown", () => {
  const log = createChangeLog();
  log.record(1, new Set(["a"]));
  log.record(3, new Set(["b"]));

  assert.equal(log.changedSince(0, 3), null, "revision 2 has no entry");
  assert.equal(log.changedSince(1, 3), null, "revision 2 has no entry");
  assert.deepEqual(sorted(log.changedSince(2, 3)), ["b"]);
  assert.deepEqual(sorted(log.changedSince(0, 1)), ["a"]);
});

test("an empty log is unknown for every older base", () => {
  const log = createChangeLog();
  assert.equal(log.changedSince(0, 1), null);
  assert.equal(log.changedSince(6, 7), null);
  assert.deepEqual(sorted(log.changedSince(7, 7)), []);
});

test("entries beyond maxEntries are evicted oldest first by revision", () => {
  const log = createChangeLog({ maxEntries: 3 });
  for (let revision = 1; revision <= 5; revision += 1) {
    log.record(revision, new Set([`key:${revision}`]));
  }

  assert.equal(log.changedSince(0, 5), null, "revisions 1 and 2 were evicted");
  assert.equal(log.changedSince(1, 5), null, "revision 2 was evicted");
  assert.deepEqual(sorted(log.changedSince(2, 5)), ["key:3", "key:4", "key:5"]);
});

test("eviction removes the lowest revision even when it was recorded last", () => {
  const log = createChangeLog({ maxEntries: 2 });
  log.record(5, new Set(["five"]));
  log.record(6, new Set(["six"]));
  log.record(4, new Set(["four"]));

  assert.equal(log.changedSince(3, 6), null, "revision 4 was evicted although it arrived last");
  assert.deepEqual(sorted(log.changedSince(4, 6)), ["five", "six"]);
});

test("recording the same revision again replaces its keys", () => {
  const log = createChangeLog();
  log.record(1, new Set(["first"]));
  log.record(1, new Set(["second"]));

  assert.deepEqual(sorted(log.changedSince(0, 1)), ["second"]);
});

test("recorded keys are copied, so later changes to the caller's set do not alter the log", () => {
  const log = createChangeLog();
  const keys = new Set(["batches:a"]);
  log.record(1, keys);
  keys.add("batches:b");

  assert.deepEqual(sorted(log.changedSince(0, 1)), ["batches:a"]);
});

test("clear forgets every entry", () => {
  const log = createChangeLog();
  log.record(1, new Set(["a"]));
  log.clear();

  assert.equal(log.changedSince(0, 1), null);
});

test("invalid revisions, keys, and capacities are rejected", () => {
  const log = createChangeLog();
  assert.throws(() => log.record(-1, new Set()), TypeError);
  assert.throws(() => log.record(1.5, new Set()), TypeError);
  assert.throws(() => log.record(1, ["not-a-set"]), TypeError);
  assert.throws(() => createChangeLog({ maxEntries: 0 }), TypeError);
  assert.equal(log.changedSince(0.5, 1), null, "a fractional base is unknown rather than matched");
});

test("record keys key array elements by id and every other top-level value by property name", () => {
  const state = {
    schemaVersion: 1,
    revision: 7,
    batches: [{ id: "b1", notes: "x" }, { id: "b2", notes: "y" }],
    issues: [],
    history: { sources: [], inspections: [{ id: "h1" }] },
    log: [{ message: "no id" }],
    duplicates: [{ id: "d" }, { id: "d" }],
    blankIds: [{ id: "" }],
    audit: [{ id: "a1" }],
  };

  assert.deepEqual(sorted(recordKeysOf(state).keys()), [
    "batches:b1",
    "batches:b2",
    "blankIds",
    "duplicates",
    "history",
    "log",
    "schemaVersion",
  ]);
});

test("diffRecordKeys reports added, removed, and changed records and ignores audit and revision", () => {
  const before = {
    revision: 1,
    batches: [{ id: "b1", count: 1 }, { id: "b2", count: 1 }],
    issues: [{ id: "i1" }],
    audit: [],
  };
  const index = recordKeysOf(before);
  const after = {
    revision: 2,
    batches: [{ id: "b1", count: 2 }, { id: "b3", count: 1 }],
    issues: [{ id: "i1" }],
    audit: [{ id: "a1", action: "saveBatchChanges" }],
  };

  assert.deepEqual(sorted(diffRecordKeys(index, after)), ["batches:b1", "batches:b2", "batches:b3"]);
});

test("diffRecordKeys detects in-place mutation because the index stores text, not references", () => {
  const state = { revision: 0, batches: [{ id: "b1", rows: [{ id: "r1", defectiveQty: 0 }] }] };
  const index = recordKeysOf(state);
  state.batches[0].rows[0].defectiveQty = 1;

  assert.deepEqual([...diffRecordKeys(index, state)], ["batches:b1"]);
});

test("diffRecordKeys reports nothing for an unchanged state and reports a whole-value property change", () => {
  const state = { revision: 0, schemaVersion: 1, history: { inspections: [] }, batches: [{ id: "b1" }] };
  const index = recordKeysOf(state);
  assert.deepEqual([...diffRecordKeys(index, structuredClone(state))], []);

  const changed = structuredClone(state);
  changed.history.inspections.push({ id: "h1" });
  assert.deepEqual([...diffRecordKeys(index, changed)], ["history"]);
});
