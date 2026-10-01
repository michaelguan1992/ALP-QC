import test from "node:test";
import assert from "node:assert/strict";
import { createInspectionAutosaveController } from "../frontend/qc-inspection-autosave.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settleMicrotasks() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function waitFor(predicate, description) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(`Timed out waiting for ${description}.`);
}

function makeController(config = {}, t) {
  const controller = createInspectionAutosaveController({ delayMs: 60_000 });
  t.after(() => controller.dispose());
  const entry = controller.register("row-1", {
    initial: { value: 0 },
    isValid: () => true,
    isComplete: () => true,
    save: async (value) => ({ ok: true, state: structuredClone(value) }),
    ...config,
  });
  return { controller, entry };
}

test("autosave coalesces multiple edits into the newest payload", async (t) => {
  const saves = [];
  const { entry } = makeController({
    save: async (value) => {
      saves.push(value);
      return { ok: true, state: structuredClone(value) };
    },
  }, t);

  entry.update({ value: 1 });
  entry.update({ value: 2 });
  entry.update({ value: 3 });
  assert.equal(await entry.flush(), true);
  assert.deepEqual(saves, [{ value: 3 }]);
  assert.equal(entry.getStatus(), "Saved");
});

test("writes from different rows stay serial even when both are flushed together", async (t) => {
  const controller = createInspectionAutosaveController({ delayMs: 60_000 });
  t.after(() => controller.dispose());
  const starts = [];
  const pending = [];
  function register(key) {
    return controller.register(key, {
      initial: { value: 0 },
      isValid: () => true,
      isComplete: () => true,
      save(value) {
        starts.push(key);
        const request = deferred();
        pending.push({ key, value, ...request });
        return request.promise;
      },
    });
  }
  const first = register("first");
  const second = register("second");
  first.update({ value: 1 });
  second.update({ value: 2 });

  const firstFlush = first.flush();
  const secondFlush = second.flush();
  await waitFor(() => starts.length === 1, "the first serialized save");
  assert.deepEqual(starts, ["first"]);
  pending[0].resolve({ ok: true, state: pending[0].value });
  await waitFor(() => starts.length === 2, "the second serialized save");
  assert.deepEqual(starts, ["first", "second"]);
  pending[1].resolve({ ok: true, state: pending[1].value });
  assert.deepEqual(await Promise.all([firstFlush, secondFlush]), [true, true]);
});

test("flush waits for an in-flight write and then saves the newest edited payload", async (t) => {
  const saves = [];
  const pending = [];
  const { controller, entry } = makeController({
    save(value) {
      saves.push(structuredClone(value));
      const request = deferred();
      pending.push(request);
      return request.promise;
    },
  }, t);

  entry.update({ value: 1 });
  const firstFlush = entry.flush();
  await waitFor(() => pending.length === 1, "the initial in-flight save");
  entry.update({ value: 2 });
  entry.update({ value: 3 });
  let flushFinished = false;
  const newestFlush = controller.flushAll().then((result) => {
    flushFinished = true;
    return result;
  });
  await settleMicrotasks();
  assert.equal(flushFinished, false);
  assert.deepEqual(saves, [{ value: 1 }]);

  pending[0].resolve({ ok: true, state: { value: 1 } });
  await waitFor(() => pending.length === 2, "the newest follow-up save");
  assert.deepEqual(saves, [{ value: 1 }, { value: 3 }]);
  await settleMicrotasks();
  assert.equal(flushFinished, false, "flush remains pending until the newest payload is acknowledged");
  pending[1].resolve({ ok: true, state: { value: 3 } });
  assert.equal(await firstFlush, true);
  assert.equal(await newestFlush, true);
  assert.equal(entry.getStatus(), "Saved");
});

test("reverting to the in-flight value does not issue a redundant follow-up write", async (t) => {
  const saves = [];
  const pending = [];
  const { entry } = makeController({
    save(value) {
      saves.push(structuredClone(value));
      const request = deferred();
      pending.push(request);
      return request.promise;
    },
  }, t);

  entry.update({ value: 1 });
  const firstFlush = entry.flush();
  await waitFor(() => pending.length === 1, "the initial save");
  entry.update({ value: 2 });
  entry.update({ value: 1 });
  const settledFlush = entry.flush();
  pending[0].resolve({ ok: true, state: { value: 1 } });
  assert.equal(await firstFlush, true);
  assert.equal(await settledFlush, true);
  assert.deepEqual(saves, [{ value: 1 }]);
  assert.equal(entry.getStatus(), "Saved");
});

test("reverting to the last accepted value during a save writes a compensating update", async (t) => {
  const saves = [];
  const pending = [];
  const { entry } = makeController({
    save(value) {
      saves.push(structuredClone(value));
      const request = deferred();
      pending.push(request);
      return request.promise;
    },
  }, t);

  entry.update({ value: 1 });
  const firstFlush = entry.flush();
  await waitFor(() => pending.length === 1, "the initial save");
  entry.update({ value: 2 });
  entry.update({ value: 0 });
  const settledFlush = entry.flush();
  pending[0].resolve({ ok: true, state: { value: 1 } });
  await waitFor(() => pending.length === 2, "the compensating save to the last accepted value");
  assert.deepEqual(saves, [{ value: 1 }, { value: 0 }]);
  pending[1].resolve({ ok: true, state: { value: 0 } });
  assert.equal(await firstFlush, true);
  assert.equal(await settledFlush, true);
  assert.equal(entry.getValue().value, 0);
  assert.equal(entry.getStatus(), "Saved");
});

test("a failed save retains the edit and retries after the next edit", async (t) => {
  const saves = [];
  const { entry } = makeController({
    save: async (value) => {
      saves.push(structuredClone(value));
      if (saves.length === 1) return { ok: false, error: new Error("Temporary storage failure") };
      return { ok: true, state: structuredClone(value) };
    },
  }, t);

  entry.update({ value: 1 });
  assert.equal(await entry.flush(), false);
  assert.equal(entry.getStatus(), "Save failed");
  assert.deepEqual(entry.getValue(), { value: 1 });
  assert.deepEqual(saves, [{ value: 1 }]);

  entry.update({ value: 2 });
  assert.equal(await entry.flush(), true);
  assert.deepEqual(saves, [{ value: 1 }, { value: 2 }]);
  assert.equal(entry.getStatus(), "Saved");
});

test("a stale revision blocks silent retries after later edits", async (t) => {
  const saves = [];
  const { entry } = makeController({
    save: async (value) => {
      saves.push(structuredClone(value));
      return { ok: false, error: new Error("This data changed since your last view. Reload and retry.") };
    },
  }, t);

  entry.update({ value: 1 });
  assert.equal(await entry.flush(), false);
  assert.equal(entry.getStatus(), "Save failed");
  entry.update({ value: 2 });
  assert.equal(await entry.flush(), false);
  assert.deepEqual(saves, [{ value: 1 }]);
  assert.equal(entry.getStatus(), "Save failed");
});

test("invalid input remains unsent until it becomes valid", async (t) => {
  const saves = [];
  const { entry } = makeController({
    isValid: (value) => Number.isSafeInteger(value.value) && value.value >= 0,
    save: async (value) => {
      saves.push(structuredClone(value));
      return { ok: true, state: structuredClone(value) };
    },
  }, t);

  entry.update({ value: -1 });
  assert.equal(await entry.flush(), false);
  assert.equal(entry.getStatus(), "Incomplete");
  assert.deepEqual(saves, []);

  entry.update({ value: 4 });
  assert.equal(await entry.flush(), true);
  assert.deepEqual(saves, [{ value: 4 }]);
});

test("a committed write recovers from a failed read without issuing the command again", async (t) => {
  let saveCalls = 0;
  let refreshCalls = 0;
  const savedEvents = [];
  const { entry } = makeController({
    save: async () => {
      saveCalls += 1;
      return { ok: false, committed: true, error: new Error("The write committed but its response could not be read.") };
    },
    refreshCommitted: async () => {
      refreshCalls += 1;
      if (refreshCalls === 1) return { ok: false, error: new Error("State is still unavailable.") };
      return { ok: true, state: { value: 5 } };
    },
    verifyCommitted: (state, sentValue) => state.value === sentValue.value,
    onSaved: (value, response) => savedEvents.push({ value, refreshed: response.refreshed }),
  }, t);

  entry.update({ value: 5 });
  assert.equal(await entry.flush(), false);
  assert.equal(saveCalls, 1);
  assert.equal(entry.getStatus(), "Save failed");
  assert.equal(await entry.flush(), false, "the committed command is retained while its state read still fails");
  assert.equal(saveCalls, 1);
  assert.equal(await entry.flush(), true);
  assert.equal(saveCalls, 1);
  assert.equal(refreshCalls, 2);
  assert.deepEqual(savedEvents, [{ value: { value: 5 }, refreshed: true }]);
  assert.equal(entry.getStatus(), "Saved");
});

test("verifyCommitted blocks a save when the reloaded row has newer remote values", async (t) => {
  let saveCalls = 0;
  const syncErrors = [];
  const { entry } = makeController({
    save: async () => {
      saveCalls += 1;
      return { ok: true, state: { value: 99 } };
    },
    verifyCommitted: (state, sentValue) => state.value === sentValue.value,
    onSyncError: (error) => syncErrors.push(error.message),
  }, t);

  entry.update({ value: 5 });
  assert.equal(await entry.flush(), false);
  assert.equal(entry.getStatus(), "Save failed");
  assert.deepEqual(syncErrors, ["The saved values changed before they could be reloaded."]);
  entry.update({ value: 6 });
  assert.equal(await entry.flush(), false);
  assert.equal(saveCalls, 1);
  assert.equal(entry.getStatus(), "Save failed");
});
