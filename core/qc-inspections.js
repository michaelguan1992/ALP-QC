import {
  fail,
  factoryKey,
  makeId,
  normalizeFactory,
  normalizeStage,
  requireArray,
  requireBoolean,
  requireDate,
  requireNonNegativeInteger,
  requirePositiveInteger,
  requireString,
} from "./qc-domain.js";
import { latestPublishedVersion, selectApplicableItems } from "./qc-standards.js";
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
  if (batch.countForPO) {
    const duplicate = state.batches.find((candidate) => candidate.id !== batch.id && candidate.variantId === batch.variantId && candidate.lotNumber.toLocaleLowerCase() === batch.lotNumber.toLocaleLowerCase() && candidate.status === "released" && candidate.countForPO);
    if (duplicate) blockers.push(`Lot ${batch.lotNumber} is already counted in released batch ${duplicate.number}.`);
  }
  return blockers;
}

export function createBatch(state, data, context) {
  const number = requireString(data.number, "Batch number", { maxLength: 160 });
  if (state.batches.some((batch) => batch.number.toLocaleLowerCase() === number.toLocaleLowerCase())) fail("Batch number must be unique.");
  const order = state.orders.find((candidate) => candidate.id === data.orderId);
  if (!order) fail("Choose an available purchase order.");
  const line = order.lines.find((candidate) => candidate.id === data.lineId);
  if (!line) fail("Choose a purchase order line from the selected order.");
  const variant = state.variants.find((candidate) => candidate.id === line.variantId);
  if (!variant) fail("The selected purchase order line has no available product variant.");
  if (!variant.active) fail("Reactivate the product variant before creating a new batch.");
  const family = state.families.find((candidate) => candidate.id === variant.familyId);
  const quantity = requirePositiveInteger(data.quantity, "Batch quantity");
  const factory = normalizeFactory(data.factory);
  if (!factory) fail("Factory is required.");
  const stage = normalizeStage(data.stage);
  if (!stage) fail("Inspection stage must be IQC or OQC.");
  if (factory === "AP" && stage === "IQC") fail("AP batches are OQC only; AP IQC batches cannot be created.");
  const lotNumber = requireString(data.lotNumber, "Physical lot number", { maxLength: 160 });
  const countForPO = requireBoolean(data.countForPO, "Final-shipment PO counting flag");
  if (countForPO && stage !== "OQC") fail("Only OQC batches can count released quantity toward a purchase order.");

  let version;
  if (data.versionId == null || String(data.versionId).trim() === "") {
    version = latestPublishedVersion(state, family.id);
    if (!version) fail(`Publish a design version for ${family.name} before creating a batch.`);
  } else {
    version = state.versions.find((candidate) => candidate.id === data.versionId);
    if (!version || version.familyId !== family.id || version.status !== "published") {
      fail("Choose a published design version from the selected product family.");
    }
  }
  const applicableItems = selectApplicableItems(version, factory, stage, variant.model);
  if (!applicableItems.length) fail(`Version ${version.label} has no ${factory} ${stage} standards applicable to ${variant.model}.`);

  const id = makeId(context.idFactory);
  const rows = applicableItems.map((item) => ({
    ...structuredClone(item),
    inspectedQty: Math.ceil(quantity * item.samplingPercent / 100),
    defectiveQty: null,
    remarks: "",
    savedAt: null,
    photoIds: [],
  }));
  state.batches.push({
    id,
    kind: "operational",
    number,
    orderId: order.id,
    lineId: line.id,
    variantId: variant.id,
    familyId: family.id,
    quantity,
    factory,
    stage,
    lotNumber,
    countForPO,
    versionId: version.id,
    versionLabel: version.label,
    date: requireDate(data.date, "Batch date"),
    recorder: requireString(data.recorder ?? "", "Recorder", { maxLength: 200, allowBlank: true }),
    notes: requireString(data.notes ?? "", "Batch notes", { maxLength: 5000, allowBlank: true }),
    status: "draft",
    rows,
    attachmentIds: [],
    createdAt: context.now(),
    releasedAt: null,
  });
  return { entityId: id, action: "createBatch", summary: `Created draft batch ${number} using locked version ${version.label}.` };
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
  const rows = batch.rows.map((row) => {
    if (historical) {
      return {
        ...structuredClone(row),
        photos: [],
        issues: [],
        history: [],
      };
    }
    const rate = row.defectiveQty == null || row.inspectedQty === 0
      ? null
      : Number(((row.defectiveQty / row.inspectedQty) * 100).toFixed(2));
    const photos = row.photoIds.map((assetId) => state.assets.find((asset) => asset.id === assetId)).filter(Boolean).map((asset) => structuredClone(asset));
    const issues = state.issues.filter((issue) => issue.batchId === batch.id && issue.rowId === row.id).map((issue) => structuredClone(issue));
    const history = state.batches
      .filter((candidate) => candidate.id !== batch.id && candidate.variantId === batch.variantId &&
        factoryKey(candidate.factory) === factoryKey(batch.factory) && candidate.stage === batch.stage &&
        (candidate.date < batch.date || (candidate.date === batch.date && candidate.createdAt < batch.createdAt)))
      .flatMap((candidate) => {
        const historicalRow = candidate.rows.find((candidateRow) => candidateRow.key === row.key && candidateRow.savedAt !== null && candidateRow.defectiveQty !== null);
        if (!historicalRow) return [];
        const rate = historicalRow.inspectedQty === 0
          ? null
          : Number(((historicalRow.defectiveQty / historicalRow.inspectedQty) * 100).toFixed(2));
        return [{
          batchId: candidate.id,
          batchNumber: candidate.number,
          date: candidate.date,
          versionLabel: candidate.versionLabel,
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
    rows,
    attachments,
    releaseBlockers: batch.status === "released" && !historical ? [] : batchReleaseBlockers(state, batch),
  };
}
