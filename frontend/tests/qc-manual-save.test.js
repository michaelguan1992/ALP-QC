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
  assert.equal(controller.saveOnExit, false);
  assert.equal(controller.saveBeforeExit, undefined);
  assert.equal(controller.getStatus(), "Unsaved changes");
  assert.equal(await controller.saveAll(), true);
  assert.deepEqual(calls, [{ value: "edited" }]);
  assert.equal(controller.getStatus(), "Saved");
  assert.ok(statuses.includes("Saving…"));
});

test("exit saving starts only when requested and waits for service acknowledgment", async () => {
  let draft = "saved";
  let acknowledged = "saved";
  const gate = deferred();
  let calls = 0;
  let leftPage = false;
  const controller = createManualSaveController({
    hasChanges: () => draft !== acknowledged,
    readSnapshot: () => ({ value: draft }),
    save: () => { calls += 1; return gate.promise; },
    onSaved: (snapshot) => { acknowledged = snapshot.value; },
    saveOnExit: true,
  });

  draft = "edited";
  controller.noteChanges();
  assert.equal(calls, 0);
  const leaving = controller.saveBeforeExit().then((saved) => {
    if (saved) leftPage = true;
    return saved;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  assert.equal(leftPage, false);

  gate.resolve({ ok: true });
  assert.equal(await leaving, true);
  assert.equal(leftPage, true);
  assert.equal(controller.hasPending(), false);
});

test("invalid exit save keeps the draft and exposes the validation reason", async () => {
  let draft = "invalid";
  let calls = 0;
  const controller = createManualSaveController({
    hasChanges: () => draft !== "saved",
    readSnapshot: () => ({ value: draft }),
    validate: (snapshot) => snapshot.value === "valid" ? true : "Correct the inspection value first.",
    save: async () => { calls += 1; return { ok: true }; },
    saveOnExit: true,
  });

  assert.equal(await controller.saveBeforeExit(), false);
  assert.equal(calls, 0);
  assert.equal(draft, "invalid");
  assert.equal(controller.hasPending(), true);
  assert.equal(controller.getLastError().message, "Correct the inspection value first.");
});

test("service failure during exit keeps the draft and exposes the stale reason", async () => {
  let draft = "edited";
  const controller = createManualSaveController({
    hasChanges: () => draft !== "saved",
    readSnapshot: () => ({ value: draft }),
    save: async () => ({ ok: false, error: new Error("stale revision; reload the latest data") }),
    saveOnExit: true,
  });

  assert.equal(await controller.saveBeforeExit(), false);
  assert.equal(draft, "edited");
  assert.equal(controller.hasPending(), true);
  assert.equal(controller.getLastError().message, "stale revision; reload the latest data");
});

test("exit flush saves typing made during the first save before resolving", async () => {
  let draft = "first";
  let acknowledged = "saved";
  const gates = [deferred(), deferred()];
  const calls = [];
  const controller = createManualSaveController({
    hasChanges: () => draft !== acknowledged,
    readSnapshot: () => ({ value: draft }),
    save: (snapshot) => {
      calls.push(snapshot.value);
      return gates[calls.length - 1].promise;
    },
    onSaved: (snapshot) => { acknowledged = snapshot.value; },
    saveOnExit: true,
  });

  const leaving = controller.saveBeforeExit();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ["first"]);
  draft = "typed during save";
  controller.noteChanges();
  gates[0].resolve({ ok: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ["first", "typed during save"]);
  gates[1].resolve({ ok: true });

  assert.equal(await leaving, true);
  assert.equal(controller.hasPending(), false);
  assert.equal(acknowledged, "typed during save");
});

test("overlapping exit flushes share one write", async () => {
  let draft = "edited";
  let acknowledged = "saved";
  const gate = deferred();
  let calls = 0;
  const controller = createManualSaveController({
    hasChanges: () => draft !== acknowledged,
    readSnapshot: () => ({ value: draft }),
    save: () => { calls += 1; return gate.promise; },
    onSaved: (snapshot) => { acknowledged = snapshot.value; },
    saveOnExit: true,
  });

  const first = controller.saveBeforeExit();
  const second = controller.saveBeforeExit();
  assert.strictEqual(second, first);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  gate.resolve({ ok: true });
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(calls, 1);
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
