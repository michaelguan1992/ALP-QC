import test from "node:test";
import assert from "node:assert/strict";
import { installDomStub, findButton, flush } from "./dom-stub.js";

const dom = installDomStub();

// The DOM stub has no FormData. This shim reads the named controls the editors submit.
class FakeFormData {
  constructor(form) {
    this.entries = [];
    const controls = [...form.querySelectorAll("input"), ...form.querySelectorAll("select"), ...form.querySelectorAll("textarea")];
    for (const control of controls) {
      if (!control.name) continue;
      if (control.type === "checkbox") {
        if (control.checked) this.entries.push([control.name, "on"]);
      } else {
        this.entries.push([control.name, control.value]);
      }
    }
  }

  get(name) {
    const match = this.entries.find(([key]) => key === name);
    return match ? match[1] : null;
  }

  getAll(name) {
    return this.entries.filter(([key]) => key === name).map(([, value]) => value);
  }
}
globalThis.FormData = FakeFormData;

const { createInitialQCState } = await import("../../core/qc-domain.js");
const { renderAdminPage } = await import("../qc-admin.js");
const { STALE_REVISION_MESSAGE } = await import("../qc-command-rules.js");

function draftVersionState() {
  const state = createInitialQCState();
  state.versions.push({
    id: "version-draft",
    familyId: "s11-s14",
    label: "Draft A",
    sequence: 1,
    effectiveDate: "2026-10-01",
    status: "draft",
    notes: "",
    items: [],
  });
  state.assets = [];
  state.batches = [];
  state.orders = [];
  state.issues = [];
  return state;
}

function context(state, overrides = {}) {
  return {
    service: { backupSnapshotUrl: () => "/api/qc/main/backup/snapshot" },
    state,
    navigate: async () => true,
    refresh: async () => {},
    announceChange: () => {},
    isCurrentRender: () => true,
    run: async () => ({ ok: true }),
    refreshState: async () => ({ ok: true, state }),
    ...overrides,
  };
}

function buttonNamed(root, label) {
  return root.querySelectorAll("button").find((candidate) => candidate.textContent === label) ?? null;
}

test("every setup page renders from a loaded workspace state", async () => {
  const state = draftVersionState();
  for (const route of ["catalog", "standards", "orders", "library", "backup"]) {
    const root = dom.document.createElement("main");
    await renderAdminPage(root, route, context(state));
    assert.ok(root.childNodes.length > 0, `${route} rendered content`);
  }
});

test("a stale version save keeps the entries, shows the message, and offers an in-place reload", async () => {
  const state = draftVersionState();
  const commands = [];
  let refreshes = 0;
  const ctx = context(state, {
    run: async (type, data) => {
      commands.push({ type, data });
      return {
        ok: false,
        stale: true,
        reloadRequired: true,
        error: Object.assign(new Error(STALE_REVISION_MESSAGE), { code: "stale_revision", status: 409 }),
      };
    },
    refreshState: async () => {
      refreshes += 1;
      return { ok: true, state };
    },
  });
  const root = dom.document.createElement("main");
  dom.body.append(root);
  renderAdminPage(root, "standards", ctx);
  dom.click(buttonNamed(root, "Edit draft"));

  const form = dom.dialog().querySelector("form");
  const label = form.querySelectorAll("input").find((node) => node.name === "label");
  dom.setValue(label, "Draft B");
  dom.fire(form, "submit");
  await flush();

  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, "saveVersion");
  assert.equal(commands[0].data.label, "Draft B");
  assert.equal(dom.dialog().open, true, "a failed save keeps the dialog open");
  const reload = buttonNamed(dom.dialog(), "Reload latest data");
  assert.equal(reload.hidden, false);
  assert.ok(dom.dialog().textContent.includes(STALE_REVISION_MESSAGE));

  dom.click(reload);
  await flush();

  assert.equal(refreshes, 1);
  assert.equal(reload.hidden, true);
  assert.equal(label.value, "Draft B", "the entries are kept for the resubmit");
  assert.ok(dom.dialog().textContent.includes("submit again to apply them"));
});
