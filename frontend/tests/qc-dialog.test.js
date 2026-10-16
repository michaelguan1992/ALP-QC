import test from "node:test";
import assert from "node:assert/strict";
import { installDomStub, findButton } from "./dom-stub.js";

const dom = installDomStub();
const { el, showDialog, closeDialog, captureDialogState, restoreDialogState, requestDialogClose } = await import("../qc-ui.js");

function dialogTitle() {
  return dom.dialog()?.querySelector(".dialog-header h2")?.textContent ?? null;
}

function dirtyForm({ attributes = {} } = {}) {
  const input = el("input", { type: "text", name: "value" });
  const form = el("form", { className: "generic-form" }, input);
  for (const [key, value] of Object.entries(attributes)) form.setAttribute(key, value);
  return { form, input };
}

test("Escape closes a dialog with nothing unsaved, such as an attachment preview", () => {
  showDialog("Preview · photo.jpg", el("p", {}, "Preview body"));
  const dialog = dom.dialog();
  assert.equal(dialog.open, true);

  dom.fire(dialog, "cancel");

  assert.equal(dialog.open, false);
});

test("Escape on a dialog with unsaved fields asks first, and Escape on that prompt returns to the form", () => {
  const { form, input } = dirtyForm();
  showDialog("Note", form);
  dom.setValue(input, "typed");
  const dialog = dom.dialog();

  dom.fire(dialog, "cancel");
  assert.equal(dialog.open, true);
  assert.equal(dialogTitle(), "Unsaved changes");

  dom.fire(dialog, "cancel");
  assert.equal(dialog.open, true);
  assert.equal(dialogTitle(), "Note");
});

test("Keep editing restores the form together with its close behavior", () => {
  let closeRequests = 0;
  showDialog("Guarded", el("form", { className: "x" }, el("input", { type: "text" })), {
    onCloseRequest: () => { closeRequests += 1; },
  });
  const guardedForm = dom.dialog().querySelector("form");
  dom.setValue(guardedForm.querySelector("input"), "typed");

  closeDialog();
  assert.equal(dialogTitle(), "Unsaved changes");
  dom.click(findButton(dom.dialog(), "Keep editing"));

  assert.equal(dialogTitle(), "Guarded");
  requestDialogClose();
  assert.equal(closeRequests, 1);
  assert.equal(dom.dialog().open, true);
});

test("the header Close button uses the content's close request instead of closing directly", () => {
  let closeRequests = 0;
  showDialog("Issue", el("p", {}, "Body"), { onCloseRequest: () => { closeRequests += 1; } });
  const dialog = dom.dialog();

  dom.click(findButton(dialog, "Close"));

  assert.equal(closeRequests, 1);
  assert.equal(dialog.open, true);
});

test("Discard in the generic prompt reports only the form's own draft identity", () => {
  const events = [];
  const onDiscard = (event) => events.push(event.detail);
  dom.window.addEventListener("masterqc:discard-dialog-draft", onDiscard);
  const { form, input } = dirtyForm({ attributes: { "data-draft-type": "note", "data-draft-id": "note-7" } });
  showDialog("Note", form);
  dom.setValue(input, "typed");

  closeDialog();
  dom.click(findButton(dom.dialog(), "Discard changes"));
  dom.window.removeEventListener("masterqc:discard-dialog-draft", onDiscard);

  assert.equal(dom.dialog().open, false);
  assert.deepEqual(events, [{ formId: "", draftType: "note", draftId: "note-7", issueId: "" }]);
});

test("forms managed by an Issue runtime are left to that runtime's guard, not the generic prompt", () => {
  const { form, input } = dirtyForm({ attributes: { "data-issue-id": "issue-1" } });
  showDialog("Issue", form);
  dom.setValue(input, "typed");

  assert.equal(closeDialog(), true);
  assert.equal(dom.dialog().open, false);
});

test("captured dialog state restores the same content and close behavior", () => {
  let closeRequests = 0;
  const body = el("p", {}, "Original body");
  showDialog("Original", body, { onCloseRequest: () => { closeRequests += 1; } });
  const captured = captureDialogState();
  showDialog("Other", el("p", {}, "Other body"));

  assert.equal(restoreDialogState(captured), true);
  assert.equal(dialogTitle(), "Original");
  requestDialogClose();
  assert.equal(closeRequests, 1);
});
