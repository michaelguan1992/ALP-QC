import {
  ensureUnique,
  fail,
  makeId,
  requireArray,
  requireDate,
  requirePositiveInteger,
  requireRecord,
  requireString,
} from "./qc-domain.js";

function normalizeOrderLines(state, orderId, linesInput, idFactory, previousLines = []) {
  const inputs = requireArray(linesInput, "Purchase order lines");
  if (inputs.length === 0) fail("Add at least one product variant line to the purchase order.");
  if (inputs.length > 500) fail("A purchase order cannot contain more than 500 lines.");
  const lines = inputs.map((input) => {
    requireRecord(input, "Purchase order line");
    const variantId = requireString(input.variantId, "Line product variant ID", { maxLength: 120 });
    if (!state.variants.some((variant) => variant.id === variantId)) fail("A purchase order line refers to an unavailable product variant.");
    const previous = input.id
      ? previousLines.find((line) => line.id === input.id)
      : previousLines.find((line) => line.variantId === variantId);
    const id = input.id ? requireString(input.id, "Purchase order line ID", { maxLength: 120 }) : previous?.id ?? makeId(idFactory);
    if (previous && previous.variantId !== variantId && state.batches.some((batch) => batch.orderId === orderId && batch.lineId === previous.id)) {
      fail("A purchase order line used by a batch cannot change its product variant.");
    }
    return { id, variantId, orderedQty: requirePositiveInteger(input.orderedQty, "Ordered quantity") };
  });
  ensureUnique(lines.map((line) => line.id), "Purchase order line IDs");
  ensureUnique(lines.map((line) => line.variantId), "Product variants within one purchase order");

  const nextIds = new Set(lines.map((line) => line.id));
  for (const previous of previousLines) {
    if (!nextIds.has(previous.id) && state.batches.some((batch) => batch.orderId === orderId && batch.lineId === previous.id)) {
      fail("A purchase order line used by a batch cannot be removed.");
    }
  }
  return lines;
}

function normalizeOrderDetails(state, data, exceptId = null) {
  const number = requireString(data.number, "Purchase order number", { maxLength: 160 });
  if (state.orders.some((order) => order.number.toLocaleLowerCase() === number.toLocaleLowerCase() && order.id !== exceptId)) {
    fail("Purchase order number must be unique.");
  }
  return {
    number,
    date: requireDate(data.date, "Purchase order date"),
    supplier: requireString(data.supplier ?? "", "Supplier", { maxLength: 300, allowBlank: true }),
    notes: requireString(data.notes ?? "", "Purchase order notes", { maxLength: 5000, allowBlank: true }),
  };
}

export function createOrder(state, data, context) {
  const details = normalizeOrderDetails(state, data);
  const id = makeId(context.idFactory);
  const lines = normalizeOrderLines(state, id, data.lines, context.idFactory);
  state.orders.push({ id, ...details, lines, createdAt: context.now() });
  return { entityId: id, action: "createOrder", summary: `Created purchase order ${details.number}.` };
}

export function saveOrder(state, data, context) {
  const id = requireString(data.id, "Purchase order ID", { maxLength: 120 });
  const order = state.orders.find((candidate) => candidate.id === id);
  if (!order) fail("That purchase order is no longer available.");
  const details = normalizeOrderDetails(state, data, id);
  const lines = normalizeOrderLines(state, id, data.lines, context.idFactory, order.lines);
  Object.assign(order, details, { lines });
  return { entityId: id, action: "saveOrder", summary: `Updated purchase order ${details.number}.` };
}

export function getPurchaseOrderProgress(state, orderId) {
  const order = state.orders.find((candidate) => candidate.id === orderId);
  if (!order) fail("That purchase order is no longer available.");
  const lines = order.lines.map((line) => {
    const variant = state.variants.find((candidate) => candidate.id === line.variantId);
    const batches = state.batches
      .filter((batch) => batch.orderId === order.id && batch.lineId === line.id && batch.status === "released" && batch.countForPO === true && batch.stage === "OQC")
      .sort((left, right) => left.date.localeCompare(right.date) || left.createdAt.localeCompare(right.createdAt))
      .map((batch) => ({
        id: batch.id,
        number: batch.number,
        lotNumber: batch.lotNumber,
        date: batch.date,
        quantity: batch.quantity,
        versionLabel: batch.versionLabel,
      }));
    const releasedQty = batches.reduce((total, batch) => total + batch.quantity, 0);
    return {
      ...line,
      variant: structuredClone(variant),
      orderedQty: line.orderedQty,
      releasedQty,
      remainingQty: Math.max(line.orderedQty - releasedQty, 0),
      excessQty: Math.max(releasedQty - line.orderedQty, 0),
      batches,
    };
  });
  return { order: structuredClone(order), lines };
}
