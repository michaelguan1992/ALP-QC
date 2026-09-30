import {
  button, csvRow, dateLabel, el, list, pageHeading, quantity, safeFilename, safeProcedureUrl, statusPill, text,
} from "./qc-ops-common.js";
import { downloadFile, notify } from "./qc-ui.js";
import { resolveBatchDisplayNumbers } from "../core/qc-batch-display.js";

const h = el;

function percent(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(2)}%` : String(value);
}

function isHistoricalBatch(batch) {
  return batch?.kind === "historical";
}

function sourceText(value) {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function sourcePercent(value) {
  if (value === null || value === undefined || value === "") return "—";
  const printed = String(value);
  if (/%\s*$/.test(printed)) return printed;
  return /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(printed.trim()) ? `${printed}%` : printed;
}

function sourceRate(value) {
  return sourcePercent(value);
}

function batchProductLabel(batch, variant) {
  if (!isHistoricalBatch(batch)) return variant?.label;
  const label = String(batch.productLabel || batch.model || "");
  const color = String(batch.color || "");
  const normalColor = ["red", "normalred"].includes(color.toLocaleLowerCase().replace(/[\s_-]/g, ""));
  return color && !normalColor && !label.toLocaleLowerCase().includes(color.toLocaleLowerCase()) ? `${label} ${color}`.trim() : label;
}

function batchInspection(stage, factory) {
  return [factory, stage].filter((value) => value !== null && value !== undefined && value !== "").join(" · ") || "—";
}

function sourceComputedQuantity(batch, row) {
  if (row.status === "missing-from-source" || batch.quantity === null || batch.quantity === undefined || batch.quantity === "" || row.sourceInspectedQty === null || row.sourceInspectedQty === undefined || row.sourceInspectedQty === "" || row.samplingPercent === null || row.samplingPercent === undefined || row.samplingPercent === "") return null;
  const batchQuantity = Number(batch.quantity);
  const samplingPercent = Number(String(row.samplingPercent).replace(/%\s*$/, ""));
  const sourceQuantity = Number(row.sourceInspectedQty);
  if (!Number.isFinite(batchQuantity) || batchQuantity < 0 || !Number.isFinite(samplingPercent) || samplingPercent < 0 || samplingPercent > 100 || !Number.isFinite(sourceQuantity)) return null;
  const computed = Math.ceil(batchQuantity * samplingPercent / 100);
  return computed === sourceQuantity ? null : computed;
}

function sourceInspection(batch, state) {
  const inspection = list(state.history?.inspections).find((entry) => entry.id === batch.historyInspectionId) ?? null;
  return inspection;
}

function displayTitle(cell, english, chinese) {
  cell.append(h("span", { className: "qc-ops-en" }, text(english)));
  if (chinese) cell.append(h("span", { className: "qc-ops-zh", lang: "zh" }, chinese));
}

function lookupOrder(state, batch) {
  return list(state.orders).find((order) => order.id === batch.orderId) ?? null;
}

function lookupVariant(state, batch) {
  return list(state.variants).find((variant) => variant.id === batch.variantId) ?? null;
}

function lookupOrderLine(order, batch) {
  return list(order?.lines).find((line) => line.id === batch.lineId) ?? null;
}

function makeReadOnlyTable(workspace) {
  const historical = isHistoricalBatch(workspace.batch);
  const table = h("table", { className: "qc-ops-inspection-table qc-ops-report-table" });
  const widths = ["34px", "100px", "185px", "80px", "60px", "76px", "55px", "55px", "52px", "52px", "52px", "52px", "52px", "44px", "64px", "165px", "128px"];
  const colgroup = h("colgroup", {}, widths.map((width) => h("col", { style: { width } })));
  const thead = h("thead", {},
    h("tr", { className: "qc-ops-group-head" },
      h("th", { rowSpan: "2", scope: "col" }, "No.", h("br"), h("span", { lang: "zh" }, "序号")),
      h("th", { rowSpan: "2", scope: "col" }, "QC task", h("br"), h("span", { lang: "zh" }, "检验项目")),
      h("th", { rowSpan: "2", scope: "col" }, "Specifications / inspection points", h("br"), h("span", { lang: "zh" }, "规格尺寸 / 检验要点")),
      h("th", { rowSpan: "2", scope: "col" }, "Devices / methods", h("br"), h("span", { lang: "zh" }, "检测仪器 / 方法")),
      h("th", { rowSpan: "2", scope: "col" }, "Inspection frequency", h("br"), h("span", { lang: "zh" }, "检验频率")),
      h("th", { rowSpan: "2", scope: "col" }, "Recording frequency", h("br"), h("span", { lang: "zh" }, "记录频率")),
      h("th", { colSpan: "3", scope: "colgroup" }, "Quality control points", h("br"), h("span", { lang: "zh" }, "品质管制点")),
      h("th", { colSpan: "4", scope: "colgroup" }, "Defective rate history · saved batches only", h("br"), h("span", { lang: "zh" }, "不良率历史记录 · 已保存批次")),
      h("th", { rowSpan: "2", scope: "col" }, "Time", h("br"), h("span", { lang: "zh" }, "时数 (sec)")),
      h("th", { rowSpan: "2", scope: "col" }, "Procedure / link", h("br"), h("span", { lang: "zh" }, "视频 / 程序 / 报告")),
      h("th", { rowSpan: "2", scope: "col" }, "Remarks / issues", h("br"), h("span", { lang: "zh" }, "备注 / 问题")),
      h("th", { rowSpan: "2", scope: "col" }, "Photos", h("br"), h("span", { lang: "zh" }, "照片")),
    ),
    h("tr", { className: "qc-ops-sub-head" },
      h("th", { scope: "col" }, "Inspection qty", h("br"), h("span", { lang: "zh" }, "检验数量")),
      h("th", { scope: "col" }, "Defective qty", h("br"), h("span", { lang: "zh" }, "不良数")),
      h("th", { scope: "col" }, "Defective rate", h("br"), h("span", { lang: "zh" }, "不良率")),
      ...[1, 2, 3, 4].map((index) => h("th", { scope: "col" }, `Prior ${index}`, h("br"), h("span", { lang: "zh" }, `历史 ${index}`))),
    ),
  );
  const body = h("tbody", { className: "qc-ops-table-body" }, list(workspace.rows).map((row, index) => {
    const tr = h("tr", { className: `${row.important === true ? "qc-ops-important-row" : ""}${historical && row.status === "missing-from-source" ? " qc-ops-historical-missing-row" : ""}`.trim() });
    tr.append(h("td", { className: "qc-ops-no" }, text(row.no, String(index + 1))));
    const title = h("th", { scope: "row", className: "qc-ops-task" });
    displayTitle(title, row.title, row.titleZh);
    if (historical && row.status === "missing-from-source") {
      title.append(h("span", { className: "qc-ops-historical-badge" }, "Missing from source"));
      if (row.missingEvidence) title.append(h("small", { className: "qc-ops-historical-evidence" }, row.missingEvidence));
    }
    tr.append(title);
    const specification = h("td", { className: "qc-ops-spec" });
    displayTitle(specification, row.specification, row.specificationZh);
    tr.append(specification);
    const method = h("td", { className: "qc-ops-method" });
    displayTitle(method, row.devices, row.devicesZh || "");
    tr.append(method,
      h("td", { className: "qc-ops-frequency" }, historical ? sourcePercent(row.samplingPercent) : `${text(row.samplingPercent, "0")}%`),
      h("td", { className: "qc-ops-recording" }, text(row.recordingRule)),
      (() => {
        const cell = h("td", { className: "qc-ops-number" }, historical ? sourceText(row.sourceInspectedQty) : quantity(row.inspectedQty));
        const computed = historical ? sourceComputedQuantity(workspace.batch, row) : null;
        if (computed !== null) cell.append(h("small", { className: "qc-ops-historical-comparison" }, `Web formula: ${quantity(computed)}`));
        return cell;
      })(),
      h("td", { className: "qc-ops-number" }, historical
        ? sourceText(row.defectiveQty)
        : row.defectiveQty === null || row.defectiveQty === undefined ? "Not saved" : quantity(row.defectiveQty)),
      h("td", { className: "qc-ops-number qc-ops-rate" }, historical ? sourceRate(row.sourceDefectiveRate) : percent(row.defectiveRate)),
    );
    const history = list(row.history);
    for (let historyIndex = 0; historyIndex < 4; historyIndex += 1) {
      const entry = history[historyIndex];
      const cell = h("td", { className: "qc-ops-history" });
      if (entry) cell.append(h("strong", {}, percent(entry.rate)), h("small", {}, text(entry.batchNumber, entry.batchId)), h("small", {}, dateLabel(entry.date)));
      else cell.append(h("span", { className: "qc-ops-empty-history" }, "—"));
      tr.append(cell);
    }
    tr.append(h("td", { className: "qc-ops-number" }, row.timeSeconds === null || row.timeSeconds === undefined ? "—" : `${row.timeSeconds}s`));
    const procedureCell = h("td", { className: "qc-ops-link" });
    const procedureUrl = safeProcedureUrl(row.procedureUrl);
    procedureCell.append(procedureUrl ? h("a", { href: procedureUrl, target: "_blank", rel: "noopener noreferrer" }, "Open procedure") : text(row.procedureUrl, "—"));
    tr.append(procedureCell);
    const issues = list(row.issues);
    const remarks = h("td", { className: "qc-ops-remarks qc-ops-report-remarks" },
      h("div", {}, text(row.remarks)),
      issues.length ? h("div", { className: "qc-ops-report-issue-list" }, issues.map((issue) => h("span", {}, `${text(issue.number, "Issue")} · ${text(issue.status)}`))) : null,
    );
    const photos = list(row.photos).filter((photo) => typeof photo.dataUrl === "string" && photo.dataUrl.startsWith("data:image/"));
    const photoCell = h("td", { className: "qc-ops-photos qc-ops-report-photos" });
    if (photos.length) {
      photoCell.append(h("div", { className: "qc-ops-report-photo-gallery" }, photos.map((photo) => h("figure", { className: "qc-ops-report-photo" },
        h("img", { src: photo.dataUrl, alt: photo.name || `Photo for ${text(row.title)}` }),
        h("figcaption", {}, text(photo.name, "Inspection photo")),
      ))));
    } else {
      photoCell.append(h("span", { className: "qc-ops-empty-photo" }, "No photos"));
    }
    tr.append(remarks, photoCell);
    return tr;
  }));
  table.append(colgroup, thead, body);
  return h("div", { className: "qc-ops-table-scroll", tabindex: "0", "aria-label": "Read-only batch inspection report; scroll horizontally to see all columns" }, table);
}

function reportMetadata(workspace, state) {
  const batch = workspace.batch;
  const historical = isHistoricalBatch(batch);
  const inspection = historical ? sourceInspection(batch, state) : null;
  const order = workspace.order || lookupOrder(state, batch);
  const line = lookupOrderLine(order, batch);
  const variant = workspace.variant || lookupVariant(state, batch);
  const openIssues = list(state.issues).filter((issue) => issue.batchId === batch.id && issue.status === "open").length;
  const fields = [
    ["Batch number 批次编号", workspace.displayNumber ?? batch.number],
    [historical ? "Product / model 产品型号" : "Product variant 产品规格", batchProductLabel(batch, variant)],
    ["Purchase order 采购订单", order?.number],
    ["Ordered quantity 订单数量", line?.orderedQty === undefined ? "—" : quantity(line.orderedQty)],
    ["Inspection stage 检验阶段", batchInspection(batch.stage, batch.factory)],
    ["Batch quantity 批次数量", historical ? sourceText(batch.quantity) : quantity(batch.quantity)],
    ["Physical lot number 实物批号", batch.lotNumber],
    ["Batch date 批次日期", dateLabel(batch.date)],
    ["Recorded by 记录人员", historical ? inspection?.recorder : batch.recorder],
    ["Design version 设计版本", workspace.version?.label || batch.versionLabel],
    ["PO progress 采购订单进度", historical ? "Excluded · historical record" : batch.countForPO ? "Counts full quantity after release" : "Not counted"],
    ["Open linked issues 未关闭问题", openIssues],
  ];
  return h("dl", { className: "qc-ops-report-meta" }, fields.flatMap(([label, value]) => [h("dt", {}, label), h("dd", {}, String(value ?? "—"))]));
}

function exportRows(workspace, state) {
  const batch = workspace.batch;
  const displayNumbers = resolveBatchDisplayNumbers(state);
  const displayNumber = workspace.displayNumber ?? displayNumbers.get(batch.id) ?? batch.number;
  const historical = isHistoricalBatch(batch);
  const order = workspace.order || lookupOrder(state, batch);
  const variant = workspace.variant || lookupVariant(state, batch);
  const productLabel = batchProductLabel(batch, variant);
  const headers = [
    "Batch number", "Batch date", "Status", "Product variant", "Purchase order", "Factory", "Stage", "Batch quantity", "Physical lot", "Design version",
    "No.", "Inspection title", "检验项目", "Specification", "检验标准", "Devices", "Sampling percent", "Recording rule", "Inspected quantity", "Defective quantity", "Defective rate",
    "Prior 1", "Prior 2", "Prior 3", "Prior 4", "Time seconds", "Procedure URL", "Remarks", "Linked issues", "Photo file names",
  ];
  const rows = [csvRow(headers.map((value) => ({ value, textField: false })))];
  for (const row of list(workspace.rows)) {
    const histories = list(row.history);
    const priorValues = [0, 1, 2, 3].map((index) => {
      const entry = histories[index];
      const priorBatchNumber = entry ? displayNumbers.get(entry.batchId) ?? entry.batchNumber ?? entry.batchId : "";
      return entry ? `${text(priorBatchNumber, entry.batchId)} · ${dateLabel(entry.date)} · ${percent(entry.rate)}` : "";
    });
    const issues = list(row.issues).map((issue) => `${text(issue.number, "Issue")} (${text(issue.status)})`).join("; ");
    const photos = list(row.photos).map((photo) => photo.name).filter(Boolean).join("; ");
    const values = [
      [displayNumber, true], [batch.date, false], [historical ? "" : batch.status, false], [productLabel, true], [order?.number, true], [batch.factory, true], [batch.stage, true],
      [batch.quantity, false], [batch.lotNumber, true], [batch.versionLabel, true], [row.no, true], [row.title, true], [row.titleZh, true],
      [row.specification, true], [row.specificationZh, true], [row.devices, true], [row.samplingPercent, false], [row.recordingRule, true],
      [historical ? row.sourceInspectedQty : row.inspectedQty, false], [row.defectiveQty, false], [historical ? row.sourceDefectiveRate : row.defectiveRate === null || row.defectiveRate === undefined ? "" : percent(row.defectiveRate), false],
      ...priorValues.map((value) => [value, true]), [row.timeSeconds ?? "", false], [row.procedureUrl, true], [row.remarks, true], [issues, true], [photos, true],
    ];
    rows.push(csvRow(values.map(([value, textField]) => ({ value, textField }))));
  }
  return `\uFEFF${rows.join("\r\n")}\r\n`;
}

function printReport() {
  const wasPrinting = document.body.classList.contains("printing");
  document.body.classList.add("printing");
  const finish = () => document.body.classList.remove("printing");
  window.addEventListener("afterprint", finish, { once: true });
  window.setTimeout(() => window.print(), 30);
  window.setTimeout(() => {
    if (!wasPrinting && document.body.classList.contains("printing")) finish();
  }, 120000);
}

async function renderReportDetail(root, ctx) {
  root.replaceChildren(pageHeading("Batch report", "Loading the selected batch report…"), h("section", { className: "card qc-ops-loading" }, "Loading saved batch records and photos…"));
  let workspace;
  try {
    workspace = await ctx.service.getBatchWorkspace(ctx.selectedId);
  } catch (error) {
    root.replaceChildren(pageHeading("Batch report", "The selected report could not be loaded.", [button("Back to batch", () => ctx.navigate("batches", ctx.selectedId, true), "button button-secondary")]),
      h("section", { className: "card qc-ops-error-card", role: "alert" }, text(error instanceof Error ? error.message : "The selected batch is unavailable.")));
    return;
  }
  if (!root.isConnected) return;
  const batch = workspace.batch;
  const state = ctx.state || {};
  const historical = isHistoricalBatch(batch);
  const variant = workspace.variant || lookupVariant(state, batch);
  const order = workspace.order || lookupOrder(state, batch);
  const productLabel = batchProductLabel(batch, variant);
  const reportTitle = `${text(workspace.displayNumber ?? batch.number)} · ${text(productLabel)}`;
  const unsavedRows = historical ? 0 : list(workspace.rows).filter((row) => row.savedAt === null || row.defectiveQty === null).length;
  const scope = h("article", { className: "print-scope qc-ops-report" },
    h("header", { className: "qc-ops-report-document-heading" },
      h("p", { className: "eyebrow" }, "MasterQC Web · Inspection report"),
      h("h2", {}, reportTitle),
      h("div", { className: "qc-ops-report-document-status" }, historical ? h("span", { className: "qc-ops-note-pill" }, "Read-only") : statusPill(batch.status), h("span", {}, `Generated ${new Date().toLocaleString()}`)),
    ),
    reportMetadata(workspace, state),
    batch.notes ? h("section", { className: "qc-ops-report-notes" }, h("strong", {}, "Batch notes / 本批次备注"), h("p", {}, batch.notes)) : null,
    unsavedRows ? h("p", { className: "qc-ops-report-unsaved-note" }, `${unsavedRows} inspection row${unsavedRows === 1 ? "" : "s"} have no saved result. Unsaved browser edits are not included in this report.`) : null,
    h("section", { className: "qc-ops-report-table-section" },
      h("div", { className: "qc-ops-section-heading" }, h("div", {}, h("h2", {}, "Batch inspection table"), h("p", {}, historical ? "Transcribed source results are preserved, including blank cells and printed defective rates." : "Saved results, historical rates, linked issues, and photos appear on the same inspection row."))),
      makeReadOnlyTable(workspace),
    ),
  );
  const header = pageHeading("Batch report", historical ? "Read-only report of this batch and its source-recorded values." : "Read-only report of saved batch records and their row-specific evidence.", [
    button("Back to batch", () => ctx.navigate("batches", batch.id, true), "button button-secondary"),
    button("Download CSV", async () => {
      try {
        const csv = exportRows(workspace, state);
        await downloadFile(`${safeFilename(workspace.displayNumber ?? batch.number, "qc-batch")}-report.csv`, csv, "text/csv;charset=utf-8");
        notify("CSV report downloaded. Text cells are quoted and formula-neutralized.");
      } catch (error) {
        notify(error instanceof Error ? error.message : "The CSV report could not be downloaded.", true);
      }
    }, "button button-secondary"),
    button("Print / save as PDF", printReport, "button button-primary"),
  ]);
  root.replaceChildren(header, scope);
}

export async function renderBatchReportPage(root, ctx) {
  root.classList.add("qc-ops-root");
  if (!ctx.selectedId) {
    root.replaceChildren(pageHeading("Batch report", "Open a report from a batch detail page.", [button("Open batches", () => ctx.navigate("batches"), "button button-secondary")]));
    return;
  }
  return renderReportDetail(root, ctx);
}
