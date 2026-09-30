import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";

test("memory QC adapter clones state and transaction results", async () => {
  const input = { batches: [{ id: "B-1" }] };
  const adapter = createMemoryQCAdapter({ initialState: input });
  input.batches[0].id = "changed outside";

  const firstRead = await adapter.readState();
  assert.equal(firstRead.batches[0].id, "B-1");
  firstRead.batches[0].id = "changed by reader";
  assert.equal((await adapter.readState()).batches[0].id, "B-1");

  const result = { saved: true };
  const returned = await adapter.transact((state) => ({ state: { ...state, batches: [...state.batches, { id: "B-2" }] }, result }));
  result.saved = false;
  returned.saved = false;
  assert.deepEqual(await adapter.readState(), { batches: [{ id: "B-1" }, { id: "B-2" }] });
});

test("memory QC adapter serializes concurrent transactions against the latest state", async () => {
  const adapter = createMemoryQCAdapter({ initialState: { count: 0 } });
  await Promise.all(Array.from({ length: 40 }, () => adapter.transact((state) => ({
    state: { count: state.count + 1 },
    result: null,
  }))));

  assert.deepEqual(await adapter.readState(), { count: 40 });
});

test("failed and asynchronous mutators leave state unchanged", async () => {
  const adapter = createMemoryQCAdapter({ initialState: { count: 1 } });

  await assert.rejects(adapter.transact(() => { throw new Error("mutator failed"); }), /mutator failed/);
  await assert.rejects(adapter.transact(async (state) => ({ state, result: null })), /must be synchronous/);
  await assert.rejects(adapter.transact(() => ({ state: [], result: null })), /state must be an object/);
  assert.deepEqual(await adapter.readState(), { count: 1 });
});
