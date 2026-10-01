/**
 * Read the product allocations locked into an operational batch.
 *
 * Older saved batches used one set of product fields on the batch itself. Keep
 * projecting that shape so existing backups and records remain readable.
 */
export function getBatchProducts(batch) {
  if (!batch || batch.kind === "historical") return [];
  if (Array.isArray(batch.products)) return batch.products.map((product) => ({ ...product }));
  if (batch.lineId == null && batch.variantId == null && batch.familyId == null && batch.versionId == null) return [];
  return [{
    lineId: batch.lineId,
    variantId: batch.variantId,
    familyId: batch.familyId,
    quantity: batch.quantity,
    versionId: batch.versionId,
    versionLabel: batch.versionLabel,
  }];
}

/** Resolve a row's locked product allocation, including legacy single-product rows. */
export function getBatchRowProduct(batch, row) {
  if (!batch || !row || batch.kind === "historical") return null;
  const products = getBatchProducts(batch);
  if (typeof row.productLineId === "string") {
    return products.find((product) => product.lineId === row.productLineId) ?? null;
  }
  return products.length === 1 ? products[0] : null;
}
