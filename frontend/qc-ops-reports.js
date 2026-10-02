import {
  button, csvRow, dateLabel, el, list, pageHeading, quantity, safeFilename, safeProcedureUrl, statusPill, text,
} from "./qc-ops-common.js";
import { downloadFile, notify } from "./qc-ui.js";
import { attachmentCanPreview, attachmentDownload, openAttachmentPreview } from "./qc-attachments.js";
import { resolveBatchDisplayNumbers } from "../core/qc-batch-display.js";
import { getBatchProducts, getBatchRowProduct } from "../core/qc-batch-products.js";

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

function reportTimeSeconds(row, historical) {
  if (historical) return row.timeSeconds;
  return row.actualTimeSeconds;
}

function reportTimeLabel(row, historical) {
  const value = reportTimeSeconds(row, historical);
  return value === null || value === undefined || value === "" ? historical ? "—" : "Incomplete" : `${value}s`;
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

function reportProducts(workspace, state) {
  if (isHistoricalBatch(workspace.batch)) return [];
  const products = Array.isArray(workspace.products) && workspace.products.length
    ? workspace.products
    : getBatchProducts(workspace.batch).map((product) => ({
      ...product,
      variant: list(state.variants).find((variant) => variant.id === product.variantId) || null,
      version: list(state.versions).find((version) => version.id === product.versionId) || null,
    }));
  return products;
}

function rowAttachments(row, state) {
  if (row.attachments && typeof row.attachments === "object") return row.attachments;
  const assets = new Map(list(state.assets).map((asset) => [asset.id, asset]));
  const ids = row.attachmentIds || {};
  return {
    videos: assets.get(ids.videos) || null,
    procedures: assets.get(ids.procedures) || null,
    log: assets.get(ids.log) || null,
  };
}

function issueEvidence(issue, state) {
  if (Array.isArray(issue.attachments)) return issue.attachments;
  const assets = new Map(list(state.assets).map((asset) => [asset.id, asset]));
  return list(issue.attachmentIds).map((id) => assets.get(id)).filter(Boolean);
}

function legacyPhotoAssets(row, state) {
  const assets = new Map(list(state.assets).map((asset) => [asset.id, asset]));
  const direct = list(row.photos);
  const photoIds = list(row.photoIds);
  const seen = new Set();
  return [...direct, ...photoIds.map((id) => assets.get(id))].filter((asset) => {
    if (!asset || typeof asset.dataUrl !== "string" || !asset.dataUrl.startsWith("data:image/")) return false;
    const key = asset.id || `${asset.name || ""}\u0000${asset.dataUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function attachmentActions(asset) {
  const preview = attachmentCanPreview(asset)
    ? button("Preview", () => openAttachmentPreview(asset), "button-quiet qc-ops-small-button")
    : null;
  return h("div", { className: "qc-ops-report-attachment-actions" }, preview, attachmentDownload(asset));
}

function legacyEvidence(row, state) {
  const photos = legacyPhotoAssets(row, state);
  const remark = String(row.remarks || "").trim();
  if (!remark && !photos.length) return null;
  return h("details", { className: "qc-ops-report-legacy-evidence" },
    h("summary", {}, `Source evidence${photos.length ? ` · ${photos.length} photo${photos.length === 1 ? "" : "s"}` : ""}`),
    remark ? h("p", {}, remark) : null,
    photos.length ? h("div", { className: "qc-ops-report-photo-gallery qc-ops-report-legacy-photos" }, photos.map((photo) => h("figure", { className: "qc-ops-report-photo" },
      h("img", { src: photo.dataUrl, alt: text(photo.name, "Legacy photo") }),
      h("figcaption", {}, text(photo.name, "Legacy photo")),
      attachmentActions(photo),
    ))) : null,
  );
}

function reportIssueEvidence(issues, state) {
  if (!issues.length) return null;
  return h("ul", { className: "qc-ops-report-issue-list" }, issues.map((issue) => {
    const evidence = issueEvidence(issue, state);
    return h("li", { className: "qc-ops-report-issue" },
      h("strong", {}, `${text(issue.number, "Issue")} · ${text(issue.status)}`),
      issue.title ? h("span", {}, text(issue.title)) : null,
      issue.description ? h("p", {}, text(issue.description)) : null,
      evidence.length ? h("ul", { className: "qc-ops-report-issue-evidence" }, evidence.map((asset) => h("li", {},
        h("span", {}, text(asset.name, "Issue evidence")), attachmentActions(asset),
      ))) : null,
    );
  }));
}

function reportRowAttachmentCell(row, state) {
  const attachments = rowAttachments(row, state);
  const categories = [
    ["Videos", attachments.videos],
    ["Procedures", attachments.procedures],
    ["Log", attachments.log],
  ];
  const populated = categories.filter(([, asset]) => asset);
  return h("td", { className: "qc-ops-attachments qc-ops-report-attachments" }, populated.length
    ? populated.map(([label, asset]) => h("div", { className: "qc-ops-report-attachment" },
      h("strong", {}, `${label}:`), h("span", {}, text(asset.name, "Attachment")), attachmentActions(asset),
    ))
    : h("span", { className: "qc-ops-empty-photo" }, "—"));
}

function historicalPhotosCell(row, state) {
  const photos = legacyPhotoAssets(row, state);
  if (!photos.length) return h("td", { className: "qc-ops-photos qc-ops-report-photos" }, h("span", { className: "qc-ops-empty-photo" }, "—"));
  return h("td", { className: "qc-ops-photos qc-ops-report-photos" },
    h("div", { className: "qc-ops-report-photo-gallery" }, photos.map((photo) => h("figure", { className: "qc-ops-report-photo" },
      h("img", { src: photo.dataUrl, alt: photo.name || `Photo for ${text(row.title)}` }),
      h("figcaption", {}, text(photo.name, "Inspection photo")),
      attachmentActions(photo),
    ))),
  );
}

function productLabel(product, state) {
  const variant = product?.variant || list(state.variants).find((entry) => entry.id === product?.variantId);
  return text(product?.variantLabel || product?.productLabel || variant?.label, product?.variantId || "Product");
}

function allProductsSummary(products, state, order = null) {
  return products.map((product) => {
    const line = list(order?.lines).find((entry) => entry.id === product.lineId);
    return `${productLabel(product, state)} · ${quantity(product.quantity)} units · Version ${text(product.version?.label || product.versionLabel)}${line ? ` · ${quantity(line.orderedQty)} ordered` : ""}`;
  }).join("; ");
}

function totalBatchQuantity(workspace, state) {
  if (isHistoricalBatch(workspace.batch)) return workspace.batch.quantity;
  const products = reportProducts(workspace, state);
  return products.length ? products.reduce((sum, product) => sum + Number(product.quantity || 0), 0) : workspace.batch.quantity;
}

function rowProduct(workspace, row, state) {
  const batch = workspace.batch;
  const linked = getBatchRowProduct(batch, row) || {};
  const product = reportProducts(workspace, state).find((entry) => entry.lineId === (row.productLineId || linked.lineId));
  return { ...linked, ...product, ...linked };
}

function makeReadOnlyTable(workspace, state) {
  const historical = isHistoricalBatch(workspace.batch);
  const multipleProducts = !historical && reportProducts(workspace, state).length > 1;
  const table = h("table", { className: `qc-ops-inspection-table qc-ops-report-table${multipleProducts ? " qc-ops-mixed-product-table" : ""}` });
  const widths = ["34px", ...(multipleProducts ? ["118px"] : []), "100px", "185px", "80px", "60px", "76px", "55px", "55px", "52px", "52px", "52px", "52px", "52px", "44px", "64px", "165px", "154px"];
  const colgroup = h("colgroup", {}, widths.map((width) => h("col", { style: { width } })));
  const thead = h("thead", {},
    h("tr", { className: "qc-ops-group-head" },
      h("th", { rowSpan: "2", scope: "col" }, "No.", h("br"), h("span", { lang: "zh" }, "序号")),
      multipleProducts ? h("th", { rowSpan: "2", scope: "col" }, "Product / qty", h("br"), h("span", { lang: "zh" }, "产品 / 数量")) : null,
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
      h("th", { rowSpan: "2", scope: "col" }, historical ? "Photos" : "Attachments", h("br"), h("span", { lang: "zh" }, historical ? "照片" : "附件")),
    ),
    h("tr", { className: "qc-ops-sub-head" },
      h("th", { scope: "col" }, "Inspection qty", h("br"), h("span", { lang: "zh" }, "检验数量")),
      h("th", { scope: "col" }, "Defective qty", h("br"), h("span", { lang: "zh" }, "不良数")),
      h("th", { scope: "col" }, "Defective rate", h("br"), h("span", { lang: "zh" }, "不良率")),
      ...[1, 2, 3, 4].map((index) => h("th", { scope: "col" }, `Prior ${index}`, h("br"), h("span", { lang: "zh" }, `历史 ${index}`))),
    ),
  );
  const body = h("tbody", { className: "qc-ops-table-body" }, list(workspace.rows).map((row, index) => {
    const important = historical ? row.important : (row.displayImportant ?? row.important);
    const tr = h("tr", { className: `${important === true ? "qc-ops-important-row" : ""}${historical && row.status === "missing-from-source" ? " qc-ops-historical-missing-row" : ""}`.trim() });
    tr.append(h("td", { className: "qc-ops-no" }, text(row.no, String(index + 1))));
    if (multipleProducts) {
      const product = rowProduct(workspace, row, state);
      tr.append(h("td", { className: "qc-ops-product-context" },
        h("strong", {}, text(row.productLabel || productLabel(product, state))),
        h("small", {}, `${quantity(row.productQuantity ?? product.quantity)} units`),
      ));
    }
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
        : row.defectiveQty === null || row.defectiveQty === undefined ? "Incomplete" : quantity(row.defectiveQty)),
      h("td", { className: "qc-ops-number qc-ops-rate" }, historical ? sourceRate(row.sourceDefectiveRate) :
        row.defectiveQty === null || row.defectiveQty === undefined ? "Incomplete" : percent(row.defectiveRate)),
    );
    const history = list(row.history);
    for (let historyIndex = 0; historyIndex < 4; historyIndex += 1) {
      const entry = history[historyIndex];
      const cell = h("td", { className: "qc-ops-history" });
      if (entry) cell.append(h("strong", {}, percent(entry.rate)), h("small", {}, text(entry.batchNumber, entry.batchId)), h("small", {}, dateLabel(entry.date)));
      else cell.append(h("span", { className: "qc-ops-empty-history" }, "—"));
      tr.append(cell);
    }
    tr.append(h("td", { className: "qc-ops-number" }, reportTimeLabel(row, historical)));
    const procedureCell = h("td", { className: "qc-ops-link" });
    const procedureUrl = safeProcedureUrl(row.procedureUrl);
    procedureCell.append(procedureUrl ? h("a", { href: procedureUrl, target: "_blank", rel: "noopener noreferrer" }, "Open procedure") : text(row.procedureUrl, "—"));
    tr.append(procedureCell);
    const issues = list(row.issues);
    const remarks = h("td", { className: "qc-ops-remarks qc-ops-report-remarks" },
      historical ? text(row.remarks) : reportIssueEvidence(issues, state),
      historical ? null : legacyEvidence(row, state),
    );
    tr.append(remarks, historical ? historicalPhotosCell(row, state) : reportRowAttachmentCell(row, state));
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
  const variant = workspace.variant || lookupVariant(state, batch);
  const products = reportProducts(workspace, state);
  const openIssues = list(state.issues).filter((issue) => issue.batchId === batch.id && issue.status === "open").length;
  const fields = [
    ...(historical ? [["Product / model 产品型号", batchProductLabel(batch, variant)]] : []),
    ["Purchase order 采购订单", order?.number],
    ["Inspection stage 检验阶段", batchInspection(batch.stage, batch.factory)],
    ["Total batch quantity 批次总数量", historical ? sourceText(batch.quantity) : quantity(totalBatchQuantity(workspace, state))],
    ["Batch date 批次日期", dateLabel(batch.date)],
    ["Recorded by 记录人员", historical ? inspection?.recorder : batch.recorder],
    ...(historical ? [["Design version 设计版本", workspace.version?.label || batch.versionLabel]] : []),
    ["PO progress 采购订单进度", historical ? "Excluded · historical record" : batch.countForPO ? "Counts each product quantity after release" : "Not counted"],
    ["Open linked issues 未关闭问题", openIssues],
  ];
  const productDetails = products.length ? h("dl", { className: "qc-ops-report-products" },
    h("dt", {}, "Product versions and PO quantities 产品版本及采购数量"),
    h("dd", {}, h("ul", {}, products.map((product) => {
      const line = list(order?.lines).find((entry) => entry.id === product.lineId);
      return h("li", {}, h("strong", {}, productLabel(product, state)), ` · Version ${text(product.version?.label || product.versionLabel)}`, line ? ` · ${quantity(line.orderedQty)} ordered` : "");
    }))),
  ) : null;
  return h("div", { className: "qc-ops-report-metadata" },
    h("dl", { className: "qc-ops-report-meta" }, fields.flatMap(([label, value]) => [h("dt", {}, label), h("dd", {}, String(value ?? "—"))])),
    productDetails,
  );
}

function exportRows(workspace, state) {
  const batch = workspace.batch;
  const displayNumbers = resolveBatchDisplayNumbers(state);
  const displayNumber = workspace.displayNumber ?? displayNumbers.get(batch.id) ?? batch.number;
  const historical = isHistoricalBatch(batch);
  const order = workspace.order || lookupOrder(state, batch);
  const variant = workspace.variant || lookupVariant(state, batch);
  const products = reportProducts(workspace, state);
  const productsSummary = historical
    ? `${batchProductLabel(batch, variant)} · ${sourceText(batch.quantity)} units · Version ${text(workspace.version?.label || batch.versionLabel)}`
    : allProductsSummary(products, state, order);
  const headers = [
    "Batch number", "Batch date", "Status", "Batch products summary", "Purchase order", "Factory", "Stage", "Total batch quantity", "PO progress",
    "No.", "Product", "Product quantity", "PO line ordered quantity", "Design version",
    "Inspection title", "检验项目", "Specification", "检验标准", "Devices", "Sampling percent", "Recording rule", "Inspected quantity", "Defective quantity", "Defective rate",
    "Prior 1", "Prior 2", "Prior 3", "Prior 4", "Time seconds", "Procedure URL", "Remarks", "Linked issues", "Issue descriptions", "Issue evidence file names", "Row attachment file names", "Photo file names",
  ];
  const rows = [csvRow(headers.map((value) => ({ value, textField: false })))];
  for (const row of list(workspace.rows)) {
    const histories = list(row.history);
    const priorValues = [0, 1, 2, 3].map((index) => {
      const entry = histories[index];
      const priorBatchNumber = entry ? displayNumbers.get(entry.batchId) ?? entry.batchNumber ?? entry.batchId : "";
      return entry ? `${text(priorBatchNumber, entry.batchId)} · ${dateLabel(entry.date)} · ${percent(entry.rate)}` : "";
    });
    const issueRows = list(row.issues);
    const issues = issueRows.map((issue) => `${text(issue.number, "Issue")} (${text(issue.status)})`).join("; ");
    const issueDescriptions = issueRows.map((issue) => `${text(issue.number, "Issue")}: ${String(issue.description || "").trim()}`).filter((value) => !value.endsWith(": " )).join("; ");
    const issueEvidenceNames = issueRows.flatMap((issue) => issueEvidence(issue, state)
      .filter((asset) => asset.name)
      .map((asset) => `${text(issue.number, "Issue")}: ${asset.name}`)).join("; ");
    const rowAttachmentNames = Object.entries(rowAttachments(row, state)).filter(([, asset]) => asset?.name)
      .map(([category, asset]) => `${category}: ${asset.name}`).join("; ");
    const photos = legacyPhotoAssets(row, state).map((photo) => photo.name).filter(Boolean).join("; ");
    const linkedProduct = historical ? null : rowProduct(workspace, row, state);
    const ownerProduct = products.find((product) => product.lineId === (row.productLineId || linkedProduct?.lineId)) || linkedProduct;
    const ownerLabel = historical ? batchProductLabel(batch, variant) : text(row.productLabel, productLabel(ownerProduct || {}, state));
    const ownerQuantity = historical ? batch.quantity : row.productQuantity ?? ownerProduct?.quantity;
    const ownerVersion = historical ? workspace.version?.label || batch.versionLabel : row.versionLabel || ownerProduct?.version?.label || ownerProduct?.versionLabel;
    const orderLine = ownerProduct ? list(order?.lines).find((line) => line.id === ownerProduct.lineId) : lookupOrderLine(order, batch);
    const reportDefectiveQty = row.defectiveQty;
    const reportDefectiveRate = historical ? row.sourceDefectiveRate : row.defectiveRate === null || row.defectiveRate === undefined ? "" : percent(row.defectiveRate);
    const reportActualTime = reportTimeSeconds(row, historical) ?? "";
    const values = [
      [displayNumber, true], [batch.date, false], [historical ? "" : batch.status, false], [productsSummary, true], [order?.number, true], [batch.factory, true], [batch.stage, true],
      [historical ? batch.quantity : totalBatchQuantity(workspace, state), false], [historical ? "Excluded · historical record" : batch.countForPO ? "Counts after release" : "Not counted", true],
      [row.no, true], [ownerLabel, true], [ownerQuantity, false], [orderLine?.orderedQty, false], [ownerVersion, true], [row.title, true], [row.titleZh, true],
      [row.specification, true], [row.specificationZh, true], [row.devices, true], [row.samplingPercent, false], [row.recordingRule, true],
      [historical ? row.sourceInspectedQty : row.inspectedQty, false], [reportDefectiveQty, false], [reportDefectiveRate, false],
      ...priorValues.map((value) => [value, true]), [reportActualTime, false], [row.procedureUrl, true], [row.remarks, true], [issues, true], [issueDescriptions, true], [issueEvidenceNames, true], [rowAttachmentNames, true], [photos, true],
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
  root.replaceChildren(pageHeading("Batch report"), h("section", { className: "card qc-ops-loading" }, "Loading…"));
  let workspace;
  try {
    workspace = await ctx.service.getBatchWorkspace(ctx.selectedId);
  } catch (error) {
    root.replaceChildren(pageHeading("Batch report", "", [button("Back to batch", () => ctx.navigate("batches", ctx.selectedId, true), "button button-secondary")]),
      h("section", { className: "card qc-ops-error-card", role: "alert" }, text(error instanceof Error ? error.message : "The selected batch is unavailable.")));
    return;
  }
  if (!root.isConnected) return;
  const batch = workspace.batch;
  const state = ctx.state || {};
  const historical = isHistoricalBatch(batch);
  const reportTitle = text(workspace.displayNumber ?? batch.number, "Batch");
  const incompleteRows = historical ? 0 : list(workspace.rows).filter((row) => !row.savedAt || row.defectiveQty === null || row.defectiveQty === undefined || row.actualTimeSeconds === null || row.actualTimeSeconds === undefined || row.actualTimeSeconds === "").length;
  const scope = h("article", { className: "print-scope qc-ops-report" },
    h("header", { className: "qc-ops-report-document-heading" },
      h("p", { className: "eyebrow" }, "MasterQC Web · Inspection report"),
      h("h2", {}, reportTitle),
      h("div", { className: "qc-ops-report-document-status" }, historical ? h("span", { className: "qc-ops-note-pill" }, "Read-only") : statusPill(batch.status), h("span", {}, `Generated ${new Date().toLocaleString()}`)),
    ),
    reportMetadata(workspace, state),
    batch.notes ? h("section", { className: "qc-ops-report-notes" }, h("strong", {}, "Batch notes / 本批次备注"), h("p", {}, batch.notes)) : null,
    incompleteRows ? h("p", { className: "qc-ops-report-unsaved-note" }, `${incompleteRows} incomplete row${incompleteRows === 1 ? "" : "s"}.`) : null,
    h("section", { className: "qc-ops-report-table-section" },
      h("div", { className: "qc-ops-section-heading" }, h("h2", {}, "Batch inspection table")),
      makeReadOnlyTable(workspace, state),
    ),
  );
  const header = pageHeading("Batch report", "", [
    button("Back to batch", () => ctx.navigate("batches", batch.id, true), "button button-secondary"),
    button("Download CSV", async () => {
      try {
        const csv = exportRows(workspace, state);
        await downloadFile(`${safeFilename(workspace.displayNumber ?? batch.number, "qc-batch")}-report.csv`, csv, "text/csv;charset=utf-8");
        notify("CSV report downloaded.");
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
    root.replaceChildren(pageHeading("Batch report", "", [button("Open batches", () => ctx.navigate("batches"), "button button-secondary")]));
    return;
  }
  return renderReportDetail(root, ctx);
}
