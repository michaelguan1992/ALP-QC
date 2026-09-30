import {
  clone,
  deepEqual,
  fail,
  requireDate,
  requirePositiveInteger,
  requireRecord,
  requireString,
  requireTimestamp,
} from "./qc-domain.js";
import { normalizeStandardItems } from "./qc-standards.js";

export const AP_VERSION_MERGE_PAIRS = Object.freeze([
  Object.freeze({
    id: "history-version-28472835a7113e44c0de60c15607f7cdf7fc82bc",
    familyId: "s11-s14",
    label: "25.10.29",
    targetVersionId: "lark:recvscXCuZAHXR:s11-s14",
  }),
  Object.freeze({
    id: "history-version-cac6c73b7872b4fdf9493ec4c66d4509e12b9e0c",
    familyId: "s15",
    label: "25.10.29",
    targetVersionId: "lark:recvscXCuZAHXR:s15",
  }),
]);

const DUPLICATE_NOTE_PREFIX = "Historical source reference draft.";
const CANONICAL_SOURCE_RECORD_ID = "recvscXCuZAHXR";

function mergePair(id) {
  return AP_VERSION_MERGE_PAIRS.find((pair) => pair.id === id) ?? null;
}

function requireCanonicalVersion(state, pair) {
  const canonical = state.versions.find((version) => version.id === pair.targetVersionId);
  if (!canonical) return null;
  if (canonical.familyId !== pair.familyId || canonical.label !== pair.label || canonical.status !== "recorded" ||
    canonical.source?.kind !== "lark-version-record" || canonical.source.recordId !== CANONICAL_SOURCE_RECORD_ID) {
    fail(`Recorded version ${pair.targetVersionId} does not match the verified ${pair.label} merge target.`);
  }
  return canonical;
}

function validateDuplicateVersion(version, pair) {
  if (!version || version.id !== pair.id || version.familyId !== pair.familyId || version.label !== pair.label ||
    version.status !== "superseded" || typeof version.notes !== "string" ||
    !version.notes.trimStart().startsWith(DUPLICATE_NOTE_PREFIX)) {
    fail(`Version ${pair.id} does not match the verified superseded AP reference identity.`);
  }
  if (Object.hasOwn(version, "sourceRows")) fail(`Version ${pair.id} cannot be merged with recorded source rows.`);
}

function findEvidence(state, pair) {
  const entries = state.versionMergeEvidence ?? [];
  const matches = entries.filter((entry) => entry?.id === pair.id);
  if (matches.length > 1) fail(`Version merge evidence for ${pair.id} is duplicated.`);
  const entry = matches[0];
  if (entry) {
    const active = state.versions.find((version) => version.id === pair.id);
    if (entry.targetVersionId !== pair.targetVersionId || (active && !sameMergedVersionSourceFacts(entry.version, active))) {
      fail(`Version merge evidence for ${pair.id} conflicts with the active version record.`);
    }
  }
  return entry ?? null;
}

function assertNoLockedReferences(state, pair) {
  if (state.batches?.some((batch) => batch.versionId === pair.id)) {
    fail(`Version ${pair.id} is locked by a batch and cannot be merged.`);
  }
  if (state.issues?.some((issue) => issue.versionId === pair.id || issue.sourceSnapshot?.versionId === pair.id)) {
    fail(`Version ${pair.id} is referenced by an issue and cannot be merged.`);
  }
}

function assertMergeableAssets(assets, pair) {
  const matches = assets.filter((asset) => asset.versionId === pair.id);
  for (const asset of matches) {
    if (asset.kind !== "document" || asset.batchId !== null || asset.rowId !== null) {
      fail(`Attachment ${asset.id} has an unsupported link to version ${pair.id}.`);
    }
  }
  return matches;
}

function expectedEvidenceEntry(version, pair) {
  return { id: pair.id, targetVersionId: pair.targetVersionId, version: clone(version) };
}

export function sameMergedVersionSourceFacts(left, right) {
  if (!left || !right) return false;
  const leftFacts = clone(left);
  const rightFacts = clone(right);
  for (const record of [leftFacts, rightFacts]) {
    delete record.status;
    delete record.publishedAt;
  }
  return deepEqual(leftFacts, rightFacts);
}

/** Merge only the two verified PDF-derived AP versions into their existing recorded source entries. */
export function mergeSupersededAPVersionDuplicates(state) {
  const ledger = state.versionMergeEvidence ?? [];
  if (!Array.isArray(ledger)) fail("Version merge evidence must be a list.");

  const pending = [];
  for (const pair of AP_VERSION_MERGE_PAIRS) {
    const duplicate = state.versions.find((version) => version.id === pair.id);
    const existingEvidence = findEvidence(state, pair);
    if (!duplicate) {
      if (existingEvidence && !requireCanonicalVersion(state, pair)) {
        fail(`Recorded merge target ${pair.targetVersionId} is missing for ${pair.id}.`);
      }
      continue;
    }

    validateDuplicateVersion(duplicate, pair);
    const canonical = requireCanonicalVersion(state, pair);
    // A PDF-only workspace remains usable until the matching archived Lark source is present.
    if (!canonical) {
      if (existingEvidence) fail(`Recorded merge target ${pair.targetVersionId} is missing for ${pair.id}.`);
      continue;
    }
    if (existingEvidence && !sameMergedVersionSourceFacts(existingEvidence.version, duplicate)) {
      fail(`Version merge evidence for ${pair.id} conflicts with the active version record.`);
    }
    assertNoLockedReferences(state, pair);
    pending.push({ pair, duplicate, existingEvidence, assets: assertMergeableAssets(state.assets, pair) });
  }

  if (!pending.length) return { changed: false, versionIds: [], assetIds: [], evidenceIds: [] };

  const evidence = [...ledger];
  const versionIds = [];
  const assetIds = [];
  const evidenceIds = [];
  for (const item of pending) {
    if (!item.existingEvidence) {
      evidence.push(expectedEvidenceEntry(item.duplicate, item.pair));
      evidenceIds.push(item.pair.id);
    }
    for (const asset of item.assets) {
      asset.versionId = item.pair.targetVersionId;
      assetIds.push(asset.id);
    }
    versionIds.push(item.pair.id);
  }

  state.versionMergeEvidence = evidence;
  const mergedIds = new Set(versionIds);
  state.versions = state.versions.filter((version) => !mergedIds.has(version.id));
  return { changed: true, versionIds, assetIds, evidenceIds };
}

function supersededPackageVersion(version, pair) {
  const normalized = clone(version);
  if (["draft", "published"].includes(normalized.status) && normalized.familyId === pair.familyId &&
    normalized.label === pair.label && typeof normalized.notes === "string" &&
    normalized.notes.trimStart().startsWith(DUPLICATE_NOTE_PREFIX)) {
    normalized.status = "superseded";
  }
  validateDuplicateVersion(normalized, pair);
  return normalized;
}

function verifyMergeableImportedAsset(asset, pair) {
  if (asset.kind !== "document" || asset.batchId !== null || asset.rowId !== null) {
    fail(`Attachment ${asset.id} has an unsupported link to version ${pair.id}.`);
  }
}

/** Remove verified duplicate versions from a PDF package and retain them in the target's evidence ledger. */
export function reconcileHistoricalVersionPackage(state, historyPackage) {
  const prepared = clone(historyPackage);
  prepared.versions ??= [];
  if (state.versionMergeEvidence !== undefined && !Array.isArray(state.versionMergeEvidence)) {
    fail("Version merge evidence must be a list.");
  }
  const ledger = [...(state.versionMergeEvidence ?? [])];
  if (!Array.isArray(prepared.assets)) fail("Historical PDF package assets must be a list.");
  const evidenceAdded = [];
  const assetIds = [];
  const removedVersionIds = [];
  const pending = [];

  for (const pair of AP_VERSION_MERGE_PAIRS) {
    const incomingIndex = prepared.versions.findIndex((version) => version.id === pair.id);
    const rawIncoming = incomingIndex < 0 ? null : prepared.versions[incomingIndex];
    const existingEvidence = ledger.find((entry) => entry?.id === pair.id) ?? null;
    const matchingAssets = prepared.assets.filter((asset) => asset.versionId === pair.id);
    if (!rawIncoming && !matchingAssets.length) continue;

    const incoming = rawIncoming ? supersededPackageVersion(rawIncoming, pair) : null;
    const canonical = requireCanonicalVersion(state, pair);
    if (!canonical) {
      // A PDF package imported before its Lark history remains a valid, repeatable import.
      if (incoming) prepared.versions[incomingIndex] = incoming;
      continue;
    }

    if (incoming) {
      if (existingEvidence && (existingEvidence.targetVersionId !== pair.targetVersionId || !sameMergedVersionSourceFacts(existingEvidence.version, incoming))) {
        fail(`Historical PDF package conflicts with version merge evidence for ${pair.id}; no data was imported.`);
      }
    } else if (!existingEvidence) {
      fail(`Historical PDF package attachment refers to ${pair.id} without its version record.`);
    }

    for (const asset of matchingAssets) {
      verifyMergeableImportedAsset(asset, pair);
    }
    pending.push({ pair, incoming, existingEvidence, incomingIndex, assets: matchingAssets });
  }

  for (const item of pending) {
    if (item.incoming && !item.existingEvidence) {
      ledger.push(expectedEvidenceEntry(item.incoming, item.pair));
      evidenceAdded.push(item.pair.id);
    }
    for (const asset of item.assets) {
      asset.versionId = item.pair.targetVersionId;
      assetIds.push(asset.id);
    }
    if (item.incoming) removedVersionIds.push(item.pair.id);
  }
  const removed = new Set(removedVersionIds);
  if (removed.size) prepared.versions = prepared.versions.filter((version) => !removed.has(version.id));
  if (evidenceAdded.length) state.versionMergeEvidence = ledger;
  return { historyPackage: prepared, evidenceIds: evidenceAdded, assetIds, versionIds: removedVersionIds };
}

/** Match an older full backup against evidence already present in the restore target. */
export function reconcileBackupVersionDuplicates(incomingState, targetState) {
  const targetEvidence = targetState.versionMergeEvidence ?? [];
  const pending = [];
  for (const pair of AP_VERSION_MERGE_PAIRS) {
    const evidence = targetEvidence.find((entry) => entry?.id === pair.id);
    const duplicate = incomingState.versions.find((version) => version.id === pair.id);
    const assets = incomingState.assets.filter((asset) => asset.versionId === pair.id);
    if (!evidence || (!duplicate && !assets.length)) continue;
    if (evidence.targetVersionId !== pair.targetVersionId) {
      fail(`Version merge evidence for ${pair.id} has the wrong target.`);
    }
    if (!requireCanonicalVersion(targetState, pair)) {
      fail(`Recorded merge target ${pair.targetVersionId} is missing for ${pair.id}.`);
    }
    const normalized = duplicate ? supersededPackageVersion(duplicate, pair) : null;
    if (normalized && !sameMergedVersionSourceFacts(evidence.version, normalized)) {
      fail(`Backup conflicts with version merge evidence for ${pair.id}; no data was imported.`);
    }
    assertNoLockedReferences(incomingState, pair);
    for (const asset of assets) verifyMergeableImportedAsset(asset, pair);
    pending.push({ pair, duplicate, assets });
  }

  const versionIds = [];
  const assetIds = [];
  for (const item of pending) {
    if (item.duplicate) versionIds.push(item.pair.id);
    for (const asset of item.assets) {
      asset.versionId = item.pair.targetVersionId;
      assetIds.push(asset.id);
    }
  }
  if (versionIds.length) {
    const removed = new Set(versionIds);
    incomingState.versions = incomingState.versions.filter((version) => !removed.has(version.id));
  }
  return { versionIds, assetIds };
}

/** Validate the optional, lossless evidence ledger while leaving older states without it valid. */
export function validateVersionMergeEvidence(state, families) {
  if (state.versionMergeEvidence === undefined) return true;
  if (!Array.isArray(state.versionMergeEvidence)) fail("Version merge evidence must be a list.");
  const seen = new Set();
  for (const entryValue of state.versionMergeEvidence) {
    const entry = requireRecord(entryValue, "Version merge evidence entry");
    const pair = mergePair(entry.id);
    if (!pair || seen.has(entry.id)) fail("Version merge evidence contains an unsupported or duplicate entry.");
    seen.add(entry.id);
    if (entry.targetVersionId !== pair.targetVersionId) fail(`Version merge evidence for ${pair.id} has the wrong target.`);
    const version = requireRecord(entry.version, `Version merge evidence for ${pair.id}`);
    validateDuplicateVersion(version, pair);
    requireString(version.notes, "Merged version notes", { maxLength: 5000, allowBlank: true });
    requirePositiveInteger(version.sequence, "Merged version sequence");
    requireDate(version.effectiveDate, "Merged version effective date");
    requireTimestamp(version.createdAt, "Merged version created time");
    if (version.publishedAt !== null) requireTimestamp(version.publishedAt, "Merged version publication time");
    if (!Array.isArray(version.items)) fail(`Merged version ${pair.id} items must be a list.`);
    const family = families.get(pair.familyId);
    if (!family) fail(`Merged version ${pair.id} refers to a missing family.`);
    normalizeStandardItems(version.items, family, () => fail(`Merged version ${pair.id} contains an item without an ID.`), version.items);
    if (!requireCanonicalVersion(state, pair)) fail(`Recorded merge target ${pair.targetVersionId} is missing for ${pair.id}.`);
    const active = state.versions.find((candidate) => candidate.id === pair.id);
    if (active && !sameMergedVersionSourceFacts(active, version)) fail(`Version merge evidence for ${pair.id} conflicts with its active record.`);
  }
  return true;
}
