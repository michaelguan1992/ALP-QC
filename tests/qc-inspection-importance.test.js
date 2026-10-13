import assert from "node:assert/strict";
import test from "node:test";
import { createInitialQCState } from "../core/qc-domain.js";
import { getBatchWorkspace } from "../core/qc-inspections.js";
import { createQCService } from "../core/qc-service.js";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";

const CURRENT_ROW = {
  id: "operation-row-1",
  key: "H025",
  no: 1,
  title: "Air Pump Test 气泵测试 [S11/S12/S13/S14·AP·OQC]",
  specification: "Power on to check whether the air pump and EVAP knob is working properly 通电检查气泵,气压调节钮是否正常工 作",
  devices: "DC power supply 直流电源",
  factory: "AP",
  stage: "OQC",
  models: ["S11", "S12", "S13", "S14"],
  samplingPercent: 10,
  recordingRule: "0%",
  important: false,
  sourceItemId: "source-item-1",
  productLineId: "line-1",
  inspectedQty: 10,
  defectiveQty: null,
  remarks: "",
  savedAt: null,
  photoIds: [],
};

const HISTORICAL_ROW = {
  id: "history-row-1",
  no: 1,
  title: "Air Pump Test\n气泵测试",
  specification: "Power on to check whether the air pump and\nEVAP knob is working properly\n通电检查气泵，气压调节钮是否正常工 作",
  devices: "DC power\nsupply\n直流电源",
  samplingPercent: 10,
  recordingRule: "0%",
  important: true,
};

function historicalEntry(id, { row = {}, batch = {}, inspection = {}, source = {}, asset = {} } = {}) {
  const sourceAssetId = `asset-${id}`;
  const sourceId = `source-${id}`;
  const inspectionId = `inspection-${id}`;
  const sourceRow = { ...structuredClone(HISTORICAL_ROW), id: `history-row-${id}`, ...row };
  const historyInspection = {
    id: inspectionId,
    sourceId,
    page: 3,
    model: null,
    productLabel: "HyperSmoke",
    date: "2026-09-03",
    printedVersion: "26.4.24",
    factory: "AP",
    stage: "OQC",
    rows: [structuredClone(sourceRow)],
    ...inspection,
  };
  const historySource = {
    id: sourceId,
    family: "s11-s14",
    assetId: sourceAssetId,
    fileName: `${id}.pdf`,
    ...source,
  };
  const sourceAsset = {
    id: sourceAssetId,
    kind: "document",
    mimeType: "application/pdf",
    dataUrl: "data:application/pdf;base64,JVBERi0xLjQK",
    ...asset,
  };
  const historicalBatch = {
    id,
    kind: "historical",
    historyInspectionId: inspectionId,
    familyId: "s11-s14",
    model: historyInspection.model,
    productLabel: historyInspection.productLabel,
    date: historyInspection.date,
    versionLabel: historyInspection.printedVersion,
    factory: historyInspection.factory,
    stage: historyInspection.stage,
    number: `HIST-${id}`,
    rows: [structuredClone(sourceRow)],
    attachmentIds: [historySource.assetId],
    ...batch,
  };
  return { batch: historicalBatch, inspection: historyInspection, source: historySource, asset: sourceAsset };
}

function makeState({
  row = {},
  currentModel = "S11",
  sourceRawRecord = {},
  sourceRows,
  versionStatus = "recorded",
  historical = [historicalEntry("evidence-1")],
} = {}) {
  const currentRow = { ...structuredClone(CURRENT_ROW), ...row };
  const entries = historical;
  const sourceProductIds = ["product-s11", "product-s12", "product-s13", "product-s14"];
  const sourceRaw = {
    "历史项目编号 History Item Code": currentRow.key,
    "工厂 Factory": [currentRow.factory],
    "工序 Stage": [currentRow.stage],
    "序号 No.": currentRow.no,
    "抽检比例 Sampling Ratio": `${currentRow.samplingPercent}%`,
    "记录比例 Recording Ratio": currentRow.recordingRule,
    "检验方法/设备 Method & Equipment": currentRow.devices,
    "规格/尺寸/检验要点 Spec & Criteria": currentRow.specification,
    "项目名称 Item Name": currentRow.title,
    ...sourceRawRecord,
  };
  const versionSourceRows = sourceRows ?? [{
    sourceRecordId: "source-item-1",
    applicableProductIds: sourceProductIds,
    rawRecord: sourceRaw,
  }];
  return {
    families: [
      { id: "s11-s14", name: "S11–S14", models: ["S11", "S12", "S13", "S14"] },
      { id: "s15", name: "S15", models: ["S15"] },
    ],
    variants: [
      { id: "variant-s11", familyId: "s11-s14", model: "S11", label: "S11" },
      { id: "variant-s12", familyId: "s11-s14", model: "S12", label: "S12" },
      { id: "variant-s13", familyId: "s11-s14", model: "S13", label: "S13" },
      { id: "variant-s14", familyId: "s11-s14", model: "S14", label: "S14" },
    ],
    versions: [{
      id: "recorded-version",
      familyId: "s11-s14",
      status: versionStatus,
      source: {
        productFieldMapping: { fieldLabel: "VENTUS" },
        familyProductFacts: sourceProductIds.map((id, index) => ({
          sourceRecordId: id,
          fieldValues: { VENTUS: `S${11 + index}` },
        })),
      },
      sourceRows: versionSourceRows,
    }],
    orders: [],
    issues: [],
    assets: entries.map((entry) => entry.asset),
    batches: [
      ...entries.map((entry) => entry.batch),
      {
        id: "operation-batch",
        kind: "operational",
        number: "S11-20261001-AP-OQC",
        orderId: null,
        lineId: null,
        variantId: null,
        familyId: null,
        quantity: 10,
        factory: "AP",
        stage: "OQC",
        countForPO: false,
        versionId: null,
        versionLabel: "26.4.24",
        date: "2026-10-01",
        recorder: "Inspector",
        notes: "",
        status: "draft",
        rows: [currentRow],
        products: [{
          lineId: "line-1",
          variantId: `variant-${currentModel.toLocaleLowerCase()}`,
          familyId: "s11-s14",
          quantity: 10,
          versionId: "recorded-version",
          versionLabel: "26.4.24",
        }],
        attachmentIds: [],
        createdAt: "2026-10-01T12:00:00.000Z",
        releasedAt: null,
      },
    ],
    history: {
      inspections: entries.map((entry) => entry.inspection),
      sources: entries.map((entry) => entry.source),
      anomalies: [],
    },
  };
}

function workspaceFor(state) {
  return getBatchWorkspace(state, "operation-batch");
}

async function run(service, type, data) {
  const state = await service.getState();
  return service.command(type, data, state.revision);
}

function standardItem({ id, key, no, important }) {
  return {
    id,
    key,
    no,
    title: `Inspection ${no}`,
    titleZh: "",
    specification: `Required criteria ${no}`,
    specificationZh: "",
    devices: "",
    factory: "AP",
    stage: "OQC",
    models: [],
    samplingPercent: 10,
    recordingRule: "",
    important,
    timeSeconds: null,
    procedureUrl: "",
  };
}

test("new color-variant batches inherit the same standard importance flags", async () => {
  let idNumber = 0;
  const service = createQCService(createMemoryQCAdapter({ initialState: createInitialQCState() }), {
    idFactory: () => `importance-inheritance-${String(++idNumber).padStart(4, "0")}`,
    now: () => "2026-10-13T12:00:00.000Z",
  });
  await service.initialize();

  const versionResult = await run(service, "createVersion", {
    familyId: "s11-s14",
    label: "Importance test",
    sequence: 1,
    effectiveDate: "2026-10-13",
    notes: "",
    items: [standardItem({ id: "important-check", key: "important-check", no: 1, important: true }),
      standardItem({ id: "ordinary-check", key: "ordinary-check", no: 2, important: false })],
  });
  await run(service, "publishVersion", { id: versionResult.entityId });

  let state = await service.getState();
  const red = state.variants.find((variant) => variant.model === "S11" && variant.color === "Red");
  const yellow = state.variants.find((variant) => variant.model === "S11" && variant.color === "Yellow");
  const orderResult = await run(service, "createOrder", {
    number: "PO-IMPORTANCE",
    date: "2026-10-13",
    supplier: "Supplier",
    notes: "",
    lines: [
      { variantId: red.id, orderedQty: 100 },
      { variantId: yellow.id, orderedQty: 100 },
    ],
  });
  state = await service.getState();
  const order = state.orders.find((candidate) => candidate.id === orderResult.entityId);
  const batchIds = [];
  for (const [index, variant] of [red, yellow].entries()) {
    const line = order.lines.find((candidate) => candidate.variantId === variant.id);
    const result = await run(service, "createBatch", {
      number: `B-IMPORTANCE-${variant.color.toUpperCase()}`,
      orderId: order.id,
      products: [{ lineId: line.id, quantity: 20 }],
      versionLabel: "Importance test",
      factory: "AP",
      stage: "OQC",
      date: "2026-10-13",
      recorder: "Inspector",
      notes: "",
    });
    batchIds[index] = result.entityId;
  }

  const expectedFlags = [true, false];
  for (const batchId of batchIds) {
    const workspace = await service.getBatchWorkspace(batchId);
    assert.deepEqual(workspace.rows.map((row) => row.important), expectedFlags);
    await run(service, "saveBatchChanges", {
      batchId,
      rows: workspace.rows.map((row) => ({
        rowId: row.id,
        defectiveQty: 0,
        actualTimeSeconds: 1,
        remarks: "",
        important: !row.important,
      })),
    });
    const savedWorkspace = await service.getBatchWorkspace(batchId);
    assert.deepEqual(savedWorkspace.rows.map((row) => row.important), expectedFlags);
  }

  const originalVersion = (await service.getState()).versions.find((version) => version.id === versionResult.entityId);
  assert.deepEqual(originalVersion.items.map((item) => item.important), expectedFlags);
});

test("query-only fallback resolves a PDF-matched recorded row and returns auditable source IDs", () => {
  const state = makeState();
  const before = structuredClone(state);

  const workspace = workspaceFor(state);

  assert.equal(workspace.rows[0].important, false);
  assert.equal(workspace.rows[0].displayImportant, true);
  assert.equal(workspace.rows[0].importanceEvidence.status, "consistent");
  assert.equal(workspace.rows[0].importanceEvidence.matches[0].batchId, "evidence-1");
  assert.equal(workspace.rows[0].importanceEvidence.matches[0].rowId, "history-row-evidence-1");
  assert.equal(workspace.rows[0].importanceEvidence.matches[0].sourceFileName, "evidence-1.pdf");
  assert.deepEqual(state, before);
});

test("lightweight validated PDF metadata keeps the same projected importance decision", () => {
  const fullState = makeState();
  const fullRow = workspaceFor(fullState).rows[0];
  const lightweightState = structuredClone(fullState);
  lightweightState.assets = lightweightState.assets.map((asset) => {
    const { dataUrl, ...metadata } = asset;
    return { ...metadata, decodedBytes: 8, contentRevision: 1 };
  });

  const lightweightRow = workspaceFor(lightweightState).rows[0];

  assert.equal(lightweightRow.displayImportant, fullRow.displayImportant);
  assert.deepEqual(lightweightRow.importanceEvidence, fullRow.importanceEvidence);
});

test("a recognized explicit source true or false takes precedence over historical evidence", () => {
  for (const [sourceValue, historicalValue] of [[false, true], [true, false]]) {
    const state = makeState({
      sourceRawRecord: { "Important Check": sourceValue },
      historical: [historicalEntry(`explicit-${sourceValue}`, { row: { important: historicalValue } })],
    });

    const row = workspaceFor(state).rows[0];

    assert.equal(row.displayImportant, sourceValue);
    assert.equal(row.importanceEvidence, null);
  }
});

test("published snapshots keep their saved importance and unmapped source rows do not infer", () => {
  const published = makeState({
    versionStatus: "published",
    row: { important: true },
    historical: [historicalEntry("published-evidence", { row: { important: false } })],
  });
  const publishedRow = workspaceFor(published).rows[0];
  assert.equal(publishedRow.displayImportant, true);
  assert.equal(publishedRow.importanceEvidence, null);

  const unmapped = makeState({
    sourceRows: [{ sourceRecordId: "different-source-item", rawRecord: {} }],
  });
  const unmappedRow = workspaceFor(unmapped).rows[0];
  assert.equal(unmappedRow.displayImportant, false);
  assert.equal(unmappedRow.importanceEvidence, null);
});

test("unknown importance fields do not trigger historical fallback", () => {
  const state = makeState({
    sourceRawRecord: { "importance status": "possibly important" },
  });

  const row = workspaceFor(state).rows[0];

  assert.equal(row.displayImportant, false);
  assert.equal(row.importanceEvidence, null);
});

test("historical evidence must come from a linked source inspection and PDF asset", () => {
  for (const missing of ["inspection", "source", "asset"]) {
    const entry = historicalEntry(`orphan-${missing}`);
    const state = makeState({ historical: [entry] });
    if (missing === "inspection") state.history.inspections = [];
    if (missing === "source") state.history.sources = [];
    if (missing === "asset") state.assets = [];

    const row = workspaceFor(state).rows[0];

    assert.equal(row.displayImportant, false, missing);
    assert.equal(row.importanceEvidence, null, missing);
  }
});

test("missing-from-source rows and inconsistent batch projections are not evidence", () => {
  const missing = makeState({
    historical: [historicalEntry("missing-row", { row: { status: "missing-from-source" } })],
  });
  assert.equal(workspaceFor(missing).rows[0].displayImportant, false);

  const inconsistentEntry = historicalEntry("inconsistent-projection");
  inconsistentEntry.batch.rows[0].important = false;
  const inconsistent = makeState({ historical: [inconsistentEntry] });
  assert.equal(workspaceFor(inconsistent).rows[0].displayImportant, false);
});

test("same-date conflicting matching source rows stay unresolved and retain both references", () => {
  const state = makeState({
    historical: [
      historicalEntry("green-evidence", { row: { important: true } }),
      historicalEntry("plain-evidence", { row: { important: false } }),
    ],
  });

  const row = workspaceFor(state).rows[0];

  assert.equal(row.displayImportant, false);
  assert.equal(row.importanceEvidence.status, "conflict");
  assert.equal(row.importanceEvidence.matches.length, 2);
  assert.equal(row.importanceEvidence.selectedDate, "2026-09-03");
});

test("newest dated PDF marking wins across the source standard's full model scope", () => {
  const newestTrue = [
    historicalEntry("older-s14-white", {
      inspection: { model: "S14", date: "2026-08-27" },
      batch: { model: "S14", date: "2026-08-27" },
      row: { important: false },
    }),
    historicalEntry("newer-s11-green", {
      inspection: { model: "S11", date: "2026-09-03" },
      batch: { model: "S11", date: "2026-09-03" },
      row: { important: true, specification: "New criteria", devices: "New equipment", samplingPercent: 25, recordingRule: "all units" },
    }),
  ];

  for (const currentModel of ["S11", "S14"]) {
    const state = makeState({ currentModel, historical: newestTrue });
    const row = workspaceFor(state).rows[0];
    assert.equal(row.displayImportant, true, currentModel);
    assert.equal(row.importanceEvidence.selectedDate, "2026-09-03", currentModel);
    assert.equal(row.importanceEvidence.selectionPolicy, "newest-dated-inspection", currentModel);
    assert.equal(row.importanceEvidence.matches.length, 1, currentModel);
    assert.equal(row.importanceEvidence.otherMatches.length, 1, currentModel);
  }

  const newestFalse = makeState({
    currentModel: "S14",
    historical: [
      historicalEntry("older-s11-green", {
        inspection: { model: "S11", date: "2026-08-27" },
        batch: { model: "S11", date: "2026-08-27" },
        row: { important: true },
      }),
      historicalEntry("newer-s14-white", {
        inspection: { model: "S14", date: "2026-09-03" },
        batch: { model: "S14", date: "2026-09-03" },
        row: { important: false },
      }),
    ],
  });
  const newestFalseRow = workspaceFor(newestFalse).rows[0];
  assert.equal(newestFalseRow.displayImportant, false);
  assert.equal(newestFalseRow.importanceEvidence.status, "consistent");
  assert.equal(newestFalseRow.importanceEvidence.important, false);
  assert.equal(newestFalseRow.importanceEvidence.selectedDate, "2026-09-03");
});

test("ambiguous identities and disjoint source models do not infer importance", () => {
  const ambiguousHistory = historicalEntry("duplicate-history-title");
  ambiguousHistory.inspection.rows.push({ ...structuredClone(ambiguousHistory.inspection.rows[0]), id: "duplicate-row" });
  ambiguousHistory.batch.rows.push({ ...structuredClone(ambiguousHistory.batch.rows[0]), id: "duplicate-row" });
  const ambiguousHistoryState = makeState({ historical: [ambiguousHistory] });
  assert.equal(workspaceFor(ambiguousHistoryState).rows[0].importanceEvidence, null);

  const ambiguousStandard = makeState();
  const duplicateSourceRow = structuredClone(ambiguousStandard.versions[0].sourceRows[0]);
  duplicateSourceRow.sourceRecordId = "duplicate-source-item";
  duplicateSourceRow.rawRecord["历史项目编号 History Item Code"] = "H026";
  duplicateSourceRow.rawRecord["序号 No."] = 2;
  ambiguousStandard.versions[0].sourceRows.push(duplicateSourceRow);
  assert.equal(workspaceFor(ambiguousStandard).rows[0].importanceEvidence, null);

  const disjointModel = makeState({
    historical: [historicalEntry("s15-only", {
      inspection: { model: "S15", productLabel: "S15" },
      batch: { model: "S15", productLabel: "S15" },
    })],
  });
  assert.equal(workspaceFor(disjointModel).rows[0].importanceEvidence, null);

  for (const overrides of [
    { inspection: { factory: "UI" }, batch: { factory: "UI" } },
    { inspection: { stage: "IQC" }, batch: { stage: "IQC" } },
    { batch: { familyId: "s15" } },
    { row: { title: "Different check" } },
  ]) {
    const state = makeState({ historical: [historicalEntry("context-mismatch", overrides)] });
    assert.equal(workspaceFor(state).rows[0].importanceEvidence, null);
  }
});

test("undated evidence uses consensus when no dated original PDF matches", () => {
  const consistent = makeState({ historical: [historicalEntry("undated", { inspection: { date: "not-a-date" } })] });
  const row = workspaceFor(consistent).rows[0];
  assert.equal(row.displayImportant, true);
  assert.equal(row.importanceEvidence.selectionPolicy, "undated-consensus");
  assert.equal(row.importanceEvidence.selectedDate, null);

  const conflict = makeState({
    historical: [
      historicalEntry("undated-true", { inspection: { date: "not-a-date" }, row: { important: true } }),
      historicalEntry("undated-false", { inspection: { date: null }, row: { important: false } }),
    ],
  });
  const conflictRow = workspaceFor(conflict).rows[0];
  assert.equal(conflictRow.displayImportant, false);
  assert.equal(conflictRow.importanceEvidence.status, "conflict");
});

test("normalized bilingual title identity ignores criteria and frequency changes", () => {
  const current = {
    ...CURRENT_ROW,
    key: "H027",
    title: "Smoke Machine Leak Test 发烟器漏气测试 [S11/S12/S13/S14·AP·OQC]",
    specification: "12PSI pressure decay test to check seal - after 30 seconds >=11.8PSI. 充气测试，是否漏气，12PSI气压衰减，30秒后气压不能低于11.8PSI。",
    devices: "Differential pressure gauge/Air pump 差压计/气泵",
    recordingRule: "50%+all failed units",
  };
  const historical = {
    ...HISTORICAL_ROW,
    title: "Smoke Machine Leak Test\n发烟器漏气测试",
    specification: "12PSI pressure decay test to check seal - after 30 seconds >=11.8PSI.\n充气测试，是否漏气，12PSI气压衰减，30秒后气压不能低于11.8PSI。",
    devices: "Differential pressure\ngauge/Air pump\n差压计/气泵",
    recordingRule: "50%+all\nfailed\nunits",
  };
  const state = makeState({ row: current, historical: [historicalEntry("bilingual", { row: historical })] });
  assert.equal(workspaceFor(state).rows[0].displayImportant, true);

  for (const specification of [
    historical.specification.replace("12PSI", "20PSI"),
    historical.specification.replace(">=11.8PSI", ">11.8PSI"),
    historical.specification.replace("seal - after", "seal + after"),
  ]) {
    const changed = makeState({
      row: current,
      historical: [historicalEntry("changed-criterion", { row: { ...historical, specification } })],
    });
    assert.equal(workspaceFor(changed).rows[0].displayImportant, true);
  }

  const currentPower = {
    ...CURRENT_ROW,
    key: "H026",
    title: "Power Test 功率测试 [S11/S12/S13/S14·AP·OQC]",
    specification: "12.7V power on test. Passing power consumption ranges are: S11/S13: 32.3~34.0W, S12/S14: 30.1~31.8W. 12.7V电源通电测试，开机3秒功耗在规定范围内（S11/S13范围为32.3~34.0W，S12/S14范围为30.1~31.8W）则为合格",
    recordingRule: "50%+all failed units",
  };
  const historicalPower = {
    ...HISTORICAL_ROW,
    title: "Power Test\n功率测试",
    specification: "12.7V power on test. Passing power consumption ranges are: S11/S13: 32.3~34.0W,\nS12/S14: 30.1~31.8W. 12.7V电源通电测试，开机3秒功耗在规定范围内（S11/S13范围为32.3~34.0W，S12/S14范围为30.1~31.8W）则为合格",
    recordingRule: "50%+all\nfailed\nunits",
  };
  const powerMatch = makeState({ row: currentPower, historical: [historicalEntry("power-match", { row: historicalPower })] });
  assert.equal(workspaceFor(powerMatch).rows[0].displayImportant, true);
  const changedModelCode = makeState({
    row: currentPower,
    historical: [historicalEntry("power-model-changed", {
      row: { ...historicalPower, specification: historicalPower.specification.replaceAll("S11", "S15") },
    })],
  });
  assert.equal(workspaceFor(changedModelCode).rows[0].displayImportant, true);
});

test("a historical model within the source standard scope applies across product variants", () => {
  const state = makeState({
    currentModel: "S12",
    historical: [historicalEntry("s11-only", { inspection: { model: "S11" }, batch: { model: "S11" } })],
  });

  const row = workspaceFor(state).rows[0];

  assert.equal(row.displayImportant, true);
  assert.equal(row.importanceEvidence.matches[0].batchId, "s11-only");
});
