import {
  ensureUnique,
  fail,
  factoryKey,
  makeId,
  normalizeDataUrl,
  normalizeFactory,
  normalizeStage,
  requireArray,
  requireDate,
  requireNonNegativeInteger,
  requirePositiveInteger,
  requireRecord,
  requireString,
} from "./qc-domain.js";
import { normalizeStandardItems, selectApplicableItems } from "./qc-standards.js";
import { getBatchVersionItems, getBatchVersionReadiness, getBatchVersions, getSharedBatchVersionChoices } from "./qc-batch-versions.js";
import { getBatchProducts, getBatchRowProduct } from "./qc-batch-products.js";
import { normalizeBatchDisplayNumber, resolveBatchDisplayNumbers } from "./qc-batch-display.js";
import { resolveInspectionImportance } from "./qc-inspection-importance.js";

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

const ASSET_METADATA_FIELDS = [
  "id", "name", "mimeType", "kind", "batchId", "rowId", "versionId", "createdAt", "issueId", "category",
];

function assetMetadata(asset, includeAssetContent) {
  if (includeAssetContent) return structuredClone(asset);
  const metadata = Object.fromEntries(ASSET_METADATA_FIELDS
    .filter((field) => Object.hasOwn(asset, field))
    .map((field) => [field, asset[field]]));
  if (Number.isSafeInteger(asset.decodedBytes)) metadata.decodedBytes = asset.decodedBytes;
  else if (typeof asset.dataUrl === "string") metadata.decodedBytes = normalizeDataUrl(asset.dataUrl, "Stored attachment").decodedBytes;
  if (Number.isSafeInteger(asset.contentRevision)) metadata.contentRevision = asset.contentRevision;
  return metadata;
}

export function batchReleaseBlockers(state, batch) {
  if (batch.kind === "historical") return ["Historical inspection records cannot be released."];
  const blockers = [];
  const incomplete = batch.rows.filter((row) => row.savedAt === null || row.defectiveQty === null ||
    (Object.hasOwn(row, "actualTimeSeconds") && row.actualTimeSeconds === null));
  if (incomplete.length) blockers.push(`Complete all ${batch.rows.length} inspection rows before release; ${incomplete.length} remain incomplete.`);
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
    if (duplicate) blockers.push(`Lot ${batch.lotNumber} is already counted in released batch ${resolveBatchDisplayNumbers(state).get(duplicate.id) ?? duplicate.number}.`);
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

function batchNumberKey(value) {
  return typeof value === "string" ? value.trim().normalize("NFKC").toLocaleLowerCase() : "";
}

function usedBatchDisplayNumbers(state) {
  const used = new Set();
  for (const batch of state.batches) {
    const key = batchNumberKey(batch.number);
    if (key) used.add(key);
  }
  for (const displayNumber of resolveBatchDisplayNumbers(state).values()) {
    const key = batchNumberKey(displayNumber);
    if (key) used.add(key);
  }
  return used;
}

function resolveNewBatchNumber(state, requestedNumber, products, date, factory, stage) {
  const explicitNumber = requestedNumber == null
    ? ""
    : requireString(requestedNumber, "Batch number", { maxLength: 160, allowBlank: true });
  const usedNumbers = usedBatchDisplayNumbers(state);
  if (explicitNumber) {
    if (usedNumbers.has(batchNumberKey(explicitNumber)) ||
        usedNumbers.has(batchNumberKey(normalizeBatchDisplayNumber(explicitNumber)))) {
      fail("Batch number must be unique.");
    }
    return explicitNumber;
  }

  const models = [...new Set(products.map((product) => normalizeBatchDisplayNumber(product.variant.model.trim())))]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const base = `${models.join("+")}-${date.replaceAll("-", "")}-${factory}-${stage}`;
  if (!usedNumbers.has(batchNumberKey(base))) return requireString(base, "Batch number", { maxLength: 160 });

  for (let suffix = 1; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const candidate = `${base}-${String(suffix).padStart(2, "0")}`;
    if (!usedNumbers.has(batchNumberKey(candidate))) return requireString(candidate, "Batch number", { maxLength: 160 });
  }
  fail("The system could not create a unique batch number.");
}

function requireActualTimeSeconds(value) {
  if (value == null || (typeof value === "string" && value.trim() === "")) {
    fail("Enter actual inspection time in seconds before saving this row.");
  }
  if (typeof value !== "number" && typeof value !== "string") {
    fail("Actual inspection time must be a number of seconds.");
  }
  const actualTimeSeconds = typeof value === "number" ? value : Number(value);
  if (typeof value === "string" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value.trim())) {
    fail("Actual inspection time must be a number of seconds.");
  }
  if (!Number.isFinite(actualTimeSeconds) || actualTimeSeconds < 0) {
    fail("Actual inspection time must be finite and zero or more seconds.");
  }
  return actualTimeSeconds;
}

export function createBatch(state, data, context) {
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
  const hasSharedVersionLabel = Object.hasOwn(data, "versionLabel");
  const sharedVersionLabel = hasSharedVersionLabel
    ? requireString(data.versionLabel, "Design version", { maxLength: 160 })
    : null;
  if (hasSharedVersionLabel && productInputs.length > 1 && data.versionId != null && String(data.versionId).trim()) {
    fail("A shared multi-product design version cannot use a single batch version ID.");
  }

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
    products.push({
      input,
      lineId: line.id,
      variantId: variant.id,
      familyId: family.id,
      quantity: productQuantity,
      variant,
      family,
    });
  }
  ensureUnique(products.map((product) => product.lineId), "Purchase order lines in a batch");
  const selectedModels = new Set(products.map((product) => product.variant.model));
  if (selectedModels.size > 1) fail("A batch can include product variants of one model only.");

  const sharedChoice = hasSharedVersionLabel
    ? getSharedBatchVersionChoices(state, products.map((product) => product.variantId), factory, stage)
      .find((choice) => choice.label === sharedVersionLabel)
    : null;
  if (hasSharedVersionLabel && !sharedChoice) {
    fail("Choose a shared design version that is ready for every selected product.");
  }
  for (const product of products) {
    const sharedVersionId = sharedChoice?.versions.find((entry) => entry.familyId === product.familyId)?.versionId;
    if (hasSharedVersionLabel) {
      const requestedId = product.input.versionId;
      if (requestedId != null && String(requestedId).trim() && String(requestedId).trim() !== sharedVersionId) {
        fail("A product version ID conflicts with the shared design version.");
      }
      if (productInputs.length === 1 && data.versionId != null && String(data.versionId).trim() && String(data.versionId).trim() !== sharedVersionId) {
        fail("The batch version ID conflicts with the shared design version.");
      }
    }
    const requestedVersionId = hasSharedVersionLabel ? sharedVersionId : product.input.versionId;
    const { version, applicableItems } = selectProductVersion(state, product.family, product.variant, factory, stage, requestedVersionId);
    product.versionId = version.id;
    product.versionLabel = version.label;
    product.version = version;
    product.lockedItems = normalizeStandardItems(applicableItems, product.family, context.idFactory, applicableItems);
    delete product.input;
  }

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
  const date = requireDate(data.date, "Batch date");
  const recorder = requireString(data.recorder ?? "", "Recorder", { maxLength: 200, allowBlank: true });
  const notes = requireString(data.notes ?? "", "Batch notes", { maxLength: 5000, allowBlank: true });
  const number = resolveNewBatchNumber(state, data.number, products, date, factory, stage);

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
    actualTimeSeconds: null,
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
    versionLabel: firstProduct?.versionLabel ?? sharedVersionLabel ?? null,
    date,
    recorder,
    notes,
    status: "draft",
    rows,
    attachmentIds: [],
    createdAt: context.now(),
    releasedAt: null,
  };
  if (multiProduct) batch.products = productRecords;
  else if (legacyLotNumber !== null) batch.lotNumber = legacyLotNumber;
  state.batches.push(batch);
  const versionSummary = sharedVersionLabel
    ? ` using shared design version ${sharedVersionLabel}`
    : firstProduct
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

export function saveBatchChanges(state, data, context) {
  const batch = requireBatch(state, data.batchId);
  requireEditableBatch(batch);
  const rowInputs = requireArray(data.rows, "Inspection row changes");
  if (rowInputs.length > batch.rows.length) fail("A batch save cannot include more rows than the batch contains.");

  let detailsChanged = false;
  if (Object.hasOwn(data, "details")) {
    const details = requireRecord(data.details, "Batch details");
    const nextDetails = {
      date: requireDate(details.date, "Batch date"),
      recorder: requireString(details.recorder ?? "", "Recorder", { maxLength: 200, allowBlank: true }),
      notes: requireString(details.notes ?? "", "Batch notes", { maxLength: 5000, allowBlank: true }),
    };
    detailsChanged = batch.date !== nextDetails.date || batch.recorder !== nextDetails.recorder || batch.notes !== nextDetails.notes;
    Object.assign(batch, nextDetails);
  }

  const seenRowIds = new Set();
  let changedRows = 0;
  for (const [index, rowInput] of rowInputs.entries()) {
    requireRecord(rowInput, `Inspection row change ${index + 1}`);
    const rowId = requireString(rowInput.rowId, `Inspection row change ${index + 1} ID`, { maxLength: 120 });
    if (seenRowIds.has(rowId)) fail("A batch save cannot include the same inspection row more than once.");
    seenRowIds.add(rowId);
    const outcome = autosaveInspection(state, { ...rowInput, batchId: batch.id, rowId }, context);
    if (outcome.changed !== false) changedRows += 1;
  }

  if (!detailsChanged && changedRows === 0) {
    return {
      entityId: batch.id,
      changed: false,
      action: "saveBatchChanges",
      summary: `Batch ${batch.number} already has those details and inspection results.`,
    };
  }

  const updated = [];
  if (detailsChanged) updated.push("batch details");
  if (changedRows > 0) updated.push(`${changedRows} inspection row${changedRows === 1 ? "" : "s"}`);
  return {
    entityId: batch.id,
    action: "saveBatchChanges",
    summary: `Saved ${updated.join(" and ")} for batch ${batch.number}.`,
  };
}

export function deleteBatch(state, data) {
  const batch = requireBatch(state, data.id);
  if (batch.kind === "historical") fail("Historical inspection records cannot be deleted.");
  if (batch.status !== "draft") fail("Released batches cannot be deleted.");

  const linkedIssue = state.issues.find((issue) => issue.batchId === batch.id || issue.sourceSnapshot?.batchId === batch.id);
  if (linkedIssue) fail("Delete is unavailable while this batch has linked issue records.");

  const photoIds = new Set(batch.rows.flatMap((row) => Array.isArray(row.photoIds) ? row.photoIds : []));
  const referencedSnapshot = state.issues.some((issue) => issue.sourceSnapshot?.batchId === batch.id ||
    (issue.sourceSnapshot?.row?.photoIds ?? []).some((assetId) => photoIds.has(assetId)));
  if (referencedSnapshot) fail("Delete is unavailable while saved issue evidence refers to this batch.");

  const number = batch.number;
  state.batches = state.batches.filter((candidate) => candidate.id !== batch.id);
  state.assets = state.assets.filter((asset) => !(asset.batchId === batch.id && ["photo", "rowAttachment"].includes(asset.kind)));
  return {
    entityId: batch.id,
    action: "deleteBatch",
    summary: `Deleted draft batch ${number}.`,
  };
}

export function saveInspection(state, data, context) {
  const batch = requireBatch(state, data.batchId);
  requireEditableBatch(batch);
  if (Object.hasOwn(data, "inspectedQty")) fail("Inspection quantity is calculated from the batch and standard and cannot be entered.");
  const rowId = requireString(data.rowId, "Inspection row ID", { maxLength: 120 });
  const row = batch.rows.find((candidate) => candidate.id === rowId);
  if (!row) fail("That inspection row is not part of this batch.");
  const actualTimeSeconds = requireActualTimeSeconds(data.actualTimeSeconds);
  if (data.defectiveQty == null || String(data.defectiveQty).trim() === "") fail("Enter a defective quantity before saving this row.");
  if (typeof data.defectiveQty !== "number" && typeof data.defectiveQty !== "string") fail("Defective quantity must be a number.");
  const defectiveQty = typeof data.defectiveQty === "number" ? data.defectiveQty : Number(data.defectiveQty);
  if (typeof data.defectiveQty === "string" && !/^\d+(?:\.\d+)?$/.test(data.defectiveQty.trim())) fail("Defective quantity must be a whole number of zero or more.");
  requireNonNegativeInteger(defectiveQty, "Defective quantity");
  if (defectiveQty > row.inspectedQty) fail("Defective quantity cannot exceed inspection quantity.");
  const remarks = requireString(data.remarks ?? "", "Inspection remarks", { maxLength: 5000, allowBlank: true });
  row.defectiveQty = defectiveQty;
  row.actualTimeSeconds = actualTimeSeconds;
  row.remarks = remarks;
  row.savedAt = context.now();
  return { entityId: batch.id, action: "saveInspection", summary: `Saved inspection row ${row.title} for batch ${batch.number}.` };
}

export function autosaveInspection(state, data, context) {
  const batch = requireBatch(state, data.batchId);
  requireEditableBatch(batch);
  if (Object.hasOwn(data, "inspectedQty")) fail("Inspection quantity is calculated from the batch and standard and cannot be entered.");
  const rowId = requireString(data.rowId, "Inspection row ID", { maxLength: 120 });
  const row = batch.rows.find((candidate) => candidate.id === rowId);
  if (!row) fail("That inspection row is not part of this batch.");
  for (const field of ["defectiveQty", "remarks"]) {
    if (!Object.hasOwn(data, field)) fail(`Inspection autosave requires ${field}.`);
  }
  const hasActualTime = Object.hasOwn(data, "actualTimeSeconds");
  if (!hasActualTime && Object.hasOwn(row, "actualTimeSeconds")) {
    fail("Inspection autosave requires actualTimeSeconds for this row.");
  }

  const defectiveQty = data.defectiveQty;
  if (defectiveQty !== null) {
    if (typeof defectiveQty !== "number") fail("Defective quantity must be a whole number of zero or more, or blank.");
    requireNonNegativeInteger(defectiveQty, "Defective quantity");
    if (defectiveQty > row.inspectedQty) fail("Defective quantity cannot exceed inspection quantity.");
  }

  const actualTimeSeconds = hasActualTime ? data.actualTimeSeconds : undefined;
  if (hasActualTime && actualTimeSeconds !== null && (typeof actualTimeSeconds !== "number" || !Number.isFinite(actualTimeSeconds) || actualTimeSeconds < 0)) {
    fail("Actual inspection time must be finite and zero or more seconds, or blank.");
  }
  const remarks = requireString(data.remarks, "Inspection remarks", { maxLength: 5000, allowBlank: true });
  const nextHasActualTime = hasActualTime || Object.hasOwn(row, "actualTimeSeconds");
  const complete = defectiveQty !== null && (!nextHasActualTime || actualTimeSeconds !== null);
  const sameActualTime = hasActualTime
    ? row.actualTimeSeconds === actualTimeSeconds
    : !Object.hasOwn(row, "actualTimeSeconds");
  if (row.defectiveQty === defectiveQty && sameActualTime && row.remarks === remarks &&
      (row.savedAt !== null) === complete) {
    return { entityId: batch.id, changed: false, action: "autosaveInspection", summary: `Inspection row ${row.title} for batch ${batch.number} was already up to date.` };
  }

  row.defectiveQty = defectiveQty;
  if (hasActualTime) row.actualTimeSeconds = actualTimeSeconds;
  row.remarks = remarks;
  row.savedAt = complete ? context.now() : null;
  return { entityId: batch.id, action: "autosaveInspection", summary: `Autosaved inspection row ${row.title} for batch ${batch.number}.` };
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

export function getBatchWorkspace(state, batchId, { includeAssetContent = true } = {}) {
  const batch = requireBatch(state, batchId);
  const displayNumbers = resolveBatchDisplayNumbers(state);
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
    const attachmentIds = row.attachmentIds ?? {};
    const attachments = Object.fromEntries(["videos", "procedures", "log"].map((category) => {
      const assetId = attachmentIds[category] ?? null;
      const asset = assetId ? state.assets.find((candidate) => candidate.id === assetId) : null;
      return [category, asset ? assetMetadata(asset, includeAssetContent) : null];
    }));
    if (historical) {
      return {
        ...structuredClone(row),
        photos: [],
        attachments,
        issues: [],
        history: [],
      };
    }
    const product = getBatchRowProduct(batch, row);
    const rowVariant = product ? state.variants.find((candidate) => candidate.id === product.variantId) : null;
    const rate = row.defectiveQty == null || row.inspectedQty === 0
      ? null
      : Number(((row.defectiveQty / row.inspectedQty) * 100).toFixed(2));
    const photos = row.photoIds.map((assetId) => state.assets.find((asset) => asset.id === assetId)).filter(Boolean).map((asset) => assetMetadata(asset, includeAssetContent));
    const issues = state.issues.filter((issue) => issue.batchId === batch.id && issue.rowId === row.id).map((issue) => ({
      ...structuredClone(issue),
      attachments: (issue.attachmentIds ?? [])
        .map((assetId) => state.assets.find((asset) => asset.id === assetId))
        .filter(Boolean)
        .map((asset) => assetMetadata(asset, includeAssetContent)),
    }));
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
          batchNumber: displayNumbers.get(candidate.id) ?? normalizeBatchDisplayNumber(candidate.number),
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
      ...resolveInspectionImportance(state, batch, row),
      productLineId: product?.lineId ?? row.productLineId ?? null,
      variantId: product?.variantId ?? null,
      productLabel: rowVariant?.label ?? null,
      productQuantity: product?.quantity ?? null,
      versionId: product?.versionId ?? null,
      versionLabel: product?.versionLabel ?? null,
      defectiveRate: rate,
      photos,
      attachments,
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
    .map((asset) => ({ ...assetMetadata(asset, includeAssetContent), sourcePdf: asset.id === sourceAssetId }));
  return {
    batch: structuredClone(batch),
    displayNumber: displayNumbers.get(batch.id),
    variant: variant ? structuredClone(variant) : null,
    version: version ? structuredClone(version) : null,
    order: order ? structuredClone(order) : null,
    products,
    rows,
    attachments,
    releaseBlockers: batch.status === "released" && !historical ? [] : batchReleaseBlockers(state, batch),
  };
}
