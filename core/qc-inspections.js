import {
  ensureUnique,
  fail,
  factoryKey,
  makeId,
  normalizeFactory,
  normalizeStage,
  requireArray,
  requireDate,
  requireNonNegativeInteger,
  requirePositiveInteger,
  requireString,
} from "./qc-domain.js";
import { normalizeStandardItems, selectApplicableItems } from "./qc-standards.js";
import { getBatchVersionItems, getBatchVersionReadiness, getBatchVersions } from "./qc-batch-versions.js";
import { getBatchProducts, getBatchRowProduct } from "./qc-batch-products.js";
import { resolveBatchDisplayNumbers } from "./qc-batch-display.js";

export function requireBatch(state, batchId) {
  const id = requireString(batchId, "Batch ID", { maxLength: 160 });
  const batch = state.batches.find((candidate) => candidate.id === id);
  if (!batch) fail("That batch is no longer available.");
  return batch;
}

export function requireEditableBatch(batch) {
  if (batch.kind === "historical") fail("Historical inspection records are read-only.");
  if (batch.status === "released") fail("This batch is released and its records are read-only.");
}

export function batchReleaseBlockers(state, batch) {
  if (batch.kind === "historical") return ["Historical inspection records cannot be released."];
  const blockers = [];
  const unsaved = batch.rows.filter((row) => row.savedAt === null || row.defectiveQty === null);
  if (unsaved.length) blockers.push(`Save all ${batch.rows.length} inspection rows before release; ${unsaved.length} remain unsaved.`);
  if (!batch.recorder.trim()) blockers.push("Enter the recorder before release.");
  const openIssues = state.issues.filter((issue) => issue.batchId === batch.id && issue.status === "open");
  if (openIssues.length) blockers.push(`Close all linked issues before release; ${openIssues.length} remain open.`);
  if (batch.countForPO && typeof batch.lotNumber === "string" && batch.lotNumber.trim()) {
    const lotKey = batch.lotNumber.trim().toLocaleLowerCase();
    const variants = new Set(getBatchProducts(batch).map((product) => product.variantId));
    const duplicate = state.batches.find((candidate) => candidate.id !== batch.id &&
      candidate.status === "released" && candidate.countForPO === true &&
      typeof candidate.lotNumber === "string" && candidate.lotNumber.trim().toLocaleLowerCase() === lotKey &&
      getBatchProducts(candidate).some((product) => variants.has(product.variantId)));
    if (duplicate) blockers.push(`Lot ${batch.lotNumber} is already counted in released batch ${duplicate.number}.`);
  }
  return blockers;
}

function selectProductVersion(state, family, variant, factory, stage, requestedVersionId) {
  const familyVersions = getBatchVersions(state, family.id);
  let version;
  if (requestedVersionId == null || String(requestedVersionId).trim() === "") {
    version = familyVersions[0];
    if (!version) fail(`No recorded or published design version is available for ${family.name}.`);
  } else {
    const versionId = requireString(String(requestedVersionId), "Design version ID", { maxLength: 120 });
    version = familyVersions.find((candidate) => candidate.id === versionId);
    if (!version) fail("Choose a recorded, published, or superseded design version from the selected product family.");
  }
  const readiness = getBatchVersionReadiness(version, factory, stage, variant.model);
  if (!readiness.ready) fail(readiness.message);
  const projectedVersion = { ...version, items: getBatchVersionItems(version) };
  const applicableItems = selectApplicableItems(projectedVersion, factory, stage, variant.model);
  if (!applicableItems.length) fail(`Version ${version.label} has no ${factory} ${stage} standards applicable to ${variant.model}.`);
  return { version, applicableItems };
}

function uniqueInspectionRowId(idFactory, usedIds) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = makeId(idFactory);
    if (!usedIds.has(id)) {
      usedIds.add(id);
      return id;
    }
  }
  fail("The ID generator could not create unique inspection row IDs.");
}

export function createBatch(state, data, context) {
  const number = requireString(data.number, "Batch number", { maxLength: 160 });
  if (state.batches.some((batch) => batch.number.toLocaleLowerCase() === number.toLocaleLowerCase())) fail("Batch number must be unique.");
  const order = state.orders.find((candidate) => candidate.id === data.orderId);
  if (!order) fail("Choose an available purchase order.");
  const multiProduct = Object.hasOwn(data, "products");
  const productInputs = multiProduct
    ? requireArray(data.products, "Batch products")
    : [{ lineId: data.lineId, quantity: data.quantity, versionId: data.versionId }];
  if (productInputs.length === 0) fail("Add at least one product from the selected purchase order.");
  if (productInputs.length > 500) fail("A batch cannot contain more than 500 purchase order lines.");

  const factory = normalizeFactory(data.factory);
  if (!factory) fail("Factory is required.");
  const stage = normalizeStage(data.stage);
  if (!stage) fail("Inspection stage must be IQC or OQC.");
  if (factory === "AP" && stage === "IQC") fail("AP batches are OQC only; AP IQC batches cannot be created.");
  const countForPO = stage === "OQC";

  const usedLineIds = new Set();
  const products = [];
  let quantity = 0;
  for (const [index, input] of productInputs.entries()) {
    const label = `Batch product ${index + 1}`;
    if (!input || typeof input !== "object" || Array.isArray(input)) fail(`${label} must be an object.`);
    const lineId = requireString(input.lineId, `${label} purchase order line ID`, { maxLength: 120 });
    if (usedLineIds.has(lineId)) fail("Each purchase order line can appear only once in a batch.");
    usedLineIds.add(lineId);
    const line = order.lines.find((candidate) => candidate.id === lineId);
    if (!line) fail("Choose purchase order lines from the selected order.");
    const variant = state.variants.find((candidate) => candidate.id === line.variantId);
    if (!variant) fail("A selected purchase order line has no available product variant.");
    if (!variant.active) fail("Reactivate every selected product variant before creating a new batch.");
    const family = state.families.find((candidate) => candidate.id === variant.familyId);
    if (!family) fail("A selected product variant has no available inspection family.");
    const productQuantity = requirePositiveInteger(input.quantity, `${label} quantity`);
    quantity += productQuantity;
    if (!Number.isSafeInteger(quantity)) fail("The total batch quantity must be a safe whole number.");
    const { version, applicableItems } = selectProductVersion(state, family, variant, factory, stage, input.versionId);
    const lockedItems = normalizeStandardItems(applicableItems, family, context.idFactory, applicableItems);
    products.push({
      lineId: line.id,
      variantId: variant.id,
      familyId: family.id,
      quantity: productQuantity,
      versionId: version.id,
      versionLabel: version.label,
      variant,
      family,
      version,
      lockedItems,
    });
  }
  ensureUnique(products.map((product) => product.lineId), "Purchase order lines in a batch");

  let legacyLotNumber = null;
  if (!multiProduct && data.lotNumber != null && !(typeof data.lotNumber === "string" && data.lotNumber.trim() === "")) {
    legacyLotNumber = requireString(data.lotNumber, "Physical lot number", { maxLength: 160 });
  }
  const productRecords = products.map(({ lineId, variantId, familyId, quantity: productQuantity, versionId, versionLabel }) => ({
    lineId,
    variantId,
    familyId,
    quantity: productQuantity,
    versionId,
    versionLabel,
  }));
  const firstProduct = productRecords.length === 1 ? productRecords[0] : null;

  const id = makeId(context.idFactory);
  const usedRowIds = new Set();
  const rows = products.flatMap((product) => product.lockedItems.map((item) => ({
    ...structuredClone(item),
    ...(multiProduct ? {
      id: uniqueInspectionRowId(context.idFactory, usedRowIds),
      sourceItemId: item.id,
      productLineId: product.lineId,
    } : {}),
    inspectedQty: Math.ceil(product.quantity * item.samplingPercent / 100),
    defectiveQty: null,
    remarks: "",
    savedAt: null,
    photoIds: [],
  })));
  const batch = {
    id,
    kind: "operational",
    number,
    orderId: order.id,
    lineId: firstProduct?.lineId ?? null,
    variantId: firstProduct?.variantId ?? null,
    familyId: firstProduct?.familyId ?? null,
    quantity,
    factory,
    stage,
    countForPO,
    versionId: firstProduct?.versionId ?? null,
    versionLabel: firstProduct?.versionLabel ?? null,
    date: requireDate(data.date, "Batch date"),
    recorder: requireString(data.recorder ?? "", "Recorder", { maxLength: 200, allowBlank: true }),
    notes: requireString(data.notes ?? "", "Batch notes", { maxLength: 5000, allowBlank: true }),
    status: "draft",
    rows,
    attachmentIds: [],
    createdAt: context.now(),
    releasedAt: null,
  };
  if (multiProduct) batch.products = productRecords;
  else if (legacyLotNumber !== null) batch.lotNumber = legacyLotNumber;
  state.batches.push(batch);
  const versionSummary = firstProduct
    ? ` using locked version ${firstProduct.versionLabel}`
    : ` across ${productRecords.length} product lines and their locked versions`;
  return { entityId: id, action: "createBatch", summary: `Created draft batch ${number}${versionSummary}.` };
}

export function saveBatchDetails(state, data) {
  const batch = requireBatch(state, data.id);
  requireEditableBatch(batch);
  batch.date = requireDate(data.date, "Batch date");
  batch.recorder = requireString(data.recorder ?? "", "Recorder", { maxLength: 200, allowBlank: true });
  batch.notes = requireString(data.notes ?? "", "Batch notes", { maxLength: 5000, allowBlank: true });
  return { entityId: batch.id, action: "saveBatchDetails", summary: `Updated draft batch ${batch.number}.` };
}

export function saveInspection(state, data, context) {
  const batch = requireBatch(state, data.batchId);
  requireEditableBatch(batch);
  if (Object.hasOwn(data, "inspectedQty")) fail("Inspection quantity is calculated from the batch and standard and cannot be entered.");
  const rowId = requireString(data.rowId, "Inspection row ID", { maxLength: 120 });
  const row = batch.rows.find((candidate) => candidate.id === rowId);
  if (!row) fail("That inspection row is not part of this batch.");
  if (data.defectiveQty == null || String(data.defectiveQty).trim() === "") fail("Enter a defective quantity before saving this row.");
  if (typeof data.defectiveQty !== "number" && typeof data.defectiveQty !== "string") fail("Defective quantity must be a number.");
  const defectiveQty = typeof data.defectiveQty === "number" ? data.defectiveQty : Number(data.defectiveQty);
  if (typeof data.defectiveQty === "string" && !/^\d+(?:\.\d+)?$/.test(data.defectiveQty.trim())) fail("Defective quantity must be a whole number of zero or more.");
  requireNonNegativeInteger(defectiveQty, "Defective quantity");
  if (defectiveQty > row.inspectedQty) fail("Defective quantity cannot exceed inspection quantity.");
  const remarks = requireString(data.remarks ?? "", "Inspection remarks", { maxLength: 5000, allowBlank: true });
  row.defectiveQty = defectiveQty;
  row.remarks = remarks;
  row.savedAt = context.now();
  return { entityId: batch.id, action: "saveInspection", summary: `Saved inspection row ${row.title} for batch ${batch.number}.` };
}

export function releaseBatch(state, data, context) {
  const batch = requireBatch(state, data.id);
  if (batch.kind === "historical") fail("Historical inspection records cannot be released.");
  if (batch.status === "released") {
    return { entityId: batch.id, changed: false, action: "releaseBatch", summary: `Batch ${batch.number} was already released.` };
  }
  const blockers = batchReleaseBlockers(state, batch);
  if (blockers.length) fail(blockers.join(" "));
  batch.status = "released";
  batch.releasedAt = context.now();
  return { entityId: batch.id, action: "releaseBatch", summary: `Released batch ${batch.number} for its full quantity of ${batch.quantity}.` };
}

export function getBatchWorkspace(state, batchId) {
  const batch = requireBatch(state, batchId);
  const variant = state.variants.find((candidate) => candidate.id === batch.variantId);
  const version = state.versions.find((candidate) => candidate.id === batch.versionId);
  const order = state.orders.find((candidate) => candidate.id === batch.orderId);
  const historical = batch.kind === "historical";
  const products = getBatchProducts(batch).map((product) => ({
    ...product,
    variant: state.variants.some((candidate) => candidate.id === product.variantId)
      ? structuredClone(state.variants.find((candidate) => candidate.id === product.variantId))
      : null,
    version: state.versions.some((candidate) => candidate.id === product.versionId)
      ? structuredClone(state.versions.find((candidate) => candidate.id === product.versionId))
      : null,
  }));
  const rows = batch.rows.map((row) => {
    if (historical) {
      return {
        ...structuredClone(row),
        photos: [],
        issues: [],
        history: [],
      };
    }
    const product = getBatchRowProduct(batch, row);
    const rowVariant = product ? state.variants.find((candidate) => candidate.id === product.variantId) : null;
    const rate = row.defectiveQty == null || row.inspectedQty === 0
      ? null
      : Number(((row.defectiveQty / row.inspectedQty) * 100).toFixed(2));
    const photos = row.photoIds.map((assetId) => state.assets.find((asset) => asset.id === assetId)).filter(Boolean).map((asset) => structuredClone(asset));
    const issues = state.issues.filter((issue) => issue.batchId === batch.id && issue.rowId === row.id).map((issue) => structuredClone(issue));
    const history = state.batches
      .filter((candidate) => candidate.id !== batch.id && candidate.kind !== "historical" &&
        factoryKey(candidate.factory) === factoryKey(batch.factory) && candidate.stage === batch.stage &&
        (candidate.date < batch.date || (candidate.date === batch.date && candidate.createdAt < batch.createdAt)))
      .flatMap((candidate) => {
        const historicalRow = candidate.rows.find((candidateRow) => {
          const candidateProduct = getBatchRowProduct(candidate, candidateRow);
          return candidateProduct?.variantId === product?.variantId && candidateRow.key === row.key &&
            candidateRow.savedAt !== null && candidateRow.defectiveQty !== null;
        });
        if (!historicalRow) return [];
        const rate = historicalRow.inspectedQty === 0
          ? null
          : Number(((historicalRow.defectiveQty / historicalRow.inspectedQty) * 100).toFixed(2));
        const historicalProduct = getBatchRowProduct(candidate, historicalRow);
        return [{
          batchId: candidate.id,
          batchNumber: candidate.number,
          date: candidate.date,
          versionLabel: historicalProduct?.versionLabel ?? null,
          inspectedQty: historicalRow.inspectedQty,
          defectiveQty: historicalRow.defectiveQty,
          rate,
          savedAt: historicalRow.savedAt,
        }];
      })
      .sort((left, right) => right.date.localeCompare(left.date) || right.savedAt.localeCompare(left.savedAt))
      .slice(0, 4);
    return {
      ...structuredClone(row),
      productLineId: product?.lineId ?? row.productLineId ?? null,
      variantId: product?.variantId ?? null,
      productLabel: rowVariant?.label ?? null,
      productQuantity: product?.quantity ?? null,
      versionId: product?.versionId ?? null,
      versionLabel: product?.versionLabel ?? null,
      defectiveRate: rate,
      photos,
      issues,
      history,
    };
  });
  const inspection = historical
    ? state.history?.inspections?.find((candidate) => candidate.id === batch.historyInspectionId)
    : null;
  const source = inspection
    ? state.history.sources.find((candidate) => candidate.id === inspection.sourceId)
    : null;
  const sourceAssetId = source?.assetId ?? null;
  const attachments = (batch.attachmentIds ?? [])
    .map((assetId) => state.assets.find((asset) => asset.id === assetId))
    .filter(Boolean)
    .map((asset) => ({ ...structuredClone(asset), sourcePdf: asset.id === sourceAssetId }));
  return {
    batch: structuredClone(batch),
    displayNumber: resolveBatchDisplayNumbers(state).get(batch.id),
    variant: variant ? structuredClone(variant) : null,
    version: version ? structuredClone(version) : null,
    order: order ? structuredClone(order) : null,
    products,
    rows,
    attachments,
    releaseBlockers: batch.status === "released" && !historical ? [] : batchReleaseBlockers(state, batch),
  };
}
