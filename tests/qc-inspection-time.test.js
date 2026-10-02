import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createQCService } from "../core/qc-service.js";
import { validateBackup, validateQCState } from "../core/qc-validation.js";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";
import { createSQLiteQCAdapter } from "../storage/sqlite-qc-adapter.mjs";

const DATE = "2026-10-01";
const PNG_URL = "data:image/png;base64,iVBORw0KGgo=";

function makeService(adapter = createMemoryQCAdapter()) {
  let idNumber = 0;
  return createQCService(adapter, {
    idFactory: () => `inspection-time-${String(++idNumber).padStart(5, "0")}`,
    now: () => "2026-10-01T12:00:00.000Z",
  });
}

test("average per-unit time is a saved-query projection and does not enter persisted rows", async () => {
  const service = makeService();
  const { batch } = await prepareBatch(service, { batchNumber: "B-AVERAGE-TIME", orderNumber: "PO-AVERAGE-TIME" });
  const initial = await service.getBatchWorkspace(batch.id);
  const initialRow = initial.rows[0];
  assert.equal(initialRow.averageTimePerUnitSeconds, null);
  assert.ok(initialRow.inspectedQty > 0);

  let state = await service.getState();
  await service.command("saveInspection", {
    batchId: batch.id,
    rowId: initialRow.id,
    actualTimeSeconds: 0,
    defectiveQty: 0,
    remarks: "",
  }, state.revision);
  let workspace = await service.getBatchWorkspace(batch.id);
  let row = workspace.rows.find((candidate) => candidate.id === initialRow.id);
  assert.equal(row.averageTimePerUnitSeconds, 0);
  state = await service.getState();
  let persisted = state.batches.find((candidate) => candidate.id === batch.id).rows.find((candidate) => candidate.id === initialRow.id);
  assert.equal(Object.hasOwn(persisted, "averageTimePerUnitSeconds"), false);

  await service.command("saveInspection", {
    batchId: batch.id,
    rowId: initialRow.id,
    actualTimeSeconds: 1.75,
    defectiveQty: 0,
    remarks: "",
  }, state.revision);
  workspace = await service.getBatchWorkspace(batch.id);
  row = workspace.rows.find((candidate) => candidate.id === initialRow.id);
  assert.equal(row.averageTimePerUnitSeconds, 1.75 / row.inspectedQty);
  assert.equal(row.timeSeconds, initialRow.timeSeconds, "the locked standard time stays independent");
  state = await service.getState();
  persisted = state.batches.find((candidate) => candidate.id === batch.id).rows.find((candidate) => candidate.id === initialRow.id);
  assert.equal(Object.hasOwn(persisted, "averageTimePerUnitSeconds"), false);
});

async function prepareBatch(service, { batchNumber = "B-ACTUAL-TIME", orderNumber = "PO-ACTUAL-TIME", date = DATE } = {}) {
  let state = await service.initialize();
  await service.command("installAPReferences", {}, state.revision);
  state = await service.getState();
  const version = state.versions.find((candidate) => candidate.familyId === "s15");
  await service.command("publishVersion", { id: version.id }, state.revision);
  state = await service.getState();
  const variant = state.variants.find((candidate) => candidate.model === "S15" && candidate.color === "Red");
  const orderResult = await service.command("createOrder", {
    number: orderNumber,
    date,
    supplier: "Supplier",
    notes: "",
    lines: [{ variantId: variant.id, orderedQty: 100 }],
  }, state.revision);
  state = await service.getState();
  const order = state.orders.find((candidate) => candidate.id === orderResult.entityId);
  const batchResult = await service.command("createBatch", {
    number: batchNumber,
    orderId: order.id,
    lineId: order.lines[0].id,
    quantity: 100,
    versionId: version.id,
    factory: "AP",
    stage: "OQC",
    date,
    recorder: "Inspector",
  }, state.revision);
  const batch = (await service.getState()).batches.find((candidate) => candidate.id === batchResult.entityId);
  return { batch, order, variant, version };
}

test("saving inspection time requires a finite non-negative value and rejects invalid input atomically", async () => {
  const service = makeService();
  const { batch, version } = await prepareBatch(service);
  const workspace = await service.getBatchWorkspace(batch.id);
  const row = workspace.rows[0];
  const standardTime = version.items.find((item) => item.id === row.sourceItemId)?.timeSeconds ?? row.timeSeconds;
  assert.equal(row.actualTimeSeconds, null);

  const invalidInputs = [
    {},
    { actualTimeSeconds: "" },
    { actualTimeSeconds: "   " },
    { actualTimeSeconds: null },
    { actualTimeSeconds: true },
    { actualTimeSeconds: false },
    { actualTimeSeconds: -0.01 },
    { actualTimeSeconds: "-1" },
    { actualTimeSeconds: Infinity },
    { actualTimeSeconds: NaN },
    { actualTimeSeconds: "Infinity" },
    { actualTimeSeconds: "not a number" },
  ];
  for (const input of invalidInputs) {
    const before = await service.getState();
    await assert.rejects(service.command("saveInspection", {
      batchId: batch.id,
      rowId: row.id,
      defectiveQty: 0,
      remarks: "",
      ...input,
    }, before.revision));
    assert.deepEqual(await service.getState(), before);
  }

  let state = await service.getState();
  await service.command("saveInspection", {
    batchId: batch.id,
    rowId: row.id,
    actualTimeSeconds: 0,
    defectiveQty: 0,
    remarks: "",
  }, state.revision);
  state = await service.getState();
  assert.equal(state.batches.find((candidate) => candidate.id === batch.id).rows[0].actualTimeSeconds, 0);

  await service.command("saveInspection", {
    batchId: batch.id,
    rowId: row.id,
    actualTimeSeconds: "1.75",
    defectiveQty: 0,
    remarks: "Measured decimal time.",
  }, state.revision);
  state = await service.getState();
  let savedRow = state.batches.find((candidate) => candidate.id === batch.id).rows[0];
  assert.equal(savedRow.actualTimeSeconds, 1.75);
  assert.equal(savedRow.timeSeconds, standardTime);

  const issueResult = await service.command("createIssue", {
    reportedBy: "Inspector",
    title: "Measured-time evidence",
    batchId: batch.id,
    rowId: row.id,
    files: [{ name: "measured-time.png", mimeType: "image/png", dataUrl: PNG_URL, category: "photo" }],
  }, state.revision);
  state = await service.getState();
  const issue = state.issues.find((candidate) => candidate.id === issueResult.entityId);
  assert.equal(issue.sourceSnapshot.row.actualTimeSeconds, 1.75);

  await service.command("saveInspection", {
    batchId: batch.id,
    rowId: row.id,
    actualTimeSeconds: 2.5,
    defectiveQty: 0,
    remarks: "Updated measurement.",
  }, state.revision);
  const refreshedWorkspace = await service.getBatchWorkspace(batch.id);
  const refreshedRow = refreshedWorkspace.rows.find((candidate) => candidate.id === row.id);
  const refreshedState = await service.getState();
  assert.equal(refreshedRow.actualTimeSeconds, 2.5);
  assert.equal(refreshedRow.timeSeconds, standardTime);
  assert.equal(refreshedState.issues.find((candidate) => candidate.id === issue.id).sourceSnapshot.row.actualTimeSeconds, 1.75);
});

test("actual inspection time and legacy missing values survive backup validation and restore", async () => {
  const source = makeService();
  const { batch } = await prepareBatch(source, { batchNumber: "B-TIME-BACKUP", orderNumber: "PO-TIME-BACKUP" });
  let state = await source.getState();
  const workspace = await source.getBatchWorkspace(batch.id);
  const savedRow = workspace.rows[0];
  await source.command("saveInspection", {
    batchId: batch.id,
    rowId: savedRow.id,
    actualTimeSeconds: 3.125,
    defectiveQty: 0,
    remarks: "",
  }, state.revision);
  const backup = await source.exportBackup();
  validateBackup(backup);
  const backupRow = backup.state.batches.find((candidate) => candidate.id === batch.id).rows.find((candidate) => candidate.id === savedRow.id);
  assert.equal(backupRow.actualTimeSeconds, 3.125);
  assert.ok(backup.state.batches.find((candidate) => candidate.id === batch.id).rows.some((row) => row.savedAt === null && row.actualTimeSeconds === null));

  const target = makeService();
  await target.initialize();
  await target.importBackup(backup, 0);
  state = await target.getState();
  assert.equal(state.batches.find((candidate) => candidate.id === batch.id).rows.find((candidate) => candidate.id === savedRow.id).actualTimeSeconds, 3.125);
  assert.ok(state.batches.find((candidate) => candidate.id === batch.id).rows.some((row) => row.savedAt === null && row.actualTimeSeconds === null));

  const legacyBackup = structuredClone(backup);
  const legacyBatch = legacyBackup.state.batches.find((candidate) => candidate.id === batch.id);
  for (const row of legacyBatch.rows) delete row.actualTimeSeconds;
  validateBackup(legacyBackup);
  const legacyTarget = makeService();
  await legacyTarget.initialize();
  await legacyTarget.importBackup(legacyBackup, 0);
  const legacyState = await legacyTarget.getState();
  const legacyRows = legacyState.batches.find((candidate) => candidate.id === batch.id).rows;
  assert.equal(Object.hasOwn(legacyRows.find((row) => row.id === savedRow.id), "actualTimeSeconds"), false);
  assert.equal(Object.hasOwn(legacyRows.find((row) => row.savedAt === null), "actualTimeSeconds"), false);
  validateQCState(legacyState);

  const invalidSavedBackup = structuredClone(backup);
  const invalidSavedRow = invalidSavedBackup.state.batches.find((candidate) => candidate.id === batch.id).rows.find((candidate) => candidate.id === savedRow.id);
  invalidSavedRow.actualTimeSeconds = null;
  assert.throws(() => validateBackup(invalidSavedBackup));
  const invalidUnsavedBackup = structuredClone(backup);
  const invalidUnsavedRow = invalidUnsavedBackup.state.batches.find((candidate) => candidate.id === batch.id).rows.find((row) => row.savedAt === null);
  invalidUnsavedRow.actualTimeSeconds = 0;
  assert.doesNotThrow(() => validateBackup(invalidUnsavedBackup), "a partial actual-time entry is valid while the row remains incomplete");
  invalidUnsavedRow.savedAt = "2026-10-01T12:00:00.000Z";
  assert.throws(() => validateBackup(invalidUnsavedBackup));
});

function makeHistoricalPackage() {
  const pdf = Buffer.from("%PDF-1.4\n", "utf8");
  const assetId = "history-asset-autosave";
  const sourceId = "history-source-autosave";
  const inspectionId = "history-inspection-autosave";
  return {
    format: "masterqc-pdf-history",
    formatVersion: 1,
    sources: [{
      id: sourceId,
      fileName: "inspection.pdf",
      sha256: createHash("sha256").update(pdf).digest("hex"),
      pageCount: 1,
      family: "s15",
      assetId,
    }],
    inspections: [{
      id: inspectionId,
      sourceId,
      page: 1,
      printedVersion: "25.10.29",
      printedDate: "2026/09/30",
      date: "2026-09-30",
      productLabel: "S15",
      model: "S15",
      color: null,
      factory: "AP",
      stage: "OQC",
      batchQuantity: 10,
      recorder: null,
      notes: "",
      rows: [{
        no: 1,
        title: "Visual check",
        specification: "Inspect the surface.",
        devices: "Visual",
        recordingRule: "Record defects.",
        remarks: "",
        samplingPercent: 10,
        timeSeconds: null,
        important: true,
        sourceInspectedQty: 1,
        defectiveQty: 0,
        sourceDefectiveRate: 0,
      }],
    }],
    assets: [{
      id: assetId,
      name: "inspection.pdf",
      mimeType: "application/pdf",
      dataUrl: `data:application/pdf;base64,${pdf.toString("base64")}`,
      kind: "document",
      batchId: null,
      rowId: null,
      versionId: null,
      createdAt: "2026-10-01T12:00:00.000Z",
    }],
    versions: [],
  };
}

test("inspection autosave persists partial rows, completes and clears results, and rejects invalid or locked writes", async () => {
  const service = makeService();
  const { batch } = await prepareBatch(service, { batchNumber: "B-AUTOSAVE", orderNumber: "PO-AUTOSAVE" });
  let state = await service.getState();
  const firstWorkspace = await service.getBatchWorkspace(batch.id);
  const row = firstWorkspace.rows[0];
  const oneDefectRate = Number(((1 / row.inspectedQty) * 100).toFixed(2));
  const basePayload = { batchId: batch.id, rowId: row.id, defectiveQty: null, actualTimeSeconds: null, remarks: "Partial note" };

  let result = await service.command("autosaveInspection", basePayload, state.revision);
  state = await service.getState();
  let storedRow = state.batches.find((candidate) => candidate.id === batch.id).rows.find((candidate) => candidate.id === row.id);
  assert.equal(result.revision, state.revision);
  assert.equal(storedRow.defectiveQty, null);
  assert.equal(storedRow.actualTimeSeconds, null);
  assert.equal(storedRow.remarks, "Partial note");
  assert.equal(storedRow.savedAt, null);

  const partialPayload = { ...basePayload, defectiveQty: 1, remarks: "Check this defect" };
  result = await service.command("autosaveInspection", partialPayload, state.revision);
  state = await service.getState();
  storedRow = state.batches.find((candidate) => candidate.id === batch.id).rows.find((candidate) => candidate.id === row.id);
  assert.equal(storedRow.defectiveQty, 1);
  assert.equal(storedRow.actualTimeSeconds, null);
  assert.equal(storedRow.savedAt, null);
  const partialWorkspace = await service.getBatchWorkspace(batch.id);
  assert.equal(partialWorkspace.rows.find((candidate) => candidate.id === row.id).defectiveQty, 1);
  assert.equal(partialWorkspace.rows.find((candidate) => candidate.id === row.id).defectiveRate, oneDefectRate);
  assert.match(partialWorkspace.releaseBlockers.join(" "), /Complete all .* inspection rows.*remain incomplete/i);
  const partialBackup = await service.exportBackup();
  validateBackup(partialBackup);
  const partialRestore = makeService();
  await partialRestore.initialize();
  await partialRestore.importBackup(partialBackup, 0);
  const restoredPartial = (await partialRestore.getBatchWorkspace(batch.id)).rows.find((candidate) => candidate.id === row.id);
  assert.equal(restoredPartial.defectiveQty, 1);
  assert.equal(restoredPartial.actualTimeSeconds, null);
  assert.equal(restoredPartial.remarks, "Check this defect");
  assert.equal(restoredPartial.savedAt, null);
  await assert.rejects(service.command("createIssue", { reportedBy: "Inspector", title: "Incomplete result", batchId: batch.id, rowId: row.id }, state.revision), /save the inspection row/i);
  await assert.rejects(service.command("releaseBatch", { id: batch.id }, state.revision), /Complete all .* inspection rows.*remain incomplete/i);

  const repeated = await service.command("autosaveInspection", partialPayload, state.revision);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.revision, state.revision);
  const beforeStale = await service.getState();
  await assert.rejects(service.command("autosaveInspection", { ...partialPayload, remarks: "Stale edit" }, state.revision - 1), /changed since your last view/i);
  assert.deepEqual(await service.getState(), beforeStale);

  const invalidPayloads = [
    { defectiveQty: 1.5 },
    { defectiveQty: -1 },
    { defectiveQty: row.inspectedQty + 1 },
    { defectiveQty: "1" },
    { actualTimeSeconds: "1.25" },
    { actualTimeSeconds: Infinity },
    { actualTimeSeconds: -0.01 },
    { remarks: null },
    { remarks: "x".repeat(5001) },
    { inspectedQty: row.inspectedQty },
  ];
  for (const invalid of invalidPayloads) {
    const before = await service.getState();
    await assert.rejects(service.command("autosaveInspection", { ...partialPayload, ...invalid }, before.revision));
    assert.deepEqual(await service.getState(), before, "invalid autosave input leaves state and revision unchanged");
  }
  for (const field of ["defectiveQty", "actualTimeSeconds", "remarks"]) {
    const incompletePayload = { ...partialPayload };
    delete incompletePayload[field];
    const before = await service.getState();
    await assert.rejects(service.command("autosaveInspection", incompletePayload, before.revision), new RegExp(field));
    assert.deepEqual(await service.getState(), before);
  }

  const newer = await prepareBatch(service, { batchNumber: "B-AUTOSAVE-HISTORY", orderNumber: "PO-AUTOSAVE-HISTORY", date: "2026-10-02" });
  const newerRow = (await service.getBatchWorkspace(newer.batch.id)).rows.find((candidate) => candidate.key === row.key);
  assert.equal(newerRow.history.some((entry) => entry.batchId === batch.id), false, "partial results do not enter later history");

  state = await service.getState();
  result = await service.command("autosaveInspection", { ...partialPayload, actualTimeSeconds: 0 }, state.revision);
  state = await service.getState();
  storedRow = state.batches.find((candidate) => candidate.id === batch.id).rows.find((candidate) => candidate.id === row.id);
  assert.equal(result.revision, state.revision);
  assert.equal(storedRow.actualTimeSeconds, 0);
  assert.notEqual(storedRow.savedAt, null);
  assert.equal((await service.getBatchWorkspace(batch.id)).rows.find((candidate) => candidate.id === row.id).defectiveRate, oneDefectRate);

  state = await service.getState();
  await service.command("autosaveInspection", { ...partialPayload, defectiveQty: 0, actualTimeSeconds: 1.25, remarks: "Decimal time" }, state.revision);
  let completeWorkspace = await service.getBatchWorkspace(batch.id);
  const completeRow = completeWorkspace.rows.find((candidate) => candidate.id === row.id);
  assert.equal(completeRow.defectiveQty, 0);
  assert.equal(completeRow.actualTimeSeconds, 1.25);
  assert.equal(completeRow.defectiveRate, 0);
  assert.notEqual(completeRow.savedAt, null);

  const newest = await prepareBatch(service, { batchNumber: "B-AUTOSAVE-HISTORY-2", orderNumber: "PO-AUTOSAVE-HISTORY-2", date: "2026-10-03" });
  const newestRow = (await service.getBatchWorkspace(newest.batch.id)).rows.find((candidate) => candidate.key === row.key);
  assert.equal(newestRow.history.some((entry) => entry.batchId === batch.id), true, "completed results enter later history");

  state = await service.getState();
  await service.command("autosaveInspection", { ...basePayload, remarks: "" }, state.revision);
  completeWorkspace = await service.getBatchWorkspace(batch.id);
  const cleared = completeWorkspace.rows.find((candidate) => candidate.id === row.id);
  assert.equal(cleared.defectiveQty, null);
  assert.equal(cleared.actualTimeSeconds, null);
  assert.equal(cleared.remarks, "");
  assert.equal(cleared.savedAt, null);
  assert.equal(cleared.defectiveRate, null);

  const backup = await service.exportBackup();
  validateBackup(backup);
  const backupRow = backup.state.batches.find((candidate) => candidate.id === batch.id).rows.find((candidate) => candidate.id === row.id);
  assert.deepEqual({ defectiveQty: backupRow.defectiveQty, actualTimeSeconds: backupRow.actualTimeSeconds, remarks: backupRow.remarks, savedAt: backupRow.savedAt }, {
    defectiveQty: null, actualTimeSeconds: null, remarks: "", savedAt: null,
  });
  const restored = makeService();
  await restored.initialize();
  await restored.importBackup(backup, 0);
  const restoredRow = (await restored.getBatchWorkspace(batch.id)).rows.find((candidate) => candidate.id === row.id);
  assert.equal(restoredRow.defectiveQty, null);
  assert.equal(restoredRow.actualTimeSeconds, null);
  assert.equal(restoredRow.remarks, "");
  assert.equal(restoredRow.savedAt, null);

  const released = await prepareBatch(service, { batchNumber: "B-AUTOSAVE-RELEASE", orderNumber: "PO-AUTOSAVE-RELEASE" });
  for (const releasedRow of (await service.getBatchWorkspace(released.batch.id)).rows) {
    const current = await service.getState();
    await service.command("autosaveInspection", {
      batchId: released.batch.id,
      rowId: releasedRow.id,
      defectiveQty: 0,
      actualTimeSeconds: 0,
      remarks: "",
    }, current.revision);
  }
  state = await service.getState();
  await service.command("releaseBatch", { id: released.batch.id }, state.revision);
  const releasedWorkspace = await service.getBatchWorkspace(released.batch.id);
  await assert.rejects(service.command("autosaveInspection", {
    batchId: released.batch.id,
    rowId: releasedWorkspace.rows[0].id,
    defectiveQty: 0,
    actualTimeSeconds: 0,
    remarks: "Late correction",
  }), /released.*read-only/i);

  const historicalService = makeService();
  const initial = await historicalService.initialize();
  const imported = await historicalService.importHistory(makeHistoricalPackage(), initial.revision);
  const historical = (await historicalService.getState()).batches[0];
  const historicalRow = historical.rows[0];
  assert.equal(imported.changed, true);
  await assert.rejects(historicalService.command("autosaveInspection", {
    batchId: historical.id,
    rowId: historicalRow.id,
    defectiveQty: 0,
    actualTimeSeconds: 0,
    remarks: "Historical edit",
  }), /historical.*read-only/i);
});

test("actual inspection time survives SQLite close and reopen and returns in the refreshed workspace", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "masterqc-time-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "workspace.sqlite");
  let service = makeService(createSQLiteQCAdapter({ databasePath }));
  const { batch, version } = await prepareBatch(service, { batchNumber: "B-TIME-SQLITE", orderNumber: "PO-TIME-SQLITE" });
  let state = await service.getState();
  const beforeSave = await service.getBatchWorkspace(batch.id);
  const row = beforeSave.rows[0];
  const standardTime = row.timeSeconds;
  await service.command("saveInspection", {
    batchId: batch.id,
    rowId: row.id,
    actualTimeSeconds: 4.375,
    defectiveQty: 0,
    remarks: "",
  }, state.revision);
  const expected = await service.getState();
  await service.close();

  service = makeService(createSQLiteQCAdapter({ databasePath }));
  await service.initialize();
  const refreshed = await service.getBatchWorkspace(batch.id);
  const reopenedRow = refreshed.rows.find((candidate) => candidate.id === row.id);
  assert.equal(reopenedRow.actualTimeSeconds, 4.375);
  assert.equal(reopenedRow.timeSeconds, standardTime);
  assert.equal(reopenedRow.timeSeconds, version.items.find((item) => item.id === row.sourceItemId)?.timeSeconds ?? standardTime);
  assert.deepEqual(await service.getState(), expected);

  const backup = await service.exportBackup();
  const restored = makeService();
  await restored.initialize();
  await restored.importBackup(backup, 0);
  assert.equal((await restored.getBatchWorkspace(batch.id)).rows.find((candidate) => candidate.id === row.id).actualTimeSeconds, 4.375);
  await service.close();
});

test("SQLite autosave preserves remarks-only, time-only, defect-only, and cleared partial rows", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "masterqc-autosave-sqlite-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "workspace.sqlite");
  let service = makeService(createSQLiteQCAdapter({ databasePath }));
  const { batch } = await prepareBatch(service, { batchNumber: "B-AUTOSAVE-SQLITE", orderNumber: "PO-AUTOSAVE-SQLITE" });
  let workspace = await service.getBatchWorkspace(batch.id);
  const originalRow = workspace.rows[0];
  const command = (values) => ({
    batchId: batch.id,
    rowId: originalRow.id,
    defectiveQty: null,
    actualTimeSeconds: null,
    remarks: "",
    ...values,
  });

  let state = await service.getState();
  await service.command("autosaveInspection", command({ remarks: "Remarks only" }), state.revision);
  let storedRow = (await service.getBatchWorkspace(batch.id)).rows.find((candidate) => candidate.id === originalRow.id);
  assert.equal(storedRow.remarks, "Remarks only");
  assert.equal(storedRow.savedAt, null);

  state = await service.getState();
  await service.command("autosaveInspection", command({ actualTimeSeconds: 0, remarks: "Zero seconds" }), state.revision);
  const backup = await service.exportBackup();
  validateBackup(backup);
  const backupRow = backup.state.batches.find((candidate) => candidate.id === batch.id).rows.find((candidate) => candidate.id === originalRow.id);
  assert.equal(backupRow.defectiveQty, null);
  assert.equal(backupRow.actualTimeSeconds, 0);
  assert.equal(backupRow.remarks, "Zero seconds");
  assert.equal(backupRow.savedAt, null);
  const restored = makeService();
  await restored.initialize();
  await restored.importBackup(backup, 0);
  const restoredRow = (await restored.getBatchWorkspace(batch.id)).rows.find((candidate) => candidate.id === originalRow.id);
  assert.equal(restoredRow.actualTimeSeconds, 0);
  assert.equal(restoredRow.remarks, "Zero seconds");
  assert.equal(restoredRow.savedAt, null);

  await service.close();
  service = makeService(createSQLiteQCAdapter({ databasePath }));
  await service.initialize();
  workspace = await service.getBatchWorkspace(batch.id);
  storedRow = workspace.rows.find((candidate) => candidate.id === originalRow.id);
  assert.equal(storedRow.defectiveQty, null);
  assert.equal(storedRow.actualTimeSeconds, 0);
  assert.equal(storedRow.remarks, "Zero seconds");
  assert.equal(storedRow.savedAt, null);

  state = await service.getState();
  await service.command("autosaveInspection", command({ actualTimeSeconds: 1.375, remarks: "Decimal seconds" }), state.revision);
  await service.close();
  service = makeService(createSQLiteQCAdapter({ databasePath }));
  await service.initialize();
  workspace = await service.getBatchWorkspace(batch.id);
  storedRow = workspace.rows.find((candidate) => candidate.id === originalRow.id);
  assert.equal(storedRow.actualTimeSeconds, 1.375);
  assert.equal(storedRow.defectiveQty, null);
  assert.equal(storedRow.remarks, "Decimal seconds");
  assert.equal(storedRow.savedAt, null);

  state = await service.getState();
  await service.command("autosaveInspection", command({ defectiveQty: 1, remarks: "Defect only" }), state.revision);
  await service.close();
  service = makeService(createSQLiteQCAdapter({ databasePath }));
  await service.initialize();
  workspace = await service.getBatchWorkspace(batch.id);
  storedRow = workspace.rows.find((candidate) => candidate.id === originalRow.id);
  assert.equal(storedRow.actualTimeSeconds, null);
  assert.equal(storedRow.defectiveQty, 1);
  assert.equal(storedRow.remarks, "Defect only");
  assert.equal(storedRow.savedAt, null);
  assert.equal(storedRow.defectiveRate, Number(((1 / storedRow.inspectedQty) * 100).toFixed(2)));

  state = await service.getState();
  await service.command("autosaveInspection", command({}), state.revision);
  const cleared = (await service.getBatchWorkspace(batch.id)).rows.find((candidate) => candidate.id === originalRow.id);
  assert.equal(cleared.actualTimeSeconds, null);
  assert.equal(cleared.defectiveQty, null);
  assert.equal(cleared.remarks, "");
  assert.equal(cleared.savedAt, null);
  assert.equal(cleared.defectiveRate, null);
  await service.close();
});
