import { deepEqual, fail, requireRecord, stableStringify } from "./qc-domain.js";
import { isAuthorizedS15TrialPackageEntry } from "./qc-version-cleanup.js";

const PACKAGE_TYPE = "masterqc-lark-version-history";
const REVISION_FIELD = "版本号 Revision";
const EFFECTIVE_AT_FIELD = "生效日期 Effective Date";
const STATUS_FIELD = "是否当前生效 Revision Status";
const DESCRIPTION_FIELD = "变更内容说明 Change Description";
const SPEC_LINK_FIELD = "③QC规范 Spec Items";
const EXPECTED_FAMILIES = new Map([
  ["s11-s14", ["S11", "S12", "S13", "S14"]],
  ["s15", ["S15"]],
]);

function assert(condition, message) {
  if (!condition) fail(message);
}

function assertString(value, label, { allowBlank = false, maxLength = 1000 } = {}) {
  assert(typeof value === "string", `${label} must be text.`);
  assert(allowBlank || value.trim().length > 0, `${label} is required.`);
  assert(value.length <= maxLength, `${label} is too long.`);
}

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

function idsFromLinkField(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => typeof entry === "string" ? entry : entry?.id).filter((id) => typeof id === "string");
}

function assertManifest(manifest, label) {
  requireRecord(manifest, `${label} dataset`);
  assertString(manifest.tableId, `${label} dataset ID`, { maxLength: 120 });
  const sourceRevision = manifest.tableRevision ?? manifest.rev;
  assert(Number.isSafeInteger(sourceRevision) && sourceRevision >= 0, `${label} revision number is invalid.`);
  assert(manifest.hasMore === false || manifest.has_more === false, `${label} data is incomplete.`);
  const rowCount = manifest.recordCount ?? manifest.recordsCount ?? manifest.records_count ?? manifest.record_count;
  assert(Number.isSafeInteger(rowCount) && rowCount >= 0, `${label} record count is invalid.`);
  if (manifest.tableUrl !== undefined) assertHttpUrl(manifest.tableUrl, `${label} page address`);
  return rowCount;
}

function assertHttpUrl(value, label) {
  if (value === null) return;
  assertString(value, label, { maxLength: 2000 });
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} must be an absolute HTTP or HTTPS URL.`);
  }
  assert(parsed.protocol === "http:" || parsed.protocol === "https:", `${label} must use HTTP or HTTPS.`);
}

function assertCounts(packageData) {
  const counts = requireRecord(packageData.report?.counts, "Version history counts");
  const records = packageData.records;
  const includedSpecs = records.reduce((sum, record) => sum + record.specs.length, 0);
  const revisionIds = new Set(records.map((record) => record.source.recordId));
  const specIds = new Set(records.flatMap((record) => record.specs.map((spec) => spec.sourceRecordId)));
  const byFamily = Object.fromEntries([...EXPECTED_FAMILIES.keys()].map((familyId) => [
    familyId,
    records.filter((record) => record.familyId === familyId).length,
  ]));
  const derived = {
    records: records.length,
    distinctIncludedRevisionIds: revisionIds.size,
    includedSpecRows: includedSpecs,
    distinctIncludedSpecSourceIds: specIds.size,
    excludedVersionRecords: packageData.report.excludedVersionRecords.length,
    recordsByFamily: byFamily,
  };
  for (const [key, value] of Object.entries(derived)) {
    assert(stableStringify(counts[key]) === stableStringify(value), `Version history count ${key} does not match its entries.`);
  }
}

/** Validate the complete bundled package before any version record is merged. */
export function verifyLarkVersionPackage(packageData) {
  requireRecord(packageData, "Version history file");
  assert(packageData.packageType === PACKAGE_TYPE, "This version history file is not supported.");
  assert(packageData.schemaVersion === 1, "This version history file uses an unsupported format.");
  requireRecord(packageData.capturedAt, "Import details");
  assertString(packageData.capturedAt.localDate, "Import date", { maxLength: 30 });
  assertString(packageData.capturedAt.timeZone, "Import time zone", { maxLength: 100 });
  requireRecord(packageData.sources, "Version history datasets");
  const revisionRows = assertManifest(packageData.sources.revisions, "Revision");
  assertManifest(packageData.sources.products, "Product");
  assertManifest(packageData.sources.specs, "Specification");

  assert(Array.isArray(packageData.families), "Version history families must be a list.");
  const families = new Map();
  for (const family of packageData.families) {
    requireRecord(family, "Version history family");
    assert(EXPECTED_FAMILIES.has(family.id), `Unsupported inspection family ${family.id}.`);
    assert(Array.isArray(family.modelValues), `Family ${family.id} must list its product models.`);
    assert(stableStringify([...family.modelValues].sort()) === stableStringify([...EXPECTED_FAMILIES.get(family.id)].sort()),
      `Family ${family.id} has an invalid product mapping.`);
    assert(!families.has(family.id), `Inspection family ${family.id} is duplicated.`);
    families.set(family.id, family);
  }
  assert(families.size === EXPECTED_FAMILIES.size, "Version history must include both supported inspection families.");

  assert(Array.isArray(packageData.records) && packageData.records.length > 0, "Version history must include at least one version.");
  assert(Array.isArray(packageData.report?.excludedVersionRecords), "Version history exclusions must be listed.");
  const ids = new Set();
  const recordFamilies = new Set();
  for (const entry of packageData.records) {
    requireRecord(entry, "Archived version entry");
    assert(families.has(entry.familyId), `Version entry uses unsupported family ${entry.familyId}.`);
    requireRecord(entry.source, "Version entry details");
    assertString(entry.source.recordId, "Version record ID", { maxLength: 120 });
    assertString(entry.source.tableId, "Version dataset ID", { maxLength: 120 });
    assertHttpUrl(entry.source.tableUrl, "Version page address");
    assert(entry.id === `lark:${entry.source.recordId}:${entry.familyId}`, "Archived version ID does not match its version record and family.");
    assert(!ids.has(entry.id), `Archived version entry ${entry.id} is duplicated.`);
    ids.add(entry.id);
    const recordFamilyKey = `${entry.source.recordId}|${entry.familyId}`;
    assert(!recordFamilies.has(recordFamilyKey), `Version record is duplicated for ${entry.familyId}.`);
    recordFamilies.add(recordFamilyKey);

    assert(Array.isArray(entry.applicableProductIds) && entry.applicableProductIds.length > 0,
      `Version entry ${entry.id} has no applicable family products.`);
    assert(new Set(entry.applicableProductIds).size === entry.applicableProductIds.length,
      `Version entry ${entry.id} has duplicate applicable product links.`);
    requireRecord(entry.rawRecord, `Version entry ${entry.id} details`);
    assert(entry.rawRecord.record_id === entry.source.recordId, `Version record IDs do not match.`);
    assert(deepEqual(entry.revision, entry.rawRecord[REVISION_FIELD]), `Version label does not match its version entry.`);
    assert(deepEqual(entry.effectiveAt, entry.rawRecord[EFFECTIVE_AT_FIELD]), `Version date does not match its version entry.`);
    assert(deepEqual(entry.rawStatus, entry.rawRecord[STATUS_FIELD]), `Version status does not match its version entry.`);
    assert(deepEqual(entry.changeDescription, entry.rawRecord[DESCRIPTION_FIELD]), `Change description does not match its version entry.`);
    assert(deepEqual(entry.attachments, entry.rawRecord["图纸/附件 Engineering Drawing"]), `Version attachments do not match its version entry.`);
    assert(Array.isArray(entry.specs), `Version inspection items must be a list.`);
    assert(Array.isArray(entry.anomalies), `Version review details are missing.`);
    assertJsonValue(entry.rawRecord, `Version entry ${entry.id} details`);
    assertJsonValue(entry.anomalies, `Version entry ${entry.id} review details`);

    const revisionSpecIds = new Set(idsFromLinkField(entry.rawRecord[SPEC_LINK_FIELD]));
    const seenSpecIds = new Set();
    for (const spec of entry.specs) {
      requireRecord(spec, `Version entry ${entry.id} inspection item`);
      assertString(spec.sourceRecordId, "Inspection item ID", { maxLength: 120 });
      assert(revisionSpecIds.has(spec.sourceRecordId),
        `Inspection item ${spec.sourceRecordId} is not linked to its version.`);
      assert(!seenSpecIds.has(spec.sourceRecordId), `Specification ${spec.sourceRecordId} is duplicated in revision ${entry.source.recordId}.`);
      seenSpecIds.add(spec.sourceRecordId);
      assert(Array.isArray(spec.applicableProductIds) && spec.applicableProductIds.length > 0,
        `Specification ${spec.sourceRecordId} has no applicable family products.`);
      assert(spec.applicableProductIds.every((productId) => entry.applicableProductIds.includes(productId)),
        `Specification ${spec.sourceRecordId} includes products outside its revision family projection.`);
      requireRecord(spec.rawRecord, `Specification ${spec.sourceRecordId} raw record`);
      assert(spec.rawRecord.record_id === spec.sourceRecordId, `Specification ${spec.sourceRecordId} raw record ID does not match its provenance.`);
      assertJsonValue(spec.rawRecord, `Specification ${spec.sourceRecordId} raw record`);
    }
  }
  assert(packageData.records.every((entry) => entry.source.tableId === packageData.sources.revisions.tableId && entry.source.tableUrl === packageData.sources.revisions.tableUrl),
    "Version entries refer to different datasets.");
  assert(revisionRows >= new Set(packageData.records.map((entry) => entry.source.recordId)).size,
    "Package contains more distinct revisions than the complete revision export.");
  assertJsonValue(packageData.report.excludedVersionRecords, "Version history exclusions");
  assertCounts(packageData);
  return true;
}

function recordedVersionFromPackage(packageData, entry) {
  const exports = Object.fromEntries(Object.entries(packageData.sources).map(([name, manifest]) => [name, {
    tableId: manifest.tableId,
    rev: manifest.tableRevision ?? manifest.rev,
    recordsCount: manifest.recordCount ?? manifest.recordsCount ?? manifest.records_count ?? manifest.record_count,
    hasMore: manifest.hasMore ?? manifest.has_more,
    tableUrl: manifest.tableUrl ?? null,
    timeZone: manifest.timeZone ?? manifest.timezone ?? null,
    fieldIds: structuredClone(manifest.fieldIds ?? {}),
  }]));
  const family = packageData.families.find((item) => item.id === entry.familyId);
  return {
    id: entry.id,
    familyId: entry.familyId,
    label: typeof entry.revision === "string" ? entry.revision : "",
    sequence: null,
    effectiveDate: null,
    notes: "",
    status: "recorded",
    items: [],
    createdAt: null,
    publishedAt: null,
    source: {
      kind: "lark-version-record",
      packageType: packageData.packageType,
      packageSchemaVersion: packageData.schemaVersion,
      capturedAt: structuredClone(packageData.capturedAt),
      exports,
      system: entry.source.system,
      tableId: entry.source.tableId,
      tableUrl: entry.source.tableUrl,
      recordId: entry.source.recordId,
      applicableProductIds: structuredClone(entry.applicableProductIds),
      familyProductFacts: structuredClone(family?.products ?? []),
      productFieldMapping: structuredClone(packageData.productFieldMapping ?? {}),
      effectiveAtRaw: structuredClone(entry.effectiveAt),
      statusRaw: structuredClone(entry.rawStatus),
      changeDescriptionRaw: structuredClone(entry.changeDescription),
      attachmentsRaw: structuredClone(entry.attachments),
      rawRecord: structuredClone(entry.rawRecord),
      anomalies: structuredClone(entry.anomalies),
    },
    sourceRows: entry.specs.map((spec) => ({
      sourceRecordId: spec.sourceRecordId,
      applicableProductIds: structuredClone(spec.applicableProductIds),
      rawRecord: structuredClone(spec.rawRecord),
    })),
  };
}

/** Add archived version records as immutable, non-operational family entries. */
export function importLarkVersionHistory(state, packageData) {
  verifyLarkVersionPackage(packageData);
  const omittedTrialVersions = packageData.records.filter(isAuthorizedS15TrialPackageEntry).length;
  const currentById = new Map(state.versions.map((version) => [version.id, version]));
  const currentBySource = new Map(state.versions
    .filter((version) => version.status === "recorded" && version.source?.kind === "lark-version-record")
    .map((version) => [`${version.familyId}|${version.source.recordId}`, version]));
  const incoming = packageData.records
    .filter((entry) => !isAuthorizedS15TrialPackageEntry(entry))
    .map((entry) => recordedVersionFromPackage(packageData, entry));
  const pending = [];
  let skipped = 0;
  let skippedSourceRows = 0;

  for (const version of incoming) {
    const sourceKey = `${version.familyId}|${version.source.recordId}`;
    const sameSource = currentBySource.get(sourceKey);
    if (sameSource && sameSource.id !== version.id) {
      fail("An archived version conflicts with an existing version ID; no data was imported.");
    }
    const existing = currentById.get(version.id);
    if (existing) {
      if (!deepEqual(existing, version)) {
        fail(`Archived version ${version.label || "entry"} conflicts with existing version data; no data was imported.`);
      }
      skipped += 1;
      skippedSourceRows += version.sourceRows.length;
      continue;
    }
    pending.push(version);
    currentById.set(version.id, version);
    currentBySource.set(sourceKey, version);
  }

  state.versions.push(...pending);
  const sourceRowsAdded = pending.reduce((sum, version) => sum + version.sourceRows.length, 0);
  const sourceRowsSkipped = skippedSourceRows;
  return {
    entityId: pending[0]?.id ?? incoming[0]?.id ?? "lark-version-history-import",
    changed: pending.length > 0,
    action: "importLarkVersionHistory",
    summary: `Added ${pending.length} archived version${pending.length === 1 ? "" : "s"} and ${sourceRowsAdded} inspection item${sourceRowsAdded === 1 ? "" : "s"}; skipped ${skipped} already-present version${skipped === 1 ? "" : "s"}; omitted ${omittedTrialVersions} authorized empty S15 trial version${omittedTrialVersions === 1 ? "" : "s"}.`,
    counts: {
      addedVersions: pending.length,
      skippedVersions: skipped,
      addedSourceRows: sourceRowsAdded,
      skippedSourceRows,
      omittedTrialVersions,
    },
  };
}

export function rawLarkVersionFields() {
  return Object.freeze({
    revision: REVISION_FIELD,
    effectiveAt: EFFECTIVE_AT_FIELD,
    status: STATUS_FIELD,
    changeDescription: DESCRIPTION_FIELD,
  });
}
