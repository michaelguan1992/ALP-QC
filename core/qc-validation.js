import {
  ASSET_TOTAL_MAX_BYTES,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_MAX_BYTES,
  DANGEROUS_EXTENSIONS,
  DOCUMENT_MIMES,
  DOCUMENT_MAX_BYTES,
  ensureUnique,
  fail,
  factoryKey,
  MIME_EXTENSIONS,
  isIsoTimestamp,
  normalizeDataUrl,
  normalizeFactory,
  normalizeStage,
  PHOTO_MIMES,
  requireNonNegativeInteger,
  PHOTO_MAX_BYTES,
  requireDate,
  requirePositiveInteger,
  requireRecord,
  requireString,
  requireTimestamp,
  ROW_ATTACHMENT_CATEGORIES,
  stableStringify,
  TEXT_EXTENSIONS,
  VIDEO_MIMES,
} from "./qc-domain.js";
import { normalizeStandardItems, selectApplicableItems } from "./qc-standards.js";
import { getBatchVersionItems, getBatchVersionReadiness } from "./qc-batch-versions.js";
import { getBatchProducts, getBatchRowProduct } from "./qc-batch-products.js";
import { validateHistoryState } from "./qc-history.js";
import { createHistoricalBatch, historicalResultValues, historicalSourceResultValues } from "./qc-historical-batches.js";
import { validateVersionMergeEvidence } from "./qc-version-merge.js";

const MAX_ASSET_VALIDATION_CACHE_CHARS = Math.ceil(ASSET_TOTAL_MAX_BYTES * 4 / 3) + 1024;

function assert(condition, message) {
  if (!condition) fail(message);
}

function assertText(value, label, options) {
  requireString(value, label, options);
}

function assertUniqueIds(records, label, maxLength = 120) {
  for (const record of records) {
    requireRecord(record, label);
    assertText(record.id, `${label} ID`, { maxLength });
  }
  ensureUnique(records.map((record) => record.id), `${label} IDs`);
}

function familyMap(state) {
  return new Map(state.families.map((family) => [family.id, family]));
}

function assetMap(state) {
  return new Map(state.assets.map((asset) => [asset.id, asset]));
}

function versionMap(state) {
  return new Map(state.versions.map((version) => [version.id, version]));
}

function batchMap(state) {
  return new Map(state.batches.map((batch) => [batch.id, batch]));
}

function validateFamiliesAndVariants(state) {
  assert(state.families.length === 2, "QC state must contain the two predefined inspection families.");
  const expectedFamilies = new Map([
    ["s11-s14", ["S11", "S12", "S13", "S14"]],
    ["s15", ["S15"]],
  ]);
  assertUniqueIds(state.families, "Inspection family");
  for (const family of state.families) {
    const expectedModels = expectedFamilies.get(family.id);
    assert(expectedModels, "QC state contains an unsupported inspection family.");
    assertText(family.name, "Inspection family name", { maxLength: 160 });
    assert(Array.isArray(family.models), "Inspection family models must be a list.");
    assert(JSON.stringify([...family.models].sort()) === JSON.stringify([...expectedModels].sort()), `Inspection family ${family.id} has an invalid model set.`);
  }
  const families = familyMap(state);
  assertUniqueIds(state.variants, "Product variant");
  for (const variant of state.variants) {
    const family = families.get(variant.familyId);
    assert(family, `Variant ${variant.id} refers to an unknown inspection family.`);
    assert(family.models.includes(variant.model), `Variant ${variant.id} refers to a model outside its family.`);
    assertText(variant.color, "Variant color", { maxLength: 80 });
    assertText(variant.label, "Variant label", { maxLength: 160 });
    assert(typeof variant.active === "boolean", "Variant active state must be boolean.");
  }
  const variantKeys = state.variants.map((variant) => `${variant.familyId}|${variant.model}|${variant.color.toLocaleLowerCase()}|${variant.label.toLocaleLowerCase()}`);
  ensureUnique(variantKeys, "Product variant identity");
  const seedVariantIds = [
    "10000000-0000-4000-8000-000000000111", "10000000-0000-4000-8000-000000000112",
    "10000000-0000-4000-8000-000000000121", "10000000-0000-4000-8000-000000000122",
    "10000000-0000-4000-8000-000000000131", "10000000-0000-4000-8000-000000000132",
    "10000000-0000-4000-8000-000000000141", "10000000-0000-4000-8000-000000000142",
    "10000000-0000-4000-8000-000000000151", "10000000-0000-4000-8000-000000000152",
  ];
  for (const id of seedVariantIds) assert(state.variants.some((variant) => variant.id === id), `Predefined product variant ${id} is missing.`);
}

const LARK_REVISION_FIELDS = Object.freeze({
  label: "版本号 Revision",
  effectiveAt: "生效日期 Effective Date",
  status: "是否当前生效 Revision Status",
  description: "变更内容说明 Change Description",
  attachments: "图纸/附件 Engineering Drawing",
  specs: "③QC规范 Spec Items",
});

function assertJsonValue(value, label, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    assert(Number.isFinite(value), `${label} contains a non-finite number.`);
    return;
  }
  assert(typeof value === "object", `${label} must contain only JSON values.`);
  assert(!seen.has(value), `${label} cannot contain a cycle.`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, label, seen);
  } else {
    assert(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
      `${label} must contain plain objects.`);
    for (const item of Object.values(value)) assertJsonValue(item, label, seen);
  }
  seen.delete(value);
}

function validateRecordedVersion(version) {
  assert(version.sequence === null, `Recorded version ${version.id} cannot use an operational sequence.`);
  assert(version.effectiveDate === null, `Recorded version ${version.id} must keep the source timestamp in its provenance.`);
  assert(version.createdAt === null, `Recorded version ${version.id} cannot claim an application creation time.`);
  assert(version.publishedAt === null, `Recorded version ${version.id} cannot have a publication time.`);
  assert(Array.isArray(version.items) && version.items.length === 0, `Recorded version ${version.id} cannot contain operational standards.`);
  assertText(version.label, "Recorded version label", { maxLength: 160, allowBlank: true });
  assert(Array.isArray(version.sourceRows), `Recorded version ${version.id} source rows must be a list.`);

  const source = requireRecord(version.source, `Recorded version ${version.id} source provenance`);
  assert(source.kind === "lark-version-record", `Recorded version ${version.id} has unsupported source provenance.`);
  assertText(source.packageType, "Source package type", { maxLength: 100 });
  requirePositiveInteger(source.packageSchemaVersion, "Source package schema version");
  requireRecord(source.capturedAt, "Source package capture context");
  assertText(source.system, "Source system", { maxLength: 100 });
  assertText(source.tableId, "Source table ID", { maxLength: 120 });
  assertText(source.recordId, "Source record ID", { maxLength: 120 });
  if (source.tableUrl !== null) {
    assertText(source.tableUrl, "Source table URL", { maxLength: 2000 });
    let sourceUrl;
    try { sourceUrl = new URL(source.tableUrl); } catch { fail("Source table URL must be an absolute HTTP or HTTPS URL."); }
    assert(sourceUrl.protocol === "http:" || sourceUrl.protocol === "https:", "Source table URL must use HTTP or HTTPS.");
  }
  assert(Array.isArray(source.applicableProductIds) && source.applicableProductIds.length > 0,
    `Recorded version ${version.id} must retain its applicable source products.`);
  ensureUnique(source.applicableProductIds, `Applicable source products for ${version.id}`);
  assert(Array.isArray(source.familyProductFacts), `Recorded version ${version.id} must retain its family product mapping.`);
  const familyProductIds = new Set(source.familyProductFacts.map((product) => product.sourceRecordId));
  assert(source.applicableProductIds.every((productId) => familyProductIds.has(productId)),
    `Recorded version ${version.id} family product mapping is inconsistent.`);
  requireRecord(source.productFieldMapping, "Source product field mapping");
  requireRecord(source.exports, "Source export metadata");
  requireRecord(source.exports.revisions, "Revision export metadata");
  assert(source.exports.revisions.tableId === source.tableId, `Recorded version ${version.id} revision table metadata is inconsistent.`);

  const rawRecord = requireRecord(source.rawRecord, `Recorded version ${version.id} raw source record`);
  assert(rawRecord.record_id === source.recordId, `Recorded version ${version.id} raw source ID is inconsistent.`);
  const rawLabel = rawRecord[LARK_REVISION_FIELDS.label];
  assert(version.label === (typeof rawLabel === "string" ? rawLabel : ""), `Recorded version ${version.id} label differs from its source record.`);
  for (const [sourceKey, field] of [
    ["effectiveAtRaw", LARK_REVISION_FIELDS.effectiveAt],
    ["statusRaw", LARK_REVISION_FIELDS.status],
    ["changeDescriptionRaw", LARK_REVISION_FIELDS.description],
    ["attachmentsRaw", LARK_REVISION_FIELDS.attachments],
  ]) {
    assert(stableStringify(source[sourceKey]) === stableStringify(rawRecord[field]),
      `Recorded version ${version.id} ${sourceKey} differs from its raw source record.`);
  }
  assert(Array.isArray(source.anomalies), `Recorded version ${version.id} anomalies must be a list.`);
  assertJsonValue(source.capturedAt, `Recorded version ${version.id} capture context`);
  assertJsonValue(source.exports, `Recorded version ${version.id} export metadata`);
  assertJsonValue(source.familyProductFacts, `Recorded version ${version.id} family product facts`);
  assertJsonValue(source.productFieldMapping, `Recorded version ${version.id} product field mapping`);
  assertJsonValue(rawRecord, `Recorded version ${version.id} raw source record`);
  assertJsonValue(source.anomalies, `Recorded version ${version.id} anomalies`);

  const linkedSpecIds = new Set((Array.isArray(rawRecord[LARK_REVISION_FIELDS.specs]) ? rawRecord[LARK_REVISION_FIELDS.specs] : [])
    .map((item) => typeof item === "string" ? item : item?.id)
    .filter((id) => typeof id === "string"));
  const rowIds = [];
  for (const row of version.sourceRows) {
    requireRecord(row, `Recorded version ${version.id} source row`);
    assertText(row.sourceRecordId, "Inspection item ID", { maxLength: 120 });
    assert(linkedSpecIds.has(row.sourceRecordId), `Specification ${row.sourceRecordId} is not linked from recorded version ${version.id}.`);
    assert(Array.isArray(row.applicableProductIds) && row.applicableProductIds.length > 0,
      `Specification ${row.sourceRecordId} has no applicable source products.`);
    assert(row.applicableProductIds.every((productId) => source.applicableProductIds.includes(productId)),
      `Specification ${row.sourceRecordId} has products outside recorded version ${version.id}.`);
    const rawRow = requireRecord(row.rawRecord, `Specification ${row.sourceRecordId} raw record`);
    assert(rawRow.record_id === row.sourceRecordId, `Specification ${row.sourceRecordId} raw record ID is inconsistent.`);
    assertJsonValue(row, `Recorded version ${version.id} source row`);
    rowIds.push(row.sourceRecordId);
  }
  ensureUnique(rowIds, `Source specification IDs for ${version.id}`);
}

function validateVersions(state, families) {
  assertUniqueIds(state.versions, "Design version");
  const sequenceKeys = [];
  for (const version of state.versions) {
    const family = families.get(version.familyId);
    assert(family, `Version ${version.id} refers to an unknown inspection family.`);
    assertText(version.notes, "Version notes", { maxLength: 5000, allowBlank: true });
    if (version.status === "recorded") {
      validateRecordedVersion(version);
      continue;
    }
    assert(["draft", "published", "superseded"].includes(version.status), `Version ${version.id} has an invalid status.`);
    assertText(version.label, "Version label", { maxLength: 160 });
    assert(!Object.hasOwn(version, "sourceRows"), `Operational version ${version.id} cannot contain recorded source rows.`);
    requirePositiveInteger(version.sequence, "Version sequence");
    requireDate(version.effectiveDate, "Version effective date");
    requireTimestamp(version.createdAt, "Version created time");
    if (version.status === "published") requireTimestamp(version.publishedAt, "Version published time");
    else if (version.status === "draft") assert(version.publishedAt === null, `Draft version ${version.label} cannot have a publication time.`);
    else if (version.publishedAt !== null) requireTimestamp(version.publishedAt, "Superseded version publication time");
    normalizeStandardItems(version.items, family, () => fail("A persisted standard item is missing an ID."), version.items);
    sequenceKeys.push(`${version.familyId}|${version.sequence}`);
    if (version.status === "published" || (version.status === "superseded" && version.publishedAt !== null)) {
      const missingModels = family.models.filter((model) => !version.items.some((item) => item.models.length === 0 || item.models.includes(model)));
      assert(missingModels.length === 0, `Published version ${version.label} has no inspection items for ${missingModels.join(", ")}.`);
    }
  }
  ensureUnique(sequenceKeys, "Version sequence within a family");
}

function validateOrders(state, variants) {
  assertUniqueIds(state.orders, "Purchase order");
  ensureUnique(state.orders.map((order) => order.number.toLocaleLowerCase()), "Purchase order number");
  const lineIds = [];
  for (const order of state.orders) {
    assertText(order.number, "Purchase order number", { maxLength: 160 });
    requireDate(order.date, "Purchase order date");
    assertText(order.supplier, "Supplier", { maxLength: 300, allowBlank: true });
    assertText(order.notes, "Purchase order notes", { maxLength: 5000, allowBlank: true });
    requireTimestamp(order.createdAt, "Purchase order created time");
    assert(Array.isArray(order.lines) && order.lines.length > 0, `Purchase order ${order.number} must contain at least one line.`);
    const lineVariants = [];
    for (const line of order.lines) {
      assertText(line.id, "Purchase order line ID", { maxLength: 120 });
      assert(variants.has(line.variantId), `Purchase order line ${line.id} refers to an unknown variant.`);
      requirePositiveInteger(line.orderedQty, "Ordered quantity");
      lineIds.push(line.id);
      lineVariants.push(line.variantId);
    }
    ensureUnique(lineVariants, `Product variant on purchase order ${order.number}`);
  }
  ensureUnique(lineIds, "Purchase order line ID");
}

function validateBatchRow(row, batch, family, variant, assets, productQuantity = batch.quantity) {
  requirePositiveInteger(row.no, "Inspection item number");
  requireNonNegativeInteger(row.inspectedQty, "Calculated inspection quantity");
  assert(typeof row.samplingPercent === "number" && Number.isFinite(row.samplingPercent) && row.samplingPercent >= 0 && row.samplingPercent <= 100, "Batch row sampling percentage is invalid.");
  const expectedQty = Math.ceil(productQuantity * row.samplingPercent / 100);
  assert(row.inspectedQty === expectedQty, `Locked inspection quantity for ${row.title} is inconsistent with the batch basis.`);
  assert(row.defectiveQty === null || (Number.isSafeInteger(row.defectiveQty) && row.defectiveQty >= 0 && row.defectiveQty <= row.inspectedQty), `Defective quantity for ${row.title} is invalid.`);
  if (Object.hasOwn(row, "actualTimeSeconds")) {
    assert(row.actualTimeSeconds === null || (typeof row.actualTimeSeconds === "number" && Number.isFinite(row.actualTimeSeconds) && row.actualTimeSeconds >= 0),
      `Actual inspection time for ${row.title} must be null or a finite non-negative number.`);
  }
  assertText(row.remarks, "Inspection remarks", { maxLength: 5000, allowBlank: true });
  assert(Array.isArray(row.photoIds), "Inspection row photo IDs must be a list.");
  ensureUnique(row.photoIds, "Photo IDs on an inspection row");
  const complete = row.defectiveQty !== null &&
    (!Object.hasOwn(row, "actualTimeSeconds") || row.actualTimeSeconds !== null);
  assert((row.savedAt !== null) === complete, `Inspection row ${row.title} must have a saved time exactly when its required results are complete.`);
  if (row.savedAt !== null) {
    requireTimestamp(row.savedAt, "Inspection row saved time");
  }
  for (const assetId of row.photoIds) {
    const asset = assets.get(assetId);
    assert(asset && asset.kind === "photo" && asset.batchId === batch.id && asset.rowId === row.id, `Photo ${assetId} is not owned by this batch row.`);
  }
  if (Object.hasOwn(row, "attachmentIds")) {
    requireRecord(row.attachmentIds, `Attachments on inspection row ${row.id}`);
    assert(Object.keys(row.attachmentIds).every((category) => ROW_ATTACHMENT_CATEGORIES.has(category)),
      `Inspection row ${row.id} has an unsupported attachment category.`);
    const attachmentAssetIds = [];
    for (const category of ROW_ATTACHMENT_CATEGORIES) {
      assert(Object.hasOwn(row.attachmentIds, category), `Inspection row ${row.id} must preserve its ${category} attachment slot.`);
      const assetId = row.attachmentIds[category];
      assert(assetId === null || (typeof assetId === "string" && assetId.trim()), `Inspection row ${row.id} ${category} attachment ID must be null or text.`);
      if (assetId === null) continue;
      const asset = assets.get(assetId);
      assert(asset && asset.kind === "rowAttachment" && asset.batchId === batch.id && asset.rowId === row.id && asset.category === category,
        `Attachment ${assetId} is not owned by this inspection row category.`);
      attachmentAssetIds.push(assetId);
    }
    ensureUnique(attachmentAssetIds, `Attachments on inspection row ${row.id}`);
  }
  assert(row.models.length === 0 || row.models.includes(variant.model), `Batch row ${row.title} does not apply to ${variant.model}.`);
  assert(factoryKey(row.factory) === factoryKey(batch.factory) && row.stage === batch.stage, `Batch row ${row.title} does not apply to ${batch.factory} ${batch.stage}.`);
  assert(family.models.includes(variant.model), "Batch variant does not belong to its inspection family.");
}

function validateBatchAttachments(batch, assets) {
  if (!Object.hasOwn(batch, "attachmentIds")) return;
  assert(Array.isArray(batch.attachmentIds), `Batch ${batch.number} attachment IDs must be a list.`);
  ensureUnique(batch.attachmentIds, `Attachments on batch ${batch.number}`);
  for (const assetId of batch.attachmentIds) {
    const asset = assets.get(assetId);
    assert(asset && asset.kind === "document" && asset.batchId === null && asset.rowId === null,
      `Batch ${batch.number} attachment ${assetId} must refer to an unlinked library document.`);
  }
}

function validateHistoricalBatch(state, batch, assets) {
  assert(batch.kind === "historical", `Batch ${batch.number} has an invalid historical discriminator.`);
  requireString(batch.historyInspectionId, `Historical batch ${batch.number} inspection ID`, { maxLength: 160 });
  const inspection = state.history?.inspections?.find((candidate) => candidate.id === batch.historyInspectionId);
  assert(inspection && batch.id === inspection.id, `Historical batch ${batch.number} must use its source inspection ID.`);
  const source = state.history.sources.find((candidate) => candidate.id === inspection.sourceId);
  assert(source, `Historical batch ${batch.number} refers to missing PDF evidence.`);
  const expected = createHistoricalBatch(inspection, source, batch.createdAt);
  const actualWithoutGeneratedFields = structuredClone(batch);
  const expectedWithoutGeneratedFields = structuredClone(expected);
  delete actualWithoutGeneratedFields.createdAt;
  delete expectedWithoutGeneratedFields.createdAt;
  delete actualWithoutGeneratedFields.attachmentIds;
  delete expectedWithoutGeneratedFields.attachmentIds;
  for (const projection of [actualWithoutGeneratedFields, expectedWithoutGeneratedFields]) {
    for (const row of projection.rows ?? []) {
      delete row.inspectedQty;
      delete row.defectiveQty;
      delete row.actualTimeSeconds;
      delete row.attachmentIds;
    }
  }
  assert(stableStringify(actualWithoutGeneratedFields) === stableStringify(expectedWithoutGeneratedFields),
    `Historical batch ${batch.number} disagrees with its preserved source inspection evidence.`);
  for (const [index, row] of batch.rows.entries()) {
    const sourceRow = inspection.rows[index];
    const resultValues = historicalResultValues(row, sourceRow);
    const sourceResultValues = historicalSourceResultValues(sourceRow);
    const countsEdited = resultValues.inspectedQty !== sourceResultValues.inspectedQty ||
      resultValues.defectiveQty !== sourceResultValues.defectiveQty;
    if (Object.hasOwn(row, "inspectedQty")) {
      assert(row.inspectedQty === null || (Number.isSafeInteger(row.inspectedQty) && row.inspectedQty >= 0),
        `Historical batch ${batch.number} has an invalid edited inspection quantity.`);
    }
    if (!Object.is(row.defectiveQty, sourceRow.defectiveQty)) {
      assert(row.defectiveQty === null || (Number.isSafeInteger(row.defectiveQty) && row.defectiveQty >= 0),
        `Historical batch ${batch.number} has an invalid edited defective quantity.`);
    }
    if (Object.hasOwn(row, "actualTimeSeconds")) {
      assert(row.actualTimeSeconds === null || (typeof row.actualTimeSeconds === "number" && Number.isFinite(row.actualTimeSeconds) && row.actualTimeSeconds >= 0),
        `Historical batch ${batch.number} has an invalid edited inspection time.`);
    }
    if (countsEdited && resultValues.inspectedQty !== null && resultValues.defectiveQty !== null) {
      assert(resultValues.defectiveQty <= resultValues.inspectedQty,
        `Historical batch ${batch.number} has edited defective quantity above inspection quantity.`);
    }
    if (Object.hasOwn(row, "attachmentIds")) {
      requireRecord(row.attachmentIds, `Attachments on historical inspection row ${row.id}`);
      assert(Object.keys(row.attachmentIds).every((category) => ROW_ATTACHMENT_CATEGORIES.has(category)),
        `Historical inspection row ${row.id} has an unsupported attachment category.`);
      const attachmentIds = [];
      for (const category of ROW_ATTACHMENT_CATEGORIES) {
        assert(Object.hasOwn(row.attachmentIds, category), `Historical inspection row ${row.id} must preserve its ${category} attachment slot.`);
        const assetId = row.attachmentIds[category];
        assert(assetId === null || (typeof assetId === "string" && assetId.trim()),
          `Historical inspection row ${row.id} ${category} attachment ID must be null or text.`);
        if (assetId === null) continue;
        const asset = assets.get(assetId);
        assert(asset && asset.kind === "rowAttachment" && asset.batchId === batch.id && asset.rowId === row.id && asset.category === category,
          `Attachment ${assetId} is not owned by historical inspection row ${row.id}.`);
        attachmentIds.push(assetId);
      }
      ensureUnique(attachmentIds, `Attachments on historical inspection row ${row.id}`);
    }
  }
  requireTimestamp(batch.createdAt, "Historical batch created time");
  assert(Array.isArray(batch.attachmentIds) && batch.attachmentIds.includes(source.assetId),
    `Historical batch ${batch.number} must retain its original PDF attachment.`);
  validateBatchAttachments(batch, assets);
}

function validateProductRows(batch, product, family, variant, version, assets) {
  const productRows = batch.rows.filter((row) => row.productLineId === product.lineId);
  assert(productRows.length > 0, `Batch ${batch.number} product line ${product.lineId} must contain inspection rows.`);
  assert(productRows.every((row) => typeof row.sourceItemId === "string" && row.sourceItemId.trim()),
    `Batch ${batch.number} rows must preserve their source standard item IDs.`);
  const normalizedLockedRows = normalizeStandardItems(
    productRows.map((row) => ({ ...row, id: row.sourceItemId })),
    family,
    () => fail("A locked inspection row is missing its source standard ID."),
    productRows,
  );
  const readiness = getBatchVersionReadiness(version, batch.factory, batch.stage, variant.model);
  assert(readiness.ready, `Batch ${batch.number} uses incomplete inspection standards. ${readiness.message}`);
  const projectedVersion = { ...version, items: getBatchVersionItems(version) };
  const applicableSourceItems = selectApplicableItems(projectedVersion, batch.factory, batch.stage, variant.model);
  const sourceItems = normalizeStandardItems(applicableSourceItems, family,
    () => fail("A projected inspection standard is incomplete."), applicableSourceItems);
  assert(sourceItems.length === productRows.length, `Batch ${batch.number} rows do not match its product version applicability.`);
  const standardFields = ["id", "key", "no", "title", "titleZh", "specification", "specificationZh", "devices", "factory", "stage", "models", "samplingPercent", "recordingRule", "important", "timeSeconds", "procedureUrl"];
  for (let index = 0; index < sourceItems.length; index += 1) {
    assert(normalizedLockedRows[index].id === sourceItems[index].id,
      `Batch ${batch.number} row ${index + 1} changed its source standard item ID.`);
    const expected = Object.fromEntries(standardFields.map((field) => [field, sourceItems[index][field]]));
    const actual = Object.fromEntries(standardFields.map((field) => [field,
      field === "id" ? productRows[index].sourceItemId : productRows[index][field]]));
    assert(stableStringify(actual) === stableStringify(expected),
      `Batch ${batch.number} locked standard row ${index + 1} differs from product line ${product.lineId}'s version.`);
    assert(productRows[index].productLineId === product.lineId,
      `Batch ${batch.number} inspection row has the wrong product line.`);
    validateBatchRow(productRows[index], batch, family, variant, assets, product.quantity);
  }
}

function validateOperationalBatchFacts(state, batch) {
  assert(batch.kind === undefined || batch.kind === "operational", `Batch ${batch.number} has an unsupported kind.`);
  assert(!Object.hasOwn(batch, "historyInspectionId"), `Operational batch ${batch.number} cannot reference historical inspection evidence.`);
  requirePositiveInteger(batch.quantity, "Batch quantity");
  const factory = normalizeFactory(batch.factory);
  const stage = normalizeStage(batch.stage);
  assert(factory && factory === batch.factory, `Batch ${batch.number} factory is not normalized.`);
  assert(stage && stage === batch.stage, `Batch ${batch.number} stage is not normalized.`);
  if (factory === "AP" && stage === "IQC") fail("AP IQC batches are not supported.");
  assert(typeof batch.countForPO === "boolean", "PO-counting flag must be boolean.");
  if (batch.countForPO) assert(stage === "OQC", "Only OQC batches may count toward PO released quantity.");
  requireDate(batch.date, "Batch date");
  assertText(batch.recorder, "Recorder", { maxLength: 200, allowBlank: true });
  assertText(batch.notes, "Batch notes", { maxLength: 5000, allowBlank: true });
  assert(["draft", "released"].includes(batch.status), `Batch ${batch.number} has an invalid status.`);
  requireTimestamp(batch.createdAt, "Batch created time");
  assert(Array.isArray(batch.rows) && batch.rows.length > 0, `Batch ${batch.number} must contain applicable inspection rows.`);
  assertUniqueIds(batch.rows, `Inspection row in batch ${batch.number}`);
}

function validateLegacyBatch(state, batch, families, variants, orders, versions, assets, lots) {
  validateOperationalBatchFacts(state, batch);
  validateBatchAttachments(batch, assets);
  const order = orders.get(batch.orderId);
  assert(order, `Batch ${batch.number} refers to an unknown purchase order.`);
  const line = order.lines.find((candidate) => candidate.id === batch.lineId);
  assert(line, `Batch ${batch.number} refers to a line outside its purchase order.`);
  const variant = variants.get(batch.variantId);
  assert(variant && line.variantId === variant.id, `Batch ${batch.number} variant does not match its purchase order line.`);
  const family = families.get(batch.familyId);
  assert(family && family.id === variant.familyId, `Batch ${batch.number} family does not match its product variant.`);
  const version = versions.get(batch.versionId);
  assert(version && version.familyId === family.id && ["recorded", "published", "superseded"].includes(version.status), `Batch ${batch.number} must reference a recorded, published, or superseded version in its family.`);
  if (batch.lotNumber != null && batch.lotNumber !== "") assertText(batch.lotNumber, "Physical lot number", { maxLength: 160 });
  assertText(batch.versionLabel, "Locked version label", { maxLength: 160 });
  assert(batch.versionLabel === version.label, `Batch ${batch.number} version label does not match its immutable inspection version.`);
  const readiness = getBatchVersionReadiness(version, batch.factory, batch.stage, variant.model);
  assert(readiness.ready, `Batch ${batch.number} uses incomplete inspection standards. ${readiness.message}`);
  const projectedVersion = { ...version, items: getBatchVersionItems(version) };
  const applicableSourceItems = selectApplicableItems(projectedVersion, batch.factory, batch.stage, variant.model);
  const sourceItems = normalizeStandardItems(applicableSourceItems, family, () => fail("A projected inspection standard is incomplete."), applicableSourceItems);
  assert(sourceItems.length === batch.rows.length, `Batch ${batch.number} rows do not match its published version applicability.`);
  const standardFields = ["id", "key", "no", "title", "titleZh", "specification", "specificationZh", "devices", "factory", "stage", "models", "samplingPercent", "recordingRule", "important", "timeSeconds", "procedureUrl"];
  for (let index = 0; index < sourceItems.length; index += 1) {
    const expected = Object.fromEntries(standardFields.map((field) => [field, sourceItems[index][field]]));
    const actual = Object.fromEntries(standardFields.map((field) => [field, batch.rows[index][field]]));
    assert(stableStringify(actual) === stableStringify(expected), `Batch ${batch.number} locked standard row ${index + 1} differs from its published version.`);
    validateBatchRow(batch.rows[index], batch, family, variant, assets);
  }
  if (batch.status === "released" && batch.countForPO && typeof batch.lotNumber === "string" && batch.lotNumber.trim()) {
    lots.push(`${variant.id}|${batch.lotNumber.trim().toLocaleLowerCase()}`);
  }
}

function validateProductBatch(state, batch, families, variants, orders, versions, assets, lots) {
  validateOperationalBatchFacts(state, batch);
  validateBatchAttachments(batch, assets);
  const order = orders.get(batch.orderId);
  assert(order, `Batch ${batch.number} refers to an unknown purchase order.`);
  assert(!Object.hasOwn(batch, "lotNumber"), `Product batch ${batch.number} cannot contain a physical lot number.`);
  assert(Array.isArray(batch.products) && batch.products.length > 0 && batch.products.length <= 500,
    `Batch ${batch.number} must contain between 1 and 500 product lines.`);
  ensureUnique(batch.products.map((product) => product?.lineId), `Product lines in batch ${batch.number}`);
  const products = [];
  let totalQuantity = 0;
  for (const product of batch.products) {
    requireRecord(product, `Batch ${batch.number} product`);
    const lineId = requireString(product.lineId, "Batch product purchase order line ID", { maxLength: 120 });
    const line = order.lines.find((candidate) => candidate.id === lineId);
    assert(line, `Batch ${batch.number} product refers to a line outside its purchase order.`);
    const variant = variants.get(product.variantId);
    assert(variant && line.variantId === variant.id, `Batch ${batch.number} product does not match its purchase order line.`);
    const family = families.get(product.familyId);
    assert(family && family.id === variant.familyId, `Batch ${batch.number} product family does not match its variant.`);
    const version = versions.get(product.versionId);
    assert(version && version.familyId === family.id && ["recorded", "published", "superseded"].includes(version.status),
      `Batch ${batch.number} product must reference a recorded, published, or superseded version in its family.`);
    requirePositiveInteger(product.quantity, "Batch product quantity");
    totalQuantity += product.quantity;
    assert(Number.isSafeInteger(totalQuantity), `Batch ${batch.number} total quantity must be a safe whole number.`);
    assertText(product.versionLabel, "Locked product version label", { maxLength: 160 });
    assert(product.versionLabel === version.label, `Batch ${batch.number} product version label does not match its immutable inspection version.`);
    products.push({ product, line, variant, family, version });
  }
  assert(totalQuantity === batch.quantity, `Batch ${batch.number} total quantity does not equal its product allocations.`);
  const topLevelFields = ["lineId", "variantId", "familyId", "versionId"];
  const onlyProduct = products.length === 1 ? products[0].product : null;
  for (const field of topLevelFields) {
    assert(batch[field] === (onlyProduct?.[field] ?? null),
      `Batch ${batch.number} top-level ${field} must reflect one product or be null for a mixed batch.`);
  }
  if (onlyProduct) {
    assert(batch.versionLabel === onlyProduct.versionLabel,
      `Batch ${batch.number} top-level version label must reflect its single product.`);
  } else if (batch.versionLabel === null) {
    // Legacy multi-product batches may retain independently selected versions.
  } else {
    assertText(batch.versionLabel, "Shared batch version label", { maxLength: 160 });
    assert(products.every(({ product }) => product.versionLabel === batch.versionLabel),
      `Batch ${batch.number} shared version label must match every product version label.`);
  }
  const lineIds = new Set(batch.products.map((product) => product.lineId));
  assert(batch.rows.every((row) => typeof row.productLineId === "string" && lineIds.has(row.productLineId)),
    `Batch ${batch.number} inspection rows must identify a product line.`);
  for (const { product, variant, family, version } of products) {
    validateProductRows(batch, product, family, variant, version, assets);
  }
}

function validateBatches(state, families, variants, orders, versions, assets) {
  assertUniqueIds(state.batches, "Batch", 160);
  ensureUnique(state.batches.map((batch) => batch.number.toLocaleLowerCase()), "Batch number");
  const lots = [];
  for (const batch of state.batches) {
    assertText(batch.number, "Batch number", { maxLength: 160 });
    if (batch.kind === "historical") {
      validateHistoricalBatch(state, batch, assets);
      continue;
    }
    if (Object.hasOwn(batch, "products")) {
      validateProductBatch(state, batch, families, variants, orders, versions, assets, lots);
    } else {
      validateLegacyBatch(state, batch, families, variants, orders, versions, assets, lots);
    }
    if (batch.status === "draft") assert(batch.releasedAt === null, `Draft batch ${batch.number} cannot have a release time.`);
    else {
      requireTimestamp(batch.releasedAt, "Batch release time");
      assert(batch.recorder.trim(), `Released batch ${batch.number} must have a recorder.`);
      assert(batch.rows.every((row) => row.savedAt !== null && row.defectiveQty !== null), `Released batch ${batch.number} must have all rows saved.`);
      assert(!state.issues.some((issue) => issue.batchId === batch.id && issue.status === "open"), `Released batch ${batch.number} cannot have open linked issues.`);
    }
  }
  ensureUnique(lots, "Released counting batch physical lot and variant");
}

/**
 * Content parsing is deterministic for an exact data URL. Keep a bounded cache
 * for repeated payloads within one client/revision/restore scope; moving to a
 * different scope drops all entries so a restored or newer state is checked
 * against its own contents.
 */
export function createAssetValidationCache({ maxChars = MAX_ASSET_VALIDATION_CACHE_CHARS } = {}) {
  const limit = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : MAX_ASSET_VALIDATION_CACHE_CHARS;
  let scope = null;
  let cachedChars = 0;
  const entries = new Map();

  function clear() {
    entries.clear();
    cachedChars = 0;
  }

  function setScope(context = {}) {
    const nextScope = JSON.stringify({
      revision: Number.isSafeInteger(context.revision) ? context.revision : null,
      clientId: typeof context.clientId === "string" ? context.clientId : "default",
      restoreId: typeof context.restoreId === "string" ? context.restoreId : null,
    });
    if (scope !== nextScope) {
      clear();
      scope = nextScope;
    }
  }

  return Object.freeze({
    parse(dataUrl, label, context) {
      setScope(context);
      if (entries.has(dataUrl)) {
        const entry = entries.get(dataUrl);
        entry.validationCount += 1;
        entries.delete(dataUrl);
        entries.set(dataUrl, entry);
        return entry.parsed;
      }
      const parsed = normalizeDataUrl(dataUrl, label);
      if (dataUrl.length <= limit) {
        while (entries.size > 0 && cachedChars + dataUrl.length > limit) {
          const oldestKey = entries.keys().next().value;
          cachedChars -= oldestKey.length;
          entries.delete(oldestKey);
        }
        entries.set(dataUrl, { parsed, validationCount: 1 });
        cachedChars += dataUrl.length;
      }
      return parsed;
    },
    completePass() {
      for (const [dataUrl, entry] of entries) {
        if (entry.validationCount === 1) {
          entries.delete(dataUrl);
          cachedChars -= dataUrl.length;
        } else {
          entry.validationCount = 0;
        }
      }
    },
    reset() {
      clear();
      scope = null;
    },
  });
}

function readTrustedAssetContent(asset, trustedAssetValidation) {
  const trusted = trustedAssetValidation?.get?.(asset.id);
  assert(trusted && trusted.contentRef === asset.contentRef,
    `Stored attachment ${asset.name} is missing trusted content metadata.`);
  assert(trusted.mimeType === asset.mimeType && Number.isSafeInteger(trusted.decodedBytes) && trusted.decodedBytes >= 0,
    `Stored attachment ${asset.name} has invalid trusted content metadata.`);
  assert(typeof trusted.contentSha256 === "string" && /^[0-9a-f]{64}$/i.test(trusted.contentSha256),
    `Stored attachment ${asset.name} has invalid trusted content metadata.`);
  assert(Number.isSafeInteger(trusted.contentRevision) && trusted.contentRevision > 0,
    `Stored attachment ${asset.name} has invalid trusted content metadata.`);
  return { mimeType: trusted.mimeType, decodedBytes: trusted.decodedBytes };
}

function validateAssets(state, batches, versions, issues, options) {
  assertUniqueIds(state.assets, "Attachment");
  const assets = assetMap(state);
  let totalBytes = 0;
  for (const asset of state.assets) {
    assertText(asset.name, "Attachment name", { maxLength: 200 });
    assert(!/[\\/\u0000-\u001f\u007f]/.test(asset.name) && !DANGEROUS_EXTENSIONS.test(asset.name), "Attachment name cannot contain a path or executable extension.");
    const parsed = typeof asset.dataUrl === "string"
      ? (options.assetValidationCache?.parse(asset.dataUrl, "Stored attachment", options.validationContext)
        ?? normalizeDataUrl(asset.dataUrl, "Stored attachment"))
      : readTrustedAssetContent(asset, options.trustedAssetValidation);
    assert(parsed.mimeType === asset.mimeType, `Attachment ${asset.name} MIME type does not match its data URL.`);
    const ext = asset.name.includes(".") ? asset.name.slice(asset.name.lastIndexOf(".")).toLocaleLowerCase() : "";
    if (asset.kind === "photo") {
      assert(PHOTO_MIMES.has(asset.mimeType), "Photos must be PNG, JPEG, WebP, or GIF raster images.");
      assert(parsed.decodedBytes > 0 && parsed.decodedBytes <= PHOTO_MAX_BYTES, `Photo ${asset.name} exceeds its size limit.`);
      const batch = batches.get(asset.batchId);
      assert(batch && typeof asset.rowId === "string" && batch.rows.some((row) => row.id === asset.rowId), `Photo ${asset.name} must belong to a batch row.`);
      assert(asset.versionId === null, "Photos cannot be attached directly to a version.");
      const attachedToRow = batch.rows.find((row) => row.id === asset.rowId).photoIds.includes(asset.id);
      const attachedToIssue = issues.some((issue) => issue.sourceSnapshot?.row?.photoIds?.includes(asset.id));
      assert(attachedToRow || attachedToIssue, `Photo ${asset.name} is not referenced by a row or issue snapshot.`);
    } else if (asset.kind === "document") {
      assert(DOCUMENT_MIMES.has(asset.mimeType), "Library documents must use a supported document, image, office, zip, text, or video type.");
      assert(parsed.decodedBytes > 0 && parsed.decodedBytes <= DOCUMENT_MAX_BYTES, `Document ${asset.name} exceeds its size limit.`);
      assert(asset.batchId === null && asset.rowId === null, "Library documents cannot be linked to batch rows.");
      assert(asset.versionId === null || versions.has(asset.versionId), `Document ${asset.name} refers to an unknown design version.`);
      if (asset.mimeType === "text/plain") assert(TEXT_EXTENSIONS.has(ext), "Plain-text library files must use .txt, .csv, .md, .markdown, or .log filenames.");
      if (MIME_EXTENSIONS.has(asset.mimeType)) assert(MIME_EXTENSIONS.get(asset.mimeType).has(ext), `Document ${asset.name} extension does not match its MIME type.`);
    } else if (asset.kind === "rowAttachment") {
      assert(ROW_ATTACHMENT_CATEGORIES.has(asset.category), `Attachment ${asset.name} has an unsupported inspection row category.`);
      const allowedMime = asset.category === "videos"
        ? VIDEO_MIMES.has(asset.mimeType)
        : DOCUMENT_MIMES.has(asset.mimeType) && !VIDEO_MIMES.has(asset.mimeType);
      assert(allowedMime, `Attachment ${asset.name} does not match its inspection row category.`);
      assert(parsed.decodedBytes > 0 && parsed.decodedBytes <= DOCUMENT_MAX_BYTES, `Attachment ${asset.name} exceeds its size limit.`);
      const batch = batches.get(asset.batchId);
      const row = batch?.rows.find((candidate) => candidate.id === asset.rowId);
      assert(row && row.attachmentIds?.[asset.category] === asset.id, `Attachment ${asset.name} is not referenced by its inspection row slot.`);
      assert(asset.versionId === null && asset.issueId === null, `Inspection row attachment ${asset.name} cannot also belong to a version or issue.`);
      if (asset.mimeType === "text/plain") assert(TEXT_EXTENSIONS.has(ext), "Plain-text row attachments must use .txt, .csv, .md, .markdown, or .log filenames.");
      if (MIME_EXTENSIONS.has(asset.mimeType)) assert(MIME_EXTENSIONS.get(asset.mimeType).has(ext), `Attachment ${asset.name} extension does not match its MIME type.`);
    } else if (asset.kind === "issueAttachment") {
      assert(["photo", "file"].includes(asset.category), `Issue attachment ${asset.name} must be categorized as photo or file.`);
      const allowedMime = asset.category === "photo" ? PHOTO_MIMES.has(asset.mimeType) : DOCUMENT_MIMES.has(asset.mimeType);
      const maxBytes = asset.category === "photo" ? PHOTO_MAX_BYTES : DOCUMENT_MAX_BYTES;
      assert(allowedMime, `Issue attachment ${asset.name} does not match its photo or file category.`);
      assert(parsed.decodedBytes > 0 && parsed.decodedBytes <= maxBytes, `Issue attachment ${asset.name} exceeds its size limit.`);
      const issue = issues.find((candidate) => candidate.id === asset.issueId);
      assert(issue && (issue.attachmentIds ?? []).includes(asset.id), `Issue attachment ${asset.name} is not referenced by its issue.`);
      assert(asset.batchId === issue.batchId && asset.rowId === issue.rowId,
        `Issue attachment ${asset.name} does not match its issue batch and row scope.`);
      assert(asset.versionId === null, `Issue attachment ${asset.name} cannot be attached to a version.`);
      if (asset.mimeType === "text/plain") assert(TEXT_EXTENSIONS.has(ext), "Plain-text issue files must use .txt, .csv, .md, .markdown, or .log filenames.");
      if (MIME_EXTENSIONS.has(asset.mimeType)) assert(MIME_EXTENSIONS.get(asset.mimeType).has(ext), `Issue attachment ${asset.name} extension does not match its MIME type.`);
    } else {
      fail("Attachment kind must be photo, document, rowAttachment, or issueAttachment.");
    }
    totalBytes += parsed.decodedBytes;
    requireTimestamp(asset.createdAt, "Attachment created time");
  }
  assert(totalBytes <= ASSET_TOTAL_MAX_BYTES, `Attachments exceed the ${Math.floor(ASSET_TOTAL_MAX_BYTES / (1024 * 1024))} MiB total limit.`);
  return assets;
}

function validateIssues(state, batches, variants, assets) {
  assertUniqueIds(state.issues, "Issue");
  ensureUnique(state.issues.map((issue) => issue.number.toLocaleLowerCase()), "Issue number");
  const requestIds = [];
  for (const issue of state.issues) {
    assertText(issue.number, "Issue number", { maxLength: 120 });
    assertText(issue.title, "Issue title", { maxLength: 300 });
    if (Object.hasOwn(issue, "reportedBy")) {
      assertText(issue.reportedBy, "Reported by", { maxLength: 200 });
      assert(issue.reportedBy === issue.reportedBy.trim(), `Issue ${issue.number} reporter name must be trimmed.`);
    }
    if (Object.hasOwn(issue, "description")) assertText(issue.description, "Issue description", { maxLength: 10000, allowBlank: true });
    if (Object.hasOwn(issue, "requestId")) {
      assertText(issue.requestId, "Issue request ID", { maxLength: 120 });
      requestIds.push(issue.requestId);
      if (Object.hasOwn(issue, "requestFingerprint")) {
        assert(typeof issue.requestFingerprint === "string" && /^[0-9a-f]{16}$/.test(issue.requestFingerprint),
          `Issue ${issue.number} has an invalid request fingerprint.`);
      }
    } else {
      assert(!Object.hasOwn(issue, "requestFingerprint"), `Issue ${issue.number} cannot have a request fingerprint without a request ID.`);
    }
    if (Object.hasOwn(issue, "attachmentIds")) {
      assert(Array.isArray(issue.attachmentIds), `Issue ${issue.number} attachment IDs must be a list.`);
      ensureUnique(issue.attachmentIds, `Attachments on issue ${issue.number}`);
      for (const assetId of issue.attachmentIds) {
        const asset = assets.get(assetId);
        assert(asset && asset.kind === "issueAttachment" && asset.issueId === issue.id &&
          asset.batchId === issue.batchId && asset.rowId === issue.rowId,
        `Issue ${issue.number} contains a missing or out-of-scope attachment.`);
      }
    }
    assert(["open", "closed"].includes(issue.status), `Issue ${issue.number} has an invalid status.`);
    assertText(issue.owner, "Disposition owner", { maxLength: 200, allowBlank: true });
    assertText(issue.disposition, "Formal disposition", { maxLength: 10000, allowBlank: true });
    assert(Array.isArray(issue.confirmations) && issue.confirmations.length === 3 && issue.confirmations.every((item) => typeof item === "string" && item.trim().length <= 200), `Issue ${issue.number} must contain three valid confirmation names.`);
    requireTimestamp(issue.createdAt, "Issue created time");
    if (issue.status === "open") assert(issue.closedAt === null, `Open issue ${issue.number} cannot have a close time.`);
    else {
      requireTimestamp(issue.closedAt, "Issue close time");
      assert(issue.owner.trim() && issue.disposition.trim() && issue.confirmations.every((name) => name.trim()), `Closed issue ${issue.number} is missing disposition or confirmations.`);
    }
    assert(Array.isArray(issue.discussion), `Issue ${issue.number} discussion must be a list.`);
    assertUniqueIds(issue.discussion, `Discussion entry on ${issue.number}`);
    for (const entry of issue.discussion) {
      assertText(entry.text, "Discussion entry", { maxLength: 5000 });
      if (Object.hasOwn(entry, "authorName")) {
        assertText(entry.authorName, "Discussion author name", { maxLength: 200 });
        assert(entry.authorName.length <= 200, "Discussion author name must be 200 characters or fewer.");
      }
      requireTimestamp(entry.createdAt, "Discussion created time");
    }
    if (issue.batchId === null) {
      assert(issue.rowId === null && issue.sourceSnapshot === null, `Standalone issue ${issue.number} cannot have a batch source snapshot.`);
    } else {
      const batch = batches.get(issue.batchId);
      assert(batch, `Issue ${issue.number} refers to an unknown batch.`);
      assert(issue.sourceSnapshot && issue.sourceSnapshot.batchId === batch.id && issue.sourceSnapshot.batchNumber === batch.number, `Issue ${issue.number} has an invalid batch source snapshot.`);
      const source = issue.sourceSnapshot;
      const products = getBatchProducts(batch);
      const expectedProducts = products.map((product) => ({
        lineId: product.lineId,
        variantId: product.variantId,
        variantLabel: variants.get(product.variantId)?.label ?? null,
        versionId: product.versionId,
        versionLabel: product.versionLabel,
        quantity: product.quantity,
      }));
      assert(source.orderId === batch.orderId, `Issue ${issue.number} source snapshot references the wrong order.`);
      assert(source.factory === batch.factory && source.stage === batch.stage, `Issue ${issue.number} source snapshot has an invalid factory or stage.`);
      const historicalBatch = batch.kind === "historical";
      if (historicalBatch) {
        assert(source.date === batch.date && source.products.length === 0 && source.lineId === null && source.variantId === null &&
          source.variantLabel === null && source.familyId === batch.familyId && source.versionId === null && source.versionLabel === batch.versionLabel,
        `Issue ${issue.number} has an invalid historical batch snapshot.`);
      } else {
        requireDate(source.date, "Issue source batch date");
      }
      if (Array.isArray(source.products)) {
        assert(stableStringify(source.products) === stableStringify(expectedProducts),
          `Issue ${issue.number} source snapshot changed its locked product allocations or versions.`);
        const single = expectedProducts.length === 1 ? expectedProducts[0] : null;
        const singleFamilyId = historicalBatch ? batch.familyId : products.length === 1 ? products[0].familyId : null;
        for (const [field, expected] of Object.entries({
          lineId: single?.lineId ?? null,
          variantId: single?.variantId ?? null,
          variantLabel: single?.variantLabel ?? null,
          familyId: singleFamilyId,
          versionId: single?.versionId ?? null,
          versionLabel: historicalBatch ? batch.versionLabel : single?.versionLabel ?? null,
        })) {
          const detail = field === "versionId" || field === "versionLabel"
            ? "invalid design version product projection"
            : `invalid ${field} product projection`;
          assert(source[field] === expected, `Issue ${issue.number} source snapshot has an ${detail}.`);
        }
      } else {
        assert(!Array.isArray(batch.products), `Issue ${issue.number} must preserve product allocation snapshots.`);
        const legacyProduct = expectedProducts[0];
        const line = state.orders.find((order) => order.id === batch.orderId)?.lines.find((candidate) => candidate.id === batch.lineId);
        const variant = variants.get(batch.variantId);
        assert(products.length === 1 && source.lineId === batch.lineId && source.variantId === batch.variantId,
          `Issue ${issue.number} source snapshot references the wrong order line or variant.`);
        assert(source.variantLabel === variant?.label && source.versionId === legacyProduct.versionId && source.versionLabel === legacyProduct.versionLabel,
          `Issue ${issue.number} source snapshot has an invalid variant or design version.`);
        assert(line && line.variantId === source.variantId, `Issue ${issue.number} source line does not match its variant.`);
      }
      if (issue.rowId === null) assert(issue.sourceSnapshot.row === null, `Batch-level issue ${issue.number} cannot contain an inspection row snapshot.`);
      else {
        const row = batch.rows.find((candidate) => candidate.id === issue.rowId);
        const rowProduct = row ? getBatchRowProduct(batch, row) : null;
        const rowVariant = rowProduct ? variants.get(rowProduct.variantId) : null;
        const sourceRow = issue.sourceSnapshot.row;
        assert(row && sourceRow && sourceRow.id === row.id, `Issue ${issue.number} has an invalid inspection row link.`);
        if (!historicalBatch && (sourceRow.productLineId !== undefined || Array.isArray(batch.products))) {
          assert(rowProduct && sourceRow.productLineId === rowProduct.lineId &&
            sourceRow.variantId === rowProduct.variantId && sourceRow.variantLabel === rowVariant?.label &&
            sourceRow.familyId === rowProduct.familyId && sourceRow.versionId === rowProduct.versionId &&
            sourceRow.versionLabel === rowProduct.versionLabel && sourceRow.productQuantity === rowProduct.quantity,
          `Issue ${issue.number} source row snapshot has an invalid product or design version.`);
        }
        const immutableRowFields = historicalBatch
          ? ["key", "no", "title", "titleZh", "specification", "specificationZh"]
          : ["key", "no", "title", "titleZh", "specification", "specificationZh", "inspectedQty"];
        for (const field of immutableRowFields) {
          assert(sourceRow[field] === row[field], `Issue ${issue.number} source snapshot changed locked row field ${field}.`);
        }
        requirePositiveInteger(sourceRow.no, "Issue source inspection item number");
        if (historicalBatch) {
          assert(sourceRow.inspectedQty === null || (Number.isSafeInteger(sourceRow.inspectedQty) && sourceRow.inspectedQty >= 0),
            `Issue ${issue.number} source snapshot has an invalid inspection quantity.`);
        } else {
          requireNonNegativeInteger(sourceRow.inspectedQty, "Issue source inspection quantity");
        }
        assert(sourceRow.defectiveQty === null || (Number.isSafeInteger(sourceRow.defectiveQty) && sourceRow.defectiveQty >= 0 &&
          (historicalBatch || sourceRow.defectiveQty <= sourceRow.inspectedQty)), `Issue ${issue.number} source snapshot has an invalid defective quantity.`);
        if (Object.hasOwn(sourceRow, "actualTimeSeconds")) {
          assert(sourceRow.actualTimeSeconds === null || (typeof sourceRow.actualTimeSeconds === "number" && Number.isFinite(sourceRow.actualTimeSeconds) && sourceRow.actualTimeSeconds >= 0),
            `Issue ${issue.number} source snapshot has an invalid actual inspection time.`);
        }
        const complete = sourceRow.defectiveQty !== null &&
          (!Object.hasOwn(sourceRow, "actualTimeSeconds") || sourceRow.actualTimeSeconds !== null);
        if (historicalBatch) {
          assert(sourceRow.savedAt === null, `Issue ${issue.number} historical source snapshot cannot claim an operational save time.`);
        } else {
          assert((sourceRow.savedAt !== null) === complete, `Issue ${issue.number} source snapshot has an inconsistent saved time.`);
        }
        if (sourceRow.savedAt !== null) requireTimestamp(sourceRow.savedAt, "Issue source row saved time");
        assertText(sourceRow.remarks, "Issue source row remarks", { maxLength: 5000, allowBlank: true });
        const expectedRate = sourceRow.defectiveQty === null || sourceRow.inspectedQty == null || sourceRow.inspectedQty === 0
          ? null
          : Number(((sourceRow.defectiveQty / sourceRow.inspectedQty) * 100).toFixed(2));
        assert(sourceRow.defectiveRate === expectedRate, `Issue ${issue.number} source snapshot has an invalid defective rate.`);
        const photoIds = sourceRow.photoIds;
        assert(Array.isArray(photoIds), `Issue ${issue.number} snapshot photo references must be a list.`);
        ensureUnique(photoIds, `Issue snapshot photo references for ${issue.number}`);
        for (const assetId of photoIds) {
          const asset = assets.get(assetId);
          assert(asset && asset.kind === "photo" && asset.batchId === issue.batchId && asset.rowId === issue.rowId, `Issue ${issue.number} references missing or out-of-scope photo evidence.`);
        }
      }
    }
  }
  ensureUnique(requestIds, "Issue request ID");
}

function validateAudit(state) {
  assert(Array.isArray(state.audit), "Audit trail must be a list.");
  assertUniqueIds(state.audit, "Audit event");
  for (const entry of state.audit) {
    requireTimestamp(entry.at, "Audit event time");
    assertText(entry.action, "Audit action", { maxLength: 100 });
    assertText(entry.entityId, "Audit entity ID", { maxLength: 200 });
    assertText(entry.summary, "Audit summary", { maxLength: 1000, allowBlank: true });
  }
}

export function validateQCState(state, options = {}) {
  try {
    requireRecord(state, "QC state");
    assert(state.schemaVersion === 1, "Unsupported QC state schema version.");
    assert(Number.isSafeInteger(state.revision) && state.revision >= 0, "QC revision must be a non-negative whole number.");
    for (const collection of ["families", "variants", "versions", "orders", "batches", "issues", "assets", "audit"]) {
      assert(Array.isArray(state[collection]), `QC state ${collection} must be a list.`);
    }
    validateFamiliesAndVariants(state);
    const families = familyMap(state);
    const variants = new Map(state.variants.map((variant) => [variant.id, variant]));
    validateVersions(state, families);
    validateVersionMergeEvidence(state, families);
    const versions = versionMap(state);
    validateOrders(state, variants);
    const orders = new Map(state.orders.map((order) => [order.id, order]));
    const batches = batchMap(state);
    const assets = assetMap(state);
    validateBatches(state, families, variants, orders, versions, assets);
    validateIssues(state, batches, variants, assets);
    const validatedAssets = validateAssets(state, batches, versions, state.issues, options);
    validateHistoryState(state.history, validatedAssets);
    validateAudit(state);
    return state;
  } finally {
    options.assetValidationCache?.completePass?.();
  }
}

export function validateBackup(backup) {
  requireRecord(backup, "Backup");
  if (backup.format !== BACKUP_FORMAT || backup.formatVersion !== BACKUP_FORMAT_VERSION) fail("This backup format is not supported.");
  if (!isIsoTimestamp(backup.exportedAt)) fail("Backup export time must be an ISO timestamp.");
  let serialized;
  try {
    serialized = JSON.stringify(backup);
  } catch {
    fail("Backup must contain JSON-serializable data.");
  }
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > BACKUP_MAX_BYTES) fail(`Backup exceeds the ${Math.floor(BACKUP_MAX_BYTES / (1024 * 1024))} MiB import limit.`);
  // Backups are portable user input and must always carry every payload.
  validateQCState(backup.state);
  return bytes;
}
