// New inspection batch dialog: purchase-order product lines and quantities, the design version that
// every chosen product shares, the factory and stage that version supports, and the batch details.
// Creation runs through the page context; the dialog then opens the new batch when its id is returned.

import { button, el, errorText, field, list, quantity, setOptions, text } from "./qc-ops-common.js";
import { closeDialog, createSingleFlight, showDialog } from "./qc-ui.js";
import { getBatchVersionReadiness, getBatchVersions, getSharedBatchVersionChoices } from "../core/qc-batch-versions.js";
import { applicablePairs, orderedLines } from "./qc-batch-model.js";

function lineOptionLabel(entry, orderLines = []) {
  const sameVariant = orderLines.filter((candidate) => candidate.variant.id === entry.variant.id);
  const lineSuffix = sameVariant.length > 1 ? ` · Line ${sameVariant.indexOf(entry) + 1}` : "";
  return `${text(entry.variant.label)} · ${quantity(entry.line.orderedQty)} ordered${lineSuffix}`;
}

export function openNewBatchDialog(state, ctx) {
  const lines = orderedLines(state);
  const orders = list(state.orders).filter((order) => lines.some((entry) => entry.order.id === order.id));
  if (!lines.length) {
    const message = "Create a purchase order with at least one product line before creating a batch.";
    showDialog("New inspection batch", el("div", { className: "qc-ops-new-batch-form" },
      el("p", {}, message),
      el("div", { className: "qc-ops-dialog-actions" },
        button("Open purchase orders", () => { closeDialog(); ctx.navigate("orders"); }, "button-primary"),
        button("Cancel", () => closeDialog(), "button-secondary"),
      ),
    ));
    return;
  }
  const localToday = new Date();
  const today = `${localToday.getFullYear()}-${String(localToday.getMonth() + 1).padStart(2, "0")}-${String(localToday.getDate()).padStart(2, "0")}`;
  const orderSelect = el("select", { required: true, name: "orderId" },
    ...orders.map((order) => el("option", { value: order.id }, text(order.number, "Purchase order")))
  );
  const versionSelect = el("select", { required: true, name: "versionLabel" });
  const productsHost = el("div", { className: "qc-ops-product-entries" });
  const addProduct = button("Add product", () => addProductEntry(), "button button-secondary");
  const productEntries = [];
  const factorySelect = el("select", { required: true, name: "factory" });
  const stageSelect = el("select", { required: true, name: "stage" });
  const dateInput = el("input", { type: "date", required: true, name: "date", value: today });
  const recorderInput = el("input", { type: "text", required: true, maxLength: "80", name: "recorder", autocomplete: "name" });
  const notesInput = el("textarea", { rows: "2", maxLength: "1000", name: "notes" });
  const standardsAction = button("Open standards", () => { closeDialog(); ctx.navigate("standards"); }, "button-secondary");
  const showStandardsAction = (visible) => {
    standardsAction.hidden = !visible;
    standardsAction.style.display = visible ? "" : "none";
  };
  showStandardsAction(false);
  const formError = el("p", { className: "qc-ops-form-error", role: "alert" });
  const submit = el("button", { type: "submit", className: "button button-primary", disabled: true }, "Create batch");
  // One submit creates one batch: a repeated submit while the first is pending is ignored.
  const submitFlight = createSingleFlight({ controls: () => [submit], onSettled: () => updateSubmitState() });
  const cancel = button("Cancel", () => closeDialog(), "button button-secondary");
  const currentOrderLines = () => lines.filter((entry) => entry.order.id === orderSelect.value);
  const findLine = (lineId) => currentOrderLines().find((entry) => entry.line.id === lineId);
  const selectedModel = () => {
    const firstEntry = productEntries[0];
    const firstLine = firstEntry ? findLine(firstEntry.lineSelect.value) : null;
    return firstLine ? String(firstLine.variant.model ?? "").trim() : null;
  };
  const readyPairs = (entry) => {
    const line = findLine(entry.lineSelect.value);
    if (!line) return [];
    const pairs = getBatchVersions(state, line.variant.familyId).flatMap((version) =>
      applicablePairs(version, line.variant.model).filter((pair) => getBatchVersionReadiness(version, pair.factory, pair.stage, line.variant.model).ready));
    return Array.from(new Map(pairs.map((pair) => [`${pair.factory}::${pair.stage}`, pair])).values());
  };
  const refreshProductOptions = () => {
    const model = selectedModel();
    if (model !== null) {
      for (const entry of productEntries.slice(1)) {
        const selectedLine = findLine(entry.lineSelect.value);
        if (selectedLine && String(selectedLine.variant.model ?? "").trim() !== model) entry.lineSelect.value = "";
      }
    }
    for (const [index, entry] of productEntries.entries()) {
      const selected = entry.lineSelect.value;
      const usedByOthers = new Set(productEntries.filter((candidate) => candidate !== entry).map((candidate) => candidate.lineSelect.value).filter(Boolean));
      const available = currentOrderLines().filter((line) => {
        const matchesModel = index === 0 || model === null || String(line.variant.model ?? "").trim() === model;
        return matchesModel && (line.line.id === selected || !usedByOthers.has(line.line.id));
      });
      const selectedStillAvailable = available.some((line) => line.line.id === selected);
      setOptions(entry.lineSelect, [
        { value: "", label: "Select product" },
        ...available.map((line) => ({ value: line.line.id, label: lineOptionLabel(line, currentOrderLines()) }))
      ], selectedStillAvailable ? selected : "");
    }
    const eligibleLines = currentOrderLines().filter((line) => model === null || String(line.variant.model ?? "").trim() === model);
    addProduct.disabled = !eligibleLines.some((line) => !productEntries.some((entry) => entry.lineSelect.value === line.line.id));
    for (const entry of productEntries) entry.remove.disabled = productEntries.length <= 1;
  };
  let commonReadyPairs = [];
  let sharedVersionChoices = [];
  const selectedVariantIds = () => productEntries.map((entry) => findLine(entry.lineSelect.value)?.variant?.id).filter(Boolean);
  const sharedChoicesFor = (factory, stage) => getSharedBatchVersionChoices(state, selectedVariantIds(), factory, stage);
  const refreshApplicability = () => {
    const firstPairs = productEntries.length ? readyPairs(productEntries[0]) : [];
    commonReadyPairs = firstPairs.filter((pair) => productEntries.every((entry) =>
      readyPairs(entry).some((candidate) => candidate.factory === pair.factory && candidate.stage === pair.stage)) &&
      sharedChoicesFor(pair.factory, pair.stage).length > 0);
    const factories = Array.from(new Set(commonReadyPairs.map((pair) => pair.factory))).sort();
    const priorFactory = factorySelect.value;
    setOptions(factorySelect, factories.map((factory) => ({ value: factory, label: factory })), factories.includes(priorFactory) ? priorFactory : factories[0] || "");
    const stages = commonReadyPairs.filter((pair) => pair.factory === factorySelect.value).map((pair) => pair.stage);
    const priorStage = stageSelect.value;
    setOptions(stageSelect, stages.map((stage) => ({ value: stage, label: stage })), stages.includes(priorStage) ? priorStage : stages[0] || "");
    const hasCommonBasis = commonReadyPairs.some((pair) => pair.factory === factorySelect.value && pair.stage === stageSelect.value);
    sharedVersionChoices = hasCommonBasis ? sharedChoicesFor(factorySelect.value, stageSelect.value) : [];
    const previousLabel = versionSelect.value;
    setOptions(versionSelect, sharedVersionChoices.map((choice) => ({ value: choice.label, label: choice.label })),
      sharedVersionChoices.some((choice) => choice.label === previousLabel) ? previousLabel : sharedVersionChoices[0]?.label || "");
    versionSelect.disabled = sharedVersionChoices.length === 0;
    showStandardsAction(!hasCommonBasis || sharedVersionChoices.length === 0);
    updateSubmitState();
  };
  const updateSubmitState = () => {
    const lineIds = productEntries.map((entry) => entry.lineSelect.value);
    const duplicateLines = lineIds.some((id, index) => id && lineIds.indexOf(id) !== index);
    const selectedModels = productEntries.map((entry) => findLine(entry.lineSelect.value)).filter(Boolean)
      .map((line) => String(line.variant.model ?? "").trim());
    const mixedModels = new Set(selectedModels).size > 1;
    const quantities = productEntries.map((entry) => Number(entry.quantityInput.value));
    const quantitiesReady = quantities.every((value) => Number.isSafeInteger(value) && value > 0) && Number.isSafeInteger(quantities.reduce((sum, value) => sum + value, 0));
    const productsReady = productEntries.length > 0 && !duplicateLines && productEntries.every((entry) => entry.lineSelect.value);
    const selectedVersionIsReady = sharedVersionChoices.some((choice) => choice.label === versionSelect.value);
    const ordinaryFieldsReady = Boolean(orderSelect.value && dateInput.value && recorderInput.value.trim());
    const hasCommonBasis = commonReadyPairs.some((pair) => pair.factory === factorySelect.value && pair.stage === stageSelect.value);
    submit.disabled = submitFlight.isBusy() || !(hasCommonBasis && selectedVersionIsReady && productsReady && !mixedModels && quantitiesReady && ordinaryFieldsReady);
    formError.textContent = mixedModels ? "Choose products from the same model."
      : duplicateLines ? "Select each purchase order line only once."
      : productEntries.length && productsReady && !selectedVersionIsReady ? "No shared design version is available for these products."
        : "";
  };
  const refreshAll = () => {
    refreshProductOptions();
    refreshApplicability();
  };
  function addProductEntry(lineId = "") {
    const lineSelect = el("select", { required: true, name: "lineId" });
    const quantityInput = el("input", { type: "number", required: true, min: "1", step: "1", name: "productQuantity", inputMode: "numeric" });
    const remove = button("Remove", () => {
      if (productEntries.length <= 1) return;
      const index = productEntries.indexOf(entry);
      if (index >= 0) productEntries.splice(index, 1);
      card.remove();
      refreshAll();
    }, "button button-secondary qc-ops-small-button");
    const entry = { lineSelect, quantityInput, remove };
    const card = el("div", { className: "qc-ops-product-entry" },
      el("div", { className: "qc-ops-product-entry-fields" },
        field("Product from this PO", lineSelect),
        field("Product quantity", quantityInput),
      ),
      remove,
    );
    productEntries.push(entry);
    productsHost.append(card);
    refreshProductOptions();
    if (lineId && Array.from(lineSelect.options).some((option) => option.value === lineId)) lineSelect.value = lineId;
    lineSelect.addEventListener("change", () => { refreshProductOptions(); refreshApplicability(); });
    quantityInput.addEventListener("input", updateSubmitState);
    refreshApplicability();
  }
  const resetProductsForOrder = () => {
    productEntries.splice(0);
    productsHost.replaceChildren();
    const first = currentOrderLines()[0];
    if (first) addProductEntry(first.line.id);
    else refreshApplicability();
  };
  orderSelect.addEventListener("change", resetProductsForOrder);
  factorySelect.addEventListener("change", refreshApplicability);
  stageSelect.addEventListener("change", refreshApplicability);
  versionSelect.addEventListener("change", updateSubmitState);
  for (const input of [dateInput, recorderInput]) input.addEventListener("input", updateSubmitState);
  const form = el("form", { className: "qc-ops-form qc-ops-new-batch-form" },
    el("div", { className: "qc-ops-form-grid" }, field("Purchase order 采购订单", orderSelect), field("Design version 设计版本", versionSelect)),
    el("div", { className: "qc-ops-product-entry-heading" }, el("strong", {}, "Products and quantities"), addProduct),
    productsHost,
    standardsAction,
    el("div", { className: "qc-ops-form-grid" }, field("Factory 工厂", factorySelect), field("Inspection stage 检验阶段", stageSelect)),
    el("div", { className: "qc-ops-form-grid" }, field("Batch date 批次日期", dateInput), field("Recorded by 记录人员", recorderInput)),
    field("Special notes 本批次特殊情况", notesInput),
    formError,
    el("div", { className: "qc-ops-dialog-actions" }, cancel, submit)
  );
  resetProductsForOrder();
  async function submitBatch() {
    formError.textContent = "";
    if (!form.reportValidity()) return;
    const selectedProducts = productEntries.map((entry) => ({
      lineId: entry.lineSelect.value,
      quantity: Number(entry.quantityInput.value),
    }));
    if (!orderSelect.value || !factorySelect.value || !stageSelect.value || !selectedProducts.length || !versionSelect.value || selectedProducts.some((product) => !product.lineId || !Number.isSafeInteger(product.quantity) || product.quantity <= 0) || !Number.isSafeInteger(selectedProducts.reduce((sum, product) => sum + product.quantity, 0))) {
      formError.textContent = selectedProducts.length && !versionSelect.value
        ? "No shared design version is available for these products."
        : "Choose a PO, product quantities, a design version, and a shared factory/stage.";
      return;
    }
    if (new Set(selectedProducts.map((product) => product.lineId)).size !== selectedProducts.length) {
      formError.textContent = "Select each purchase order line only once.";
      return;
    }
    const productModels = selectedProducts.map((product) => {
      const line = findLine(product.lineId);
      return String(line?.variant.model ?? "").trim();
    });
    if (new Set(productModels).size > 1) {
      formError.textContent = "Choose products from the same model.";
      return;
    }
    const selectedSharedChoice = sharedChoicesFor(factorySelect.value, stageSelect.value)
      .find((choice) => choice.label === versionSelect.value);
    if (!selectedSharedChoice) {
      formError.textContent = "No shared design version is available for these products.";
      return;
    }
    const result = await ctx.run("createBatch", {
      orderId: orderSelect.value,
      products: selectedProducts,
      versionLabel: versionSelect.value,
      factory: factorySelect.value,
      stage: stageSelect.value,
      date: dateInput.value,
      recorder: recorderInput.value.trim(),
      notes: notesInput.value
    });
    if (!result.ok) {
      formError.textContent = errorText(result.error);
      return;
    }
    closeDialog(true);
    const createdId = result.result?.entityId || result.result?.batchId;
    if (createdId) ctx.navigate("batches", createdId);
    else ctx.navigate("batches");
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitFlight(submitBatch);
  });
  showDialog("New inspection batch", form);
}
