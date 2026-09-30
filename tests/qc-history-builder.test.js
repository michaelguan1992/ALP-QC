import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildHistoryPackage } from "../scripts/pdf-import/build_history_package.mjs";
import { validateHistoryPackage } from "../core/qc-history.js";

const FIXED_TIME = "2026-09-29T00:00:00.000Z";
const VERSION = "25.10.29";

function makeSource(fileName, pages, date = "2026-09-15") {
  const pdfBytes = Buffer.from(`%PDF-1.4\n${fileName}\n`, "utf8");
  const sha256 = createHash("sha256").update(pdfBytes).digest("hex");
  const sourceId = `extract-${fileName}`;
  const assetId = `asset-${fileName}`;
  const source = {
    id: sourceId,
    fileName,
    sha256,
    pageCount: pages.length,
    family: "s15",
    assetId,
  };
  const inspections = pages.map((page, index) => ({
    id: `${sourceId}-p${index + 1}`,
    sourceId,
    page: index + 1,
    printedVersion: VERSION,
    printedDate: "2026/09/15",
    date,
    productLabel: "S15",
    model: "S15",
    color: null,
    factory: page.factory,
    stage: page.stage,
    batchQuantity: 768,
    recorder: null,
    notes: "",
    rows: page.rows.map((row) => ({
      no: row.no,
      title: row.title,
      specification: row.specification,
      devices: "Visual",
      samplingPercent: 10,
      recordingRule: "Record results.",
      timeSeconds: null,
      important: false,
      sourceInspectedQty: null,
      defectiveQty: null,
      sourceDefectiveRate: null,
      remarks: "",
      raw: { printedItem: row.no },
    })),
  }));
  const asset = {
    id: assetId,
    name: fileName,
    mimeType: "application/pdf",
    dataUrl: `data:application/pdf;base64,${pdfBytes.toString("base64")}`,
    kind: "document",
    batchId: null,
    rowId: null,
    versionId: null,
    createdAt: FIXED_TIME,
  };
  return {
    format: "masterqc-pdf-history",
    formatVersion: 1,
    family: "s15",
    sources: [source],
    inspections,
    assets: [asset],
    anomalies: [],
  };
}

function row(no, title, specification) {
  return { no, title, specification };
}

function inspectionFor(pkg, fileName, factory, stage) {
  const source = pkg.sources.find((candidate) => candidate.fileName === fileName);
  return pkg.inspections.find((inspection) => inspection.sourceId === source.id && inspection.factory === factory && inspection.stage === stage);
}

test("history builder unions same-revision checks by title only and pads missing rows with unique blank values per factory and stage", () => {
  const completeRegularSource = makeSource("S15-15.pdf", [
    { factory: "AP", stage: "OQC", rows: [row(1, "Visual inspection", "Check visible surfaces.")] },
    { factory: "UI", stage: "IQC", rows: [row(1, "Visual inspection", "Check visible surfaces.")] },
    { factory: "UI", stage: "OQC", rows: [
      row(1, "Valve direction check", "Confirm the valve direction."),
      row(2, "Visual inspection", "Check visible surfaces."),
    ] },
  ]);
  const sameFactorySource = makeSource("S15-14.pdf", [
    { factory: "UI", stage: "OQC", rows: [row(1, "Valve direction check", "Revised wording of the same check.")] },
  ], "2026-09-14");
  const otherFactorySource = makeSource("S15-13.pdf", [
    { factory: "AP", stage: "OQC", rows: [row(1, "Visual inspection", "Check visible surfaces.")] },
  ], "2026-09-13");

  const result = buildHistoryPackage([completeRegularSource, sameFactorySource, otherFactorySource]);
  const pkg = result.package;
  validateHistoryPackage(pkg);

  const uiTarget = inspectionFor(pkg, "S15-14.pdf", "UI", "OQC");
  assert.equal(uiTarget.rows.length, 2, "specification changes must not create a second check");
  assert.equal(uiTarget.rows[0].no, 1, "original printed numbering must stay intact");
  assert.equal(uiTarget.rows[0].specification, "Revised wording of the same check.");
  assert.equal(uiTarget.rows[1].title, "Visual inspection");
  assert.equal(uiTarget.rows[1].status, "missing-from-source");
  assert.equal(uiTarget.rows[1].no, 2, "supplemented rows start above existing printed numbers");
  assert.equal(uiTarget.rows[1].sourceInspectedQty, null);
  assert.equal(uiTarget.rows[1].defectiveQty, null);
  assert.equal(uiTarget.rows[1].sourceDefectiveRate, null);
  assert.match(uiTarget.rows[1].missingEvidence, /S15-15\.pdf/);
  assert.equal(uiTarget.rows[1].raw.standardSource.printedNo, 2);

  const apOqcTarget = inspectionFor(pkg, "S15-13.pdf", "AP", "OQC");
  assert.equal(apOqcTarget.rows.length, 1, "a UI OQC check must not be copied into AP OQC");
  assert.equal(pkg.versions[0].status, "draft");
  assert.equal(pkg.versions[0].publishedAt, null);
});

