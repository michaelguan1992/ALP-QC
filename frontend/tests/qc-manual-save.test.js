import test from "node:test";
import assert from "node:assert/strict";
import { createManualSaveController } from "../qc-manual-save.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("manual save waits for an explicit save and reports acknowledgment", async () => {
  let draft = "saved";
  const calls = [];
  const statuses = [];
  const controller = createManualSaveController({
    hasChanges: () => draft !== "saved",
    readSnapshot: () => ({ value: draft }),
    save: async (snapshot) => {
      calls.push(snapshot);
      return { ok: true };
    },
    onStatus: (status) => statuses.push(status),
    onSaved: (snapshot) => { if (draft === snapshot.value) draft = "saved"; },
  });

  draft = "edited";
  controller.noteChanges();
  assert.deepEqual(calls, []);
  assert.equal(controller.getStatus(), "Unsaved changes");
  assert.equal(await controller.saveAll(), true);
  assert.deepEqual(calls, [{ value: "edited" }]);
  assert.equal(controller.getStatus(), "Saved");
  assert.ok(statuses.includes("Saving…"));
});

test("a failed save keeps the draft and reports failure", async () => {
  let draft = "edited";
  const controller = createManualSaveController({
    hasChanges: () => draft !== "saved",
    readSnapshot: () => ({ value: draft }),
    save: async () => ({ ok: false, error: new Error("stale revision") }),
  });

  assert.equal(await controller.saveAll(), false);
  assert.equal(draft, "edited");
  assert.equal(controller.hasPending(), true);
  assert.equal(controller.getStatus(), "Save failed");
});

test("typing during a save remains pending after the earlier value is acknowledged", async () => {
  let draft = "first";
  let saved = "saved";
  const gate = deferred();
  const controller = createManualSaveController({
    hasChanges: () => draft !== saved,
    readSnapshot: () => ({ value: draft }),
    save: () => gate.promise,
    onSaved: (snapshot) => {
      saved = snapshot.value;
    },
  });

  const saving = controller.saveAll();
  draft = "typed while saving";
  controller.noteChanges();
  gate.resolve({ ok: true });

  assert.equal(await saving, true);
  assert.equal(draft, "typed while saving");
  assert.equal(controller.hasPending(), true);
  assert.equal(controller.getStatus(), "Unsaved changes");
});

test("the final status clears saving and keeps a newer draft saveable", async () => {
  let draft = "saved";
  let acknowledged = "saved";
  const gate = deferred();
  const statuses = [];
  const controller = createManualSaveController({
    hasChanges: () => draft !== acknowledged,
    readSnapshot: () => ({ value: draft }),
    save: () => gate.promise,
    onStatus: (status, meta) => statuses.push({ status, ...meta }),
    onSaved: (snapshot) => { acknowledged = snapshot.value; },
  });

  draft = "submitted";
  controller.noteChanges();
  const saving = controller.saveAll();
  assert.deepEqual(statuses.at(-1), { status: "Saving…", dirty: true, saving: true });
  draft = "typed while saving";
  controller.noteChanges();
  gate.resolve({ ok: true });

  assert.equal(await saving, true);
  assert.equal(controller.hasPending(), true);
  assert.deepEqual(statuses.at(-1), { status: "Unsaved changes", dirty: true, saving: false });
  assert.equal(await controller.saveAll(), true);
  assert.equal(controller.hasPending(), false);
  assert.deepEqual(statuses.at(-1), { status: "Saved", dirty: false, saving: false });
});

test("an in-flight save remains pending if the user reverts to the old saved value", async () => {
  let draft = "saved";
  let acknowledged = "saved";
  const gate = deferred();
  const controller = createManualSaveController({
    hasChanges: () => draft !== acknowledged,
    readSnapshot: () => ({ value: draft }),
    save: () => gate.promise,
    onSaved: (snapshot) => { acknowledged = snapshot.value; },
  });

  draft = "submitted";
  const saving = controller.saveAll();
  assert.equal(controller.hasPending(), true);
  draft = "saved";
  controller.noteChanges();
  assert.equal(controller.hasPending(), true);

  gate.resolve({ ok: true });
  assert.equal(await saving, true);
  assert.equal(controller.hasPending(), true);
  assert.equal(controller.getStatus(), "Unsaved changes");
});

test("discard clears pending edits through the owning page callback", () => {
  let draft = "edited";
  const controller = createManualSaveController({
    hasChanges: () => draft !== "saved",
    readSnapshot: () => ({ value: draft }),
    save: async () => ({ ok: true }),
    onDiscard: () => { draft = "saved"; },
  });

  assert.equal(controller.discardAll(), true);
  assert.equal(controller.hasPending(), false);
  assert.equal(controller.getStatus(), "Saved");
});
