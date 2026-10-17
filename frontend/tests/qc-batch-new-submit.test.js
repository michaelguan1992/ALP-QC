import test from "node:test";
import assert from "node:assert/strict";
import { installDomStub, findButton, flush } from "./dom-stub.js";

const dom = installDomStub();
const { createInitialQCState } = await import("../../core/qc-domain.js");
const { openNewBatchDialog } = await import("../qc-batch-new.js");
const { openNewIssueDialog } = await import("../qc-ops-issues.js");

// One PO line for an S11 red product and a published version whose AP/OQC item applies to S11.
function readyState() {
  const state = createInitialQCState();
  const s11Red = state.variants.find((variant) => variant.model === "S11" && variant.color === "Red");
  state.orders.push({
    id: "order-1",
    number: "PO-1",
    date: "2026-10-01",
    supplier: "",
    notes: "",
    lines: [{ id: "line-1", variantId: s11Red.id, orderedQty: 100 }],
  });
  state.versions.push({
    id: "version-s11",
    familyId: "s11-s14",
    label: "26.10.01",
    sequence: 1,
    effectiveDate: "2026-10-01",
    status: "published",
    items: [{
      id: "version-s11-item",
      key: "version-s11-key",
      no: 1,
      title: "Inspection check",
      titleZh: "",
      specification: "Required criteria",
      specificationZh: "",
      devices: "",
      factory: "AP",
      stage: "OQC",
      models: ["S11"],
      samplingPercent: 10,
      recordingRule: "",
      important: false,
      timeSeconds: null,
      procedureUrl: "",
    }],
  });
  return state;
}

function fieldNamed(form, name) {
  return [...form.querySelectorAll("input"), ...form.querySelectorAll("select")].find((node) => node.name === name) ?? null;
}

test("the new Issue dialog checks the reporter name before it sends anything", async () => {
  const state = readyState();
  const commands = [];
  const ctx = {
    state,
    navigate: () => {},
    isCurrentRender: () => true,
    run: async (type) => {
      commands.push(type);
      return { ok: true, result: {} };
    },
  };

  openNewIssueDialog(state, ctx);
  const form = dom.dialog().querySelector("form");
  const submit = findButton(form, "Create issue");
  dom.fire(form, "submit");
  await flush();

  assert.equal(form.querySelector("p.qc-ops-form-error").textContent, "Enter the name of the person reporting this issue.");
  assert.deepEqual(commands, []);
  assert.equal(submit.disabled, false, "a rejected submit leaves the button available");
});

test("a repeated submit while createBatch is pending calls ctx.run once, and the button is re-enabled afterwards", async () => {
  const state = readyState();
  const commands = [];
  let settle = null;
  const ctx = {
    state,
    navigate: () => {},
    isCurrentRender: () => true,
    run: (type, data) => {
      commands.push({ type, data });
      return new Promise((resolve) => { settle = resolve; });
    },
  };

  openNewBatchDialog(state, ctx);
  const form = dom.dialog().querySelector("form");
  const orderSelect = fieldNamed(form, "orderId");
  // Choosing the PO adds its first product line, as it does in the browser.
  orderSelect.value = "order-1";
  dom.fire(orderSelect, "change");
  const submit = findButton(form, "Create batch");
  const quantity = fieldNamed(form, "productQuantity");
  const recorder = fieldNamed(form, "recorder");

  dom.setValue(quantity, "10");
  dom.setValue(recorder, "Ann");
  assert.equal(submit.disabled, false, "the form is ready to submit");

  dom.fire(form, "submit");
  dom.fire(form, "submit");
  await flush();

  assert.equal(commands.length, 1, "the second submit is ignored while the first is pending");
  assert.equal(commands[0].type, "createBatch");
  assert.equal(commands[0].data.orderId, "order-1");
  assert.equal(submit.disabled, true, "the submit button stays disabled until the call settles");

  settle({ ok: false, error: new Error("The batch could not be created.") });
  await flush();

  assert.equal(submit.disabled, false, "the button is re-enabled once the call settles");
  assert.equal(findButton(form, "Create batch"), submit);

  dom.fire(form, "submit");
  await flush();
  assert.equal(commands.length, 2, "a deliberate submit after the failure runs again");
});
