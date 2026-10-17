// Batch list page and the public entry points of the batch pages. The inspection rows, attachments,
// the historical and operational detail pages, and the New batch dialog live in the qc-batch-*.js
// modules. The exports here are unchanged, so existing importers do not change.

import { button, dateLabel, el, field, list, pageHeading, quantity, text } from "./qc-ops-common.js";
import { getBatchVersionReadiness, getBatchVersions } from "../core/qc-batch-versions.js";
import { draftCounts, hasAnyBatchDrafts, pendingBatchIds } from "./qc-batch-drafts.js";
import { resolveBatchDisplayNumbers } from "../core/qc-batch-display.js";
import { applicablePairs, batchProducts, isHistoricalBatch, orderedLines, productLabel, sourceValue, totalProductQuantity, variantsById } from "./qc-batch-model.js";
import { batchAttachments } from "./qc-batch-attachments.js";
import { openNewBatchDialog } from "./qc-batch-new.js";
import { renderBatchDetail } from "./qc-batch-detail.js";

export { clearBatchDrafts } from "./qc-batch-drafts.js";
export { inspectionControlName } from "./qc-batch-model.js";

window.addEventListener("beforeunload", (event) => {
  if (hasAnyBatchDrafts()) {
    event.preventDefault();
    event.returnValue = "";
  }
});

function hasReadyVersionForModel(state, familyId, model) {
  return getBatchVersions(state, familyId).some((version) => applicablePairs(version, model)
    .some((pair) => getBatchVersionReadiness(version, pair.factory, pair.stage, model).ready));
}

function renderBatchList(root, ctx) {
  const state = ctx.state || {};
  const batches = list(state.batches).slice().sort((left, right) => String(right.date || right.createdAt || "").localeCompare(String(left.date || left.createdAt || "")));
  const displayNumbers = resolveBatchDisplayNumbers(state);
  const orders = list(state.orders);
  const variants = variantsById(state);
  const createButton = button("New batch", () => openNewBatchDialog(state, ctx), "button button-primary");
  const orderLines = orderedLines(state);
  const createableLines = orderLines.filter((entry) => hasReadyVersionForModel(state, entry.variant.familyId, entry.variant.model));
  const actions = [createButton];
  const toolbar = el("div", { className: "qc-ops-list-toolbar" });
  const search = el("input", { type: "search", placeholder: "Search batch, product, PO, source file, or version", "aria-label": "Search batches" });
  const familyById = new Map(list(state.families).map((family) => [family.id, family]));
  const plural = { Family: "families", Factory: "factories", Stage: "stages" };
  const filterSelect = (label, entries) => el("select", { "aria-label": `Filter batches by ${label.toLocaleLowerCase()}` },
    el("option", { value: "all" }, `All ${plural[label] || `${label.toLocaleLowerCase()}s`}`),
    entries.map(({ value, label: entryLabel }) => el("option", { value }, entryLabel ?? value)),
  );
  const families = [...new Set(batches.flatMap((batch) => isHistoricalBatch(batch)
    ? [batch.familyId || variants.get(batch.variantId)?.familyId]
    : batchProducts(batch, state).map((product) => product.familyId || variants.get(product.variantId)?.familyId)).filter(Boolean))].sort();
  const factories = [...new Set(batches.map((batch) => batch.factory).filter((value) => value !== null && value !== undefined && value !== ""))].map(String).sort();
  const stages = [...new Set(batches.map((batch) => batch.stage).filter((value) => value !== null && value !== undefined && value !== ""))].map(String).sort();
  const family = filterSelect("Family", families.map((value) => ({ value, label: familyById.get(value)?.name || value })));
  const factory = filterSelect("Factory", factories.map((value) => ({ value })));
  const stage = filterSelect("Stage", stages.map((value) => ({ value })));
  toolbar.append(field("Search", search), field("Family", family), field("Factory", factory), field("Stage", stage));
  const table = el("table", { className: "qc-ops-list-table qc-ops-batch-list-table" },
    el("thead", {}, el("tr", {}, ...["Batch", "Purchase order", "Total quantity", "Date"].map((label) => el("th", { scope: "col" }, label)))),
    el("tbody")
  );
  const tbody = table.querySelector("tbody");
  const isInteractiveTarget = (target) => target instanceof Element && Boolean(target.closest(
    "button, a, input, select, textarea, summary, label, form, [contenteditable='true'], [role='button'], [role='link']"
  ));
  for (const batch of batches) {
    const displayNumber = displayNumbers.get(batch.id) ?? batch.number;
    const variant = variants.get(batch.variantId);
    const order = orders.find((item) => item.id === batch.orderId);
    const products = isHistoricalBatch(batch) ? [] : batchProducts(batch, state);
    const batchFamilies = isHistoricalBatch(batch)
      ? [batch.familyId || variant?.familyId].filter(Boolean)
      : products.map((product) => product.familyId || variants.get(product.variantId)?.familyId).filter(Boolean);
    const attachments = batchAttachments(batch, state);
    const searchText = [displayNumber, ...batchFamilies, ...batchFamilies.map((familyId) => familyById.get(familyId)?.name), batch.productLabel, batch.model, batch.color, variant?.label,
      ...products.flatMap((product) => [productLabel(product, state), product.quantity, product.versionLabel]),
      order?.number, batch.factory, batch.stage, batch.versionLabel, ...attachments.map((asset) => asset.name)]
      .filter((value) => value !== null && value !== undefined).join(" ").toLocaleLowerCase();
    const tr = el("tr", {
      className: "qc-ops-batch-row",
      tabIndex: 0,
      ariaLabel: `Open batch ${displayNumber}`,
      "data-family": batchFamilies.join(" "),
      "data-factory": batch.factory || "",
      "data-stage": batch.stage || "",
      "data-search": searchText,
    },
      el("td", {}, text(displayNumber)),
      el("td", {}, text(order?.number)),
      el("td", { className: "qc-ops-number" }, isHistoricalBatch(batch) ? sourceValue(batch.quantity) : quantity(totalProductQuantity(batch, state))),
      el("td", {}, dateLabel(batch.date)),
    );
    tr.addEventListener("click", (event) => {
      if (isInteractiveTarget(event.target)) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && (tr.contains(selection.anchorNode) || tr.contains(selection.focusNode))) return;
      ctx.navigate("batches", batch.id);
    });
    tr.addEventListener("keydown", (event) => {
      if ((event.key !== "Enter" && event.key !== " ") || isInteractiveTarget(event.target)) return;
      event.preventDefault();
      ctx.navigate("batches", batch.id);
    });
    tbody.append(tr);
  }
  const updateFilters = () => {
    const query = search.value.trim().toLowerCase();
    for (const row of tbody.rows) {
      const familyMatches = family.value === "all" || row.dataset.family.split(" ").includes(family.value);
      const factoryMatches = factory.value === "all" || row.dataset.factory === factory.value;
      const stageMatches = stage.value === "all" || row.dataset.stage === stage.value;
      const searchMatches = !query || row.dataset.search.includes(query);
      row.hidden = !familyMatches || !factoryMatches || !stageMatches || !searchMatches;
    }
  };
  search.addEventListener("input", updateFilters);
  for (const select of [family, factory, stage]) select.addEventListener("change", updateFilters);
  const sections = [];
  if (!batches.length && !orders.length) {
    sections.push(el("section", { className: "card qc-ops-empty-card" },
      el("h2", {}, "Start with a purchase order"),
      button("Open purchase orders", () => ctx.navigate("orders"), "button button-primary")
    ));
  } else if (!batches.length && orders.length && !orderLines.length) {
    sections.push(el("section", { className: "card qc-ops-empty-card" },
      el("h2", {}, "Add a purchase order line"),
      button("Open purchase orders", () => ctx.navigate("orders"), "button button-primary")
    ));
  } else if (!batches.length && orderLines.length && !createableLines.length) {
    sections.push(el("section", { className: "card qc-ops-empty-card" },
      el("h2", {}, "Review design versions"),
      button("Open standards", () => ctx.navigate("standards"), "button button-primary")
    ));
  }
  if (hasAnyBatchDrafts()) {
    const counts = draftCounts();
    sections.unshift(el("section", { className: "card qc-ops-draft-warning" },
      el("strong", {}, "Unsaved edits are kept in this browser until saved"),
      el("p", {}, `${counts.rows} inspection row(s) and ${counts.details} batch detail set(s) need saving.`),
      ...pendingBatchIds().map((batchId) => {
        const batch = batches.find((item) => item.id === batchId);
        return batch ? button(`Resume ${text(displayNumbers.get(batch.id) ?? batch.number)}`, () => ctx.navigate("batches", batchId, true), "button button-secondary qc-ops-small-button") : null;
      })
    ));
  }
  if (batches.length) {
    sections.push(el("section", { className: "card qc-ops-list-card" }, toolbar, el("div", { className: "qc-ops-table-scroll" }, table)));
  } else if (orders.length && orderLines.length && createableLines.length) {
    sections.push(el("section", { className: "card qc-ops-empty-card" },
      el("h2", {}, "No batches yet"),
      createButton
    ));
  }
  root.replaceChildren(pageHeading("Batches", "", actions), ...sections);
}

export async function renderBatchesPage(root, ctx) {
  if (ctx.selectedId) return renderBatchDetail(root, ctx);
  renderBatchList(root, ctx);
}
