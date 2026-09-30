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
  const allowSeedAdoption = pristineGeneratedCatalog(target);
  const counts = {
    added: Object.fromEntries(COLLECTIONS.map((collection) => [collection, 0])),
    skipped: Object.fromEntries(COLLECTIONS.map((collection) => [collection, 0])),
    adoptedSeedVariants: 0,
  };
  for (const collection of ["historySources", "historyInspections", "historyAnomalies"]) {
    counts.added[collection] = 0;
    counts.skipped[collection] = 0;
  }

  for (const collection of COLLECTIONS) {
    mergeCollection(target[collection], backup.state[collection], collection, counts, allowSeedAdoption);
  }

  if (backup.state.history) {
    target.history ??= { sources: [], inspections: [], anomalies: [] };
    target.history.anomalies ??= [];
    mergeCollection(target.history.sources, backup.state.history.sources, "historySources", counts, false);
    mergeCollection(target.history.inspections, backup.state.history.inspections, "historyInspections", counts, false);
    for (const anomaly of backup.state.history.anomalies ?? []) {
      if (target.history.anomalies.some((existing) => deepEqual(existing, anomaly))) counts.skipped.historyAnomalies += 1;
      else {
        target.history.anomalies.push(clone(anomaly));
        counts.added.historyAnomalies += 1;
      }
    }
  }

  const projections = materializeHistoricalBatches(target);
  counts.added.batches += projections.added;

  const addedCount = Object.values(counts.added).reduce((total, count) => total + count, 0);
  if (addedCount === 0 && counts.adoptedSeedVariants === 0) {
    validateQCState(target);
    return { state: target, result: { entityId: "backup-import", changed: false, counts, revision: target.revision } };
  }

  target.revision += 1;
  addAudit(target, {
    idFactory: context.idFactory,
    now: context.now,
    action: "importBackup",
    entityId: "backup-import",
    summary: `Imported ${addedCount} records from a validated backup and materialized ${projections.added} historical batches; adopted ${counts.adoptedSeedVariants} initial catalog preferences.`,
  });
  validateQCState(target);
  return { state: target, result: { entityId: "backup-import", changed: true, counts, revision: target.revision } };
}
