// Pure helpers that describe an Issue for the Issue pages: its source inspection, products,
// draft comparison and evidence. They hold no dialog state, so they can be tested directly.
import { list, text, quantity } from "./qc-ops-common.js";
import { getBatchProducts, getBatchRowProduct } from "../core/qc-batch-products.js";
import { resolveBatchDisplayNumber } from "../core/qc-batch-display.js";

export function batchById(state) {
  return new Map(list(state.batches).map((batch) => [batch.id, batch]));
}

export function variantById(state) {
  return new Map(list(state.variants).map((variant) => [variant.id, variant]));
}

export function issueProducts(issue, state) {
  const snapshot = sourceSnapshot(issue);
  const batchSnapshot = snapshot.batch || {};
  const currentBatch = batchById(state).get(issue.batchId || batchSnapshot.id);
  const rawProducts = list(snapshot.products).length
    ? list(snapshot.products)
    : getBatchProducts(batchSnapshot).length
      ? getBatchProducts(batchSnapshot)
      : getBatchProducts(currentBatch || {});
  const variants = variantById(state);
  return rawProducts.map((product) => ({
    ...product,
    variant: product.variant || variants.get(product.variantId) || null,
  }));
}

export function issueProductLabel(product, state) {
  const variant = product?.variant || variantById(state).get(product?.variantId);
  return text(product?.variantLabel || product?.productLabel || product?.label || variant?.label, product?.variantId || "Product");
}

export function hasProductContext(product) {
  return Boolean(product?.variantLabel || product?.productLabel || product?.label || product?.variant?.label || product?.variantId || product?.lineId || product?.productLineId);
}

export function productSummary(products, state) {
  return products.map((product) => {
    const quantityLabel = product.quantity === null || product.quantity === undefined ? "quantity unknown" : `${quantity(product.quantity)} units`;
    const version = product.version?.label || product.versionLabel;
    return `${issueProductLabel(product, state)} · ${quantityLabel}${version ? ` · Version ${version}` : ""}`;
  }).join("; ");
}

export function issueRowProduct(issue, state) {
  const snapshot = sourceSnapshot(issue);
  const row = snapshot.row || (sourceRow(issue) ? snapshot : null);
  if (!row) return null;
  const batchSnapshot = snapshot.batch || batchById(state).get(issue.batchId) || {};
  const linked = getBatchRowProduct(batchSnapshot, row) || {};
  const products = issueProducts(issue, state);
  const matched = products.find((product) => product.lineId === (row.productLineId || linked.lineId));
  return { ...linked, ...matched, ...row };
}

export function sourceSnapshot(issue) {
  return issue.sourceSnapshot || {};
}

export function sourceBatch(issue, state) {
  const snapshot = sourceSnapshot(issue);
  const fromSnapshot = snapshot.batch || {};
  const fallback = snapshot.batchNumber || fromSnapshot.number || fromSnapshot.batchNumber || "";
  return resolveBatchDisplayNumber(state, issue.batchId || fromSnapshot.id, fallback) || "Standalone issue";
}

export function sourceRow(issue) {
  const snapshot = sourceSnapshot(issue);
  const row = snapshot.row || snapshot;
  return row.title || row.titleZh || row.no || row.id || issue.rowId ? row : null;
}

export function otherBatchProducts(products, row, rowProduct, state) {
  if (!rowProduct) return products;
  const linkedKey = row?.productLineId || rowProduct.lineId || rowProduct.variantId || rowProduct.variant?.id || issueProductLabel(rowProduct, state);
  return products.filter((product) => {
    const key = product.lineId || product.variantId || product.variant?.id || issueProductLabel(product, state);
    return key !== linkedKey;
  });
}

export function sourceText(issue, state) {
  const row = sourceRow(issue);
  const products = issueProducts(issue, state);
  const rowProduct = issueRowProduct(issue, state);
  const linkedProduct = hasProductContext(rowProduct) ? rowProduct : null;
  const parts = [sourceBatch(issue, state)];
  const otherProducts = otherBatchProducts(products, row, linkedProduct, state);
  if (linkedProduct) {
    const productQuantity = row?.productQuantity ?? linkedProduct.productQuantity ?? linkedProduct.quantity;
    const version = row?.versionLabel || linkedProduct.versionLabel || linkedProduct.version?.label;
    parts.push(`${issueProductLabel(linkedProduct, state)}${productQuantity === null || productQuantity === undefined ? "" : ` · ${quantity(productQuantity)} units`}${version ? ` · Version ${version}` : ""}`);
  }
  if (!linkedProduct && products.length) parts.push(productSummary(products, state));
  else if (otherProducts.length) parts.push(`Other products: ${productSummary(otherProducts, state)}`);
  if (row) parts.push(text(row.title || row.titleZh || row.no || row.id));
  return parts.join(" · ");
}

export function quantityOrDash(value) {
  return value === null || value === undefined || value === "" ? "—" : quantity(value);
}

export function savedIssueDraft(issue) {
  return {
    owner: String(issue.owner || ""),
    disposition: String(issue.disposition || ""),
    confirmations: [0, 1, 2].map((index) => String(issue.confirmations?.[index] || ""))
  };
}

export function draftDiffers(issue, draft) {
  const saved = savedIssueDraft(issue);
  return !sameDisposition(dispositionValue(draft), dispositionValue(saved));
}

export function dispositionValue(draft) {
  return {
    owner: draft.owner.trim(),
    disposition: draft.disposition.trim(),
    confirmations: draft.confirmations.map((name) => name.trim()),
  };
}

export function sameDisposition(left, right) {
  return left.owner === right.owner && left.disposition === right.disposition &&
    left.confirmations.length === right.confirmations.length &&
    left.confirmations.every((value, index) => value === right.confirmations[index]);
}

export function hasDiscussionDraft(draft) {
  return Boolean(draft.discussionAuthorName || draft.discussionText);
}

export function hasIssueDraft(issue, draft) {
  return draftDiffers(issue, draft) || hasDiscussionDraft(draft);
}

export function sourcePhotos(issue, state) {
  const photoIds = sourcePhotoIds(issue);
  const assets = new Map(list(state.assets).map((asset) => [asset.id, asset]));
  return photoIds.map((id) => assets.get(id)).filter(Boolean);
}

export function sourcePhotoIds(issue) {
  const snapshot = sourceSnapshot(issue);
  const row = snapshot.row || snapshot;
  return list(row.photoIds ?? snapshot.photoIds);
}

export function issueAttachments(issue, state) {
  if (Array.isArray(issue.attachments)) return issue.attachments;
  const assets = new Map(list(state.assets).map((asset) => [asset.id, asset]));
  return list(issue.attachmentIds).map((id) => assets.get(id)).filter(Boolean);
}

export function newRequestId() {
  return globalThis.crypto.randomUUID();
}
