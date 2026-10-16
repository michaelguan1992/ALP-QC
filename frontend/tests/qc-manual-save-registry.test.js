import test from "node:test";
import assert from "node:assert/strict";
import { installDomStub, findButton, flush } from "./dom-stub.js";

const dom = installDomStub();
const { createManualSaveController, REPLACED_PAGE_MESSAGE } = await import("../qc-manual-save.js");
const { createManualSaveRegistry } = await import("../qc-manual-save-registry.js");
const { el, showDialog, closeDialog } = await import("../qc-ui.js");

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function dialogTitle() {
  return dom.dialog()?.querySelector(".dialog-header h2")?.textContent ?? null;
}

function lastToast() {
  return dom.toastHost.children.at(-1)?.textContent ?? "";
}

function savingController({ save = async () => ({ ok: true }), saveOnExit = true } = {}) {
  let draft = "edited";
  let acknowledged = "saved";
  const controller = createManualSaveController({
    hasChanges: () => draft !== acknowledged,
    readSnapshot: () => ({ value: draft }),
    save,
    onSaved: (snapshot) => {
      acknowledged = snapshot.value;
    },
    onDiscard: () => {
      draft = acknowledged;
    },
    saveOnExit,
  });
  return { controller, setDraft: (value) => { draft = value; }, draft: () => draft };
}

test("a controller retired by a re-render keeps guarding departure until its replacement registers", async () => {
  const registry = createManualSaveRegistry();
  let saves = 0;
  const { controller } = savingController({ save: async () => { saves += 1; return { ok: true }; } });
  registry.register(controller);
  registry.retireRendered();

  assert.equal(registry.active(), controller);
  assert.equal(controller.isDisposed(), false);
  let left = false;
  await registry.resolve("leave for batches", () => { left = true; });
  assert.equal(saves, 1);
  assert.equal(left, true);
});

test("registering a replacement disposes the controller it replaces", () => {
  const registry = createManualSaveRegistry();
  const { controller: previous } = savingController();
  const { controller: next } = savingController();
  registry.register(previous);
  registry.retireRendered();
  registry.register(next);

  assert.equal(previous.isDisposed(), true);
  assert.equal(next.isDisposed(), false);
  assert.equal(registry.active(), next);
});

test("a finished render that registers nothing releases its retired controllers", () => {
  const registry = createManualSaveRegistry();
  const { controller } = savingController();
  registry.register(controller);
  registry.retireRendered();
  registry.releaseRetired();

  assert.equal(controller.isDisposed(), true);
  assert.equal(registry.active(), null);
});

test("unregistering disposes the controller and clears it as the active guard", () => {
  const registry = createManualSaveRegistry();
  const { controller } = savingController();
  const unregister = registry.register(controller);
  unregister();

  assert.equal(controller.isDisposed(), true);
  assert.equal(registry.active(), null);
});

test("a failed departure save keeps the page open and says why", async () => {
  const registry = createManualSaveRegistry();
  const { controller } = savingController({ save: async () => ({ ok: false, error: new Error("stale revision; reload the latest data") }) });
  registry.register(controller);
  let left = false;

  assert.equal(await registry.resolve("leave", () => { left = true; }), false);
  assert.equal(left, false);
  assert.match(lastToast(), /could not be saved: stale revision; reload the latest data/);
  assert.equal(controller.hasPending(), true);
});

test("a departure save acknowledged after the page was replaced says so instead of leaving silently", async () => {
  const registry = createManualSaveRegistry();
  const gate = deferred();
  const { controller } = savingController({ save: () => gate.promise });
  registry.register(controller);
  let left = false;
  const leaving = registry.resolve("leave", () => { left = true; });
  await flush(2);

  // A re-render replaces the page while the save is still in flight.
  registry.retireRendered();
  registry.register(savingController().controller);
  gate.resolve({ ok: true });

  assert.equal(await leaving, false);
  assert.equal(left, false);
  assert.equal(controller.getLastError().message, REPLACED_PAGE_MESSAGE);
  assert.match(lastToast(), /refreshed/);
});

test("Save in the prompt keeps the Issue dialog open for a non-navigation action", async () => {
  const registry = createManualSaveRegistry();
  const { controller } = savingController({ saveOnExit: false });
  showDialog("Issue ISS-1 · Dent", el("form", { className: "qc-ops-issue-form" }, el("p", {}, "Form body")));
  registry.register(controller);
  const titlesSeenByAction = [];

  registry.resolve("close this issue", async () => {
    titlesSeenByAction.push(dom.dialog().open ? dialogTitle() : "closed");
  }, { keepDialog: true });
  assert.equal(dialogTitle(), "Unsaved changes");

  dom.click(findButton(dom.dialog(), "Save changes"));
  await flush();

  assert.deepEqual(titlesSeenByAction, ["Issue ISS-1 · Dent"]);
  assert.equal(dom.dialog().open, true);
  assert.equal(dialogTitle(), "Issue ISS-1 · Dent");
  assert.equal(controller.hasPending(), false);
});

test("Discard runs navigation-style actions after closing the dialog", async () => {
  const registry = createManualSaveRegistry();
  const { controller, draft } = savingController({ saveOnExit: false });
  showDialog("Issue ISS-1 · Dent", el("form", { className: "qc-ops-issue-form" }, el("p", {}, "Form body")));
  registry.register(controller);
  const dialogStateSeen = [];

  registry.resolve("leave for batches", async () => {
    dialogStateSeen.push(dom.dialog().open);
  });
  dom.click(findButton(dom.dialog(), "Discard changes"));
  await flush();

  assert.deepEqual(dialogStateSeen, [false]);
  assert.equal(draft(), "saved");
  assert.equal(controller.hasPending(), false);
});

test("Cancel and Escape return to the form, keep the edits, and never run the action", async () => {
  const registry = createManualSaveRegistry();
  const { controller, draft } = savingController({ saveOnExit: false });
  const dialogForm = el("form", { className: "qc-ops-issue-form" }, el("p", {}, "Form body"));
  showDialog("Issue ISS-1 · Dent", dialogForm);
  registry.register(controller);
  let acted = 0;
  const action = async () => { acted += 1; };

  registry.resolve("close this issue", action, { keepDialog: true });
  dom.click(findButton(dom.dialog(), "Cancel"));
  assert.equal(dialogTitle(), "Issue ISS-1 · Dent");

  registry.resolve("close this issue", action, { keepDialog: true });
  dom.fire(dom.dialog(), "cancel");
  assert.equal(dialogTitle(), "Issue ISS-1 · Dent");

  await flush();
  assert.equal(acted, 0);
  assert.equal(draft(), "edited");
  assert.equal(controller.hasPending(), true);
});

test("only one unsaved-changes prompt is open at a time", () => {
  const registry = createManualSaveRegistry();
  const { controller } = savingController({ saveOnExit: false });
  showDialog("Issue ISS-1 · Dent", el("form", { className: "qc-ops-issue-form" }, el("p", {}, "Form body")));
  registry.register(controller);

  const first = registry.resolve("close this issue", async () => {}, { keepDialog: true });
  const second = registry.resolve("close this issue", async () => {}, { keepDialog: true });

  return Promise.all([first, second]).then(([firstShown, secondShown]) => {
    assert.equal(firstShown, true);
    assert.equal(secondShown, false);
    assert.equal(dialogTitle(), "Unsaved changes");
    closeDialog(true);
  });
});
