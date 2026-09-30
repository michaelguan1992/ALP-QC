import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";
import { createQCService } from "../core/qc-service.js";

const PDF_BYTES = Buffer.from("%PDF-1.4\n", "utf8");
const PDF_DATA_URL = `data:application/pdf;base64,${PDF_BYTES.toString("base64")}`;
const PDF_SHA256 = createHash("sha256").update(PDF_BYTES).digest("hex");
const TIMESTAMP = "2026-09-29T12:00:00.000Z";

function makePackage() {
  const source = {
    id: "source-s15-001",
    fileName: "S15-15.pdf",
    sha256: PDF_SHA256,
    pageCount: 3,
    family: "s15",
    assetId: "asset-s15-001",
    rawFileName: "S15-15.pdf",
  };
  return {
    format: "masterqc-pdf-history",
    formatVersion: 1,
    sources: [source],
    inspections: [{
      id: "inspection-s15-001-p3",
      sourceId: source.id,
      page: 3,
      printedVersion: "25.10.29",
      printedDate: "2026/09/14",
      date: "2026-09-14",
      productLabel: "S15",
      model: "S15",
      color: null,
      factory: "AP",
      stage: "IQC",
      batchQuantity: 384,
      recorder: null,
      notes: "Printed sample count differs from the calculated reference.",
      rows: [
        {
          no: 1,
          title: "Visual check",
          specification: "Inspect visible surface.",
          devices: "Visual",
          samplingPercent: 10,
          recordingRule: "Record defects.",
          timeSeconds: null,
          important: true,
          sourceInspectedQty: 5000,
          defectiveQty: 0,
          sourceDefectiveRate: 0,
          remarks: "",
          raw: { sourceInspectedQtyText: "5000", defectiveQtyText: "0", printedRateText: "0.00%" },
        },
        {
          no: 2,
          title: "Electrical check",
          specification: "",
          devices: "Meter",
          samplingPercent: null,
          recordingRule: "",
          timeSeconds: "",
          important: null,
          sourceInspectedQty: null,
          defectiveQty: null,
          sourceDefectiveRate: null,
          remarks: "—",
          raw: { sourceSamplingText: "", sourceDefectiveText: "" },
        },
      ],
      anomalies: ["Printed source sample count 5000 exceeds batch quantity 384."],
      raw: { printedHeaderQuantity: "384", printedActualSample: "5000" },
    }],
    assets: [{
      id: source.assetId,
      name: source.fileName,
      mimeType: "application/pdf",
      dataUrl: PDF_DATA_URL,
      kind: "document",
      batchId: null,
      rowId: null,
      versionId: null,
      createdAt: TIMESTAMP,
    }],
    versions: [{
      id: "history-draft-s15-25-10-29",
      familyId: "s15",
      label: "25.10.29",
      sequence: 1,
      effectiveDate: "2025-10-29",
      status: "draft",
      notes: "Historical source snapshot from S15-15.pdf page 3; printed date retained as 2026/09/14.",
      items: [{
        id: "history-item-s15-visual-1",
        key: "s15-visual-check",
        no: 1,
        title: "Visual check",
        titleZh: "外观检查",
        specification: "Inspect visible surface.",
        specificationZh: "检查可见表面。",
        devices: "Visual",
        factory: "AP",
        stage: "OQC",
        models: ["S15"],
        samplingPercent: 10,
        recordingRule: "Record defects.",
        important: false,
        timeSeconds: null,
        procedureUrl: "",
      }],
      createdAt: TIMESTAMP,
      publishedAt: null,
    }],
    anomalies: [{ id: "package-note-1", note: "Historical import only." }],
  };
}

function makeHarness(initialState = null) {
  let sequence = 0;
  const service = createQCService(createMemoryQCAdapter({ initialState }), {
    idFactory: () => `history-test-${String(++sequence).padStart(4, "0")}`,
    now: () => TIMESTAMP,
  });
  return service;
}

test("history import preserves evidence in canonical batches without creating PO accounting", async () => {
  const service = makeHarness();
  await service.initialize();
  const result = await service.importHistory(makePackage(), 0);
  const state = await service.getState();

  assert.equal(result.changed, true);
  assert.equal(result.revision, 1);
  assert.equal(state.history.sources.length, 1);
  assert.equal(state.history.inspections.length, 1);
  assert.equal(state.versions[0].status, "draft");
  assert.equal(state.versions[0].label, "25.10.29");
  assert.equal(state.history.inspections[0].factory, "AP");
  assert.equal(state.history.inspections[0].stage, "IQC");
  assert.equal(state.history.inspections[0].batchQuantity, 384);
  assert.equal(state.history.inspections[0].rows[0].sourceInspectedQty, 5000);
  assert.equal(state.history.inspections[0].rows[0].defectiveQty, 0);
  assert.equal(state.history.inspections[0].rows[1].sourceInspectedQty, null);
  assert.equal(state.history.inspections[0].rows[1].defectiveQty, null);
  assert.equal(state.history.inspections[0].rows[0].raw.sourceInspectedQtyText, "5000");
  assert.equal(state.assets[0].dataUrl, PDF_DATA_URL);
  assert.equal(state.orders.length, 0);
  assert.equal(state.batches.length, 1);
  const batch = state.batches[0];
  assert.equal(batch.id, state.history.inspections[0].id);
  assert.equal(batch.historyInspectionId, state.history.inspections[0].id);
  assert.equal(batch.kind, "historical");
  assert.equal(batch.status, "historical");
  assert.match(batch.number, /^HIST-S15-20260914-AP-IQC-[a-f0-9]{8}-P3$/);
  assert.equal(batch.familyId, "s15");
  assert.equal(batch.productLabel, "S15");
  assert.equal(batch.model, "S15");
  assert.equal(batch.color, null);
  assert.equal(batch.quantity, 384);
  assert.equal(batch.factory, "AP");
  assert.equal(batch.stage, "IQC");
  assert.equal(batch.date, "2026-09-14");
  assert.equal(batch.versionLabel, "25.10.29");
  assert.equal(batch.orderId, null);
  assert.equal(batch.lineId, null);
  assert.equal(batch.variantId, null);
  assert.equal(batch.versionId, null);
  assert.equal(batch.lotNumber, null);
  assert.equal(batch.countForPO, false);
  assert.equal(batch.releasedAt, null);
  assert.deepEqual(batch.attachmentIds, [state.history.sources[0].assetId]);
  assert.deepEqual(batch.rows[0], { ...state.history.inspections[0].rows[0], id: "historical-row-1" });
  assert.equal(batch.rows[1].sourceInspectedQty, null);
  assert.equal(batch.rows[1].defectiveQty, null);
  assert.deepEqual(batch.rows[1].raw, state.history.inspections[0].rows[1].raw);
  assert.equal(state.history.anomalies[0].note, "Historical import only.");

  const workspace = await service.getBatchWorkspace(batch.id);
  assert.equal(workspace.variant, null);
  assert.equal(workspace.version, null);
  assert.equal(workspace.order, null);
  assert.equal(workspace.rows[0].sourceDefectiveRate, 0);
  assert.equal(Object.hasOwn(workspace.rows[0], "defectiveRate"), false);
  assert.equal(workspace.attachments[0].sourcePdf, true);
  assert.equal(workspace.releaseBlockers.length, 1);
  await assert.rejects(service.command("releaseBatch", { id: batch.id }), /historical.*cannot be released/i);
  await assert.rejects(service.command("saveInspection", { batchId: batch.id, rowId: workspace.rows[0].id, defectiveQty: 0 }), /historical.*read-only/i);
  await assert.rejects(service.command("createIssue", { title: "Historical issue", batchId: batch.id, rowId: workspace.rows[0].id }), /historical.*read-only/i);

  const s15 = state.variants.find((variant) => variant.model === "S15" && variant.color === "Red");
  const order = await service.command("createOrder", {
    number: "PO-HISTORICAL-NO-COUNT",
    date: "2026-09-29",
    supplier: "Supplier",
    notes: "",
    lines: [{ variantId: s15.id, orderedQty: 1000 }],
  });
  const progress = await service.getPurchaseOrderProgress(order.entityId);
  assert.equal(progress.lines[0].releasedQty, 0);
  assert.deepEqual(progress.lines[0].batches, []);
});

test("history import is idempotent and identical records do not advance revision", async () => {
  const service = makeHarness();
  await service.initialize();
  const packageData = makePackage();
  await service.importHistory(packageData, 0);
  const beforeRepeat = await service.getState();

  const result = await service.importHistory(packageData, beforeRepeat.revision);
  const afterRepeat = await service.getState();

  assert.equal(result.changed, false);
  assert.equal(result.revision, beforeRepeat.revision);
  assert.equal(result.counts.skipped.sources, 1);
  assert.equal(result.counts.skipped.inspections, 1);
  assert.equal(result.counts.skipped.assets, 1);
  assert.equal(result.counts.skipped.versions, 1);
  assert.equal(result.counts.skipped.batches, 1);
  assert.deepEqual(afterRepeat, beforeRepeat);
});

test("initialize atomically projects legacy history once and leaves source evidence unchanged", async () => {
  const imported = makeHarness();
  await imported.initialize();
  await imported.importHistory(makePackage(), 0);
  const beforeMigration = await imported.getState();
  const legacyState = structuredClone(beforeMigration);
  legacyState.batches = [];

  const legacyService = makeHarness(legacyState);
  const migrated = await legacyService.initialize();
  assert.equal(migrated.batches.length, 1);
  assert.equal(migrated.revision, legacyState.revision + 1);
  assert.equal(migrated.audit.length, legacyState.audit.length + 1);
  assert.deepEqual(migrated.history, legacyState.history);
  assert.deepEqual(migrated.assets, legacyState.assets);
  assert.equal(migrated.batches[0].createdAt, migrated.assets[0].createdAt);

  const repeated = await legacyService.initialize();
  assert.deepEqual(repeated, migrated);
});

test("historical source PDFs stay linked while extra batch attachments remain in the library", async () => {
  const service = makeHarness();
  await service.initialize();
  await service.importHistory(makePackage(), 0);
  const before = await service.getState();
  const batch = before.batches[0];

  await assert.rejects(service.command("removeBatchAttachment", { batchId: batch.id, assetId: batch.attachmentIds[0] }), /original historical PDF.*remain attached/i);
  const added = await service.command("addBatchAttachment", {
    batchId: batch.id,
    name: "supporting-evidence.pdf",
    dataUrl: PDF_DATA_URL,
  });
  const afterAdd = await service.getState();
  assert.equal(afterAdd.history.inspections[0].rows[0].sourceInspectedQty, before.history.inspections[0].rows[0].sourceInspectedQty);
  assert.equal(afterAdd.assets.find((asset) => asset.id === batch.attachmentIds[0]).dataUrl, PDF_DATA_URL);
  assert.equal(afterAdd.batches[0].attachmentIds.length, 2);
  const workspace = await service.getBatchWorkspace(batch.id);
  assert.deepEqual(workspace.attachments.map((asset) => asset.sourcePdf), [true, false]);

  const addedAssetId = afterAdd.assets.find((asset) => asset.name === "supporting-evidence.pdf").id;
  await service.command("removeBatchAttachment", { batchId: batch.id, assetId: addedAssetId });
  const afterRemove = await service.getState();
  assert.deepEqual(afterRemove.batches[0].attachmentIds, [batch.attachmentIds[0]]);
  assert.ok(afterRemove.assets.some((asset) => asset.id === addedAssetId), "unlinked document remains in the library");
  assert.deepEqual(afterRemove.history, before.history);
});

test("history conflicts reject the full package atomically without overwriting or partially adding", async () => {
  const service = makeHarness();
  await service.initialize();
  await service.importHistory(makePackage(), 0);
  const before = await service.getState();
  const conflicting = makePackage();
  conflicting.inspections[0].notes = "Changed extraction must not replace the original import.";
  conflicting.sources.push({
    id: "source-new-conflict-package",
    fileName: "S15-new.pdf",
    sha256: PDF_SHA256,
    pageCount: 1,
    family: "s15",
    assetId: "asset-new-conflict-package",
  });
  conflicting.assets.push({ ...conflicting.assets[0], id: "asset-new-conflict-package", name: "S15-new.pdf" });
  conflicting.inspections.push({ ...conflicting.inspections[0], id: "inspection-new-conflict-package", sourceId: "source-new-conflict-package", page: 1 });

  await assert.rejects(service.importHistory(conflicting, before.revision), /conflicts with existing inspections record/i);
  assert.deepEqual(await service.getState(), before);
});

test("history package checksum is verified before any write", async () => {
  const service = makeHarness();
  await service.initialize();
  const badPackage = makePackage();
  badPackage.sources[0].sha256 = "0".repeat(64);

  await assert.rejects(service.importHistory(badPackage, 0), /SHA-256 does not match/i);
  const state = await service.getState();
  assert.equal(state.revision, 0);
  assert.equal(state.history.sources.length, 0);
  assert.equal(state.assets.length, 0);
});

test("backup round-trip retains history and legacy backups without the optional history field remain valid", async () => {
  const source = makeHarness();
  await source.initialize();
  await source.importHistory(makePackage(), 0);
  const backup = await source.exportBackup();
  const target = makeHarness();
  await target.initialize();
  await target.importBackup(backup, 0);
  const restored = await target.getState();

  assert.deepEqual(restored.history.sources, (await source.getState()).history.sources);
  assert.deepEqual(restored.history.inspections, (await source.getState()).history.inspections);
  assert.deepEqual(restored.history.anomalies, (await source.getState()).history.anomalies);
  assert.deepEqual(restored.assets, (await source.getState()).assets);
  assert.deepEqual(restored.batches, (await source.getState()).batches);
  assert.equal(restored.versions[0].status, "draft");

  const legacyHistoryBackup = structuredClone(backup);
  legacyHistoryBackup.state.batches = legacyHistoryBackup.state.batches.filter((batch) => batch.kind !== "historical");
  const legacyTarget = makeHarness();
  await legacyTarget.initialize();
  const restoredLegacy = await legacyTarget.importBackup(legacyHistoryBackup, 0);
  assert.equal(restoredLegacy.counts.added.batches, 1);
  const legacyState = await legacyTarget.getState();
  assert.equal(legacyState.batches.length, 1);
  const repeatedLegacy = await legacyTarget.importBackup(legacyHistoryBackup, legacyState.revision);
  assert.equal(repeatedLegacy.changed, false);
  assert.equal((await legacyTarget.getState()).revision, legacyState.revision);

  const independentlyImported = makeHarness();
  await independentlyImported.initialize();
  await independentlyImported.importHistory(makePackage(), 0);
  const currentBackup = await source.exportBackup();
  const currentRepeat = await independentlyImported.importBackup(currentBackup, 1);
  assert.equal(currentRepeat.changed, false);
  assert.deepEqual((await independentlyImported.getState()).batches, (await source.getState()).batches);

  const oldSource = makeHarness();
  await oldSource.initialize();
  const oldBackup = await oldSource.exportBackup();
  delete oldBackup.state.history;
  const oldTarget = makeHarness();
  await oldTarget.initialize();
  await oldTarget.importBackup(oldBackup, 0);
  assert.deepEqual((await oldTarget.getState()).history, { sources: [], inspections: [], anomalies: [] });
});

test("conflicting historical standards sequence rejects without changing records", async () => {
  const service = makeHarness();
  await service.initialize();
  const packageData = makePackage();
  await service.importHistory(packageData, 0);
  const before = await service.getState();
  const second = makePackage();
  second.versions[0].id = "history-draft-s15-sequence-conflict";
  second.versions[0].label = "Different historical draft";
  second.inspections[0].id = "different-inspection-id";
  second.inspections[0].sourceId = "source-s15-001";
  second.inspections[0].page = 2;

  await assert.rejects(service.importHistory(second, before.revision), /version sequence within a family/i);
  assert.deepEqual(await service.getState(), before);
});

test("missing-from-source rows require evidence and cannot carry copied inspection results", async () => {
  const service = makeHarness();
  await service.initialize();
  const missingRowPackage = makePackage();
  missingRowPackage.inspections[0].rows.push({
    no: 3,
    title: "Pressure gauge",
    specification: "Confirm pressure is stable.",
    devices: "Pressure gauge",
    samplingPercent: 10,
    recordingRule: "Record the reading.",
    timeSeconds: null,
    important: null,
    sourceInspectedQty: null,
    defectiveQty: null,
    sourceDefectiveRate: null,
    remarks: "",
    status: "missing-from-source",
    missingEvidence: "Same printed version on a later UI OQC page contains item 3; no result is present on this source page.",
  });
  await service.importHistory(missingRowPackage, 0);
  const imported = await service.getState();
  assert.equal(imported.history.inspections[0].rows[2].status, "missing-from-source");
  assert.equal(imported.history.inspections[0].rows[2].defectiveQty, null);

  const invalidPackage = makePackage();
  invalidPackage.inspections[0].rows[1].status = "missing-from-source";
  invalidPackage.inspections[0].rows[1].missingEvidence = "A later source page contains this row.";
  invalidPackage.inspections[0].rows[1].defectiveQty = 0;
  await assert.rejects(service.importHistory(invalidPackage, imported.revision), /must not contain copied results/i);
  assert.deepEqual(await service.getState(), imported);
});

test("backup validation rejects duplicate historical source identities", async () => {
  const source = makeHarness();
  await source.initialize();
  await source.importHistory(makePackage(), 0);
  const malformedBackup = await source.exportBackup();
  malformedBackup.state.history.sources.push({ ...malformedBackup.state.history.sources[0] });

  const target = makeHarness();
  await target.initialize();
  await assert.rejects(target.importBackup(malformedBackup, 0), /source ID .* repeated/i);
  const state = await target.getState();
  assert.equal(state.revision, 0);
  assert.equal(state.history.sources.length, 0);
  assert.equal(state.assets.length, 0);
});

test("historical batch fields are validated against source evidence and release accounting", async () => {
  const source = makeHarness();
  await source.initialize();
  await source.importHistory(makePackage(), 0);
  const malformedBackup = await source.exportBackup();
  malformedBackup.state.batches[0].countForPO = true;

  const target = makeHarness();
  await target.initialize();
  await assert.rejects(target.importBackup(malformedBackup, 0), /disagrees with its preserved source inspection evidence/i);
  const state = await target.getState();
  assert.equal(state.revision, 0);
  assert.equal(state.batches.length, 0);
});
