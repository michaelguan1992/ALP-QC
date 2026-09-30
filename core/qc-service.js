import {
  addAudit,
  BACKUP_MAX_BYTES,
  createInitialQCState,
  DOCUMENT_MAX_BYTES,
  fail,
  PHOTO_MAX_BYTES,
  ASSET_TOTAL_MAX_BYTES,
} from "./qc-domain.js";
import { createVariant, setVariantActive } from "./qc-catalog.js";
import { makeBackup, importBackup as applyBackupImport } from "./qc-backup.js";
import { importHistory as applyHistoryImport, verifyHistoryPackage, verifyHistoryStateAssets } from "./qc-history.js";
import { addBatchAttachment, addDocument, addPhotos, removeBatchAttachment, removePhoto, removeVersionAttachment } from "./qc-assets.js";
import { addDiscussion, closeIssue, createIssue, saveIssue } from "./qc-issues.js";
import { createBatch, getBatchWorkspace as readBatchWorkspace, releaseBatch, saveBatchDetails, saveInspection } from "./qc-inspections.js";
import { createOrder, getPurchaseOrderProgress, saveOrder } from "./qc-purchasing.js";
import { createVersion, cloneVersion, installAPReferences, publishVersion, saveVersion } from "./qc-standards.js";
import { clone } from "./qc-domain.js";
import { validateQCState } from "./qc-validation.js";
import { materializeHistoricalBatches } from "./qc-historical-batches.js";
import { importLarkVersionHistory } from "./qc-lark-versions.js";

export { PHOTO_MAX_BYTES, DOCUMENT_MAX_BYTES, ASSET_TOTAL_MAX_BYTES, BACKUP_MAX_BYTES };

const COMMANDS = new Map([
  ["createVariant", createVariant],
  ["setVariantActive", setVariantActive],
  ["createVersion", createVersion],
  ["saveVersion", saveVersion],
  ["cloneVersion", cloneVersion],
  ["publishVersion", publishVersion],
  ["installAPReferences", installAPReferences],
  ["importLarkVersionHistory", (state, data) => importLarkVersionHistory(state, data.package)],
  ["createOrder", createOrder],
  ["saveOrder", saveOrder],
  ["createBatch", createBatch],
  ["saveBatchDetails", saveBatchDetails],
  ["saveInspection", saveInspection],
  ["addPhotos", addPhotos],
  ["removePhoto", removePhoto],
  ["addBatchAttachment", addBatchAttachment],
  ["removeBatchAttachment", removeBatchAttachment],
  ["createIssue", createIssue],
  ["saveIssue", saveIssue],
  ["addDiscussion", addDiscussion],
  ["closeIssue", closeIssue],
  ["releaseBatch", releaseBatch],
  ["addDocument", addDocument],
  ["removeVersionAttachment", removeVersionAttachment],
]);

function defaultIdFactory() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [...bytes].map((byte, index) => `${[4, 6, 8, 10].includes(index) ? "-" : ""}${byte.toString(16).padStart(2, "0")}`).join("");
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

export function createQCService(adapter, options = {}) {
  requireAdapter(adapter);
  const idFactory = options.idFactory ?? defaultIdFactory;
  const now = options.now ?? options.clock ?? defaultNow;
  let openPromise = null;

  async function ensureOpen() {
    if (typeof adapter.initialize !== "function") return;
    if (!openPromise) openPromise = Promise.resolve().then(() => adapter.initialize());
    await openPromise;
  }

  async function initialize() {
    await ensureOpen();
    const existing = await adapter.readState();
    if (existing !== null) {
      validateQCState(existing);
      if (existing.history?.inspections?.length) {
        await adapter.transact((current) => {
          if (current === null) return { state: createInitialQCState(), result: null };
          validateQCState(current);
          const state = clone(current);
          const migration = materializeHistoricalBatches(state);
          if (migration.added === 0) return { state: current, result: null };
          state.revision += 1;
          addAudit(state, {
            idFactory,
            now,
            action: "migrateHistoricalBatches",
            entityId: "historical-batch-migration",
            summary: `Added ${migration.added} canonical historical batch record${migration.added === 1 ? "" : "s"} from preserved PDF evidence.`,
          });
          validateQCState(state);
          return { state, result: null };
        });
        return clone(await adapter.readState());
      }
      return clone(existing);
    }
    await adapter.transact((current) => {
      if (current !== null) {
        validateQCState(current);
        return { state: current, result: null };
      }
      const state = createInitialQCState();
      validateQCState(state);
      return { state, result: null };
    });
    return getState();
  }

  async function getState() {
    await ensureOpen();
    const state = await adapter.readState();
    if (state === null) return createInitialQCState();
    validateQCState(state);
    return clone(state);
  }

  async function command(type, data = {}, expectedRevision) {
    await ensureOpen();
    const handler = COMMANDS.get(type);
    if (!handler) fail(`Unknown QC command: ${String(type)}.`);
    return adapter.transact((current) => {
      const state = current === null ? createInitialQCState() : current;
      validateQCState(state);
      validateExpectedRevision(expectedRevision, state);
      const outcome = handler(state, data, { idFactory, now });
      if (outcome.changed === false) {
        return { state, result: { entityId: outcome.entityId, revision: state.revision, ...(outcome.counts ? { counts: outcome.counts } : {}) } };
      }
      state.revision += 1;
      addAudit(state, { idFactory, now, action: outcome.action || type, entityId: outcome.entityId, summary: outcome.summary || type });
      validateQCState(state);
      return { state, result: { entityId: outcome.entityId, revision: state.revision, ...(outcome.counts ? { counts: outcome.counts } : {}) } };
    });
  }

  async function getBatchWorkspace(batchId) {
    const state = await getState();
    return readBatchWorkspace(state, batchId);
  }

  async function getOrderProgress(orderId) {
    const state = await getState();
    return getPurchaseOrderProgress(state, orderId);
  }

  async function exportBackup() {
    const state = await getState();
    return makeBackup(state, now);
  }

  async function importBackup(backup, expectedRevision) {
    const savedBackup = clone(backup);
    if (savedBackup?.state?.history?.sources?.length) await verifyHistoryStateAssets(savedBackup.state);
    await ensureOpen();
    return adapter.transact((current) => {
      const state = current === null ? createInitialQCState() : current;
      validateQCState(state);
      validateExpectedRevision(expectedRevision, state);
      const outcome = applyBackupImport(state, savedBackup, { idFactory, now });
      return { state: outcome.state, result: outcome.result };
    });
  }

  async function importHistory(historyPackage, expectedRevision) {
    const savedPackage = clone(historyPackage);
    await verifyHistoryPackage(savedPackage);
    await ensureOpen();
    return adapter.transact((current) => {
      const state = current === null ? createInitialQCState() : current;
      validateQCState(state);
      validateExpectedRevision(expectedRevision, state);
      const outcome = applyHistoryImport(state, savedPackage, { idFactory, now });
      return { state: outcome.state, result: outcome.result };
    });
  }

  return Object.freeze({
    initialize,
    getState,
    command,
    getBatchWorkspace,
    getPurchaseOrderProgress: getOrderProgress,
    exportBackup,
    importBackup,
    importHistory,
    close: typeof adapter.close === "function" ? () => adapter.close() : async () => undefined,
  });
}
