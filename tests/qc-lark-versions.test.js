import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createQCService } from "../core/qc-service.js";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";

const LARK_PACKAGE = JSON.parse(readFileSync(new URL("../data/lark-import/version-history.v1.json", import.meta.url), "utf8"));
const EFFECTIVE_AT_FIELD = "生效日期 Effective Date";
const STATUS_FIELD = "是否当前生效 Revision Status";
const DESCRIPTION_FIELD = "变更内容说明 Change Description";

function makeService() {
  let idNumber = 0;
  let timeNumber = 0;
  const adapter = createMemoryQCAdapter();
  const service = createQCService(adapter, {
    idFactory: () => `lark-test-${String(++idNumber).padStart(5, "0")}`,
    now: () => new Date(Date.UTC(2026, 8, 29, 12, 0, timeNumber++)).toISOString(),
  });
  return service;
}

async function run(service, type, data = {}) {
  const state = await service.getState();
  return service.command(type, data, state.revision);
}

async function installLocalReferenceDrafts(service) {
  await run(service, "installAPReferences");
  return (await service.getState()).versions.map((version) => structuredClone(version));
}

test("Lark package projections reconcile and preserve raw records through additive import and backup", async () => {
  assert.equal(LARK_PACKAGE.report.counts.records, 23);
  assert.deepEqual(LARK_PACKAGE.report.counts.recordsByFamily, { "s11-s14": 11, s15: 12 });
  assert.equal(LARK_PACKAGE.report.counts.includedSpecRows, 120);
  assert.equal(LARK_PACKAGE.report.counts.excludedVersionRecords, 15);

  const service = makeService();
  await service.initialize();
  const oldDrafts = await installLocalReferenceDrafts(service);
  const oldBackup = await service.exportBackup();
  const result = await run(service, "importLarkVersionHistory", { package: LARK_PACKAGE });
  assert.deepEqual(result.counts, {
    addedVersions: 23,
    skippedVersions: 0,
    addedSourceRows: 120,
    skippedSourceRows: 0,
  });

  const state = await service.getState();
  assert.equal(state.versions.length, 25);
  assert.deepEqual(state.versions.filter((version) => oldDrafts.some((old) => old.id === version.id)), oldDrafts);
  for (const sourceEntry of LARK_PACKAGE.records) {
    const version = state.versions.find((candidate) => candidate.id === sourceEntry.id);
    assert.ok(version, `missing source projection ${sourceEntry.id}`);
    assert.equal(version.status, "recorded");
    assert.equal(version.sequence, null);
    assert.equal(version.effectiveDate, null);
    assert.deepEqual(version.source.rawRecord, sourceEntry.rawRecord);
    assert.deepEqual(version.sourceRows.map((row) => row.rawRecord), sourceEntry.specs.map((spec) => spec.rawRecord));
  }

  const rawSpelling = state.versions.find((version) => version.familyId === "s15" && version.label === "26.4.24");
  assert.ok(rawSpelling);
  const noDate = state.versions.find((version) => version.familyId === "s15" && version.label === "26.09.05");
  assert.equal(noDate.source.rawRecord[EFFECTIVE_AT_FIELD], "2026-09-24T00:00:00.000-07:00");
  assert.deepEqual(noDate.source.rawRecord[STATUS_FIELD], ["生效中 Active"]);
  assert.equal(noDate.source.rawRecord[DESCRIPTION_FIELD], "fefe");
  assert.equal(noDate.sourceRows.length, 0);

  const exported = await service.exportBackup();
  const restoredService = makeService();
  await restoredService.initialize();
  await restoredService.importBackup(exported, 0);
  assert.deepEqual((await restoredService.getState()).versions, state.versions);

  const legacyService = makeService();
  await legacyService.initialize();
  await legacyService.importBackup(oldBackup, 0);
  assert.deepEqual((await legacyService.getState()).versions, oldDrafts);
});

test("identical Lark imports are idempotent and conflicting source records reject atomically", async () => {
  const service = makeService();
  await service.initialize();
  const first = await run(service, "importLarkVersionHistory", { package: LARK_PACKAGE });
  const imported = await service.getState();

  const repeated = await run(service, "importLarkVersionHistory", { package: LARK_PACKAGE });
  assert.equal(repeated.revision, imported.revision);
  assert.deepEqual(repeated.counts, {
    addedVersions: 0,
    skippedVersions: 23,
    addedSourceRows: 0,
    skippedSourceRows: 120,
  });
  assert.deepEqual(await service.getState(), imported);

  const conflictingPackage = structuredClone(LARK_PACKAGE);
  const changedEntry = conflictingPackage.records[0];
  changedEntry.changeDescription = "Changed source description";
  changedEntry.rawRecord[DESCRIPTION_FIELD] = "Changed source description";
  await assert.rejects(
    run(service, "importLarkVersionHistory", { package: conflictingPackage }),
    /conflicts with existing version/i,
  );
  assert.deepEqual(await service.getState(), imported);
  assert.equal(first.revision, imported.revision);
});

test("version attachments survive backup and repeat import without changing source facts", async () => {
  const service = makeService();
  await service.initialize();
  await installLocalReferenceDrafts(service);
  await run(service, "importLarkVersionHistory", { package: LARK_PACKAGE });

  let state = await service.getState();
  const recorded = state.versions.find((version) => version.status === "recorded");
  const draft = state.versions.find((version) => version.status === "draft" && version.familyId === "s15");
  const published = state.versions.find((version) => version.status === "draft" && version.familyId === "s11-s14");
  assert.ok(recorded);
  assert.ok(draft);
  assert.ok(published);
  const sourceFacts = structuredClone({ source: recorded.source, sourceRows: recorded.sourceRows });
  await run(service, "publishVersion", { id: published.id });

  for (const version of [recorded, draft, { ...published, status: "published" }]) {
    await run(service, "addDocument", {
      name: `${version.status}-${version.id}.txt`,
      mimeType: "text/plain",
      dataUrl: "data:text/plain;base64,ZXhhbXBsZQ==",
      versionId: version.id,
    });
  }

  state = await service.getState();
  const versionAssets = state.assets.filter((asset) => asset.kind === "document" && asset.versionId);
  assert.equal(versionAssets.length, 3);
  assert.deepEqual(
    new Set(versionAssets.map((asset) => state.versions.find((version) => version.id === asset.versionId)?.status)),
    new Set(["recorded", "draft", "published"]),
  );
  const recordedAfterUpload = state.versions.find((version) => version.id === recorded.id);
  assert.deepEqual({ source: recordedAfterUpload.source, sourceRows: recordedAfterUpload.sourceRows }, sourceFacts);

  const repeated = await run(service, "importLarkVersionHistory", { package: LARK_PACKAGE });
  assert.equal(repeated.counts.skippedVersions, 23);
  assert.equal(repeated.counts.addedVersions, 0);
  state = await service.getState();
  assert.deepEqual(state.versions.find((version) => version.id === recorded.id), recordedAfterUpload);
  assert.equal(state.assets.filter((asset) => asset.kind === "document" && asset.versionId).length, 3);

  const restoredService = makeService();
  await restoredService.initialize();
  await restoredService.importBackup(await service.exportBackup(), 0);
  const restored = await restoredService.getState();
  assert.deepEqual(restored.versions, state.versions);
  assert.deepEqual(restored.assets, state.assets);
  assert.deepEqual(
    new Set(restored.assets.filter((asset) => asset.kind === "document").map((asset) => restored.versions.find((version) => version.id === asset.versionId)?.status)),
    new Set(["recorded", "draft", "published"]),
  );
});

test("recorded Lark versions cannot become operational and never supply a new batch", async () => {
  const service = makeService();
  await service.initialize();
  await installLocalReferenceDrafts(service);
  for (const version of (await service.getState()).versions) {
    await run(service, "publishVersion", { id: version.id });
  }
  await run(service, "importLarkVersionHistory", { package: LARK_PACKAGE });

  let state = await service.getState();
  const recorded = state.versions.find((version) => version.status === "recorded" && version.familyId === "s11-s14");
  await assert.rejects(run(service, "saveVersion", {
    id: recorded.id, label: recorded.label, sequence: 1, effectiveDate: "2026-09-29", notes: "", items: [],
  }), /immutable/i);
  await assert.rejects(run(service, "cloneVersion", {
    id: recorded.id, label: "Operational clone", sequence: 2, effectiveDate: "2026-09-29",
  }), /cannot be cloned/i);
  await assert.rejects(run(service, "publishVersion", { id: recorded.id }), /cannot be published/i);

  const variant = state.variants.find((item) => item.model === "S11" && item.color === "Red");
  const orderResult = await run(service, "createOrder", {
    number: "LARK-IMPORT-PO",
    date: "2026-09-29",
    supplier: "Supplier",
    notes: "",
    lines: [{ variantId: variant.id, orderedQty: 100 }],
  });
  state = await service.getState();
  const line = state.orders.find((order) => order.id === orderResult.entityId).lines[0];
  const batchData = {
    number: "LARK-IMPORT-BATCH",
    orderId: orderResult.entityId,
    lineId: line.id,
    quantity: 20,
    factory: "AP",
    stage: "OQC",
    lotNumber: "LARK-IMPORT-LOT",
    countForPO: true,
    date: "2026-09-29",
    recorder: "Inspector",
    notes: "",
  };
  await assert.rejects(run(service, "createBatch", { ...batchData, versionId: recorded.id }), /published design version/i);
  const batchResult = await run(service, "createBatch", batchData);
  const workspace = await service.getBatchWorkspace(batchResult.entityId);
  assert.equal(workspace.version.status, "published");
  assert.notEqual(workspace.version.id, recorded.id);
});
