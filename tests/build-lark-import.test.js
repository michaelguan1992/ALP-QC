import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildPackage } from "../scripts/build-lark-import.mjs";

const BUILDER = fileURLToPath(new URL("../scripts/build-lark-import.mjs", import.meta.url));
const REVISION_FIELDS = {
  productLinks: "关联产品 Products",
  specLinks: "③QC规范 Spec Items",
  version: "版本号 Revision",
  effectiveAt: "生效日期 Effective Date",
  status: "是否当前生效 Revision Status",
  change: "变更内容说明 Change Description",
  attachments: "图纸/附件 Engineering Drawing",
};
const PRODUCT_MODEL = "VENTUS";
const PRODUCT_NAME = "产品名称 Product Name";
const SPEC_PRODUCTS = "关联产品 Product";

function manifest(table, labels) {
  return {
    format: "ndjson",
    table_id: table,
    rev: 1,
    timezone: "America/Los_Angeles",
    records_count: 0,
    page_count: 1,
    has_more: false,
    query_context: { field_scope: "all_fields", record_scope: "all_records" },
    columns: Object.fromEntries(labels.map((label) => [label, { field_id: `fld_${label.length}_${table}` }])),
  };
}

function revision(id, products, specs, version) {
  return {
    record_id: id,
    [REVISION_FIELDS.productLinks]: products.map((productId) => ({ id: productId })),
    [REVISION_FIELDS.specLinks]: specs.map((specId) => ({ id: specId })),
    [REVISION_FIELDS.version]: version,
    [REVISION_FIELDS.effectiveAt]: "2026-08-19T00:00:00.000-07:00",
    [REVISION_FIELDS.status]: ["生效中 Active"],
    [REVISION_FIELDS.change]: `Change ${version}`,
    [REVISION_FIELDS.attachments]: [],
  };
}

function product(id, model) {
  return { record_id: id, [PRODUCT_MODEL]: model, [PRODUCT_NAME]: `${model} product` };
}

function spec(id, productIds) {
  return { record_id: id, [SPEC_PRODUCTS]: productIds.map((productId) => ({ id: productId })), "Spec Name": `Spec ${id}` };
}

function input({ revisions, products, specs }) {
  const revisionLabels = Object.values(REVISION_FIELDS);
  const specLabels = [SPEC_PRODUCTS, "Spec Name"];
  const productLabels = [PRODUCT_MODEL, PRODUCT_NAME];
  return {
    manifests: {
      revisions: manifest("tblRevisions", revisionLabels),
      products: manifest("tblProducts", productLabels),
      specs: manifest("tblSpecs", specLabels),
    },
    rows: { revisions, products, specs },
  };
}

test("orphan spec links and unknown product links are counted once per included revision", () => {
  const pkg = buildPackage(input({
    products: [product("p-s11", "S11"), product("p-s15", "S15")],
    revisions: [revision("rev-1", ["p-s11", "p-s15", "p-missing"], ["spec-1", "spec-missing"], "26.08.19")],
    specs: [spec("spec-1", ["p-s11"])],
  }));

  assert.equal(pkg.records.length, 2, "a dual-family revision projects into both families");
  assert.equal(pkg.report.counts.orphanSpecLinks, 1);
  assert.equal(pkg.report.counts.unknownProductLinks, 1);
  assert.equal(pkg.records.every((record) => record.anomalies.some((anomaly) => anomaly.code === "ORPHAN_SPEC_LINK")), true);
});

test("spec rows linked only to out-of-scope products or to no product are counted as dropped", () => {
  const pkg = buildPackage(input({
    products: [product("p-s11", "S11"), product("p-other", "OTHER")],
    revisions: [revision("rev-2", ["p-s11", "p-other"], ["spec-in", "spec-out", "spec-none"], "26.08.20")],
    specs: [spec("spec-in", ["p-s11"]), spec("spec-out", ["p-other"]), spec("spec-none", [])],
  }));

  assert.equal(pkg.report.counts.includedSpecRows, 1);
  assert.equal(pkg.report.counts.specRowsWithoutApplicableProducts, 2);
  assert.equal(pkg.report.counts.otherFamilySpecRowsSkipped, 0);
});

test("other-family spec rows stay in their own counter and are not counted as dropped", () => {
  const pkg = buildPackage(input({
    products: [product("p-s11", "S11"), product("p-s15", "S15")],
    revisions: [revision("rev-3", ["p-s11", "p-s15"], ["spec-11", "spec-15"], "26.08.21")],
    specs: [spec("spec-11", ["p-s11"]), spec("spec-15", ["p-s15"])],
  }));

  assert.equal(pkg.report.counts.specRowsWithoutApplicableProducts, 0);
  assert.equal(pkg.report.counts.otherFamilySpecRowsSkipped, 2);
  assert.equal(pkg.report.counts.includedSpecRows, 2);
});

test("the builder refuses to run without explicit export inputs", () => {
  const result = spawnSync(process.execPath, [BUILDER], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing required input --revisions/u);
  assert.equal(result.stdout, "");
});
