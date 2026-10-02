import {
  addAudit,
  BACKUP_MAX_BYTES,
  createInitialQCState,
  DOCUMENT_MAX_BYTES,
  fail,
  normalizeDataUrl,
  PHOTO_MAX_BYTES,
  ASSET_TOTAL_MAX_BYTES,
} from "./qc-domain.js";
import { createVariant, setVariantActive } from "./qc-catalog.js";
import { makeBackup, importBackup as applyBackupImport } from "./qc-backup.js";
import { importHistory as applyHistoryImport, verifyHistoryPackage, verifyHistoryStateAssets } from "./qc-history.js";
import {
  addBatchAttachment,
  addDocument,
  addIssueAttachments,
  addPhotos,
  removeBatchAttachment,
  removeIssueAttachment,
  removePhoto,
  removeRowAttachment,
  removeVersionAttachment,
  setRowAttachment,
} from "./qc-assets.js";
import { addDiscussion, closeIssue, createIssue, deleteIssue, saveIssue } from "./qc-issues.js";
import { autosaveInspection, createBatch, deleteBatch, getBatchWorkspace as readBatchWorkspace, releaseBatch, saveBatchChanges, saveBatchDetails, saveInspection } from "./qc-inspections.js";
import { createOrder, getPurchaseOrderProgress, saveOrder } from "./qc-purchasing.js";
import { createVersion, cloneVersion, installAPReferences, publishVersion, saveVersion, supersedeOutdatedAPVersions } from "./qc-standards.js";
import { clone, requireString } from "./qc-domain.js";
import { createAssetValidationCache, validateBackup, validateQCState } from "./qc-validation.js";
import { materializeHistoricalBatches } from "./qc-historical-batches.js";
import { importLarkVersionHistory } from "./qc-lark-versions.js";
import { mergeSupersededAPVersionDuplicates } from "./qc-version-merge.js";
import { removeAuthorizedS15TrialVersion, S15_TRIAL_VERSION_ID } from "./qc-version-cleanup.js";

export { PHOTO_MAX_BYTES, DOCUMENT_MAX_BYTES, ASSET_TOTAL_MAX_BYTES, BACKUP_MAX_BYTES };

const COMMANDS = new Map([
  ["createVariant", createVariant],
  ["setVariantActive", setVariantActive],
  ["createVersion", createVersion],
  ["saveVersion", saveVersion],
  ["cloneVersion", cloneVersion],
  ["publishVersion", publishVersion],
  ["installAPReferences", installAPReferences],
  ["importLarkVersionHistory", (state, data) => {
    const outcome = importLarkVersionHistory(state, data.package);
    const versionCorrection = supersedeOutdatedAPVersions(state);
    const versionMerge = mergeSupersededAPVersionDuplicates(state);
    if (!versionCorrection.versionIds.length && !versionMerge.changed) return outcome;
    const mergedDocuments = versionMerge.assetIds.length;
    return {
      ...outcome,
      changed: true,
      summary: `${outcome.summary} Superseded ${versionCorrection.versionIds.length} verified AP version${versionCorrection.versionIds.length === 1 ? "" : "s"}; merged ${versionMerge.versionIds.length} into the existing recorded history and relinked ${mergedDocuments} document${mergedDocuments === 1 ? "" : "s"}.`,
      counts: {
        ...outcome.counts,
        supersededVersions: versionCorrection.versionIds.length,
        mergedVersions: versionMerge.versionIds.length,
        relinkedDocuments: mergedDocuments,
      },
    };
  }],
  ["createOrder", createOrder],
  ["saveOrder", saveOrder],
  ["createBatch", createBatch],
  ["deleteBatch", deleteBatch],
  ["saveBatchDetails", saveBatchDetails],
  ["saveBatchChanges", saveBatchChanges],
  ["saveInspection", saveInspection],
  ["autosaveInspection", autosaveInspection],
  ["addPhotos", addPhotos],
  ["removePhoto", removePhoto],
  ["setRowAttachment", setRowAttachment],
  ["removeRowAttachment", removeRowAttachment],
  ["addBatchAttachment", addBatchAttachment],
  ["removeBatchAttachment", removeBatchAttachment],
  ["createIssue", createIssue],
  ["deleteIssue", deleteIssue],
  ["addIssueAttachments", addIssueAttachments],
  ["removeIssueAttachment", removeIssueAttachment],
  ["saveIssue", saveIssue],
  ["addDiscussion", addDiscussion],
  ["closeIssue", closeIssue],
  ["releaseBatch", releaseBatch],
  ["addDocument", addDocument],
  ["removeVersionAttachment", removeVersionAttachment],
]);

export const QC_COMMAND_TYPES = Object.freeze([...COMMANDS.keys()]);

function defaultIdFactory() {
  return globalThis.crypto.randomUUID();
}

function defaultNow() {
  return new Date().toISOString();
}

function validateExpectedRevision(expectedRevision, state) {
  if (expectedRevision === undefined || expectedRevision === null) return;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail("Expected revision must be a non-negative whole number.");
  if (expectedRevision !== state.revision) fail("This data changed since your last view. Reload the latest state and retry.");
}

function requireAdapter(adapter) {
  if (!adapter || typeof adapter.transact !== "function" || typeof adapter.readState !== "function") {
    throw new TypeError("QC service requires an adapter with readState and transact methods.");
  }
}

const ASSET_METADATA_FIELDS = [
  "id", "name", "mimeType", "kind", "batchId", "rowId", "versionId", "createdAt", "issueId", "category",
];

function isLightweightMode(options) {
  return options === "lightweight" || options?.mode === "lightweight";
}

function projectLightweightState(state, trustedAssetValidation) {
  const projected = clone(state);
  projected.assets = state.assets.map((asset) => {
    const metadata = Object.fromEntries(
      ASSET_METADATA_FIELDS.filter((field) => Object.hasOwn(asset, field)).map((field) => [field, asset[field]]),
    );
    const trusted = trustedAssetValidation?.get?.(asset.id);
    if (Number.isSafeInteger(trusted?.decodedBytes)) metadata.decodedBytes = trusted.decodedBytes;
    else if (typeof asset.dataUrl === "string") metadata.decodedBytes = normalizeDataUrl(asset.dataUrl, "Stored attachment").decodedBytes;
    if (Number.isSafeInteger(trusted?.contentRevision)) metadata.contentRevision = trusted.contentRevision;
    return metadata;
  });
  return projected;
}

function projectFullAsset(asset) {
  const projected = clone(asset);
  delete projected.contentRef;
  delete projected.contentValidation;
  delete projected.decodedBytes;
  delete projected.contentRevision;
  return projected;
}

function projectCommandChanges(type, state, entityId, auditStart) {
  const changes = {
    batches: [],
    issues: [],
    audit: clone(state.audit.slice(auditStart)),
  };
  if (type === "saveBatchChanges") {
    const batch = state.batches.find((candidate) => candidate.id === entityId);
    if (batch) changes.batches.push(clone(batch));
    changes.issues = state.issues.filter((issue) => issue.batchId === entityId).map(clone);
  } else if (type === "saveIssue") {
    const issue = state.issues.find((candidate) => candidate.id === entityId);
    if (issue) changes.issues.push(clone(issue));
  } else if (type === "createOrder" || type === "saveOrder") {
    changes.orders = state.orders.filter((order) => order.id === entityId).map(clone);
  }
  return changes;
}

function hasS15TrialCleanupAudit(state) {
  return state.audit.some((event) => event.action === "removeS15TrialVersion" && event.entityId === S15_TRIAL_VERSION_ID);
}

export function createQCService(adapter, options = {}) {
  requireAdapter(adapter);
  const idFactory = options.idFactory ?? defaultIdFactory;
  const now = options.now ?? options.clock ?? defaultNow;
  const assetValidationCache = createAssetValidationCache();
  const validationClientId = typeof options.validationClientId === "string" && options.validationClientId
    ? options.validationClientId
    : "qc-service";
  let restoreId = 0;
  let openPromise = null;

  function validationOptions(state) {
    return {
      trustedAssetValidation: trustedAssetValidation(),
      assetValidationCache,
      validationContext: {
        revision: Number.isSafeInteger(state?.revision) ? state.revision : 0,
        clientId: validationClientId,
        restoreId: String(restoreId),
      },
    };
  }

  function trustedAssetValidation() {
    return typeof adapter.getTrustedAssetValidation === "function"
      ? adapter.getTrustedAssetValidation()
      : undefined;
  }

  function validateState(state, preparedOptions = undefined) {
    return validateQCState(state, preparedOptions ?? validationOptions(state));
  }

  async function ensureOpen() {
    if (typeof adapter.initialize !== "function") return;
    if (!openPromise) {
      const validateLegacyState = async (legacyState) => {
        validateQCState(legacyState);
        if (legacyState.history?.sources?.length) await verifyHistoryStateAssets(legacyState);
      };
      openPromise = Promise.resolve().then(() => adapter.initialize({ validateLegacyState }));
    }
    await openPromise;
  }

  async function initialize(readOptions = {}) {
    const includeAssetContent = !isLightweightMode(readOptions);
    await ensureOpen();
    const existing = await adapter.readState({ includeAssetContent });
    if (existing !== null) {
      validateState(existing);
      const correctionPreview = clone(existing);
      const pendingVersionCorrection = supersedeOutdatedAPVersions(correctionPreview);
      const pendingVersionMerge = mergeSupersededAPVersionDuplicates(correctionPreview);
      const pendingTrialCleanup = removeAuthorizedS15TrialVersion(correctionPreview);
      if (existing.history?.inspections?.length || pendingVersionCorrection.versionIds.length || pendingVersionMerge.changed || pendingTrialCleanup.versionIds.length) {
        await adapter.transact((current) => {
          if (current === null) return { state: createInitialQCState(), result: null };
          validateState(current);
          const state = clone(current);
          const migration = state.history?.inspections?.length
            ? materializeHistoricalBatches(state)
            : { added: 0 };
          const versionCorrection = supersedeOutdatedAPVersions(state);
          const versionMerge = mergeSupersededAPVersionDuplicates(state);
          const trialCleanup = removeAuthorizedS15TrialVersion(state);
          if (migration.added === 0 && versionCorrection.versionIds.length === 0 && !versionMerge.changed && trialCleanup.versionIds.length === 0) return { state: current, result: null };
          state.revision += 1;
          if (migration.added > 0) {
            addAudit(state, {
              idFactory,
              now,
              action: "migrateHistoricalBatches",
              entityId: "historical-batch-migration",
              summary: `Added ${migration.added} canonical historical batch record${migration.added === 1 ? "" : "s"} from preserved PDF evidence.`,
            });
          }
          if (versionCorrection.versionIds.length > 0) {
            addAudit(state, {
              idFactory,
              now,
              action: "supersedeOutdatedAPVersions",
              entityId: "ap-25.10.29-supersession",
              summary: `Marked ${versionCorrection.versionIds.length} verified AP 25.10.29 operational version${versionCorrection.versionIds.length === 1 ? "" : "s"} as superseded.`,
            });
          }
          if (versionMerge.changed) {
            addAudit(state, {
              idFactory,
              now,
              action: "mergeSupersededAPVersionDuplicates",
              entityId: "ap-25.10.29-recorded-merge",
              summary: `Merged ${versionMerge.versionIds.length} verified AP 25.10.29 PDF version${versionMerge.versionIds.length === 1 ? "" : "s"} into existing recorded source entries and relinked ${versionMerge.assetIds.length} document${versionMerge.assetIds.length === 1 ? "" : "s"}.`,
            });
          }
          if (trialCleanup.versionIds.length > 0 && !hasS15TrialCleanupAudit(state)) {
            addAudit(state, {
              idFactory,
              now,
              action: "removeS15TrialVersion",
              entityId: S15_TRIAL_VERSION_ID,
              summary: "Removed the authorized empty S15 trial version 26.09.05.",
            });
          }
          validateState(state);
          return { state, result: null };
        }, { includeAssetContent });
        const initialized = await adapter.readState({ includeAssetContent });
        return includeAssetContent ? clone(initialized) : projectLightweightState(initialized, trustedAssetValidation());
      }
      return includeAssetContent ? clone(existing) : projectLightweightState(existing, trustedAssetValidation());
    }
    await adapter.transact((current) => {
      if (current !== null) {
        validateState(current);
        return { state: current, result: null };
      }
      const state = createInitialQCState();
      validateState(state);
      return { state, result: null };
    }, { includeAssetContent });
    return getState(readOptions);
  }

  async function getState(readOptions = {}) {
    const includeAssetContent = !isLightweightMode(readOptions);
    await ensureOpen();
    const state = await adapter.readState({ includeAssetContent });
    if (state === null) return createInitialQCState();
    validateState(state);
    return includeAssetContent ? clone(state) : projectLightweightState(state, trustedAssetValidation());
  }

  async function getRevision() {
    await ensureOpen();
    if (typeof adapter.getRevision === "function") {
      const revision = await adapter.getRevision();
      return revision === null ? 0 : revision;
    }
    return (await getState({ mode: "lightweight" })).revision;
  }

  async function command(type, data = {}, expectedRevision) {
    await ensureOpen();
    const handler = COMMANDS.get(type);
    if (!handler) fail(`Unknown QC command: ${String(type)}.`);
    const includeAssetContent = type === "importLarkVersionHistory";
    return adapter.transact((current) => {
      const state = current === null ? createInitialQCState() : current;
      const currentValidation = validationOptions(state);
      validateState(state, currentValidation);
      validateExpectedRevision(expectedRevision, state);
      const outcome = handler(state, data, {
        idFactory,
        now,
        trustedAssetValidation: currentValidation.trustedAssetValidation,
      });
      const auditStart = state.audit.length;
      if (outcome.changed === false) {
        return {
          state,
          result: {
            entityId: outcome.entityId,
            revision: state.revision,
            ...(type === "autosaveInspection" || type === "saveBatchChanges" ? { changed: false } : {}),
            ...(outcome.counts ? { counts: outcome.counts } : {}),
            ...(type === "saveBatchChanges" ? { changes: projectCommandChanges(type, state, outcome.entityId, auditStart) } : {}),
          },
        };
      }
      state.revision += 1;
      addAudit(state, { idFactory, now, action: outcome.action || type, entityId: outcome.entityId, summary: outcome.summary || type });
      validateState(state, validationOptions(state));
      return {
        state,
        result: {
          entityId: outcome.entityId,
          revision: state.revision,
          ...(outcome.counts ? { counts: outcome.counts } : {}),
          ...(["saveBatchChanges", "saveIssue", "createOrder", "saveOrder"].includes(type)
            ? { changes: projectCommandChanges(type, state, outcome.entityId, auditStart) }
            : {}),
        },
      };
    }, { includeAssetContent });
  }

  async function saveBatchChanges(data, expectedRevision) {
    return command("saveBatchChanges", data, expectedRevision);
  }

  async function getAsset(assetId) {
    const id = requireString(assetId, "Asset ID", { maxLength: 160 });
    await ensureOpen();
    if (typeof adapter.readAsset === "function") {
      const asset = await adapter.readAsset(id);
      if (asset == null) return null;
      if (asset?.id !== id || typeof asset.dataUrl !== "string") fail("That attachment is no longer available.");
      return projectFullAsset(asset);
    }
    const state = await adapter.readState({ includeAssetContent: true });
    if (state === null) return null;
    validateState(state);
    const asset = state.assets.find((candidate) => candidate.id === id);
    return asset ? projectFullAsset(asset) : null;
  }

  async function getBatchWorkspace(batchId, readOptions = {}) {
    const includeAssetContent = !isLightweightMode(readOptions);
    await ensureOpen();
    const state = await adapter.readState({ includeAssetContent });
    if (state === null) return readBatchWorkspace(createInitialQCState(), batchId, { includeAssetContent });
    validateState(state);
    const contentValidation = trustedAssetValidation();
    const displayState = includeAssetContent
      ? state
      : {
        ...state,
        assets: state.assets.map((asset) => {
          const trusted = contentValidation?.get?.(asset.id);
          return trusted ? { ...asset, decodedBytes: trusted.decodedBytes, contentRevision: trusted.contentRevision } : asset;
        }),
      };
    return readBatchWorkspace(displayState, batchId, { includeAssetContent });
  }

  async function getOrderProgress(orderId) {
    const state = await getState({ mode: "lightweight" });
    return getPurchaseOrderProgress(state, orderId);
  }

  async function exportBackup() {
    const state = await getState();
    return makeBackup(state, now);
  }

  async function importBackup(backup, expectedRevision) {
    const savedBackup = clone(backup);
    if (savedBackup?.state?.history?.sources?.length) await verifyHistoryStateAssets(savedBackup.state);
    validateBackup(savedBackup);
    const omittedBackupTrial = removeAuthorizedS15TrialVersion(savedBackup.state);
    await ensureOpen();
    restoreId += 1;
    return adapter.transact((current) => {
      const state = current === null ? createInitialQCState() : current;
      validateState(state);
      validateExpectedRevision(expectedRevision, state);
      const outcome = applyBackupImport(state, savedBackup, { idFactory, now });
      const trialCleanup = removeAuthorizedS15TrialVersion(outcome.state);
      const shouldAuditCleanup = (trialCleanup.versionIds.length > 0 || omittedBackupTrial.versionIds.length > 0) &&
        !hasS15TrialCleanupAudit(outcome.state);
      if (trialCleanup.versionIds.length === 0 && !shouldAuditCleanup) {
        if (!omittedBackupTrial.versionIds.length) return { state: outcome.state, result: outcome.result };
        return {
          state: outcome.state,
          result: {
            ...outcome.result,
            counts: {
              ...outcome.result.counts,
              omittedTrialVersions: omittedBackupTrial.versionIds.length,
              removedTrialVersions: 0,
            },
          },
        };
      }

      if (!outcome.result.changed) outcome.state.revision += 1;
      if (shouldAuditCleanup) {
        addAudit(outcome.state, {
          idFactory,
          now,
          action: "removeS15TrialVersion",
          entityId: S15_TRIAL_VERSION_ID,
          summary: "Removed or omitted the authorized empty S15 trial version 26.09.05 during restore.",
        });
      }
      validateState(outcome.state);
      return {
        state: outcome.state,
        result: {
          ...outcome.result,
          changed: true,
          revision: outcome.state.revision,
          counts: {
            ...outcome.result.counts,
            omittedTrialVersions: omittedBackupTrial.versionIds.length,
            removedTrialVersions: trialCleanup.versionIds.length,
          },
        },
      };
    }, { includeAssetContent: true });
  }

  async function importHistory(historyPackage, expectedRevision) {
    const savedPackage = clone(historyPackage);
    await verifyHistoryPackage(savedPackage);
    await ensureOpen();
    restoreId += 1;
    return adapter.transact((current) => {
      const state = current === null ? createInitialQCState() : current;
      validateState(state);
      validateExpectedRevision(expectedRevision, state);
      const outcome = applyHistoryImport(state, savedPackage, { idFactory, now });
      return { state: outcome.state, result: outcome.result };
    }, { includeAssetContent: true });
  }

  return Object.freeze({
    initialize,
    getState,
    getRevision,
    command,
    saveBatchChanges,
    getAsset,
    getBatchWorkspace,
    getPurchaseOrderProgress: getOrderProgress,
    exportBackup,
    importBackup,
    importHistory,
    close: typeof adapter.close === "function" ? () => adapter.close() : async () => undefined,
  });
}
