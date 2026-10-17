// Pure helpers for the batch pages: product and variant lookups, batch and row labels, rate and
// quantity rules, reading of entered values, and the purchase-order line choices for New batch.
// They touch no DOM and hold no page state, so they can be tested directly. The navigation helper
// only forwards to the page context.

import { list, text } from "./qc-ops-common.js";
import { getBatchVersionItems } from "../core/qc-batch-versions.js";
import { getBatchProducts, getBatchRowProduct } from "../core/qc-batch-products.js";
import { historicalProductLabel } from "../core/qc-batch-display.js";

export function navigateWithDraftWarning(ctx, route, id) {
  void ctx.navigate(route, id);
}

/**
 * Accessible name for a control in the inspection table. It states the action, the file slot and the
 * row, so that repeated controls in different rows can be told apart by assistive technology.
 */
export function inspectionControlName({ action, slot = "", fileName = "" }, row) {
  const subject = [slot, fileName ? `file ${fileName}` : ""].filter(Boolean).join(" ");
  return [action, subject, "for", text(row?.title, "inspection row")].filter(Boolean).join(" ");
}

export function variantsById(state) {
  return new Map(list(state.variants).map((variant) => [variant.id, variant]));
}

export function orderById(state) {
  return new Map(list(state.orders).map((order) => [order.id, order]));
}

export function productLabel(product, state) {
  const variant = product?.variant || variantsById(state).get(product?.variantId);
  return text(variant?.label || product?.productLabel, product?.variantId || "Product");
}

export function batchProducts(batch, state, workspace = null) {
  if (Array.isArray(workspace?.products) && workspace.products.length) return workspace.products;
  return getBatchProducts(batch).map((product) => ({
    ...product,
    variant: variantsById(state).get(product.variantId) || null,
    version: list(state.versions).find((version) => version.id === product.versionId) || null,
  }));
}

function batchProductNames(batch, state, workspace = null) {
  if (isHistoricalBatch(batch)) return [batchProductLabel(batch, state)];
  return batchProducts(batch, state, workspace).map((product) => productLabel(product, state)).filter(Boolean);
}

export function totalProductQuantity(batch, state, workspace = null) {
  if (isHistoricalBatch(batch)) return batch.quantity;
  const products = batchProducts(batch, state, workspace);
  if (!products.length) return batch.quantity;
  return products.reduce((total, product) => total + Number(product.quantity || 0), 0);
}

export function rowProduct(row, batch, state, workspace = null) {
  const product = getBatchRowProduct(batch, row);
  const resolved = batchProducts(batch, state, workspace).find((candidate) => candidate.lineId === product?.lineId || candidate.lineId === row.productLineId);
  return { ...product, ...resolved, ...product };
}

export function isHistoricalBatch(batch) {
  return batch?.kind === "historical";
}

export function batchProductLabel(batch, state) {
  const variant = variantsById(state).get(batch.variantId);
  if (!isHistoricalBatch(batch)) return text(variant?.label, batch.variantId);
  return historicalProductLabel(String(batch.productLabel || batch.model || ""), batch.color);
}

export function sourceValue(value) {
  return text(value);
}

export function nullableNumberFromInput(input) {
  if (input.validity.badInput) return { value: null, invalid: true };
  if (input.value === "") return { value: null, invalid: false };
  const value = Number(input.value);
  return { value, invalid: !Number.isFinite(value) };
}

function normalizedRemarks(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function sameInspectionValues(row, values) {
  if (!row || (row.defectiveQty ?? null) !== values.defectiveQty || normalizedRemarks(row.remarks) !== normalizedRemarks(values.remarks)) return false;
  if (values.actualTimeSeconds === undefined) return !Object.hasOwn(row, "actualTimeSeconds");
  return (row.actualTimeSeconds ?? null) === values.actualTimeSeconds;
}

export function rateLabel(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value.includes("%") || value === "—" ? value : `${value}%`;
  const rate = Number(value);
  if (!Number.isFinite(rate)) return "—";
  return `${rate.toFixed(2)}%`;
}

export function currentRate(row, draft, allowUnchangedAnomaly = false) {
  const inspectedValue = draft.inspectedQty === undefined ? row.inspectedQty : draft.inspectedQty;
  if (inspectedValue === "" || inspectedValue === null || inspectedValue === undefined) return "—";
  if (draft.defectiveQty === "") return "—";
  const inspected = Number(inspectedValue);
  const defective = Number(draft.defectiveQty);
  if (!Number.isInteger(inspected) || !Number.isInteger(defective) || inspected < 0 || defective < 0) return "Check quantity";
  if (defective > inspected && !(allowUnchangedAnomaly && inspected === row.inspectedQty && defective === row.defectiveQty)) return "Check quantity";
  return inspected === 0 ? "—" : `${((defective / inspected) * 100).toFixed(2)}%`;
}

export function operationalTaskTitle(row, workspace, state) {
  const title = text(row.title, "");
  const product = rowProduct(row, workspace.batch, state, workspace);
  const family = list(state.families).find((entry) => entry.id === (product.familyId || product.variant?.familyId));
  const models = list(family?.models);
  if (!models.length || !workspace.batch.factory || !workspace.batch.stage) return title;
  const base = `${models.join("/")}·${workspace.batch.factory}·${workspace.batch.stage}`;
  const version = String(row.versionLabel || product.version?.label || product.versionLabel || "").trim();
  const suffixes = [version ? `[${base}·${version}]` : null, `[${base}]`].filter(Boolean);
  const suffix = suffixes.find((candidate) => title.endsWith(candidate));
  return suffix ? title.slice(0, -suffix.length).trimEnd() : title;
}

export function orderedLines(state) {
  const variants = variantsById(state);
  return list(state.orders).flatMap((order) => list(order.lines).map((line) => ({ order, line, variant: variants.get(line.variantId) })))
    .filter((entry) => entry.variant);
}

export function applicablePairs(version, model) {
  const pairs = new Map();
  for (const item of getBatchVersionItems(version)) {
    const models = list(item.models);
    if (models.length && !models.includes(model)) continue;
    if (!item.factory || !item.stage) continue;
    if (String(item.factory).toUpperCase() === "AP" && String(item.stage).toUpperCase() === "IQC") continue;
    const key = `${item.factory}::${item.stage}`;
    if (!pairs.has(key)) pairs.set(key, { factory: item.factory, stage: item.stage });
  }
  return Array.from(pairs.values());
}
