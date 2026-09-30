import test from "node:test";
import assert from "node:assert/strict";
import { latestPublishedVersion, supersedeOutdatedAPVersions } from "../core/qc-standards.js";
import { createQCService } from "../core/qc-service.js";
import { validateBackup, validateQCState } from "../core/qc-validation.js";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";

const TARGETS = [
  { id: "history-version-28472835a7113e44c0de60c15607f7cdf7fc82bc", familyId: "s11-s14" },
  { id: "history-version-cac6c73b7872b4fdf9493ec4c66d4509e12b9e0c", familyId: "s15" },
];
const DATE = "2026-09-03";
const PDF_URL = "data:application/pdf;base64,JVBERi0xLjQK";

async function makeScenario() {
  const adapter = createMemoryQCAdapter();
  let idNumber = 0;
  let timeNumber = 0;
  const service = createQCService(adapter, {
    idFactory: () => `superseded-test-${String(++idNumber).padStart(4, "0")}`,
    now: () => new Date(Date.UTC(2026, 8, 3, 12, 0, timeNumber++)).toISOString(),
  });
  await service.initialize();
  async function run(type, data = {}) {
    const state = await service.getState();
    return service.command(type, data, state.revision);
  }

  await run("installAPReferences");
  await adapter.transact((state) => {
    for (const target of TARGETS) {
      const version = state.versions.find((candidate) => candidate.familyId === target.familyId);
      version.id = target.id;
      version.label = "25.10.29";
      version.effectiveDate = DATE;
      version.notes = "Historical source reference draft. Source SHA-256: fixture-hash.";
    }
    return { state, result: null };
  });

  for (const target of TARGETS) {
    await run("addDocument", {
      name: `${target.familyId}.pdf`,
      mimeType: "application/pdf",
      dataUrl: PDF_URL,
      versionId: target.id,
    });
  }

  await run("publishVersion", { id: TARGETS[0].id });
  const orderResult = await run("createOrder", {
    number: "PO-SUPERSEDED",
    date: DATE,
    supplier: "Supplier",
    notes: "",
    lines: [{ variantId: "10000000-0000-4000-8000-000000000111", orderedQty: 1000 }],
  });
  const beforeBatch = await service.getState();
  const order = beforeBatch.orders.find((candidate) => candidate.id === orderResult.entityId);
  const batchResult = await run("createBatch", {
    number: "B-SUPERSEDED-LOCK",
    orderId: order.id,
    lineId: order.lines[0].id,
    quantity: 100,
    factory: "AP",
    stage: "OQC",
    lotNumber: "LOT-SUPERSEDED-LOCK",
    countForPO: false,
    versionId: TARGETS[0].id,
    date: DATE,
    recorder: "Inspector",
    notes: "Locked before the later status correction.",
  });

  const preCorrectionBackup = await service.exportBackup();
  validateBackup(preCorrectionBackup);
  const before = await service.getState();
  assert.equal(before.versions.find((version) => version.id === TARGETS[0].id).status, "published");
  assert.equal(before.versions.find((version) => version.id === TARGETS[1].id).status, "draft");
  return { adapter, service, run, batchId: batchResult.entityId, before, preCorrectionBackup };
}

test("initialization supersedes only the two verified AP versions and preserves their records", async () => {
  const scenario = await makeScenario();
  const { service, before, batchId } = scenario;
  const corrected = await service.initialize();

  assert.equal(corrected.revision, before.revision + 1);
  assert.deepEqual(corrected.versions.map((version) => version.status), ["superseded", "superseded"]);
  for (const target of TARGETS) {
    const previous = before.versions.find((version) => version.id === target.id);
    const current = corrected.versions.find((version) => version.id === target.id);
    assert.equal(current.familyId, target.familyId);
    assert.equal(current.label, "25.10.29");
    assert.equal(current.effectiveDate, DATE);
    assert.equal(current.publishedAt, previous.publishedAt);
    const { status: _oldStatus, ...previousFacts } = previous;
    const { status: _newStatus, ...currentFacts } = current;
    assert.deepEqual(currentFacts, previousFacts);
  }
  assert.ok(corrected.versions.find((version) => version.id === TARGETS[0].id).publishedAt);
  assert.equal(corrected.versions.find((version) => version.id === TARGETS[1].id).publishedAt, null);
  for (const collection of ["families", "variants", "orders", "batches", "issues", "assets", "history"]) {
    assert.deepEqual(corrected[collection], before[collection], `${collection} must remain unchanged`);
  }
  assert.deepEqual(corrected.audit.slice(0, -1), before.audit);
  assert.equal(corrected.audit.at(-1).action, "supersedeOutdatedAPVersions");
  assert.equal(corrected.audit.at(-1).entityId, "ap-25.10.29-supersession");
  assert.deepEqual(corrected.audit.at(-1).summary, "Marked 2 verified AP 25.10.29 operational versions as superseded.");

  const workspace = await service.getBatchWorkspace(batchId);
  assert.equal(workspace.batch.versionId, TARGETS[0].id);
  assert.equal(workspace.rows.length, before.batches[0].rows.length);
  assert.equal(latestPublishedVersion(corrected, "s11-s14"), null);
  assert.equal(latestPublishedVersion(corrected, "s15"), null);

  const afterSecondInitialize = await service.initialize();
  assert.deepEqual(afterSecondInitialize, corrected, "the correction must be idempotent");
  validateBackup(await service.exportBackup());
});

test("superseded versions can supply new batches but cannot be edited or republished", async () => {
  const { service, run } = await makeScenario();
  await service.initialize();
  const corrected = await service.getState();
  const order = corrected.orders[0];
  const revisionAfterCorrection = corrected.revision;

  const s11Batch = await run("createBatch", {
    number: "B-SUPERSEDED-EXPLICIT",
    orderId: order.id,
    lineId: order.lines[0].id,
    quantity: 100,
    factory: "AP",
    stage: "OQC",
    lotNumber: "LOT-SUPERSEDED-EXPLICIT",
    countForPO: false,
    versionId: TARGETS[0].id,
    date: DATE,
    recorder: "Inspector",
  });
  assert.equal((await service.getBatchWorkspace(s11Batch.entityId)).version.status, "superseded");

  const s15Variant = corrected.variants.find((item) => item.model === "S15" && item.color === "Red");
  const s15OrderResult = await run("createOrder", {
    number: "PO-SUPERSEDED-S15",
    date: DATE,
    supplier: "Supplier",
    notes: "",
    lines: [{ variantId: s15Variant.id, orderedQty: 1000 }],
  });
  const s15Order = (await service.getState()).orders.find((candidate) => candidate.id === s15OrderResult.entityId);
  const s15Batch = await run("createBatch", {
    number: "B-SUPERSEDED-DEFAULT",
    orderId: s15Order.id,
    lineId: s15Order.lines[0].id,
    quantity: 100,
    factory: "奥途莱 AP",
    stage: "OQC",
    lotNumber: "LOT-SUPERSEDED-DEFAULT",
    countForPO: false,
    versionId: TARGETS[1].id,
    date: DATE,
    recorder: "Inspector",
  });
  assert.equal((await service.getBatchWorkspace(s15Batch.entityId)).version.status, "superseded");
  assert.equal((await service.getState()).versions.find((version) => version.id === TARGETS[1].id).publishedAt, null);

  await assert.rejects(run("saveVersion", { id: TARGETS[0].id }), /Superseded.*immutable/i);
  await assert.rejects(run("publishVersion", { id: TARGETS[1].id }), /Superseded.*cannot be published/i);
  assert.equal((await service.getState()).revision, revisionAfterCorrection + 3);
});

test("locked batches remain valid when a superseded version has no publication timestamp", async () => {
  const { service, batchId } = await makeScenario();
  const corrected = await service.initialize();
  validateQCState(corrected);
  assert.equal((await service.getBatchWorkspace(batchId)).batch.versionId, TARGETS[0].id);

  const invalid = structuredClone(corrected);
  invalid.versions.find((version) => version.id === TARGETS[0].id).publishedAt = null;
  assert.doesNotThrow(() => validateQCState(invalid));
});

test("the status correction is exact and guarded by identity, label, family, and source note", () => {
  const makeCandidate = (changes = {}) => ({
    id: TARGETS[0].id,
    familyId: TARGETS[0].familyId,
    label: "25.10.29",
    notes: "Historical source reference draft. Source SHA-256: source-hash.",
    status: "draft",
    ...changes,
  });
  const cases = [
    makeCandidate({ id: `${TARGETS[0].id}-other` }),
    makeCandidate({ familyId: "s15" }),
    makeCandidate({ label: "25.10.30" }),
    makeCandidate({ notes: "Ordinary unrelated business note." }),
    makeCandidate({ status: "recorded" }),
  ];
  for (const candidate of cases) {
    const state = { versions: [structuredClone(candidate)] };
    const before = structuredClone(state);
    assert.deepEqual(supersedeOutdatedAPVersions(state), { versionIds: [] });
    assert.deepEqual(state, before);
  }

  const eligible = { versions: [makeCandidate()] };
  assert.deepEqual(supersedeOutdatedAPVersions(eligible), { versionIds: [TARGETS[0].id] });
  assert.equal(eligible.versions[0].status, "superseded");
});

test("legacy published/draft backups remain valid and superseded records round-trip with attachments", async () => {
  const { service, preCorrectionBackup } = await makeScenario();
  validateBackup(preCorrectionBackup);
  await service.initialize();
  const backup = await service.exportBackup();
  validateBackup(backup);

  const restoredService = createQCService(createMemoryQCAdapter(), { idFactory: () => "restore-id", now: () => `${DATE}T13:00:00.000Z` });
  await restoredService.initialize();
  await restoredService.importBackup(backup, 0);
  const restored = await restoredService.getState();
  validateQCState(restored);
  for (const target of TARGETS) {
    assert.equal(restored.versions.find((version) => version.id === target.id).status, "superseded");
  }
  assert.deepEqual(restored.assets, backup.state.assets);
  assert.deepEqual(restored.batches, backup.state.batches);
});
