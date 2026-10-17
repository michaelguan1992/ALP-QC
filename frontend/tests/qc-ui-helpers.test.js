import test from "node:test";
import assert from "node:assert/strict";
import { installDomStub } from "./dom-stub.js";

const dom = installDomStub();
const { createSingleFlight, el, hasUnsavedDialogForm, showDialog, closeDialog, uploadingLabel } = await import("../qc-ui.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("a single-flight guard disables its controls, ignores repeats, and re-enables them when the work settles", async () => {
  const submit = { disabled: false };
  const gate = deferred();
  let runs = 0;
  let settled = 0;
  const guard = createSingleFlight({ controls: () => [submit], onSettled: () => { settled += 1; } });

  const first = guard(() => { runs += 1; return gate.promise; });
  assert.equal(submit.disabled, true);
  assert.equal(guard.isBusy(), true);
  assert.equal(guard(() => { runs += 1; return Promise.resolve(); }), undefined, "a repeat returns at once");
  assert.equal(runs, 1);

  gate.resolve("done");
  assert.equal(await first, "done");
  assert.equal(submit.disabled, false);
  assert.equal(guard.isBusy(), false);
  assert.equal(settled, 1);
});

test("a failed run re-enables the controls and rethrows to the caller", async () => {
  const submit = { disabled: false };
  const guard = createSingleFlight({ controls: () => [submit] });

  await assert.rejects(guard(async () => { throw new Error("boom"); }), /boom/);

  assert.equal(submit.disabled, false);
  assert.equal(guard.isBusy(), false);
});

test("controls that were already disabled stay disabled after the run", async () => {
  const enabled = { disabled: false };
  const readOnly = { disabled: true };
  const guard = createSingleFlight({ controls: () => [enabled, readOnly, null] });

  await guard(async () => {});

  assert.equal(enabled.disabled, false);
  assert.equal(readOnly.disabled, true);
});

test("a guard whose work throws synchronously releases its controls before rethrowing", () => {
  const submit = { disabled: false };
  const guard = createSingleFlight({ controls: () => [submit] });

  assert.throws(() => guard(() => { throw new Error("sync failure"); }), /sync failure/);

  assert.equal(submit.disabled, false);
  assert.equal(guard.isBusy(), false);
});

test("upload progress reports the size being sent in megabytes", () => {
  assert.equal(uploadingLabel(2.4 * 1024 * 1024), "Uploading… (2.4 MB)");
  assert.equal(uploadingLabel(20 * 1024 * 1024), "Uploading… (20.0 MB)");
  assert.equal(uploadingLabel(1000), "Uploading… (0.1 MB)", "tiny files do not read as zero");
  assert.equal(uploadingLabel(undefined), "Uploading… (0.1 MB)");
});

test("the unsaved-dialog check finds only an open dialog with an edited generic form", () => {
  assert.equal(hasUnsavedDialogForm(), false, "no dialog yet");

  const form = el("form", {}, el("input", { type: "text", name: "value" }));
  showDialog("Note", form);
  assert.equal(hasUnsavedDialogForm(), false, "an unedited form is clean");

  form.dataset.dirty = "true";
  assert.equal(hasUnsavedDialogForm(), true);

  const issueForm = el("form", { "data-issue-id": "issue-1" });
  issueForm.dataset.dirty = "true";
  showDialog("Issue", issueForm);
  assert.equal(hasUnsavedDialogForm(), false, "Issue forms are guarded by their own controller");

  closeDialog(true);
  assert.equal(hasUnsavedDialogForm(), false, "a closed dialog is not guarded");
  assert.equal(dom.dialog().open, false);
});
