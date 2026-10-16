import test from "node:test";
import assert from "node:assert/strict";
import { createManualSaveController, REPLACED_PAGE_MESSAGE } from "../qc-manual-save.js";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("a disposed controller does not apply a save acknowledgment or touch its status", async () => {
  let draft = "edited";
  let acknowledged = "saved";
  const gate = deferred();
  const applied = [];
  const statuses = [];
  const controller = createManualSaveController({
    hasChanges: () => draft !== acknowledged,
    readSnapshot: () => ({ value: draft }),
    save: () => gate.promise,
    onStatus: (status) => statuses.push(status),
    onSaved: (snapshot) => {
      applied.push(snapshot);
      acknowledged = snapshot.value;
    },
  });

  const saving = controller.saveAll();
  controller.dispose();
  const statusCount = statuses.length;
  gate.resolve({ ok: true });

  assert.equal(await saving, false);
  assert.deepEqual(applied, []);
  assert.equal(acknowledged, "saved");
  assert.equal(statuses.length, statusCount);
  assert.equal(controller.getLastError().message, REPLACED_PAGE_MESSAGE);
  assert.equal(controller.hasPending(), false);
});

test("a disposed controller does not report save failures to a page that is gone", async () => {
  const errors = [];
  const controller = createManualSaveController({
    hasChanges: () => true,
    readSnapshot: () => ({}),
    save: async () => ({ ok: false, error: new Error("stale revision") }),
    onError: (error) => errors.push(error.message),
  });

  const saving = controller.saveAll();
  controller.dispose();

  assert.equal(await saving, false);
  assert.deepEqual(errors, []);
});

test("a disposed controller never reports a departure as saved", async () => {
  let draft = "edited";
  let calls = 0;
  const controller = createManualSaveController({
    hasChanges: () => draft !== "saved",
    readSnapshot: () => ({ value: draft }),
    save: async () => {
      calls += 1;
      return { ok: true };
    },
    saveOnExit: true,
  });

  controller.dispose();

  assert.equal(await controller.saveBeforeExit(), false);
  assert.equal(await controller.saveAll(), false);
  assert.equal(calls, 0);
  assert.equal(controller.getLastError().message, REPLACED_PAGE_MESSAGE);
  assert.equal(controller.discardAll(), false);
});

test("an exit flush interrupted by disposal reports failure instead of success", async () => {
  let draft = "first";
  let acknowledged = "saved";
  const gate = deferred();
  const controller = createManualSaveController({
    hasChanges: () => draft !== acknowledged,
    readSnapshot: () => ({ value: draft }),
    save: () => gate.promise,
    onSaved: (snapshot) => {
      acknowledged = snapshot.value;
    },
    saveOnExit: true,
  });

  const leaving = controller.saveBeforeExit();
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.dispose();
  gate.resolve({ ok: true });

  assert.equal(await leaving, false);
  assert.equal(controller.getLastError().message, REPLACED_PAGE_MESSAGE);
});

test("a live controller still applies acknowledgments and reports failures", async () => {
  let draft = "edited";
  let acknowledged = "saved";
  const errors = [];
  const controller = createManualSaveController({
    hasChanges: () => draft !== acknowledged,
    readSnapshot: () => ({ value: draft }),
    save: async () => ({ ok: false, error: new Error("stale revision") }),
    onSaved: (snapshot) => {
      acknowledged = snapshot.value;
    },
    onError: (error) => errors.push(error.message),
  });

  assert.equal(await controller.saveAll(), false);
  assert.deepEqual(errors, ["stale revision"]);
  assert.equal(controller.hasPending(), true);
  assert.equal(controller.isDisposed(), false);
});
