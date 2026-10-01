import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createInitialQCState } from "../core/qc-domain.js";
import { importLarkVersionHistory } from "../core/qc-lark-versions.js";
import {
  getBatchVersionItems,
  getBatchVersionProjection,
  getBatchVersionReadiness,
  getBatchVersions,
} from "../core/qc-batch-versions.js";
import { createQCService } from "../core/qc-service.js";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";

const LARK_PACKAGE = JSON.parse(readFileSync(new URL("../data/lark-import/version-history.v1.json", import.meta.url), "utf8"));
const SAMPLING_FIELD = "抽检比例 Sampling Ratio";

function importedState() {
  const state = createInitialQCState();
  importLarkVersionHistory(state, LARK_PACKAGE);
  return state;
}

function findVersion(state, familyId, label) {
  const version = state.versions.find((candidate) => candidate.familyId === familyId && candidate.label === label);
  assert.ok(version, `missing version ${familyId} ${label}`);
  return version;
}

function makeService() {
  const adapter = createMemoryQCAdapter();
  let idNumber = 0;
  let timeNumber = 0;
  const service = createQCService(adapter, {
    idFactory: () => `batch-version-test-${String(++idNumber).padStart(5, "0")}`,
    now: () => new Date(Date.UTC(2026, 8, 29, 12, 0, timeNumber++)).toISOString(),
  });
  return { adapter, service };
}

async function run(service, type, data = {}) {
  const state = await service.getState();
  return service.command(type, data, state.revision);
}

async function importHistory(service) {
  await service.initialize();
  await run(service, "importLarkVersionHistory", { package: LARK_PACKAGE });
}

async function createOrder(service, model, number) {
  const state = await service.getState();
  const variant = state.variants.find((candidate) => candidate.model === model && candidate.color === "Red");
  const result = await run(service, "createOrder", {
    number,
    date: "2026-09-29",
    supplier: "Supplier",
    notes: "",
    lines: [{ variantId: variant.id, orderedQty: 1000 }],
  });
  const order = (await service.getState()).orders.find((candidate) => candidate.id === result.entityId);
  return { order, line: order.lines[0] };
}

test("batch versions use explicit date order and omit drafts, blank labels, and VENTUS", () => {
  const state = importedState();
  const s11 = getBatchVersions(state, "s11-s14");
  const s15 = getBatchVersions(state, "s15");
  assert.equal(s11[0].label, "26.08.19");
  assert.equal(s15[0].label, "26.09.04");
  assert.ok(!state.versions.some((version) => version.id === "lark:recvwbnjOo2r4P:s15"));

  const mixed = [
    { id: "b", familyId: "s11-s14", label: "Z", status: "superseded", sequence: 3, effectiveDate: "2026-05-01" },
    { id: "a", familyId: "s11-s14", label: "A", status: "published", sequence: 3, effectiveDate: "2026-05-01" },
    { id: "later-label-is-older", familyId: "s11-s14", label: "99.99.99", status: "published", sequence: 1, effectiveDate: "2026-04-01" },
    { id: "draft", familyId: "s11-s14", label: "Draft", status: "draft", sequence: 90, effectiveDate: "2027-01-01" },
    { id: "ventus", familyId: "s11-s14", label: " VENTUS ", status: "recorded", source: { effectiveAtRaw: "2027-01-01T00:00:00.000Z" } },
    { id: "blank", familyId: "s11-s14", label: "  ", status: "recorded", source: { effectiveAtRaw: "2027-01-01T00:00:00.000Z" } },
  ];
  state.versions.push(...mixed);
  assert.deepEqual(getBatchVersions(state, "s11-s14").slice(0, 3).map((version) => version.id), ["lark:recvuinqJdeOy9:s11-s14", "a", "b"]);
  assert.ok(!getBatchVersions(state, "s11-s14").some((version) => ["draft", "ventus", "blank"].includes(version.id)));
});

test("recorded specs project exact source facts without mutating archived rows", () => {
  const state = importedState();
  const version = findVersion(state, "s15", "26.09.04");
  const originalRows = structuredClone(version.sourceRows);
  const projection = getBatchVersionProjection(version);
  assert.equal(projection.items.length, 18);
  assert.deepEqual(projection.diagnostics, []);
  assert.deepEqual(version.sourceRows, originalRows);

  const source = version.sourceRows.find((row) => row.sourceRecordId === "recvuipF7jt2J6");
  const raw = source.rawRecord;
  const item = projection.items.find((candidate) => candidate.id === source.sourceRecordId);
  assert.ok(item);
  assert.equal(item.key, "H021");
  assert.equal(item.title, raw["项目名称 Item Name"]);
  assert.equal(item.specification, raw["规格/尺寸/检验要点 Spec & Criteria"]);
  assert.equal(item.devices, raw["检验方法/设备 Method & Equipment"]);
  assert.equal(item.factory, "AP");
  assert.equal(item.stage, "OQC");
  assert.deepEqual(item.models, ["S15"]);
  assert.equal(item.samplingPercent, 10);
  assert.equal(item.recordingRule, raw["记录比例 Recording Ratio"]);
  assert.equal(item.important, false);
  assert.equal(item.timeSeconds, null);
  assert.equal(item.procedureUrl, "");

  const readiness = getBatchVersionReadiness(version, "奥途莱 AP", "OQC成品 OQC Outgoing", "S15");
  assert.equal(readiness.ready, true);
  assert.equal(readiness.items.length, 4);
  assert.deepEqual(readiness.items.map((candidate) => candidate.key), ["H021", "H022", "H023", "H024"]);

  const empty = structuredClone(findVersion(state, "s15", "26.09.04"));
  empty.sourceRows = [];
  const emptyProjection = getBatchVersionProjection(empty);
  assert.deepEqual(emptyProjection.items, []);
  assert.equal(emptyProjection.diagnostics[0].code, "no-linked-items");
  assert.equal(getBatchVersionItems(empty).length, 0);
});

test("new batches lock current archived defaults, explicit old archives, and their standards", async () => {
  const { service } = makeService();
  await importHistory(service);
  let state = await service.getState();
  const sourceVersion = findVersion(state, "s11-s14", "26.08.19");
  const originalSourceRows = structuredClone(sourceVersion.sourceRows);
  const { order, line } = await createOrder(service, "S11", "PO-S11-ARCHIVE");

  const defaultResult = await run(service, "createBatch", {
    number: "B-S11-DEFAULT-ARCHIVE",
    orderId: order.id,
    lineId: line.id,
    quantity: 423,
    factory: "奥途莱 AP",
    stage: "OQC",
    lotNumber: "LOT-S11-DEFAULT-ARCHIVE",
    date: "2026-09-29",
    recorder: "Inspector",
  });
  const defaultWorkspace = await service.getBatchWorkspace(defaultResult.entityId);
  assert.equal(defaultWorkspace.version.id, sourceVersion.id);
  assert.equal(defaultWorkspace.version.status, "recorded");
  assert.deepEqual(defaultWorkspace.rows.map((row) => row.key), ["H025", "H026", "H027", "H028"]);
  assert.deepEqual(defaultWorkspace.rows.map((row) => row.inspectedQty), [43, 43, 43, 43]);
  assert.equal(defaultWorkspace.rows[0].title, originalSourceRows.find((row) => row.sourceRecordId === defaultWorkspace.rows[0].id).rawRecord["项目名称 Item Name"]);

  state = await service.getState();
  const oldVersion = findVersion(state, "s11-s14", "26.4.24");
  const oldResult = await run(service, "createBatch", {
    number: "B-S11-OLD-ARCHIVE",
    orderId: order.id,
    lineId: line.id,
    quantity: 423,
    factory: "AP",
    stage: "OQC",
    lotNumber: "LOT-S11-OLD-ARCHIVE",
    versionId: oldVersion.id,
    date: "2026-09-29",
    recorder: "Inspector",
  });
  const oldWorkspace = await service.getBatchWorkspace(oldResult.entityId);
  assert.equal(oldWorkspace.version.id, oldVersion.id);
  assert.deepEqual(oldWorkspace.rows.map((row) => row.key), ["H025", "H026", "H027", "H028"]);
  assert.deepEqual((await service.getState()).versions.find((version) => version.id === sourceVersion.id).sourceRows, originalSourceRows);

  const s15Version = findVersion(await service.getState(), "s15", "26.09.04");
  const s15Order = await createOrder(service, "S15", "PO-S15-ARCHIVE");
  const s15Result = await run(service, "createBatch", {
    number: "B-S15-ARCHIVE",
    orderId: s15Order.order.id,
    lineId: s15Order.line.id,
    quantity: 100,
    factory: "AP",
    stage: "OQC",
    lotNumber: "LOT-S15-ARCHIVE",
    date: "2026-09-29",
    recorder: "Inspector",
  });
  const s15Workspace = await service.getBatchWorkspace(s15Result.entityId);
  assert.equal(s15Workspace.version.id, s15Version.id);
  assert.deepEqual(s15Workspace.rows.map((row) => row.key), ["H021", "H022", "H023", "H024"]);

  const backup = await service.exportBackup();
  const restored = createQCService(createMemoryQCAdapter(), {
    idFactory: () => "restore-id",
    now: () => "2026-09-29T13:00:00.000Z",
  });
  await restored.initialize();
  await restored.importBackup(backup, 0);
  const restoredState = await restored.getState();
  assert.deepEqual(restoredState.versions.find((version) => version.id === sourceVersion.id).sourceRows, originalSourceRows);
  for (const batch of restoredState.batches) assert.equal(restoredState.versions.find((version) => version.id === batch.versionId)?.status, "recorded");
});

test("an unknown archived sampling ratio blocks batch creation instead of becoming zero", async () => {
  const { adapter, service } = makeService();
  await importHistory(service);
  const state = await service.getState();
  const version = findVersion(state, "s11-s14", "26.08.19");
  const sourceRow = version.sourceRows.find((row) => row.rawRecord["工厂 Factory"]?.[0] === "奥途莱 AP" && row.rawRecord["工序 Stage"]?.[0] === "OQC成品 OQC Outgoing");
  const { order, line } = await createOrder(service, "S11", "PO-UNKNOWN-SAMPLING");

  await adapter.transact((draft) => {
    const mutableVersion = draft.versions.find((candidate) => candidate.id === version.id);
    mutableVersion.sourceRows.find((row) => row.sourceRecordId === sourceRow.sourceRecordId).rawRecord[SAMPLING_FIELD] = null;
    return { state: draft, result: null };
  });

  const changed = await service.getState();
  const changedVersion = findVersion(changed, "s11-s14", "26.08.19");
  const changedSourceRow = changedVersion.sourceRows.find((row) => row.sourceRecordId === sourceRow.sourceRecordId);
  const projected = getBatchVersionItems(changedVersion).find((item) => item.id === sourceRow.sourceRecordId);
  assert.equal(projected.samplingPercent, null);
  assert.equal(changedSourceRow.rawRecord[SAMPLING_FIELD], null);
  assert.equal(getBatchVersionReadiness(changedVersion, "AP", "OQC", "S11").ready, false);

  await assert.rejects(run(service, "createBatch", {
    number: "B-UNKNOWN-SAMPLING",
    orderId: order.id,
    lineId: line.id,
    quantity: 100,
    factory: "AP",
    stage: "OQC",
    lotNumber: "LOT-UNKNOWN-SAMPLING",
    versionId: version.id,
    date: "2026-09-29",
    recorder: "Inspector",
  }), /explicit valid sampling percentage/i);
  assert.deepEqual((await service.getState()).batches, []);
});

test("archived URLs require HTTP or HTTPS and projection keeps unknown importance false", () => {
  const state = importedState();
  const version = structuredClone(findVersion(state, "s15", "26.09.04"));
  version.sourceRows[0].rawRecord["视频/程序链接 Video / Procedure Link"] = "javascript:alert(1)";
  version.sourceRows[1].rawRecord["视频/程序链接 Video / Procedure Link"] = "https://example.test/procedure";
  const projection = getBatchVersionProjection(version);
  assert.equal(projection.items[0].procedureUrl, "");
  assert.equal(projection.items[1].procedureUrl, "https://example.test/procedure");
  assert.ok(projection.items.every((item) => item.important === false));
});
