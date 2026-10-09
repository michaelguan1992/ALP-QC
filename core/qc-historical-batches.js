import { clone, deepEqual, fail } from "./qc-domain.js";

function compactToken(value, fallback) {
  const token = String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 12);
  return token || fallback;
}

function dateToken(value) {
  if (typeof value !== "string") return "UNDATED";
  const match = /^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(value.trim());
  return match ? `${match[1]}${match[2]}${match[3]}` : "UNDATED";
}

function digest8(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function historicalRowId(row) {
  return typeof row.id === "string" && row.id.trim() ? row.id : `historical-row-${row.no}`;
}

function sourceWholeNumber(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== "string" || !/^\d+$/u.test(value.trim())) return null;
  const number = Number(value.trim());
  return Number.isSafeInteger(number) ? number : null;
}

/** Resolve an imported row's source counterpart without changing the preserved history collection. */
export function findHistoricalSourceRow(state, batch, row) {
  const inspection = state.history?.inspections?.find((candidate) => candidate.id === batch?.historyInspectionId);
  return inspection?.rows?.find((candidate) => historicalRowId(candidate) === row?.id) ?? null;
}

/** Project editable result values while keeping their original printed values in the source row. */
export function historicalResultValues(row, sourceRow = row) {
  return {
    inspectedQty: Object.hasOwn(row, "inspectedQty") ? row.inspectedQty : sourceWholeNumber(sourceRow?.sourceInspectedQty),
    defectiveQty: sourceWholeNumber(row.defectiveQty),
    actualTimeSeconds: Object.hasOwn(row, "actualTimeSeconds") ? row.actualTimeSeconds : null,
  };
}

export function historicalSourceResultValues(sourceRow) {
  return {
    inspectedQty: sourceWholeNumber(sourceRow?.sourceInspectedQty),
    defectiveQty: sourceWholeNumber(sourceRow?.defectiveQty),
    actualTimeSeconds: null,
  };
}

/** Give an imported source page a readable archive identity without claiming a source batch number. */
export function historicalBatchNumber(inspection, source) {
  const familyToken = compactToken(inspection.model || inspection.productLabel || source.family, source.family.toLocaleUpperCase());
  const factoryToken = compactToken(inspection.factory, "UNSPECIFIED");
  const stageToken = compactToken(inspection.stage, "UNSPECIFIED");
  return `HIST-${familyToken}-${dateToken(inspection.date)}-${factoryToken}-${stageToken}-${digest8(inspection.id)}-P${inspection.page}`;
}

export function createHistoricalBatch(inspection, source, createdAt) {
  return {
    id: inspection.id,
    kind: "historical",
    historyInspectionId: inspection.id,
    number: historicalBatchNumber(inspection, source),
    familyId: source.family,
    productLabel: inspection.productLabel,
    model: inspection.model,
    color: inspection.color,
    quantity: inspection.batchQuantity,
    factory: inspection.factory,
    stage: inspection.stage,
    date: inspection.date,
    versionLabel: inspection.printedVersion,
    orderId: null,
    lineId: null,
    variantId: null,
    lotNumber: null,
    countForPO: false,
    versionId: null,
    recorder: inspection.recorder,
    notes: inspection.notes,
    status: "historical",
    rows: inspection.rows.map((row) => ({
      ...clone(row),
      id: historicalRowId(row),
    })),
    attachmentIds: [source.assetId],
    createdAt,
    releasedAt: null,
  };
}

function sourceMaps(state) {
  const history = state.history;
  if (!history?.inspections?.length) return { sources: new Map(), inspections: [] };
  return {
    sources: new Map(history.sources.map((source) => [source.id, source])),
    inspections: history.inspections,
  };
}

function assertExistingProjection(existing, expected) {
  const existingWithoutGeneratedMetadata = clone(existing);
  const expectedWithoutGeneratedMetadata = clone(expected);
  delete existingWithoutGeneratedMetadata.createdAt;
  delete expectedWithoutGeneratedMetadata.createdAt;
  const existingAttachments = existingWithoutGeneratedMetadata.attachmentIds;
  delete existingWithoutGeneratedMetadata.attachmentIds;
  delete expectedWithoutGeneratedMetadata.attachmentIds;

  for (const batch of [existingWithoutGeneratedMetadata, expectedWithoutGeneratedMetadata]) {
    for (const row of batch.rows ?? []) {
      delete row.inspectedQty;
      delete row.defectiveQty;
      delete row.actualTimeSeconds;
      delete row.attachmentIds;
    }
  }

  if (!Array.isArray(existingAttachments) || !existingAttachments.includes(expected.attachmentIds[0])) {
    fail(`Historical batch ${expected.number} is missing its original PDF attachment.`);
  }
  if (!deepEqual(existingWithoutGeneratedMetadata, expectedWithoutGeneratedMetadata)) {
    fail(`Historical batch ${expected.number} conflicts with its source inspection evidence; no data was changed.`);
  }
}

/** Add missing historical projections without replacing an existing batch or its extra attachments. */
export function materializeHistoricalBatches(state) {
  const { sources, inspections } = sourceMaps(state);
  const byId = new Map(state.batches.map((batch) => [batch.id, batch]));
  const byNumber = new Map(state.batches.map((batch) => [batch.number.toLocaleLowerCase(), batch]));
  let added = 0;
  let skipped = 0;

  for (const inspection of inspections) {
    const source = sources.get(inspection.sourceId);
    if (!source) fail(`Historical inspection ${inspection.id} refers to a missing PDF source.`);
    const existing = byId.get(inspection.id);
    if (existing) {
      if (existing.kind !== "historical" || existing.historyInspectionId !== inspection.id) {
        fail(`Historical inspection ${inspection.id} conflicts with an existing batch identity; no data was changed.`);
      }
      const expected = createHistoricalBatch(inspection, source, existing.createdAt);
      assertExistingProjection(existing, expected);
      skipped += 1;
      continue;
    }

    const asset = state.assets.find((candidate) => candidate.id === source.assetId);
    if (!asset) fail(`Historical PDF ${source.fileName} is missing its original attachment asset.`);
    const batch = createHistoricalBatch(inspection, source, asset.createdAt);
    const sameNumber = byNumber.get(batch.number.toLocaleLowerCase());
    if (sameNumber) {
      fail(`Historical archive number ${batch.number} conflicts with batch ${sameNumber.id}; no data was changed.`);
    }
    state.batches.push(batch);
    byId.set(batch.id, batch);
    byNumber.set(batch.number.toLocaleLowerCase(), batch);
    added += 1;
  }
  return { added, skipped };
}
