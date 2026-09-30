import {
  addAudit,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  clone,
  createInitialQCState,
  deepEqual,
  fail,
} from "./qc-domain.js";
import { validateBackup, validateQCState } from "./qc-validation.js";
import { materializeHistoricalBatches } from "./qc-historical-batches.js";
import { supersedeOutdatedAPVersions } from "./qc-standards.js";
import {
  mergeSupersededAPVersionDuplicates,
  reconcileBackupVersionDuplicates,
  sameMergedVersionSourceFacts,
} from "./qc-version-merge.js";

const COLLECTIONS = ["families", "variants", "versions", "orders", "batches", "issues", "assets", "audit"];

function pristineGeneratedCatalog(state) {
  if (state.revision !== 0 || state.audit.length !== 0) return false;
  if (state.versions.length || state.orders.length || state.batches.length || state.issues.length || state.assets.length) return false;
  if (state.history?.sources?.length || state.history?.inspections?.length || state.history?.anomalies?.length) return false;
  const seed = createInitialQCState();
  return deepEqual(state.families, seed.families) && deepEqual(state.variants, seed.variants);
}

function canAdoptSeedVariant(target, incoming, isPristineTarget) {
  if (!isPristineTarget) return false;
  if (target.id !== incoming.id || target.active === incoming.active) return false;
  const targetWithoutActive = { ...target };
  const incomingWithoutActive = { ...incoming };
  delete targetWithoutActive.active;
  delete incomingWithoutActive.active;
  return deepEqual(targetWithoutActive, incomingWithoutActive);
}

function mergeCollection(currentItems, backupItems, collection, counts, allowSeedAdoption) {
  const byId = new Map(currentItems.map((item) => [item.id, item]));
  for (const backupItem of backupItems) {
    const existing = byId.get(backupItem.id);
    if (!existing) {
      const copy = clone(backupItem);
      currentItems.push(copy);
      byId.set(copy.id, copy);
      counts.added[collection] += 1;
      continue;
    }
    if (deepEqual(existing, backupItem)) {
      counts.skipped[collection] += 1;
      continue;
    }
    if (collection === "variants" && allowSeedAdoption && canAdoptSeedVariant(existing, backupItem, allowSeedAdoption)) {
      const index = currentItems.findIndex((item) => item.id === backupItem.id);
      currentItems[index] = clone(backupItem);
      byId.set(backupItem.id, currentItems[index]);
      counts.adoptedSeedVariants += 1;
      continue;
    }
    fail(`Backup conflicts with existing ${collection} record ${backupItem.id}; no data was imported.`);
  }
}

function mergeVersionMergeEvidence(currentItems, backupItems, counts) {
  const byId = new Map(currentItems.map((item) => [item.id, item]));
  for (const backupItem of backupItems) {
    const existing = byId.get(backupItem.id);
    if (!existing) {
      currentItems.push(clone(backupItem));
      byId.set(backupItem.id, currentItems.at(-1));
      counts.added.versionMergeEvidence += 1;
      continue;
    }
    if (existing.targetVersionId === backupItem.targetVersionId &&
      sameMergedVersionSourceFacts(existing.version, backupItem.version)) {
      counts.skipped.versionMergeEvidence += 1;
      continue;
    }
    fail(`Backup conflicts with version merge evidence ${backupItem.id}; no data was imported.`);
  }
}

export function makeBackup(state, now) {
  validateQCState(state);
  const backup = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: now(),
    state: clone(state),
  };
  validateBackup(backup);
  return backup;
}

export function importBackup(targetState, backup, context) {
  validateBackup(backup);
  const target = targetState === null ? createInitialQCState() : clone(targetState);
  validateQCState(target);
  const targetCorrection = supersedeOutdatedAPVersions(target);
  const targetMerge = mergeSupersededAPVersionDuplicates(target);
  const incomingState = clone(backup.state);
  supersedeOutdatedAPVersions(incomingState);
  const incomingMerge = mergeSupersededAPVersionDuplicates(incomingState);
  const restoredMerge = reconcileBackupVersionDuplicates(incomingState, target);
  const allowSeedAdoption = pristineGeneratedCatalog(target);
  const counts = {
    added: Object.fromEntries(COLLECTIONS.map((collection) => [collection, 0])),
    skipped: Object.fromEntries(COLLECTIONS.map((collection) => [collection, 0])),
    adoptedSeedVariants: 0,
  };
  counts.added.versionMergeEvidence = 0;
  counts.skipped.versionMergeEvidence = 0;
  counts.added.versionMergeEvidence += targetMerge.evidenceIds.length;
  for (const collection of ["historySources", "historyInspections", "historyAnomalies"]) {
    counts.added[collection] = 0;
    counts.skipped[collection] = 0;
  }

  if (target.versionMergeEvidence !== undefined || incomingState.versionMergeEvidence !== undefined) {
    target.versionMergeEvidence ??= [];
    mergeVersionMergeEvidence(target.versionMergeEvidence, incomingState.versionMergeEvidence ?? [], counts);
  }

  for (const collection of ["families", "variants", "versions", "orders", "batches", "issues"]) {
    mergeCollection(target[collection], incomingState[collection], collection, counts, allowSeedAdoption);
  }

  // Once the incoming canonical version is present, reparent current legacy assets before their
  // additive merge so the same document ID compares identically on both sides.
  const preAssetCorrection = supersedeOutdatedAPVersions(target);
  const preAssetMerge = mergeSupersededAPVersionDuplicates(target);
  counts.added.versionMergeEvidence += preAssetMerge.evidenceIds.length;

  for (const collection of ["assets", "audit"]) {
    mergeCollection(target[collection], incomingState[collection], collection, counts, allowSeedAdoption);
  }

  if (incomingState.history) {
    target.history ??= { sources: [], inspections: [], anomalies: [] };
    target.history.anomalies ??= [];
    mergeCollection(target.history.sources, incomingState.history.sources, "historySources", counts, false);
    mergeCollection(target.history.inspections, incomingState.history.inspections, "historyInspections", counts, false);
    for (const anomaly of incomingState.history.anomalies ?? []) {
      if (target.history.anomalies.some((existing) => deepEqual(existing, anomaly))) counts.skipped.historyAnomalies += 1;
      else {
        target.history.anomalies.push(clone(anomaly));
        counts.added.historyAnomalies += 1;
      }
    }
  }

  const mergedTargetCorrection = supersedeOutdatedAPVersions(target);
  const mergedTargetDuplicates = mergeSupersededAPVersionDuplicates(target);
  counts.added.versionMergeEvidence += mergedTargetDuplicates.evidenceIds.length;

  const projections = materializeHistoricalBatches(target);
  counts.added.batches += projections.added;

  const addedCount = Object.values(counts.added).reduce((total, count) => total + count, 0);
  const normalizedExistingState = targetCorrection.versionIds.length > 0 || targetMerge.changed ||
    preAssetCorrection.versionIds.length > 0 || preAssetMerge.changed ||
    mergedTargetCorrection.versionIds.length > 0 || mergedTargetDuplicates.changed;
  if (addedCount === 0 && counts.adoptedSeedVariants === 0 && !normalizedExistingState) {
    validateQCState(target);
    return { state: target, result: { entityId: "backup-import", changed: false, counts, revision: target.revision } };
  }

  target.revision += 1;
  addAudit(target, {
    idFactory: context.idFactory,
    now: context.now,
    action: "importBackup",
    entityId: "backup-import",
    summary: `Imported ${addedCount} records from a validated backup and materialized ${projections.added} historical batches; merged ${targetMerge.versionIds.length + incomingMerge.versionIds.length + restoredMerge.versionIds.length + preAssetMerge.versionIds.length + mergedTargetDuplicates.versionIds.length} duplicate AP version records and relinked ${targetMerge.assetIds.length + incomingMerge.assetIds.length + restoredMerge.assetIds.length + preAssetMerge.assetIds.length + mergedTargetDuplicates.assetIds.length} documents; adopted ${counts.adoptedSeedVariants} initial catalog preferences.`,
  });
  validateQCState(target);
  return { state: target, result: { entityId: "backup-import", changed: true, counts, revision: target.revision } };
}
