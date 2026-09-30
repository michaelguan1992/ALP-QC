#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_INPUTS = {
  revisions: "/tmp/masterqc-web-version-review.ndjson",
  products: "/tmp/masterqc-lark-products.ndjson",
  specs: "/tmp/masterqc-lark-specs.ndjson",
};
const DEFAULT_OUTPUT = path.join(ROOT, "data/lark-import/version-history.v1.json");
const CAPTURE = {
  localDate: "2026-09-29",
  timeZone: "America/Los_Angeles",
  utcDate: "2026-09-29",
};
const FAMILIES = [
  { id: "s11-s14", modelValues: ["S11", "S12", "S13", "S14"] },
  { id: "s15", modelValues: ["S15"] },
];
const LABELS = {
  revision: {
    productLinks: "关联产品 Products",
    specLinks: "③QC规范 Spec Items",
    version: "版本号 Revision",
    effectiveAt: "生效日期 Effective Date",
    status: "是否当前生效 Revision Status",
    change: "变更内容说明 Change Description",
    attachments: "图纸/附件 Engineering Drawing",
  },
  product: {
    model: "VENTUS",
    name: "产品名称 Product Name",
  },
  spec: {
    productLinks: "关联产品 Product",
  },
};
const VERIFIED_TABLE_URLS = {
  revisions: "https://elarkuswwod6schx.usttp.larksuite.com/wiki/ZMYmw71mDirvWekNqsUuqV6Wtnh?table=tblz8a0WMWDfq7K2",
  specs: "https://elarkuswwod6schx.usttp.larksuite.com/wiki/ZMYmw71mDirvWekNqsUuqV6Wtnh?table=tblZSEje5yJL1EJ5",
};

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const values = { ...DEFAULT_INPUTS, out: DEFAULT_OUTPUT };
  const options = {
    "--revisions": "revisions",
    "--products": "products",
    "--specs": "specs",
    "--out": "out",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = options[argv[index]];
    if (!key) fail(`Unknown option: ${argv[index]}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`Missing value for ${argv[index]}`);
    values[key] = path.resolve(value);
    index += 1;
  }
  return values;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    fail(`Cannot read JSON file ${filePath}: ${error.message}`);
  }
}

async function readNdjson(filePath) {
  let contents;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    fail(`Cannot read NDJSON file ${filePath}: ${error.message}`);
  }
  return contents.split(/\r?\n/u).filter((line) => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`Invalid JSON on line ${index + 1} of ${filePath}: ${error.message}`);
    }
  });
}

function recordMap(rows, label) {
  const result = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) fail(`${label} contains a non-object row.`);
    if (typeof row.record_id !== "string" || !row.record_id) fail(`${label} contains a row without a record_id.`);
    if (result.has(row.record_id)) fail(`${label} contains duplicate record_id ${row.record_id}.`);
    result.set(row.record_id, row);
  }
  return result;
}

function validateManifest(manifest, rows, label) {
  if (!manifest || manifest.format !== "ndjson") fail(`${label} manifest must declare NDJSON format.`);
  if (manifest.records_count !== rows.length) fail(`${label} manifest count ${manifest.records_count} does not match ${rows.length} rows.`);
  if (manifest.has_more !== false) fail(`${label} snapshot is incomplete (has_more must be false).`);
  if (manifest.query_context?.field_scope !== "all_fields" || manifest.query_context?.record_scope !== "all_records") {
    fail(`${label} snapshot must include all fields and all records.`);
  }
}

function fieldIdsFor(manifest, labels) {
  const fieldIds = {};
  for (const label of labels) {
    const column = manifest.columns?.[label];
    if (!column?.field_id) fail(`Source manifest is missing a field ID for ${label}.`);
    fieldIds[label] = column.field_id;
  }
  return fieldIds;
}

function sourceManifest(manifest, labels, tableUrl = undefined) {
  const source = {
    tableId: manifest.table_id,
    tableRevision: manifest.rev,
    timeZone: manifest.timezone,
    recordCount: manifest.records_count,
    pageCount: manifest.page_count,
    hasMore: manifest.has_more,
    queryContext: structuredClone(manifest.query_context),
    fieldIds: fieldIdsFor(manifest, labels),
  };
  if (tableUrl) source.tableUrl = tableUrl;
  return source;
}

function linkedIds(value, description) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) fail(`${description} must be an array of linked-record objects.`);
  return value.map((link, index) => {
    if (!link || typeof link.id !== "string" || !link.id) fail(`${description}[${index}] has no linked record ID.`);
    return link.id;
  });
}

function familyForProduct(product) {
  const modelValue = product?.[LABELS.product.model];
  return FAMILIES.find((family) => family.modelValues.includes(modelValue))?.id ?? null;
}

function sourceTable(manifest, tableUrl) {
  return {
    system: "lark-base",
    tableId: manifest.table_id,
    ...(tableUrl ? { tableUrl } : {}),
  };
}

function buildPackage({ manifests, rows }) {
  const revisionMap = recordMap(rows.revisions, "Revision export");
  const productMap = recordMap(rows.products, "Product export");
  const specMap = recordMap(rows.specs, "Spec export");
  const productsByFamily = new Map(FAMILIES.map((family) => [family.id, []]));

  for (const product of rows.products) {
    const familyId = familyForProduct(product);
    if (!familyId) continue;
    productsByFamily.get(familyId).push({
      sourceRecordId: product.record_id,
      fieldValues: {
        [LABELS.product.model]: product[LABELS.product.model] ?? null,
        [LABELS.product.name]: product[LABELS.product.name] ?? null,
      },
    });
  }

  const records = [];
  const excludedVersionRecords = [];
  const sourceIdsWithBroadLinks = new Set();
  let includedSpecRows = 0;
  let otherFamilySpecRowsSkipped = 0;
  let specProductLinksOutsideRevision = 0;
  let orphanSpecLinks = 0;
  let unknownProductLinks = 0;
  let attachmentMetadataRows = 0;

  for (const revision of rows.revisions) {
    const linkedProductIds = linkedIds(revision[LABELS.revision.productLinks], `${revision.record_id}.${LABELS.revision.productLinks}`);
    const linkedSpecIds = linkedIds(revision[LABELS.revision.specLinks], `${revision.record_id}.${LABELS.revision.specLinks}`);
    const familyProductIds = new Map(FAMILIES.map((family) => [family.id, []]));
    const unmatchedProductIds = [];
    const missingProductIds = [];

    for (const productId of linkedProductIds) {
      const product = productMap.get(productId);
      if (!product) {
        unmatchedProductIds.push(productId);
        missingProductIds.push(productId);
        continue;
      }
      const familyId = familyForProduct(product);
      if (familyId) familyProductIds.get(familyId).push(productId);
      else unmatchedProductIds.push(productId);
    }

    const applicableFamilies = FAMILIES.filter((family) => familyProductIds.get(family.id).length > 0);
    if (applicableFamilies.length === 0) {
      excludedVersionRecords.push({
        sourceRecordId: revision.record_id,
        revisionValue: revision[LABELS.revision.version] ?? null,
        reasonCode: linkedProductIds.length === 0 ? "no_product_links" : "no_in_scope_family_links",
        linkedProductIds,
      });
      continue;
    }

    const unmatchedSet = [...new Set(unmatchedProductIds)];
    if (unmatchedSet.length > 0) sourceIdsWithBroadLinks.add(revision.record_id);
    const attachments = revision[LABELS.revision.attachments];
    if (Array.isArray(attachments)) attachmentMetadataRows += attachments.length;

    const specProductsById = new Map();
    const outOfRevisionProductsBySpec = new Map();
    for (const specId of linkedSpecIds) {
      const spec = specMap.get(specId);
      if (!spec) continue;
      const specProductIds = linkedIds(spec[LABELS.spec.productLinks], `${specId}.${LABELS.spec.productLinks}`);
      specProductsById.set(specId, specProductIds);
      const outsideRevisionProductIds = [...new Set(specProductIds.filter((productId) => !linkedProductIds.includes(productId)))];
      if (outsideRevisionProductIds.length > 0) {
        outOfRevisionProductsBySpec.set(specId, outsideRevisionProductIds);
        specProductLinksOutsideRevision += outsideRevisionProductIds.length;
      }
    }

    for (const family of applicableFamilies) {
      const applicableProductIds = familyProductIds.get(family.id);
      const specs = [];
      const orphanedSpecIds = [];

      for (const specId of linkedSpecIds) {
        const spec = specMap.get(specId);
        if (!spec) {
          orphanedSpecIds.push(specId);
          orphanSpecLinks += 1;
          continue;
        }
        const specProductIds = specProductsById.get(specId) ?? [];
        const matchedProductIds = specProductIds.filter((productId) => applicableProductIds.includes(productId));
        if (matchedProductIds.length === 0) {
          const otherFamilyProductIds = applicableFamilies
            .filter((otherFamily) => otherFamily.id !== family.id)
            .flatMap((otherFamily) => familyProductIds.get(otherFamily.id));
          if (specProductIds.some((productId) => otherFamilyProductIds.includes(productId))) {
            otherFamilySpecRowsSkipped += 1;
          }
          continue;
        }
        specs.push({
          sourceRecordId: specId,
          applicableProductIds: matchedProductIds,
          rawRecord: structuredClone(spec),
        });
        includedSpecRows += 1;
      }

      const anomalies = [];
      if (unmatchedSet.length > 0) {
        anomalies.push({
          code: "BROAD_PRODUCT_LINKS",
          sourceRecordId: revision.record_id,
          details: {
            reviewRequired: true,
            totalLinkedProductCount: linkedProductIds.length,
            unmatchedProductIds: unmatchedSet,
            missingFromProductExportIds: [...new Set(missingProductIds)],
          },
        });
      }
      if (missingProductIds.length > 0) {
        unknownProductLinks += missingProductIds.length;
        anomalies.push({
          code: "UNKNOWN_PRODUCT_LINK",
          sourceRecordId: revision.record_id,
          relatedProductIds: [...new Set(missingProductIds)],
        });
      }
      if (orphanedSpecIds.length > 0) {
        anomalies.push({
          code: "ORPHAN_SPEC_LINK",
          sourceRecordId: revision.record_id,
          relatedSpecIds: [...new Set(orphanedSpecIds)],
        });
      }
      const outsideRevisionSpecs = [...outOfRevisionProductsBySpec.entries()].map(([specId, productIds]) => ({
        sourceRecordId: specId,
        productIds,
      }));
      if (outsideRevisionSpecs.length > 0) {
        anomalies.push({
          code: "SPEC_PRODUCT_OUTSIDE_REVISION_PRODUCTS",
          sourceRecordId: revision.record_id,
          details: {
            revisionProductIds: linkedProductIds,
            specs: outsideRevisionSpecs,
          },
        });
      }

      const sourceRecordId = revision.record_id;
      records.push({
        id: `lark:${sourceRecordId}:${family.id}`,
        familyId: family.id,
        revision: revision[LABELS.revision.version] ?? null,
        effectiveAt: revision[LABELS.revision.effectiveAt] ?? null,
        rawStatus: revision[LABELS.revision.status] ?? null,
        changeDescription: revision[LABELS.revision.change] ?? null,
        attachments: structuredClone(attachments ?? null),
        applicableProductIds,
        source: {
          ...sourceTable(manifests.revisions, VERIFIED_TABLE_URLS.revisions),
          recordId: sourceRecordId,
        },
        rawRecord: structuredClone(revision),
        specs,
        anomalies,
      });
    }
  }

  const recordsByFamily = Object.fromEntries(FAMILIES.map((family) => [
    family.id,
    records.filter((record) => record.familyId === family.id).length,
  ]));
  const distinctIncludedRevisionIds = new Set(records.map((record) => record.source.recordId));
  const distinctIncludedSpecSourceIds = new Set(records.flatMap((record) => record.specs.map((spec) => spec.sourceRecordId)));
  const zeroSpecRecords = records.filter((record) => record.specs.length === 0).length;
  const excludedVersionRecordsByReason = Object.fromEntries(
    [...new Set(excludedVersionRecords.map((record) => record.reasonCode))].sort().map((reasonCode) => [
      reasonCode,
      excludedVersionRecords.filter((record) => record.reasonCode === reasonCode).length,
    ]),
  );

  return {
    schemaVersion: 1,
    packageType: "masterqc-lark-version-history",
    capturedAt: CAPTURE,
    sources: {
      revisions: sourceManifest(manifests.revisions, Object.keys(rows.revisions[0] ?? {}).filter((label) => label !== "record_id"), VERIFIED_TABLE_URLS.revisions),
      products: sourceManifest(manifests.products, [LABELS.product.model, LABELS.product.name]),
      specs: sourceManifest(manifests.specs, Object.keys(rows.specs[0] ?? {}).filter((label) => label !== "record_id"), VERIFIED_TABLE_URLS.specs),
    },
    productFieldMapping: {
      fieldLabel: LABELS.product.model,
      fieldId: manifests.products.columns[LABELS.product.model].field_id,
      matching: "exact-value",
      familyValues: Object.fromEntries(FAMILIES.map((family) => [family.id, family.modelValues])),
    },
    families: FAMILIES.map((family) => ({
      id: family.id,
      modelValues: [...family.modelValues],
      products: productsByFamily.get(family.id),
    })),
    records,
    report: {
      counts: {
        sourceRevisionRows: rows.revisions.length,
        sourceProductRows: rows.products.length,
        sourceSpecRows: rows.specs.length,
        inScopeProducts: productsByFamily.get("s11-s14").length + productsByFamily.get("s15").length,
        distinctIncludedRevisionIds: distinctIncludedRevisionIds.size,
        records: records.length,
        recordsByFamily,
        includedSpecRows,
        distinctIncludedSpecSourceIds: distinctIncludedSpecSourceIds.size,
        otherFamilySpecRowsSkipped,
        specProductLinksOutsideRevision,
        orphanSpecLinks,
        unknownProductLinks,
        broadProductLinkRecords: sourceIdsWithBroadLinks.size,
        attachmentMetadataRows,
        zeroSpecRecords,
        excludedVersionRecords: excludedVersionRecords.length,
        excludedVersionRecordsByReason,
      },
      excludedVersionRecords,
      notes: [
        "This is a reproducible source package only; it does not assert that any version is published or operational in MasterQC-Web.",
        "Only revision-linked specs whose product links intersect that revision's in-scope family product links are included.",
        "Specs linked to another in-scope family in the same revision are normal projection skips, not anomalies.",
        "Revision and spec rawRecord objects retain original field labels and values, including nulls, empty strings, and empty link arrays.",
        "Attachment binaries are not included; original attachment metadata remains on each raw revision record.",
      ],
    },
  };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const manifests = {};
  const rows = {};
  for (const key of ["revisions", "products", "specs"]) {
    const manifestPath = args[key].replace(/\.ndjson$/u, ".manifest.json");
    [manifests[key], rows[key]] = await Promise.all([readJson(manifestPath), readNdjson(args[key])]);
    validateManifest(manifests[key], rows[key], `${key} export`);
  }

  const output = buildPackage({ manifests, rows });
  await mkdir(path.dirname(args.out), { recursive: true });
  await writeFile(args.out, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output: args.out, ...output.report.counts }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
