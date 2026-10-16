import test from "node:test";
import assert from "node:assert/strict";
import { installDomStub, findButton, flush } from "./dom-stub.js";

const dom = installDomStub();
const { closeDialog, showDialog, el } = await import("../qc-ui.js");
const { openIssueDialog, storedIssueDraft, hasUnsavedIssueWork, clearIssueDrafts } = await import("../qc-issue-dialog.js");
const { createManualSaveRegistry } = await import("../qc-manual-save-registry.js");

function issueFixture(overrides = {}) {
  return {
    id: "issue-a",
    number: "ISS-1",
    title: "Dent",
    status: "open",
    owner: "",
    disposition: "",
    confirmations: ["", "", ""],
    reportedBy: "Ann",
    batchId: null,
    description: "",
    attachmentIds: [],
    discussion: [],
    sourceSnapshot: {},
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function stateFixture(issues, revision = 3) {
  return { revision, issues, batches: [], assets: [], variants: [], families: [], orders: [], versions: [] };
}

function issueContext({ state, run, refreshState = null }) {
  const saves = createManualSaveRegistry();
  const context = {
    service: {},
    state,
    selectedId: null,
    isDemo: false,
    navigations: [],
    commands: [],
    navigate: async (route, id, force) => {
      context.navigations.push([route, id, force]);
      return true;
    },
    refresh: async () => {},
    refreshState,
    isCurrentRender: () => true,
    registerManualSaveController: (controller) => saves.register(controller),
    resolveManualChanges: (label, action, options) => saves.resolve(label, action, options),
    run: async (type, data, options = {}) => {
      context.commands.push({ type, data, options });
      return run(type, data, options);
    },
  };
  return context;
}

function fieldNamed(root, name) {
  return [...root.querySelectorAll("input"), ...root.querySelectorAll("textarea")].find((node) => node.name === name) ?? null;
}

function dialogTitle() {
  return dom.dialog()?.querySelector(".dialog-header h2")?.textContent ?? null;
}

function formErrorText() {
  return dom.dialog()?.querySelector("p.qc-ops-form-error")?.textContent ?? "";
}

function saveStatusText() {
  return dom.dialog()?.querySelector(".qc-ops-issue-save-status")?.textContent ?? "";
}

test("reloading after a stale Issue save keeps the Issue edits and other drafts, and saves nothing", async () => {
  clearIssueDrafts();
  const issueA = issueFixture({ id: "issue-a", number: "ISS-1" });
  const issueB = issueFixture({ id: "issue-b", number: "ISS-2", title: "Scratch" });
  const initialState = stateFixture([issueA, issueB], 3);
  const context = issueContext({
    state: initialState,
    run: async (type) => {
      if (type === "saveIssue") {
        return { ok: false, stale: true, error: new Error("This data changed since your last view. Reload the latest state and retry.") };
      }
      throw new Error(`unexpected command ${type}`);
    },
    refreshState: async ({ render }) => {
      const fresh = stateFixture([issueFixture({ id: "issue-a", number: "ISS-1", owner: "Bea" }), issueB], 4);
      context.state = fresh;
      if (render) openIssueDialog(fresh.issues[0], fresh, context);
      return { ok: true, state: fresh };
    },
  });

  // Unsent discussion text on another Issue.
  openIssueDialog(issueB, initialState, context);
  dom.setValue(fieldNamed(dom.dialog(), "discussionText"), "Ask the supplier.");
  closeDialog(true);

  const discardEvents = [];
  const onDiscard = () => discardEvents.push("discard");
  dom.window.addEventListener("masterqc:discard-operation-drafts", onDiscard);

  openIssueDialog(issueA, initialState, context);
  dom.setValue(fieldNamed(dom.dialog(), "owner"), "Ann");
  dom.click(findButton(dom.dialog(), "Save changes"));
  await flush();
  assert.match(formErrorText(), /changed since your last view/);
  assert.equal(findButton(dom.dialog(), "Reload latest data").hidden, false);

  dom.click(findButton(dom.dialog(), "Reload latest data"));
  await flush();
  dom.window.removeEventListener("masterqc:discard-operation-drafts", onDiscard);

  assert.deepEqual(discardEvents, []);
  assert.equal(storedIssueDraft("issue-a").owner, "Ann");
  assert.equal(storedIssueDraft("issue-b").discussionText, "Ask the supplier.");
  assert.equal(context.commands.filter((command) => command.type === "saveIssue").length, 1);
  assert.equal(dom.dialog().open, true);
  assert.equal(fieldNamed(dom.dialog(), "owner").value, "Ann");
  assert.equal(saveStatusText(), "Unsaved changes");
});

test("Close issue with unsaved edits keeps the dialog open and shows a failed closure in it", async () => {
  clearIssueDrafts();
  const issue = issueFixture({ owner: "Ann", disposition: "Scrap", confirmations: ["Ann", "Bea", "Cy"] });
  const state = stateFixture([issue]);
  const context = issueContext({
    state,
    run: async (type, data) => {
      if (type === "saveIssue") return { ok: true, state: stateFixture([{ ...issue, owner: data.owner }], 4), revision: 4 };
      if (type === "closeIssue") return { ok: false, error: new Error("Issue evidence is locked for closure.") };
      throw new Error(`unexpected command ${type}`);
    },
  });

  openIssueDialog(issue, state, context);
  dom.setValue(fieldNamed(dom.dialog(), "owner"), "Ann Lee");
  dom.click(findButton(dom.dialog(), "Close issue"));
  await flush();
  assert.equal(dialogTitle(), "Unsaved changes");

  dom.click(findButton(dom.dialog(), "Save changes"));
  await flush();

  assert.equal(dom.dialog().open, true);
  assert.match(dialogTitle(), /ISS-1/);
  assert.equal(formErrorText(), "Issue evidence is locked for closure.");
  assert.deepEqual(context.commands.map((command) => command.type), ["saveIssue", "closeIssue"]);
  assert.deepEqual(context.navigations, []);
});

test("Delete issue with unsaved edits keeps the dialog open and shows a failed deletion in it", async () => {
  clearIssueDrafts();
  const issue = issueFixture({ owner: "Ann", disposition: "Scrap", confirmations: ["Ann", "Bea", "Cy"] });
  const state = stateFixture([issue]);
  const context = issueContext({
    state,
    run: async (type) => {
      if (type === "deleteIssue") return { ok: false, error: new Error("This issue is linked to a released batch.") };
      throw new Error(`unexpected command ${type}`);
    },
  });

  openIssueDialog(issue, state, context);
  dom.setValue(fieldNamed(dom.dialog(), "disposition"), "Rework");
  dom.click(findButton(dom.dialog(), "Delete issue"));
  dom.click(findButton(dom.dialog(), "Confirm delete"));
  await flush();
  assert.equal(dialogTitle(), "Unsaved changes");

  dom.click(findButton(dom.dialog(), "Discard changes"));
  await flush();

  assert.equal(dom.dialog().open, true);
  assert.match(dialogTitle(), /ISS-1/);
  assert.equal(formErrorText(), "This issue is linked to a released batch.");
  assert.deepEqual(context.commands.map((command) => command.type), ["deleteIssue"]);
  assert.deepEqual(context.navigations, []);
});

test("discarding a dialog draft removes only the Issue it names", () => {
  clearIssueDrafts();
  const issueA = issueFixture({ id: "issue-a", number: "ISS-1" });
  const issueB = issueFixture({ id: "issue-b", number: "ISS-2" });
  const state = stateFixture([issueA, issueB]);
  const context = issueContext({ state, run: async () => ({ ok: true, state }) });

  openIssueDialog(issueA, state, context);
  dom.setValue(fieldNamed(dom.dialog(), "owner"), "Ann");
  closeDialog(true);
  openIssueDialog(issueB, state, context);
  dom.setValue(fieldNamed(dom.dialog(), "owner"), "Bea");
  closeDialog(true);

  // A generic form with no Issue identity is discarded; neither Issue draft may go with it.
  const input = el("input", { type: "text", name: "note" });
  showDialog("Note", el("form", { className: "generic-form" }, input));
  dom.setValue(input, "typed");
  closeDialog();
  dom.click(findButton(dom.dialog(), "Discard changes"));

  assert.equal(storedIssueDraft("issue-a").owner, "Ann");
  assert.equal(storedIssueDraft("issue-b").owner, "Bea");

  // An event without an Issue id discards nothing.
  dom.window.dispatchEvent(new CustomEvent("masterqc:discard-dialog-draft", { detail: { issueId: "" } }));
  assert.equal(storedIssueDraft("issue-a").owner, "Ann");

  // An event that names issue-b discards issue-b only.
  dom.window.dispatchEvent(new CustomEvent("masterqc:discard-dialog-draft", { detail: { issueId: "issue-b" } }));
  assert.equal(storedIssueDraft("issue-b"), undefined);
  assert.equal(storedIssueDraft("issue-a").owner, "Ann");
});

test("closing an Issue after a successful save does not prompt, and reverting edits does not prompt either", async () => {
  clearIssueDrafts();
  const issue = issueFixture();
  const state = stateFixture([issue]);
  const context = issueContext({
    state,
    run: async (type, data) => ({ ok: true, state: stateFixture([{ ...issue, owner: data.owner }], 4), revision: 4 }),
  });

  openIssueDialog(issue, state, context);
  dom.setValue(fieldNamed(dom.dialog(), "owner"), "Ann");
  dom.click(findButton(dom.dialog(), "Save changes"));
  await flush();
  assert.equal(hasUnsavedIssueWork(), false);

  closeDialog();
  assert.equal(dom.dialog().open, false);
  assert.notEqual(dialogTitle(), "Unsaved changes");

  openIssueDialog({ ...issue, owner: "Ann" }, stateFixture([{ ...issue, owner: "Ann" }], 4), context);
  dom.setValue(fieldNamed(dom.dialog(), "owner"), "Ann Lee");
  dom.setValue(fieldNamed(dom.dialog(), "owner"), "Ann");
  closeDialog();
  assert.equal(dom.dialog().open, false);
});

test("Escape on an Issue with unsaved edits offers Save, Discard or Cancel, and Cancel returns to the Issue", () => {
  clearIssueDrafts();
  const issue = issueFixture();
  const state = stateFixture([issue]);
  const context = issueContext({ state, run: async () => ({ ok: true, state }) });

  openIssueDialog(issue, state, context);
  dom.setValue(fieldNamed(dom.dialog(), "owner"), "Ann");
  dom.fire(dom.dialog(), "cancel");
  assert.equal(dialogTitle(), "Unsaved changes");
  assert.ok(findButton(dom.dialog(), "Save changes"));

  dom.fire(dom.dialog(), "cancel");
  assert.match(dialogTitle(), /ISS-1/);
  assert.equal(fieldNamed(dom.dialog(), "owner").value, "Ann");
  assert.equal(storedIssueDraft("issue-a").owner, "Ann");
  assert.equal(context.commands.length, 0);
});

test("Escape on an Issue without changes closes it", () => {
  clearIssueDrafts();
  const issue = issueFixture();
  const state = stateFixture([issue]);
  const context = issueContext({ state, run: async () => ({ ok: true, state }) });

  openIssueDialog(issue, state, context);
  dom.fire(dom.dialog(), "cancel");

  assert.equal(dom.dialog().open, false);
  assert.equal(hasUnsavedIssueWork(), false);
});
