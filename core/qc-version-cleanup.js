import { deepEqual, fail } from "./qc-domain.js";

export const S15_TRIAL_VERSION_ID = "lark:recvwbnjOo2r4P:s15";

const TRIAL_SOURCE_RECORD_ID = "recvwbnjOo2r4P";
const TRIAL_EFFECTIVE_AT = "2026-09-24T00:00:00.000-07:00";
const TRIAL_PRODUCT_ID = "recvscXBLjt0HI";
const TRIAL_LABEL = "26.09.05";
const TRIAL_DESCRIPTION = "fefe";
const REVISION_FIELD = "版本号 Revision";
const EFFECTIVE_AT_FIELD = "生效日期 Effective Date";
const REVISION_STATUS_FIELD = "是否当前生效 Revision Status";
const DESCRIPTION_FIELD = "变更内容说明 Change Description";
const SPEC_LINK_FIELD = "③QC规范 Spec Items";
const ATTACHMENTS_FIELD = "图纸/附件 Engineering Drawing";
const BATCH_LINK_FIELD = "④批次 QC Batches";
const ISSUE_LINK_FIELD = "⑥关联问题 Issues";
const PRODUCT_LINK_FIELD = "关联产品 Products";
const SYNC_STATUS_FIELD = "QC规范是否已同步 Spec Synced";
const PARENT_FIELD = "父记录";

const EXPECTED_RAW_RECORD = Object.freeze({
  [SYNC_STATUS_FIELD]: ["已更新 Updated"],
  record_id: TRIAL_SOURCE_RECORD_ID,
  [SPEC_LINK_FIELD]: [],
  [BATCH_LINK_FIELD]: [],
  [ISSUE_LINK_FIELD]: [],
  [PRODUCT_LINK_FIELD]: [{ id: TRIAL_PRODUCT_ID }],
  [DESCRIPTION_FIELD]: TRIAL_DESCRIPTION,
  [ATTACHMENTS_FIELD]: [],
  [REVISION_STATUS_FIELD]: ["生效中 Active"],
  [PARENT_FIELD]: [],
  [REVISION_FIELD]: TRIAL_LABEL,
  [EFFECTIVE_AT_FIELD]: TRIAL_EFFECTIVE_AT,
});

function hasTrialPackageIdentity(entry) {
  return entry?.id === S15_TRIAL_VERSION_ID && entry.familyId === "s15" &&
    entry.source?.recordId === TRIAL_SOURCE_RECORD_ID && entry.revision === TRIAL_LABEL &&
    entry.effectiveAt === TRIAL_EFFECTIVE_AT && entry.changeDescription === TRIAL_DESCRIPTION &&
    deepEqual(entry.rawStatus, ["生效中 Active"]) && deepEqual(entry.attachments, []) &&
    Array.isArray(entry.specs) && entry.specs.length === 0 &&
    deepEqual(entry.applicableProductIds, [TRIAL_PRODUCT_ID]) &&
    deepEqual(entry.rawRecord, EXPECTED_RAW_RECORD) &&
    Array.isArray(entry.anomalies) && entry.anomalies.length === 0;
}

/** Match only the exact, empty S15 trial entry in the immutable import package. */
export function isAuthorizedS15TrialPackageEntry(entry) {
  return hasTrialPackageIdentity(entry);
}

/** Match only the exact recorded version produced from the authorized trial entry. */
export function isAuthorizedS15TrialVersion(version) {
  const source = version?.source;
  return version?.id === S15_TRIAL_VERSION_ID && version.familyId === "s15" &&
    version.status === "recorded" && version.label === TRIAL_LABEL &&
    version.sequence === null && version.effectiveDate === null && version.createdAt === null &&
    version.publishedAt === null && Array.isArray(version.items) && version.items.length === 0 &&
    Array.isArray(version.sourceRows) && version.sourceRows.length === 0 &&
    source?.kind === "lark-version-record" && source.recordId === TRIAL_SOURCE_RECORD_ID &&
    deepEqual(source.applicableProductIds, [TRIAL_PRODUCT_ID]) &&
    source.effectiveAtRaw === TRIAL_EFFECTIVE_AT &&
    deepEqual(source.statusRaw, ["生效中 Active"]) &&
    source.changeDescriptionRaw === TRIAL_DESCRIPTION &&
    deepEqual(source.attachmentsRaw, []) &&
    deepEqual(source.rawRecord, EXPECTED_RAW_RECORD) &&
    Array.isArray(source.anomalies) && source.anomalies.length === 0;
}

function collectExactStringPaths(value, target, prefix, output, seen = new Set()) {
  if (value === target) {
    output.push(prefix);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectExactStringPaths(item, target, `${prefix}[${index}]`, output, seen));
  } else {
    for (const [key, item] of Object.entries(value)) {
      collectExactStringPaths(item, target, `${prefix}.${key}`, output, seen);
    }
  }
  seen.delete(value);
}

function findTrialVersionReferences(state) {
  const references = [];
  for (const batch of state.batches ?? []) {
    if (batch.versionId === S15_TRIAL_VERSION_ID) references.push(`batch ${batch.number || batch.id}`);
  }
  for (const issue of state.issues ?? []) {
    if (issue.versionId === S15_TRIAL_VERSION_ID || issue.sourceSnapshot?.versionId === S15_TRIAL_VERSION_ID) {
      references.push(`issue ${issue.number || issue.id}`);
    }
  }
  for (const asset of state.assets ?? []) {
    if (asset.versionId === S15_TRIAL_VERSION_ID) references.push(`attachment ${asset.name || asset.id}`);
  }
  for (const [label, value] of [
    ["another design version", (state.versions ?? []).filter((version) => version.id !== S15_TRIAL_VERSION_ID)],
    ["purchase order or catalog record", [state.orders, state.families, state.variants]],
    ["history evidence", state.history],
    ["version merge evidence", state.versionMergeEvidence],
  ]) {
    const paths = [];
    collectExactStringPaths(value, S15_TRIAL_VERSION_ID, label, paths);
    for (const path of paths) references.push(path);
  }
  return [...new Set(references)];
}

/** Remove the guarded trial record only when nothing in the active state refers to it. */
export function removeAuthorizedS15TrialVersion(state) {
  if (!Array.isArray(state?.versions)) return { versionIds: [] };
  const index = state.versions.findIndex((version) => version?.id === S15_TRIAL_VERSION_ID);
  if (index < 0 || !isAuthorizedS15TrialVersion(state.versions[index])) return { versionIds: [] };

  const references = findTrialVersionReferences(state);
  if (references.length) {
    fail(`Cannot remove S15 trial version ${TRIAL_LABEL} because it is referenced by ${references.join(", ")}. Remove or relink those records before retrying.`);
  }
  state.versions.splice(index, 1);
  return { versionIds: [S15_TRIAL_VERSION_ID] };
}
