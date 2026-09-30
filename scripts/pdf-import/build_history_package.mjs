#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateHistoryPackage, verifyHistoryPackage } from "../../core/qc-history.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CREATED_AT = "2026-09-29T00:00:00.000Z";
const EXPECTED_CONTEXTS = ["AP|OQC", "UI|IQC", "UI|OQC"];
const FAMILY_MODELS = {
  "s11-s14": ["S11", "S12", "S13", "S14"],
  s15: ["S15"],
};
const SELF_MADE = /自制|self[\s_-]*made|homemade/i;

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableId(prefix, value) {
  return `${prefix}-${sha256(value).slice(0, 40)}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function compact(value) {
  return text(value).replace(/\s+/gu, " ");
}

function normalizedVersion(value) {
  return text(value).normalize("NFKC").replace(/\s+/gu, "").toLocaleLowerCase();
}

function normalizedTitle(value) {
  return text(value).normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function taskIdentity(row) {
  return normalizedTitle(row.title || row.taskIdentity);
}

function sourceIsSelfMade(source) {
  return SELF_MADE.test(source.fileName || "");
}

function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

function contextKey(record) {
  const factory = text(record.factory).toLocaleUpperCase();
  const stage = text(record.stage).toLocaleUpperCase();
  if (!["AP", "UI"].includes(factory) || !["IQC", "OQC"].includes(stage)) return "";
  return `${factory}|${stage}`;
}

function groupKey(family, version, context) {
  return `${family}|${version}|${context}`;
}

function metadataDate(record) {
  return parseDate(record.date) || "0000-00-00";
}

function assertExtractionPackage(input, label) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(`${label} extraction must be an object.`);
  if (input.format !== "masterqc-pdf-history" || input.formatVersion !== 1) fail(`${label} extraction package format is unsupported.`);
  if (!Array.isArray(input.sources) || !Array.isArray(input.inspections) || !Array.isArray(input.assets)) fail(`${label} extraction package is missing sources, inspections, or assets.`);
  if (!input.family || !FAMILY_MODELS[input.family]) fail(`${label} extraction package has an unsupported family.`);
}

function stableSourceObjects(extractionPackages) {
  const sources = [];
  const inspections = [];
  const assets = [];
  const anomalies = [];
  const sourceLookup = new Map();
  const assetLookup = new Map();

  for (const [packageIndex, extraction] of extractionPackages.entries()) {
    assertExtractionPackage(extraction, `Input ${packageIndex + 1}`);
    const assetById = new Map(extraction.assets.map((asset) => [asset.id, asset]));
    for (const originalSource of extraction.sources) {
      if (!/^[a-f\d]{64}$/i.test(originalSource.sha256 || "")) fail(`Source ${originalSource.fileName} is missing a SHA-256 digest.`);
      if (!Number.isSafeInteger(originalSource.pageCount) || originalSource.pageCount <= 0) fail(`Source ${originalSource.fileName} has an invalid page count.`);
      const sourceId = `pdf-${originalSource.sha256.toLowerCase()}`;
      const assetId = `pdfasset-${originalSource.sha256.toLowerCase()}`;
      if (sourceLookup.has(originalSource.id)) fail(`Extractor source ID ${originalSource.id} is duplicated.`);
      const originalAsset = assetById.get(originalSource.assetId);
      if (!originalAsset) fail(`Source ${originalSource.fileName} has no matching embedded original PDF.`);
      const source = {
        ...structuredClone(originalSource),
        id: sourceId,
        assetId,
        family: originalSource.family || extraction.family,
        extractorSourceId: originalSource.id,
      };
      const previousContent = sources.find((candidate) => candidate.id === sourceId);
      if (previousContent) {
        if (previousContent.fileName !== source.fileName) fail(`Two source files share a SHA-256 digest but have different filenames: ${source.fileName}.`);
        fail(`Duplicate source PDF content appears more than once: ${source.fileName}.`);
      }
      const asset = {
        ...structuredClone(originalAsset),
        id: assetId,
        name: originalSource.fileName,
        mimeType: "application/pdf",
        kind: "document",
        batchId: null,
        rowId: null,
        versionId: null,
        createdAt: CREATED_AT,
      };
      if (assetLookup.has(originalAsset.id)) fail(`Embedded PDF asset ID ${originalAsset.id} is duplicated.`);
      assetLookup.set(originalAsset.id, assetId);
      sourceLookup.set(originalSource.id, { source, asset, extractionPackage: extraction });
      sources.push(source);
      assets.push(asset);
    }
  }

  for (const extraction of extractionPackages) {
    for (const original of extraction.inspections) {
      const link = sourceLookup.get(original.sourceId);
      if (!link) fail(`Inspection page ${original.page} refers to missing extractor source ${original.sourceId}.`);
      const source = link.source;
      const id = `${source.id}-page-${String(original.page).padStart(3, "0")}`;
      const inspection = {
        ...structuredClone(original),
        id,
        sourceId: source.id,
        extractorInspectionId: original.id,
        rows: (original.rows ?? []).map((sourceRow) => {
          const identity = taskIdentity(sourceRow) || `row-${sourceRow.no}`;
          return {
            ...structuredClone(sourceRow),
            id: stableId("history-row", `${source.sha256}|p${original.page}|${identity}|${sourceRow.no}`),
            extractorRowId: sourceRow.id ?? null,
            photoEvidence: (sourceRow.photoEvidence ?? []).map((photo) => ({ ...photo, sourceId: source.id })),
            ambiguousPhotoEvidence: (sourceRow.ambiguousPhotoEvidence ?? []).map((photo) => ({ ...photo, sourceId: source.id })),
          };
        }),
      };
      inspections.push(inspection);
    }
    for (const anomaly of extraction.anomalies ?? []) {
      const mapped = structuredClone(anomaly);
      if (mapped.sourceId && sourceLookup.has(mapped.sourceId)) mapped.sourceId = sourceLookup.get(mapped.sourceId).source.id;
      if (mapped.inspectionId) {
        const match = inspections.find((item) => item.extractorInspectionId === mapped.inspectionId);
        if (match) mapped.inspectionId = match.id;
      }
      anomalies.push(mapped);
    }
  }

  const sourceIds = new Set(sources.map((source) => source.id));
  const inspectionIds = new Set(inspections.map((inspection) => inspection.id));
  if (sourceIds.size !== sources.length) fail("Final content-derived PDF source IDs are not unique.");
  if (inspectionIds.size !== inspections.length) fail("Final content-derived inspection page IDs are not unique.");
  sources.sort((left, right) => left.fileName.localeCompare(right.fileName));
  assets.sort((left, right) => left.name.localeCompare(right.name));
  inspections.sort((left, right) => {
    const leftSource = sources.find((source) => source.id === left.sourceId);
    const rightSource = sources.find((source) => source.id === right.sourceId);
    return (leftSource?.fileName ?? "").localeCompare(rightSource?.fileName ?? "") || left.page - right.page;
  });
  return { sources, inspections, assets, anomalies, sourceLookup };
}

function scopeObservations(sources, inspections) {
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const scopes = new Map();
  const unidentifiedRows = [];
  for (const inspection of inspections) {
    const source = sourcesById.get(inspection.sourceId);
    const version = normalizedVersion(inspection.printedVersion);
    const context = contextKey(inspection);
    if (!source || !version || !context) continue;
    const scope = groupKey(source.family, version, context);
    if (!scopes.has(scope)) scopes.set(scope, new Map());
    const tasks = scopes.get(scope);
    for (const row of inspection.rows) {
      const identity = taskIdentity(row);
      if (!identity) {
        unidentifiedRows.push({ sourceId: source.id, inspectionId: inspection.id, page: inspection.page, no: row.no, title: row.title ?? null });
        continue;
      }
      if (!tasks.has(identity)) tasks.set(identity, []);
      tasks.get(identity).push({ row, inspection, source, family: source.family, scope, identity });
    }
  }
  return { scopes, unidentifiedRows };
}

function compareObservations(left, right) {
  return metadataDate(right.inspection) .localeCompare(metadataDate(left.inspection)) ||
    left.source.fileName.localeCompare(right.source.fileName) || left.inspection.page - right.inspection.page ||
    Number(left.row.no || 0) - Number(right.row.no || 0);
}

function taskSummary(identity, observations) {
  const sorted = [...observations].sort(compareObservations);
  const representative = sorted[0];
  const sourceNoEvidence = [...new Map(sorted.map((item) => [
    `${item.source.id}|${item.inspection.page}|${item.row.no}`,
    { sourceId: item.source.id, fileName: item.source.fileName, page: item.inspection.page, printedNo: item.row.no, printedTitle: item.row.title },
  ])).values()];
  const titleEvidence = [...new Set(sorted.map((item) => compact(item.row.title)).filter(Boolean))];
  const fieldConflicts = [];
  for (const key of ["specification", "devices", "samplingPercent", "recordingRule", "timeSeconds", "important"]) {
    const values = [...new Map(sorted.map((item) => [stableJson(item.row[key] ?? null), item.row[key] ?? null])).values()];
    if (values.length > 1) fieldConflicts.push({ field: key, values });
  }
  const printedNos = [...new Set(sorted.map((item) => item.row.no).filter((value) => Number.isSafeInteger(value)))].sort((a, b) => a - b);
  return { identity, sorted, representative, sourceNoEvidence, titleEvidence, fieldConflicts, printedNos };
}

function taskListForScope(tasks, family, version, context, anomalies) {
  const summaries = [...tasks.entries()].map(([identity, rows]) => taskSummary(identity, rows));
  for (const task of summaries) {
    if (task.printedNos.length > 1) {
      anomalies.push({
        code: "same-task-has-changing-printed-item-number",
        family,
        printedVersion: version,
        context,
        taskIdentity: task.identity,
        assignedDisplayNo: null,
        printedNoEvidence: task.sourceNoEvidence,
      });
    }
    if (task.titleEvidence.length > 1) {
      anomalies.push({
        code: "same-task-has-title-variants",
        family,
        printedVersion: version,
        context,
        taskIdentity: task.identity,
        titleEvidence: task.titleEvidence,
        sourceEvidence: task.sourceNoEvidence,
      });
    }
    if (task.fieldConflicts.length) {
      anomalies.push({
        code: "same-task-has-standard-field-conflicts",
        family,
        printedVersion: version,
        context,
        taskIdentity: task.identity,
        conflicts: task.fieldConflicts,
        sourceEvidence: task.sourceNoEvidence,
      });
    }
  }

  summaries.sort((left, right) => {
    const leftNo = left.printedNos[0] ?? Number.MAX_SAFE_INTEGER;
    const rightNo = right.printedNos[0] ?? Number.MAX_SAFE_INTEGER;
    return leftNo - rightNo || left.identity.localeCompare(right.identity);
  });

  const counts = new Map();
  for (const task of summaries) {
    task.preferredNo = Number.isSafeInteger(task.representative.row.no) ? task.representative.row.no : null;
    if (task.preferredNo !== null) counts.set(task.preferredNo, (counts.get(task.preferredNo) ?? 0) + 1);
  }
  const used = new Set(counts.keys());
  const firstForNumber = new Set();
  let nextNumber = Math.max(0, ...used) + 1;
  for (const task of summaries) {
    const preferred = task.preferredNo;
    if (preferred !== null && (counts.get(preferred) === 1 || !firstForNumber.has(preferred))) {
      task.displayNo = preferred;
      firstForNumber.add(preferred);
    } else {
      while (used.has(nextNumber)) nextNumber += 1;
      task.displayNo = nextNumber;
      used.add(nextNumber);
      nextNumber += 1;
    }
  }
  for (const task of summaries) {
    const collision = summaries.filter((candidate) => candidate !== task && candidate.representative.row.no === task.representative.row.no);
    if (collision.length && task.displayNo !== task.representative.row.no) {
      anomalies.push({
        code: "different-tasks-share-printed-item-number",
        family,
        printedVersion: version,
        context,
        printedNo: task.representative.row.no,
        assignedDisplayNo: task.displayNo,
        taskIdentity: task.identity,
        titleEvidence: task.titleEvidence,
        sourceEvidence: task.sourceNoEvidence,
      });
    }
  }
  return summaries;
}

function numericPercent(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100) return value;
  if (typeof value === "string") {
    const match = /^\s*(\d+(?:\.\d+)?)\s*%?\s*$/.exec(value);
    if (match) {
      const result = Number(match[1]);
      if (Number.isFinite(result) && result >= 0 && result <= 100) return result;
    }
  }
  return null;
}

function standardItem(family, versionLabel, context, task, anomalies) {
  const row = task.representative.row;
  const samplingPercent = numericPercent(row.samplingPercent);
  if (samplingPercent === null) {
    anomalies.push({
      code: "historical-standard-excluded-missing-sampling-percentage",
      family,
      printedVersion: versionLabel,
      context,
      title: row.title,
      sourceEvidence: task.sourceNoEvidence,
      samplingPercentRaw: row.samplingPercentRaw ?? null,
    });
    return null;
  }
  const title = compact(row.title);
  const specification = compact(row.specification);
  const devices = compact(row.devices);
  const recordingRule = compact(row.recordingRule);
  if (!title || title.length > 300 || specification.length > 5000 || devices.length > 1000 || recordingRule.length > 500) {
    anomalies.push({
      code: "historical-standard-excluded-field-outside-draft-limits",
      family,
      printedVersion: versionLabel,
      context,
      title,
      sourceEvidence: task.sourceNoEvidence,
    });
    return null;
  }
  const time = row.timeSeconds;
  const timeSeconds = Number.isSafeInteger(time) && time >= 0 ? time : null;
  if (time !== null && time !== undefined && time !== "" && timeSeconds === null) {
    anomalies.push({
      code: "historical-standard-time-not-representable-as-whole-seconds",
      family,
      printedVersion: versionLabel,
      context,
      title,
      timeSecondsRaw: row.timeSecondsRaw ?? time,
      sourceEvidence: task.sourceNoEvidence,
    });
  }
  return {
    id: stableId("history-item", `${family}|${versionLabel}|${context}|${task.identity}`),
    key: stableId("history-key", `${family}|${versionLabel}|${context}|${task.identity}`),
    no: task.displayNo,
    title,
    titleZh: "",
    specification,
    specificationZh: "",
    devices,
    factory: context.split("|")[0],
    stage: context.split("|")[1],
    models: [],
    samplingPercent,
    recordingRule,
    important: row.important === true,
    timeSeconds,
    procedureUrl: "",
  };
}

function standardCandidate(sources, inspections, family) {
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const bySource = new Map();
  for (const inspection of inspections) {
    const source = sourcesById.get(inspection.sourceId);
    if (!source || source.family !== family) continue;
    if (!bySource.has(source.id)) bySource.set(source.id, []);
    bySource.get(source.id).push(inspection);
  }
  const candidates = [];
  for (const source of sources.filter((item) => item.family === family && !sourceIsSelfMade(item))) {
    const records = bySource.get(source.id) ?? [];
    const labels = [...new Set(records.map((record) => normalizedVersion(record.printedVersion)).filter(Boolean))];
    if (labels.length !== 1) continue;
    const contexts = new Set(records.map(contextKey).filter(Boolean));
    if (!EXPECTED_CONTEXTS.every((context) => contexts.has(context))) continue;
    const dates = records.map((record) => parseDate(record.date)).filter(Boolean).sort().reverse();
    if (!dates.length) continue;
    candidates.push({ source, records, versionKey: labels[0], printedVersion: records.find((record) => normalizedVersion(record.printedVersion))?.printedVersion, effectiveDate: dates[0] });
  }
  candidates.sort((left, right) => right.effectiveDate.localeCompare(left.effectiveDate) || left.source.fileName.localeCompare(right.source.fileName));
  return candidates[0] ?? null;
}

function draftNotes(candidate, family, familyAnomalies) {
  const contexts = EXPECTED_CONTEXTS.map((context) => {
    const records = candidate.records.filter((record) => contextKey(record) === context).sort((a, b) => a.page - b.page);
    return `${context.replace("|", " ")}: ${records.map((record) => `p.${record.page}`).join(", ") || "no rows"}`;
  });
  const choice = candidate.records
    .filter((record) => parseDate(record.date))
    .sort((a, b) => (parseDate(b.date) ?? "").localeCompare(parseDate(a.date) ?? "") || a.page - b.page)[0];
  const lines = [
    "Historical source reference draft. Review all rows and applicability before publication.",
    `Printed revision retained as ${text(candidate.printedVersion) || "unresolved"}; it is not assumed to be the latest approved standard.`,
    `Draft effective date ${candidate.effectiveDate} comes from ${choice ? `the printed form date ${text(choice.printedDateRaw ?? choice.printedDate)} on page ${choice.page}` : "the newest source page date"}. It is a provisional date label for review, not proof that every check in the revision was effective then.`,
    `Complete regular source PDF: ${candidate.source.fileName}. Source SHA-256: ${candidate.source.sha256}.`,
    `Source contexts: ${contexts.join("; ")}.`,
    `Task union uses only family ${family}, printed revision ${text(candidate.printedVersion)}, and the same factory/stage. AP IQC is retained in history but excluded from normative reference drafts.`,
    "Newly supplemented historical rows are marked missing-from-source and retain blank results. No result values are carried into this standards draft.",
  ];
  if (familyAnomalies.length) lines.push(`Builder findings requiring review: ${familyAnomalies.length}; see data/pdf-import/summary.json.`);
  return lines.join(" ").slice(0, 5000);
}

function buildDrafts(sources, inspections, scopes, anomalies) {
  const versions = [];
  const candidates = {};
  for (const family of Object.keys(FAMILY_MODELS)) {
    const candidate = standardCandidate(sources, inspections, family);
    if (!candidate) {
      anomalies.push({ code: "no-complete-regular-reference-source", family, message: "No regular source PDF contains all AP OQC, UI IQC, and UI OQC pages with one printed revision and a usable printed date." });
      continue;
    }
    if (!candidate.printedVersion || candidate.printedVersion.length > 160) {
      anomalies.push({ code: "reference-draft-label-unusable", family, sourceId: candidate.source.id, printedVersion: candidate.printedVersion ?? null });
      continue;
    }
    candidates[family] = { sourceId: candidate.source.id, fileName: candidate.source.fileName, printedVersion: candidate.printedVersion, effectiveDate: candidate.effectiveDate };
    const items = [];
    const familyStart = anomalies.length;
    for (const context of EXPECTED_CONTEXTS) {
      const scope = groupKey(family, candidate.versionKey, context);
      const taskMap = scopes.get(scope) ?? new Map();
      const tasks = taskListForScope(taskMap, family, candidate.printedVersion, context, anomalies);
      for (const task of tasks) {
        const item = standardItem(family, candidate.printedVersion, context, task, anomalies);
        if (item) items.push(item);
      }
    }
    const familyAnomalies = anomalies.slice(familyStart);
    versions.push({
      id: stableId("history-version", `${family}|${candidate.source.sha256}|${candidate.versionKey}`),
      familyId: family,
      label: candidate.printedVersion,
      sequence: 1,
      effectiveDate: candidate.effectiveDate,
      status: "draft",
      notes: draftNotes(candidate, family, familyAnomalies),
      items,
      createdAt: CREATED_AT,
      publishedAt: null,
      sourcePdfSha256: candidate.source.sha256,
      sourcePrintedVersion: candidate.printedVersion,
    });
  }
  return { versions, candidates };
}

function supplementalHistoryRows(sources, inspections, scopes, anomalies) {
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const allocatedTasks = new Map();
  for (const [scope, taskMap] of scopes) {
    const [family, version, context] = scope.split("|");
    const scopeAnomalies = [];
    allocatedTasks.set(scope, taskListForScope(taskMap, family, version, context, scopeAnomalies));
    anomalies.push(...scopeAnomalies);
  }
  let added = 0;
  for (const inspection of inspections) {
    const source = sourcesById.get(inspection.sourceId);
    const version = normalizedVersion(inspection.printedVersion);
    const context = contextKey(inspection);
    if (!source || !version || !context) continue;
    const scope = groupKey(source.family, version, context);
    const taskMap = scopes.get(scope);
    if (!taskMap) continue;
    const tasks = allocatedTasks.get(scope) ?? [];
    const present = new Set(inspection.rows.map(taskIdentity).filter(Boolean));
    const usedNumbers = new Set(inspection.rows.map((row) => row.no).filter(Number.isSafeInteger));
    let nextNumber = Math.max(0, ...usedNumbers) + 1;
    for (const task of tasks) {
      if (present.has(task.identity)) continue;
      const row = task.representative.row;
      const evidence = task.sourceNoEvidence[0];
      while (usedNumbers.has(nextNumber)) nextNumber += 1;
      const displayNo = nextNumber;
      usedNumbers.add(displayNo);
      nextNumber += 1;
      const missingEvidence = `This check is printed as item ${displayNoText(evidence.printedNo)} in ${evidence.fileName}, page ${evidence.page}, under the same printed revision and ${context.replace("|", " ")}. The current source page has no matching task title/specification.`;
      inspection.rows.push({
        id: stableId("missing-history-row", `${inspection.id}|${task.identity}`),
        no: displayNo,
        title: compact(row.title),
        specification: compact(row.specification),
        devices: compact(row.devices),
        samplingPercent: row.samplingPercent ?? null,
        recordingRule: compact(row.recordingRule),
        timeSeconds: row.timeSeconds ?? null,
        important: row.important ?? null,
        sourceInspectedQty: null,
        defectiveQty: null,
        sourceDefectiveRate: null,
        remarks: "",
        status: "missing-from-source",
        missingEvidence,
        raw: {
          supplemental: true,
          taskIdentity: task.identity,
          sourceNoEvidence: task.sourceNoEvidence,
          standardSource: evidence,
          historicalResultsCopied: false,
        },
      });
      added += 1;
    }
  }
  return added;
}

function displayNoText(value) {
  return value === null || value === undefined ? "unresolved number" : String(value);
}

function buildSummary(pkg, candidates, originalRowCount, supplementalRows, anomalies) {
  const familySummaries = {};
  for (const family of Object.keys(FAMILY_MODELS)) {
    const sources = pkg.sources.filter((source) => source.family === family);
    const inspections = pkg.inspections.filter((inspection) => sources.some((source) => source.id === inspection.sourceId));
    familySummaries[family] = {
      sources: sources.length,
      sourcePages: sources.reduce((total, source) => total + source.pageCount, 0),
      inspectionPages: inspections.length,
      originalInspectionRows: inspections.reduce((total, inspection) => total + inspection.rows.filter((row) => row.status !== "missing-from-source").length, 0),
      supplementalMissingRows: inspections.reduce((total, inspection) => total + inspection.rows.filter((row) => row.status === "missing-from-source").length, 0),
      referenceDraft: candidates[family] ?? null,
    };
  }
  const actualPdfBytes = pkg.assets.reduce((total, asset) => total + Math.floor((asset.dataUrl.length - asset.dataUrl.indexOf(",") - 1) * 3 / 4), 0);
  const summary = {
    generatedAt: CREATED_AT,
    format: pkg.format,
    sourceCount: pkg.sources.length,
    sourcePageCount: pkg.sources.reduce((total, source) => total + source.pageCount, 0),
    inspectionPageCount: pkg.inspections.length,
    originalInspectionRowCount: originalRowCount,
    supplementalMissingRowCount: supplementalRows,
    referenceDraftCount: pkg.versions.length,
    families: familySummaries,
    sourcePdfBytesApprox: actualPdfBytes,
    sourcePdfMiBApprox: Number((actualPdfBytes / (1024 * 1024)).toFixed(2)),
    unresolvedBuilderFindingCount: anomalies.length,
    anomalies,
    purchaseOrdersLinked: 0,
    operationalBatchesCreated: 0,
    purchaseOrderProgressContribution: 0,
  };
  return summary;
}

function summaryMarkdown(summary) {
  const lines = [
    "# Historical PDF import build summary",
    "",
    `Generated from the two authorized PDF families. Original PDFs total about ${summary.sourcePdfMiBApprox} MiB.`,
    "",
    `- Original PDFs: ${summary.sourceCount}`,
    `- Source pages: ${summary.sourcePageCount}`,
    `- Inspection page records: ${summary.inspectionPageCount}`,
    `- Printed inspection rows: ${summary.originalInspectionRowCount}`,
    `- Explicit missing-from-source rows: ${summary.supplementalMissingRowCount}`,
    `- Unpublished reference drafts: ${summary.referenceDraftCount}`,
    "- Operational batches created: 0",
    "- Purchase orders linked: 0",
    "- PO progress contribution: 0",
    "",
    "## Families",
    "",
    "| Family | PDFs | Source pages | Inspection pages | Printed rows | Missing rows | Reference draft |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const [family, item] of Object.entries(summary.families)) {
    lines.push(`| ${family} | ${item.sources} | ${item.sourcePages} | ${item.inspectionPages} | ${item.originalInspectionRows} | ${item.supplementalMissingRows} | ${item.referenceDraft?.printedVersion ?? "Not created"} |`);
  }
  lines.push("", "## Findings", "");
  if (summary.anomalies.length) {
    for (const anomaly of summary.anomalies) lines.push(`- ${anomaly.code}: ${anomaly.message ?? anomaly.title ?? "Review source evidence in summary.json."}`);
  } else {
    lines.push("No builder findings were generated.");
  }
  lines.push("");
  return lines.join("\n");
}

export function buildHistoryPackage(extractionPackages) {
  const { sources, inspections, assets, anomalies } = stableSourceObjects(extractionPackages);
  const originalRowCount = inspections.reduce((total, inspection) => total + inspection.rows.length, 0);
  const { scopes, unidentifiedRows } = scopeObservations(sources, inspections);
  for (const row of unidentifiedRows) anomalies.push({ code: "historical-row-task-identity-unresolved", ...row });
  const draftAnomalies = [];
  const { versions, candidates } = buildDrafts(sources, inspections, scopes, draftAnomalies);
  anomalies.push(...draftAnomalies);
  const supplementalMissingRowCount = supplementalHistoryRows(sources, inspections, scopes, anomalies);
  const uniqueAnomalies = [...new Map(anomalies.map((anomaly) => [stableJson(anomaly), anomaly])).values()];
  const pkg = {
    format: "masterqc-pdf-history",
    formatVersion: 1,
    sources,
    inspections,
    assets,
    versions,
    anomalies: uniqueAnomalies,
  };
  const summary = buildSummary(pkg, candidates, originalRowCount, supplementalMissingRowCount, uniqueAnomalies);
  pkg.summary = {
    sourceCount: summary.sourceCount,
    sourcePageCount: summary.sourcePageCount,
    inspectionPageCount: summary.inspectionPageCount,
    originalInspectionRowCount: summary.originalInspectionRowCount,
    supplementalMissingRowCount: summary.supplementalMissingRowCount,
    referenceDraftCount: summary.referenceDraftCount,
    purchaseOrderProgressContribution: 0,
  };
  return { package: pkg, summary };
}

function parseArgs(args) {
  const options = {
    inputs: ["data/pdf-import/s1-history.json", "data/pdf-import/s15-extraction.json"].map((file) => path.join(ROOT, file)),
    output: path.join(ROOT, "data/pdf-import/masterqc-history.json"),
    summaryJson: path.join(ROOT, "data/pdf-import/summary.json"),
    summaryMarkdown: path.join(ROOT, "data/pdf-import/summary.md"),
  };
  const values = new Map([["--s1", 0], ["--s15", 1]]);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (values.has(option)) {
      const slot = values.get(option);
      options.inputs[slot] = path.resolve(args[++index]);
    } else if (option === "--output") options.output = path.resolve(args[++index]);
    else if (option === "--summary-json") options.summaryJson = path.resolve(args[++index]);
    else if (option === "--summary-markdown") options.summaryMarkdown = path.resolve(args[++index]);
    else if (option === "--help") options.help = true;
    else fail(`Unknown option: ${option}`);
  }
  return options;
}

async function main(args) {
  const options = parseArgs(args);
  if (options.help) {
    console.log("Build source-faithful history package: node scripts/pdf-import/build_history_package.mjs [--s1 FILE] [--s15 FILE] [--output FILE]");
    return;
  }
  const extractionPackages = [];
  for (const input of options.inputs) extractionPackages.push(JSON.parse(await readFile(input, "utf8")));
  const result = buildHistoryPackage(extractionPackages);
  await verifyHistoryPackage(result.package);
  validateHistoryPackage(result.package);
  const serialized = `${JSON.stringify(result.package, null, 2)}\n`;
  const packageBytes = Buffer.byteLength(serialized);
  if (packageBytes > 50 * 1024 * 1024) fail(`Built history package is ${(packageBytes / (1024 * 1024)).toFixed(2)} MiB, above the 50 MiB app limit.`);
  result.summary.packageBytes = packageBytes;
  result.summary.packageMiB = Number((packageBytes / (1024 * 1024)).toFixed(2));
  await writeFile(options.output, serialized, "utf8");
  await writeFile(options.summaryJson, `${JSON.stringify(result.summary, null, 2)}\n`, "utf8");
  await writeFile(options.summaryMarkdown, summaryMarkdown(result.summary), "utf8");
  console.log(JSON.stringify({ output: options.output, summaryJson: options.summaryJson, summaryMarkdown: options.summaryMarkdown, packageBytes, summary: result.package.summary }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
