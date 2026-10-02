import assert from "node:assert/strict";
import test from "node:test";
import { getBatchWorkspace } from "../core/qc-inspections.js";

const CURRENT_ROW = {
  id: "operation-row-1",
  key: "H025",
  no: 1,
  title: "Air Pump Test 气泵测试 [S11/S12/S13/S14·AP·OQC]",
  specification: "Power on to check whether the air pump and EVAP knob is working properly 通电检查气泵,气压调节钮是否正常工 作",
  devices: "DC power supply 直流电源",
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
  return {
    families: [
      { id: "s11-s14", name: "S11–S14", models: ["S11", "S12", "S13", "S14"] },
      { id: "s15", name: "S15", models: ["S15"] },
    ],
    variants: [
      { id: "variant-s11", familyId: "s11-s14", model: "S11", label: "S11" },
      { id: "variant-s12", familyId: "s11-s14", model: "S12", label: "S12" },
    ],
    versions: [{
      id: "recorded-version",
      familyId: "s11-s14",
      status: versionStatus,
      sourceRows: sourceRows ?? [{ sourceRecordId: "source-item-1", rawRecord: sourceRawRecord }],
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
          variantId: currentModel === "S12" ? "variant-s12" : "variant-s11",
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

test("conflicting matching source rows suppress green and retain both audit references", () => {
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
});

test("different criteria, method, sampling, recording rule, factory, stage, family, or model never match", async (t) => {
  const mismatches = [
    ["criteria", { row: { specification: HISTORICAL_ROW.specification.replace("气压调节钮", "气压旋钮") } }],
    ["sampling ratio", { row: { samplingPercent: 100 } }],
    ["recording rule", { row: { recordingRule: "50%+all failed units" } }],
    ["method", { row: { devices: "Visual 目测" } }],
    ["factory", { batch: { factory: "UI" }, inspection: { factory: "UI" } }],
    ["stage", { batch: { stage: "IQC" }, inspection: { stage: "IQC" } }],
    ["family", { batch: { familyId: "s15" }, source: { family: "s15" } }],
    ["model", { batch: { model: "S15" }, inspection: { model: "S15" } }],
  ];

  for (const [name, overrides] of mismatches) {
    await t.test(name, () => {
      const state = makeState({ historical: [historicalEntry(`mismatch-${name}`, overrides)] });

      const row = workspaceFor(state).rows[0];

      assert.equal(row.displayImportant, false);
      assert.equal(row.importanceEvidence, null);
    });
  }
});

test("full bilingual criteria retain model codes, numbers, and operators through PDF line reflow", () => {
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
    assert.equal(workspaceFor(changed).rows[0].displayImportant, false);
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
  assert.equal(workspaceFor(changedModelCode).rows[0].displayImportant, false);
});

test("an explicit historical model must equal the operational product model", () => {
  const state = makeState({
    currentModel: "S12",
    historical: [historicalEntry("s11-only", { inspection: { model: "S11" }, batch: { model: "S11" } })],
  });

  const row = workspaceFor(state).rows[0];

  assert.equal(row.displayImportant, false);
  assert.equal(row.importanceEvidence, null);
});
