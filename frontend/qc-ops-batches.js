import {
  button,
  dateLabel,
  el,
  errorText,
  field,
  list,
  notify,
  pageHeading,
  quantity,
  runCommand,
  safeProcedureUrl,
  setOptions,
  statusPill,
  text
} from "./qc-ops-common.js";
import { closeDialog, downloadFile, readFileAsDataURL, showDialog } from "./qc-ui.js";
import { historicalBatchImportControl } from "./qc-history.js";
import { resolveBatchDisplayNumbers } from "../core/qc-batch-display.js";

const rowDrafts = new Map();
const batchDetailDrafts = new Map();

function hasDraftsForBatch(batchId) {
  const prefix = `${batchId}::`;
  return Array.from(rowDrafts.keys()).some((key) => key.startsWith(prefix)) || batchDetailDrafts.has(String(batchId));
}

function navigateWithDraftWarning(ctx, route, id, batchId) {
  if (batchId && hasDraftsForBatch(batchId) && !window.confirm("This batch has unsaved row or detail edits. They will remain as drafts in this tab if you continue. Save all edits before release.")) return;
  ctx.navigate(route, id, true);
}

window.addEventListener("beforeunload", (event) => {
  if (rowDrafts.size || batchDetailDrafts.size) {
    event.preventDefault();
    event.returnValue = "";
  }
});

function rowKey(batchId, rowId) {
  return `${batchId}::${rowId}`;
}

function detailDraftKey(batchId) {
  return String(batchId);
}

function variantsById(state) {
  return new Map(list(state.variants).map((variant) => [variant.id, variant]));
}

function orderById(state) {
  return new Map(list(state.orders).map((order) => [order.id, order]));
}

function batchLabel(batch, state) {
  const variant = variantsById(state).get(batch.variantId);
  const order = orderById(state).get(batch.orderId);
  return `${text(batch.number, "Batch")} · ${text(variant?.label, batch.variantId)} · ${text(order?.number, batch.orderId)}`;
}

function isHistoricalBatch(batch) {
  return batch?.kind === "historical";
}

function batchProductLabel(batch, state) {
  const variant = variantsById(state).get(batch.variantId);
  if (!isHistoricalBatch(batch)) return text(variant?.label, batch.variantId);
  const productLabel = String(batch.productLabel || batch.model || "");
  const color = String(batch.color || "");
  const isNormalColor = ["red", "normalred"].includes(color.toLocaleLowerCase().replace(/[\s_-]/g, ""));
  return color && !isNormalColor && !productLabel.toLocaleLowerCase().includes(color.toLocaleLowerCase())
    ? `${productLabel} ${color}`.trim()
    : text(productLabel);
}

function historicalBatchLabel(displayNumber) {
  return text(displayNumber, "Batch");
}

function sourceValue(value) {
  return text(value);
}

function sourcePercent(value) {
  if (value === null || value === undefined || value === "") return "—";
  const printed = String(value);
  if (/%\s*$/.test(printed)) return printed;
  return /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(printed.trim()) ? `${printed}%` : printed;
}

function computedHistoricalQuantity(batch, row) {
  if (row.status === "missing-from-source" || batch.quantity === null || batch.quantity === undefined || batch.quantity === "" || row.sourceInspectedQty === null || row.sourceInspectedQty === undefined || row.sourceInspectedQty === "" || row.samplingPercent === null || row.samplingPercent === undefined || row.samplingPercent === "") return null;
  const batchQuantity = Number(batch.quantity);
  const samplingPercent = Number(String(row.samplingPercent).replace(/%\s*$/, ""));
  const sourceQuantity = Number(row.sourceInspectedQty);
  if (!Number.isFinite(batchQuantity) || batchQuantity < 0 || !Number.isFinite(samplingPercent) || samplingPercent < 0 || samplingPercent > 100 || !Number.isFinite(sourceQuantity)) return null;
  const computed = Math.ceil(batchQuantity * samplingPercent / 100);
  return computed === sourceQuantity ? null : computed;
}

function historicalRate(value) {
  if (value === null || value === undefined || value === "") return "—";
  const printed = String(value);
  if (/%\s*$/.test(printed)) return printed;
  return /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(printed.trim()) ? `${printed}%` : printed;
}

function stateForRow(row, batchId) {
  const key = rowKey(batchId, row.id);
  return rowDrafts.get(key) || {
    defectiveQty: row.defectiveQty === null || row.defectiveQty === undefined ? "" : String(row.defectiveQty),
    remarks: String(row.remarks || "")
  };
}

function savedRowValue(row) {
  return {
    defectiveQty: row.defectiveQty === null || row.defectiveQty === undefined ? "" : String(row.defectiveQty),
    remarks: String(row.remarks || "")
  };
}

function rowHasDraft(row, batchId) {
  const draft = rowDrafts.get(rowKey(batchId, row.id));
  if (!draft) return false;
  const saved = savedRowValue(row);
  return draft.defectiveQty !== saved.defectiveQty || draft.remarks !== saved.remarks;
}

function getRowPhotos(row, workspace, state) {
  if (Array.isArray(row.photos)) return row.photos;
  const assets = new Map(list(state.assets).map((asset) => [asset.id, asset]));
  return list(row.photoIds).map((id) => assets.get(id)).filter(Boolean);
}

function getRowIssues(row, workspace) {
  if (Array.isArray(row.issues)) return row.issues;
  return list(workspace.issues).filter((issue) => issue.rowId === row.id || issue.sourceSnapshot?.rowId === row.id);
}

function rateLabel(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value.includes("%") || value === "—" ? value : `${value}%`;
  const rate = Number(value);
  if (!Number.isFinite(rate)) return "—";
  return `${rate.toFixed(2)}%`;
}

function currentRate(row, draft) {
  if (draft.defectiveQty === "") return row.defectiveRate === null || row.defectiveRate === undefined ? "—" : rateLabel(row.defectiveRate);
  const inspected = Number(row.inspectedQty);
  const defective = Number(draft.defectiveQty);
  if (!Number.isInteger(inspected) || !Number.isInteger(defective) || inspected < 0 || defective < 0 || defective > inspected) return "Check quantity";
  return inspected === 0 ? "—" : `${((defective / inspected) * 100).toFixed(2)}%`;
}

function setBilingual(container, english, chinese, englishClass = "qc-ops-en", chineseClass = "qc-ops-zh") {
  container.replaceChildren(el("span", { className: englishClass }, text(english)));
  if (chinese) container.append(el("span", { className: chineseClass, lang: "zh" }, chinese));
}

function makeAction(label, handler, className = "button button-secondary") {
  return button(label, handler, className);
}

function makePhotoDialog(photo, row, readOnly, onRemove) {
  const preview = el("div", { className: "qc-ops-photo-preview" },
    el("img", { src: photo.dataUrl, alt: photo.name || "Inspection photo" }),
    el("p", {}, photo.name || "Inspection photo")
  );
  const actions = readOnly ? [] : [makeAction("Remove photo", onRemove, "button button-danger")];
  actions.push(makeAction("Done", () => closeDialog(true)));
  showDialog(`${text(row.title)} · Photo`, el("div", { className: "qc-ops-dialog-content" }, preview,
    el("div", { className: "qc-ops-dialog-actions" }, ...actions)
  ));
}

function renderInspectionRow(row, index, workspace, state, ctx, onDraftChange = null) {
  const readOnly = workspace.batch.status === "released";
  const draft = stateForRow(row, workspace.batch.id);
  const dirty = rowHasDraft(row, workspace.batch.id);
  const tr = el("tr", { className: row.important ? "qc-ops-important-row" : "" });
  const no = el("td", { className: "qc-ops-no" }, text(row.no, String(index + 1)));
  const task = el("th", { scope: "row", className: "qc-ops-task" });
  setBilingual(task, row.title, row.titleZh);
  const specification = el("td", { className: "qc-ops-spec" });
  setBilingual(specification, row.specification, row.specificationZh);
  const method = el("td", { className: "qc-ops-method" });
  setBilingual(method, row.devices, row.devicesZh || "");
  const frequency = el("td", { className: "qc-ops-frequency" }, `${text(row.samplingPercent, "0")}%`);
  const recording = el("td", { className: "qc-ops-recording" }, text(row.recordingRule, "—"));
  const inspectedInput = el("input", {
    className: "qc-ops-inspected-input",
    type: "number",
    min: "0",
    step: "1",
    value: String(row.inspectedQty ?? ""),
    readOnly: true,
    "aria-label": `Calculated inspection quantity for ${text(row.title)}`
  });
  const inspected = el("td", { className: "qc-ops-number" }, inspectedInput, el("small", {}, "Auto"));
  const defectiveInput = el("input", {
    className: "qc-ops-defective-input",
    type: "number",
    min: "0",
    step: "1",
    inputMode: "numeric",
    value: draft.defectiveQty,
    disabled: readOnly,
    "aria-label": `Defective quantity for ${text(row.title)}`
  });
  const rowFormId = `qc-row-form-${workspace.batch.id}-${row.id}`.replace(/[^A-Za-z0-9_-]/g, "-");
  defectiveInput.setAttribute("form", rowFormId);
  const defective = el("td", { className: "qc-ops-number" }, defectiveInput);
  const rateCell = el("td", { className: "qc-ops-number qc-ops-rate" }, currentRate(row, draft));
  const historyCells = [];
  const history = list(row.history);
  for (let historyIndex = 0; historyIndex < 4; historyIndex += 1) {
    const entry = history[historyIndex];
    const cell = el("td", { className: "qc-ops-history" });
    if (entry) {
      cell.append(el("strong", {}, rateLabel(entry.rate ?? entry.defectiveRate)),
        el("small", {}, text(entry.batchNumber || entry.number || entry.batchId)),
        el("small", {}, dateLabel(entry.date)));
    } else {
      cell.append(el("span", { className: "qc-ops-empty-history" }, "—"));
    }
    historyCells.push(cell);
  }
  const time = el("td", { className: "qc-ops-number" }, row.timeSeconds === null || row.timeSeconds === undefined ? "—" : `${row.timeSeconds}s`);
  const link = el("td", { className: "qc-ops-link" });
  const procedureUrl = safeProcedureUrl(row.procedureUrl);
  link.append(procedureUrl
    ? el("a", { href: procedureUrl, target: "_blank", rel: "noopener noreferrer" }, "Open procedure")
    : el("span", {}, row.procedureUrl ? "Invalid link" : "—"));
  const linkedIssues = getRowIssues(row, workspace);
  const canCreateFromRow = Boolean(row.savedAt);
  const issueButton = makeAction(linkedIssues.length ? `Open issue · ${text(linkedIssues[0].number, "record")}` : "Create issue", async () => {
    const linked = linkedIssues[0];
    if (linked) {
      navigateWithDraftWarning(ctx, "issues", linked.id, workspace.batch.id);
      return;
    }
    if (!row.savedAt) {
      notify("Save this inspection row before creating a linked issue.", true);
      return;
    }
    const details = batchDetailDrafts.get(detailDraftKey(workspace.batch.id));
    const hasDetailDraft = details && (details.date !== (workspace.batch.date || "") || details.recorder !== (workspace.batch.recorder || "") || details.notes !== (workspace.batch.notes || ""));
    if (rowHasDraft(row, workspace.batch.id) || hasDetailDraft) {
      notify("Save this row and its batch details before creating an issue so the source snapshot includes the current records.", true);
      return;
    }
    const response = await runCommand(ctx, "createIssue", {
      title: `${text(row.title)} · ${batchLabel(workspace.batch, state)}`,
      batchId: workspace.batch.id,
      rowId: row.id
    });
    if (response.ok) {
      const issueId = response.result?.entityId || response.result?.issueId;
      if (issueId) navigateWithDraftWarning(ctx, "issues", issueId, workspace.batch.id);
      else {
        const fresh = await ctx.service.getBatchWorkspace(workspace.batch.id);
        const issue = list(fresh.issues).find((item) => item.rowId === row.id || item.sourceSnapshot?.rowId === row.id);
        if (issue) navigateWithDraftWarning(ctx, "issues", issue.id, workspace.batch.id);
      }
    }
  }, "button button-secondary qc-ops-small-button");

  const remarksInput = el("textarea", {
    className: "qc-ops-row-remarks",
    rows: "3",
    maxLength: "1000",
    disabled: readOnly,
    "aria-label": `Remarks for ${text(row.title)}`
  }, draft.remarks);
  remarksInput.setAttribute("form", rowFormId);
  const rowForm = el("form", { id: rowFormId, className: "qc-ops-row-form", "data-preserve-drafts": "true" });
  const saveButton = el("button", { type: "submit", className: "button button-primary qc-ops-small-button", disabled: readOnly }, "Save row");
  rowForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const defectiveQty = defectiveInput.value;
    const remarks = remarksInput.value;
    if (defectiveQty === "") {
      notify("Enter a defective quantity before saving this row.", true);
      defectiveInput.focus();
      return;
    }
    if (!Number.isInteger(Number(defectiveQty)) || Number(defectiveQty) < 0 || Number(defectiveQty) > Number(row.inspectedQty)) {
      notify(`Defective quantity must be a whole number from 0 to ${quantity(row.inspectedQty)}.`, true);
      defectiveInput.focus();
      return;
    }
    const key = rowKey(workspace.batch.id, row.id);
    const previous = rowDrafts.get(key);
    rowDrafts.delete(key);
    const response = await runCommand(ctx, "saveInspection", { batchId: workspace.batch.id, rowId: row.id, defectiveQty: Number(defectiveQty), remarks });
    if (!response.ok) {
      const saved = savedRowValue(row);
      const failedDraft = previous || { defectiveQty, remarks };
      if (failedDraft.defectiveQty !== saved.defectiveQty || failedDraft.remarks !== saved.remarks) rowDrafts.set(key, failedDraft);
    }
  });
  rowForm.append(remarksInput, saveButton);
  const markRowDraft = () => {
    const key = rowKey(workspace.batch.id, row.id);
    const nextDraft = { defectiveQty: defectiveInput.value, remarks: remarksInput.value };
    const saved = savedRowValue(row);
    if (nextDraft.defectiveQty === saved.defectiveQty && nextDraft.remarks === saved.remarks) {
      rowDrafts.delete(key);
      delete rowForm.dataset.dirty;
    } else {
      rowForm.dataset.dirty = "true";
      rowDrafts.set(key, nextDraft);
    }
    queueMicrotask(() => {
      if (!rowHasDraft(row, workspace.batch.id)) delete rowForm.dataset.dirty;
    });
    onDraftChange?.();
  };
  defectiveInput.addEventListener("input", markRowDraft);
  remarksInput.addEventListener("input", markRowDraft);
  if (dirty) rowForm.dataset.dirty = "true";
  else delete rowForm.dataset.dirty;
  issueButton.disabled = (readOnly && !linkedIssues.length) || (!linkedIssues.length && !canCreateFromRow);
  if (!linkedIssues.length && !canCreateFromRow) issueButton.title = "Save this inspection row before creating a linked issue.";
  const issueStatus = linkedIssues.length
    ? el("p", { className: `qc-ops-row-issue qc-ops-row-issue-${linkedIssues[0].status}` }, `${text(linkedIssues[0].status)} · release blocked while open`)
    : el("p", { className: "qc-ops-row-issue" }, canCreateFromRow ? "No linked issue" : "Save this row before creating a linked issue");
  const remarks = el("td", { className: "qc-ops-remarks" }, rowForm, el("div", { className: "qc-ops-row-actions" }, issueButton, dirty ? el("span", { className: "qc-ops-unsaved" }, "Unsaved edits") : null), issueStatus);
  const photoCell = el("td", { className: "qc-ops-photos" });
  const photos = getRowPhotos(row, workspace, state);
  const photoList = el("div", { className: "qc-ops-photo-list" });
  for (const photo of photos) {
    if (!photo?.dataUrl) continue;
    const thumb = el("button", {
      type: "button",
      className: "qc-ops-photo-thumb",
      title: photo.name || "Preview inspection photo",
      "aria-label": `Preview ${photo.name || "inspection photo"}`
    }, el("img", { src: photo.dataUrl, alt: photo.name || "Inspection photo" }));
    thumb.addEventListener("click", () => makePhotoDialog(photo, row, readOnly, async () => {
      const response = await runCommand(ctx, "removePhoto", { batchId: workspace.batch.id, rowId: row.id, assetId: photo.id });
      if (response.ok) closeDialog(true);
    }));
    photoList.append(thumb);
  }
  if (!photoList.childNodes.length) photoList.append(el("span", { className: "qc-ops-empty-photo" }, "No photos"));
  const fileInput = el("input", { type: "file", accept: "image/*", multiple: true, className: "qc-ops-hidden-file", "aria-label": `Choose photos for ${text(row.title)}`, disabled: readOnly });
  const addPhotos = makeAction("Add photos", () => fileInput.click(), "button button-secondary qc-ops-small-button");
  addPhotos.disabled = readOnly;
  fileInput.addEventListener("change", async () => {
    const files = Array.from(fileInput.files || []);
    if (!files.length) return;
    try {
      const payload = await Promise.all(files.map(async (file) => ({ name: file.name, mimeType: file.type, dataUrl: await readFileAsDataURL(file) })));
      await runCommand(ctx, "addPhotos", { batchId: workspace.batch.id, rowId: row.id, files: payload });
    } catch (error) {
      notify(errorText(error, "Could not read the selected photo."), true);
    }
  });
  photoCell.append(photoList, el("div", { className: "qc-ops-photo-actions" }, addPhotos), fileInput);
  tr.append(no, task, specification, method, frequency, recording, inspected, defective, rateCell, ...historyCells, time, link, remarks, photoCell);
  return tr;
}

function renderHistoricalInspectionRow(row, index, workspace, state) {
  const batch = workspace.batch;
  const tr = el("tr", {
    className: `${row.important === true ? "qc-ops-important-row" : ""}${row.status === "missing-from-source" ? " qc-ops-historical-missing-row" : ""}`.trim(),
  });
  tr.append(el("td", { className: "qc-ops-no" }, sourceValue(row.no ?? index + 1)));

  const task = el("th", { scope: "row", className: "qc-ops-task" });
  setBilingual(task, row.title, row.titleZh);
  if (row.status === "missing-from-source") {
    task.append(el("span", { className: "qc-ops-historical-badge" }, "Missing from source"));
    if (row.missingEvidence) task.append(el("small", { className: "qc-ops-historical-evidence" }, row.missingEvidence));
  }
  if (row.raw && Object.keys(row.raw).length) {
    task.append(el("details", { className: "qc-ops-historical-raw" }, el("summary", {}, "Source fields"), el("pre", {}, JSON.stringify(row.raw, null, 2))));
  }
  tr.append(task);

  const specification = el("td", { className: "qc-ops-spec" });
  setBilingual(specification, row.specification, row.specificationZh);
  const method = el("td", { className: "qc-ops-method" });
  setBilingual(method, row.devices, row.devicesZh || "");
  tr.append(
    specification,
    method,
    el("td", { className: "qc-ops-frequency" }, sourcePercent(row.samplingPercent)),
    el("td", { className: "qc-ops-recording" }, sourceValue(row.recordingRule)),
  );

  const computed = computedHistoricalQuantity(batch, row);
  const inspectionQuantity = el("td", { className: "qc-ops-number" }, sourceValue(row.sourceInspectedQty));
  if (computed !== null) inspectionQuantity.append(el("small", { className: "qc-ops-historical-comparison" }, `Web formula: ${quantity(computed)}`));
  const defective = row.defectiveQty === null || row.defectiveQty === undefined || row.defectiveQty === "" ? "—" : String(row.defectiveQty);
  tr.append(
    inspectionQuantity,
    el("td", { className: "qc-ops-number" }, defective),
    el("td", { className: "qc-ops-number qc-ops-rate" }, historicalRate(row.sourceDefectiveRate)),
  );
  for (let historyIndex = 0; historyIndex < 4; historyIndex += 1) {
    tr.append(el("td", { className: "qc-ops-history" }, el("span", { className: "qc-ops-empty-history" }, "—")));
  }

  const procedure = el("td", { className: "qc-ops-link" });
  const procedureUrl = safeProcedureUrl(row.procedureUrl);
  procedure.append(procedureUrl ? el("a", { href: procedureUrl, target: "_blank", rel: "noopener noreferrer" }, "Open procedure") : sourceValue(row.procedureUrl));
  const remarks = el("td", { className: "qc-ops-remarks" }, sourceValue(row.remarks));
  if (list(row.anomalies).length) {
    remarks.append(el("details", { className: "qc-ops-historical-raw" },
      el("summary", {}, "Source review notes"),
      el("ul", {}, list(row.anomalies).map((anomaly) => el("li", {}, typeof anomaly === "string" ? anomaly : JSON.stringify(anomaly)))),
    ));
  }
  const photos = getRowPhotos(row, workspace, state).filter((photo) => photo?.dataUrl?.startsWith("data:image/"));
  const photoCell = el("td", { className: "qc-ops-photos" });
  if (photos.length) {
    photoCell.append(el("div", { className: "qc-ops-photo-list" }, photos.map((photo) => {
      const preview = button("", () => makePhotoDialog(photo, row, true, null), "qc-ops-photo-thumb");
      preview.setAttribute("aria-label", `Preview ${photo.name || "inspection photo"}`);
      preview.append(el("img", { src: photo.dataUrl, alt: photo.name || "Inspection photo" }));
      return preview;
    })));
  } else {
    photoCell.append(el("span", { className: "qc-ops-empty-photo" }, "No photos"));
  }
  tr.append(
    el("td", { className: "qc-ops-number" }, row.timeSeconds === null || row.timeSeconds === undefined ? "—" : `${row.timeSeconds}s`),
    procedure,
    remarks,
    photoCell,
  );
  return tr;
}

function renderRows(workspace, state, ctx, onDraftChange) {
  const body = el("tbody", { className: "qc-ops-table-body" });
  list(workspace.rows).forEach((row, index) => body.append(isHistoricalBatch(workspace.batch)
    ? renderHistoricalInspectionRow(row, index, workspace, state)
    : renderInspectionRow(row, index, workspace, state, ctx, onDraftChange)));
  return body;
}

function makeInspectionTable(workspace, state, ctx, onDraftChange) {
  const table = el("table", { className: "qc-ops-inspection-table" });
  const colgroup = el("colgroup");
  for (const width of ["34px", "100px", "185px", "80px", "60px", "76px", "55px", "55px", "52px", "52px", "52px", "52px", "52px", "44px", "64px", "165px", "128px"]) {
    colgroup.append(el("col", { style: { width } }));
  }
  const thead = el("thead", {},
    el("tr", { className: "qc-ops-group-head" },
      el("th", { rowSpan: "2", scope: "col" }, "No.", el("br"), el("span", { lang: "zh" }, "序号")),
      el("th", { rowSpan: "2", scope: "col" }, "QC task", el("br"), el("span", { lang: "zh" }, "检验项目")),
      el("th", { rowSpan: "2", scope: "col" }, "Specifications / inspection points", el("br"), el("span", { lang: "zh" }, "规格尺寸 / 检验要点")),
      el("th", { rowSpan: "2", scope: "col" }, "Devices / methods", el("br"), el("span", { lang: "zh" }, "检测仪器 / 方法")),
      el("th", { rowSpan: "2", scope: "col" }, "Inspection frequency", el("br"), el("span", { lang: "zh" }, "检验频率")),
      el("th", { rowSpan: "2", scope: "col" }, "Recording frequency", el("br"), el("span", { lang: "zh" }, "记录频率")),
      el("th", { colSpan: "3", scope: "colgroup" }, "Quality control points", el("br"), el("span", { lang: "zh" }, "品质管制点")),
      el("th", { colSpan: "4", scope: "colgroup" }, "Defective rate history · saved batches only", el("br"), el("span", { lang: "zh" }, "不良率历史记录 · 已保存批次")),
      el("th", { rowSpan: "2", scope: "col" }, "Time", el("br"), el("span", { lang: "zh" }, "时数 (sec)")),
      el("th", { rowSpan: "2", scope: "col" }, "Procedure / link", el("br"), el("span", { lang: "zh" }, "视频 / 程序 / 报告")),
      el("th", { rowSpan: "2", scope: "col" }, "Remarks", el("br"), el("span", { lang: "zh" }, "备注")),
      el("th", { rowSpan: "2", scope: "col" }, "Photos", el("br"), el("span", { lang: "zh" }, "照片"))
    ),
    el("tr", { className: "qc-ops-sub-head" },
      el("th", { scope: "col" }, "Inspection qty", el("br"), el("span", { lang: "zh" }, "检验数量")),
      el("th", { scope: "col" }, "Defective qty", el("br"), el("span", { lang: "zh" }, "不良数")),
      el("th", { scope: "col" }, "Defective rate", el("br"), el("span", { lang: "zh" }, "不良率")),
      ...[1, 2, 3, 4].map((index) => el("th", { scope: "col" }, `Prior ${index}`, el("br"), el("span", { lang: "zh" }, `历史 ${index}`)))
    )
  );
  table.append(colgroup, thead, renderRows(workspace, state, ctx, onDraftChange));
  return el("div", { className: "qc-ops-table-scroll", tabindex: "0", "aria-label": "Batch inspection table; scroll horizontally to see all columns" }, table);
}

function renderReleaseBlockers(workspace, ctx) {
  const blockerHost = el("div", { className: "qc-ops-release-blockers" });
  const release = button("Release full batch", async () => {
    const changedRows = list(workspace.rows).filter((row) => rowHasDraft(row, workspace.batch.id)).length;
    const details = batchDetailDrafts.get(detailDraftKey(workspace.batch.id));
    const changedDetails = details && (details.date !== (workspace.batch.date || "") || details.recorder !== (workspace.batch.recorder || "") || details.notes !== (workspace.batch.notes || ""));
    if (changedRows || changedDetails) {
      notify("Save all edited row results and batch details before releasing the batch.", true);
      return;
    }
    const result = await runCommand(ctx, "releaseBatch", { id: workspace.batch.id });
    if (result.ok) notify("The full batch was released.");
  }, "button button-danger");
  const refresh = () => {
    const blockers = list(workspace.releaseBlockers).map((message) => String(message));
    if (workspace.batch.status === "released") blockers.unshift("This batch has already been released and is read-only.");
    const changedRows = list(workspace.rows).filter((row) => rowHasDraft(row, workspace.batch.id)).length;
    const details = batchDetailDrafts.get(detailDraftKey(workspace.batch.id));
    const changedDetails = details && (details.date !== (workspace.batch.date || "") || details.recorder !== (workspace.batch.recorder || "") || details.notes !== (workspace.batch.notes || ""));
    if (changedRows) blockers.push(`${changedRows} row result(s) have unsaved edits. Save each changed row before release.`);
    if (changedDetails) blockers.push("Batch date, recorder, or notes have unsaved edits. Save batch details before release.");
    const blockerList = blockers.length
      ? el("ul", { className: "qc-ops-blocker-list" }, ...blockers.map((message) => el("li", {}, message)))
      : el("p", { className: "qc-ops-ready" }, "All release requirements are satisfied. Release remains a separate, explicit action.");
    blockerHost.replaceChildren(blockers.length
      ? el("div", { className: "qc-ops-blockers" }, el("strong", {}, "Resolve these items before release"), blockerList)
      : blockerList);
    release.disabled = workspace.batch.status === "released" || blockers.length > 0;
  };
  refresh();
  return { element: el("section", { className: "card qc-ops-release-card" },
    el("div", { className: "qc-ops-section-heading" },
      el("div", {}, el("h2", {}, "Full-batch release"), el("p", {}, `Releasing records all ${quantity(workspace.batch.quantity)} units on this batch. Only an eligible final-shipment OQC batch contributes to the selected PO line.`)),
      release
    ),
    blockerHost
  ), refresh };
}

function batchAttachments(batch, state) {
  const assets = new Map(list(state.assets).map((asset) => [asset.id, asset]));
  let sourceAssetId = null;
  if (isHistoricalBatch(batch)) {
    const inspection = list(state.history?.inspections).find((item) => item.id === batch.historyInspectionId);
    const source = list(state.history?.sources).find((item) => item.id === inspection?.sourceId);
    sourceAssetId = source?.assetId ?? null;
  }
  return list(batch.attachmentIds).map((id) => assets.get(id)).filter(Boolean)
    .map((asset) => ({ ...asset, sourcePdf: asset.sourcePdf === true || asset.id === sourceAssetId }));
}

function canOpenAttachment(asset) {
  const type = String(asset.mimeType || "").toLowerCase();
  return type === "application/pdf" || ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/avif"].includes(type);
}

function attachmentBlobFromDataUrl(dataUrl, fallbackMimeType = "application/octet-stream") {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("The stored attachment data is invalid.");
  const metadata = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  const mimeType = metadata.match(/^data:([^;,]+)/)?.[1] || fallbackMimeType;
  let bytes;
  if (/;base64/i.test(metadata)) {
    const binary = atob(payload);
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(payload));
  }
  return new Blob([bytes], { type: mimeType });
}

async function openAttachment(asset) {
  if (!asset?.dataUrl || !canOpenAttachment(asset)) return;
  try {
    const isImage = String(asset.mimeType || "").toLowerCase().startsWith("image/");
    const url = isImage ? null : URL.createObjectURL(attachmentBlobFromDataUrl(asset.dataUrl, asset.mimeType));
    const preview = isImage
      ? el("img", { className: "qc-ops-attachment-preview-image", src: asset.dataUrl, alt: asset.name || "Attachment preview" })
      : el("iframe", { className: "qc-ops-attachment-preview-pdf", src: url, title: asset.name || "PDF attachment preview" });
    const dialog = showDialog(`${text(asset.name, "Attachment")} · Preview`, el("div", { className: "qc-ops-attachment-preview" },
      preview,
      el("div", { className: "qc-ops-dialog-actions" },
        button("Download", () => { void downloadFile(asset.name, asset.dataUrl, asset.mimeType); }, "button-secondary"),
        button("Done", () => closeDialog(true), "button-primary"),
      ),
    ));
    if (url) dialog.addEventListener("close", () => URL.revokeObjectURL(url), { once: true });
  } catch (error) {
    notify(errorText(error, "The attachment preview could not be opened."), true);
  }
}

function attachmentActions(asset, batch, ctx) {
  const actions = [];
  if (asset.dataUrl && canOpenAttachment(asset)) {
    actions.push(button("Open", () => { void openAttachment(asset); }, "button-quiet qc-ops-small-button"));
  }
  if (asset.dataUrl) {
    actions.push(button("Download", () => {
      void downloadFile(asset.name, asset.dataUrl, asset.mimeType).catch((error) => notify(errorText(error, "The attachment could not be downloaded."), true));
    }, "button-secondary qc-ops-small-button"));
  } else {
    actions.push(el("span", { className: "qc-ops-hint" }, "File unavailable"));
  }
  const locked = batch.status === "released" || asset.sourcePdf === true;
  const remove = button(asset.sourcePdf ? "Source PDF" : "Remove", () => {
    if (!window.confirm(`Remove “${text(asset.name, "this attachment")}” from this batch? The file remains in the file library.`)) return;
    void runCommand(ctx, "removeBatchAttachment", { batchId: batch.id, assetId: asset.id });
  }, asset.sourcePdf ? "button-quiet qc-ops-small-button" : "button-danger qc-ops-small-button");
  remove.disabled = locked;
  if (asset.sourcePdf) remove.title = "The original source PDF association is preserved.";
  else if (batch.status === "released") remove.title = "Released batch attachments are read-only.";
  actions.push(remove);
  return el("div", { className: "qc-ops-attachment-actions" }, actions);
}

function renderBatchAttachments(workspace, state, ctx) {
  const batch = workspace.batch;
  const readOnly = batch.status === "released";
  const fileInput = el("input", {
    className: "qc-ops-hidden-file",
    type: "file",
    multiple: true,
    "aria-label": "Choose batch attachments",
    disabled: readOnly,
  });
  const add = button("Add attachment", () => fileInput.click(), "button-secondary qc-ops-small-button");
  add.disabled = readOnly;
  fileInput.addEventListener("change", async () => {
    const files = Array.from(fileInput.files || []);
    if (!files.length) return;
    for (const file of files) {
      if (file.size > 10 * 1024 * 1024) {
        notify(`${file.name} exceeds the 10 MiB per-file limit.`, true);
        continue;
      }
      try {
        const dataUrl = await readFileAsDataURL(file);
        const response = await runCommand(ctx, "addBatchAttachment", {
          batchId: batch.id,
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          dataUrl,
        });
        if (!response.ok) break;
      } catch (error) {
        notify(errorText(error, `Could not read ${file.name}.`), true);
        break;
      }
    }
    fileInput.value = "";
  });
  const attachmentList = list(workspace.attachments);
  const items = attachmentList.length
    ? attachmentList.map((asset) => el("li", { className: "qc-ops-attachment-item" },
      el("div", {}, el("strong", {}, text(asset.name, "Attachment")), asset.sourcePdf ? el("span", { className: "qc-ops-historical-badge" }, "Original PDF") : null,
        el("small", {}, text(asset.mimeType, "File"))),
      attachmentActions(asset, batch, ctx),
    ))
    : [el("li", { className: "qc-ops-attachment-empty" }, "No attachments. Attachments are optional for every batch.")];
  return el("section", { className: "card qc-ops-attachments-card" },
    el("div", { className: "qc-ops-section-heading" },
      el("div", {}, el("h2", {}, "Attachments"), el("p", {}, "Files stay linked to this batch. The original source PDF remains attached to historical batches.")),
      add,
    ),
    el("ul", { className: "qc-ops-attachment-list" }, items),
    readOnly ? el("p", { className: "qc-ops-hint" }, "Released batch attachments are read-only.") : null,
    fileInput,
  );
}

function historicalSourceEvidence(batch, state) {
  const inspection = list(state.history?.inspections).find((item) => item.id === batch.historyInspectionId) ?? null;
  const source = inspection ? list(state.history?.sources).find((item) => item.id === inspection.sourceId) ?? null : null;
  return { inspection, source };
}

function renderHistoricalBatchDetail(root, ctx, workspace) {
  const batch = workspace.batch;
  const state = ctx.state || {};
  const { inspection, source } = historicalSourceEvidence(batch, state);
  const family = list(state.families).find((item) => item.id === batch.familyId);
  const anomalies = [...list(source?.anomalies), ...list(inspection?.anomalies)];
  const metadata = el("section", { className: "card qc-ops-batch-meta-card qc-ops-historical-meta-card" },
    el("div", { className: "qc-ops-section-heading" },
      el("div", {},
        el("p", { className: "eyebrow" }, "Batch inspection"),
        el("h2", {}, historicalBatchLabel(workspace.displayNumber)),
        el("p", {}, "Review this batch’s recorded inspection results and attachments."),
      ),
    ),
    el("div", { className: "qc-ops-batch-facts" },
      el("span", {}, el("strong", {}, "Family"), text(family?.name || batch.familyId)),
      el("span", {}, el("strong", {}, "Model"), text(batch.model)),
      el("span", {}, el("strong", {}, "Color"), text(batch.color)),
      el("span", {}, el("strong", {}, "Factory / stage"), [batch.factory, batch.stage].filter((value) => value !== null && value !== undefined && value !== "").join(" · ") || "—"),
      el("span", {}, el("strong", {}, "Batch quantity"), sourceValue(batch.quantity)),
      el("span", {}, el("strong", {}, "Inspection date"), dateLabel(batch.date)),
      el("span", {}, el("strong", {}, "Printed version"), text(batch.versionLabel)),
      el("span", {}, el("strong", {}, "Recorded by"), text(inspection?.recorder)),
    ),
    batch.notes ? el("p", { className: "qc-ops-historical-notes" }, batch.notes) : null,
    el("details", { className: "qc-ops-historical-provenance" },
      el("summary", {}, "Source and transcription details"),
      el("dl", { className: "qc-ops-historical-source-facts" },
        el("dt", {}, "Source PDF"), el("dd", {}, text(source?.fileName, "Unavailable")),
        el("dt", {}, "Source page"), el("dd", {}, inspection?.page ? `${inspection.page} of ${source?.pageCount ?? "?"}` : "—"),
        el("dt", {}, "Printed date"), el("dd", {}, dateLabel(inspection?.printedDate)),
        el("dt", {}, "Recorded by"), el("dd", {}, text(inspection?.recorder)),
      ),
      inspection?.notes ? el("p", { className: "qc-ops-historical-notes" }, inspection.notes) : null,
      anomalies.length ? el("ul", { className: "qc-ops-historical-anomalies" }, anomalies.map((anomaly) => el("li", {}, typeof anomaly === "string" ? anomaly : JSON.stringify(anomaly)))) : null,
      inspection?.raw ? el("details", { className: "qc-ops-historical-raw" }, el("summary", {}, "Preserved source fields"), el("pre", {}, JSON.stringify(inspection.raw, null, 2))) : null,
    ),
  );
  const intro = el("section", { className: "card qc-ops-inspection-card" },
    el("div", { className: "qc-ops-section-heading" },
      el("div", {}, el("h2", {}, "Batch inspection table"), el("p", {}, "Recorded values are shown as transcribed. This read-only record does not create release or purchase-order quantities.")),
      el("span", { className: "qc-ops-note-pill" }, "Read-only"),
    ),
    el("p", { className: "qc-ops-table-note" }, "Blank source cells remain blank. Source inspection quantities and printed defective rates are preserved; any Web formula comparison is labeled separately."),
    makeInspectionTable(workspace, state, ctx, null),
  );
  const attachmentsWorkspace = { ...workspace, attachments: Array.isArray(workspace.attachments) ? workspace.attachments : batchAttachments(batch, state) };
  root.replaceChildren(
    pageHeading("Batches", "Review this batch’s recorded inspection results and attachments.", [
      button("All batches", () => ctx.navigate("batches"), "button button-secondary"),
    ]),
    metadata,
    renderBatchAttachments(attachmentsWorkspace, state, ctx),
    intro,
  );
}

function renderBatchDetail(root, ctx) {
  root.replaceChildren(el("p", { className: "qc-ops-loading" }, "Loading batch workspace…"));
  return ctx.service.getBatchWorkspace(ctx.selectedId).then((workspace) => {
    const state = ctx.state || {};
    const batch = workspace.batch;
    if (!batch) throw new Error("The selected batch could not be found.");
    if (isHistoricalBatch(batch)) return renderHistoricalBatchDetail(root, ctx, workspace);
    const isReleased = batch.status === "released";
    const detailKey = detailDraftKey(batch.id);
    const savedDetails = { date: batch.date || "", recorder: batch.recorder || "", notes: batch.notes || "" };
    const draftDetails = batchDetailDrafts.get(detailKey) || savedDetails;
    const detailChanged = draftDetails.date !== savedDetails.date || draftDetails.recorder !== savedDetails.recorder || draftDetails.notes !== savedDetails.notes;
    const order = workspace.order || orderById(state).get(batch.orderId);
    const detailForm = el("form", { className: "qc-ops-batch-meta qc-ops-detail-form", "data-preserve-drafts": "true" });
    if (detailChanged) detailForm.dataset.dirty = "true";
    const dateInput = el("input", { type: "date", value: draftDetails.date, disabled: isReleased, name: "date" });
    const recorderInput = el("input", { type: "text", maxLength: "80", value: draftDetails.recorder, disabled: isReleased, name: "recorder", autocomplete: "name" });
    const notesInput = el("textarea", { rows: "2", maxLength: "1000", disabled: isReleased, name: "notes" }, draftDetails.notes);
    const saveDetails = el("button", { type: "submit", className: "button button-secondary", disabled: isReleased || !detailChanged }, "Save batch details");
    const updateDetailDraft = () => {
      const next = { date: dateInput.value, recorder: recorderInput.value, notes: notesInput.value };
      if (next.date === savedDetails.date && next.recorder === savedDetails.recorder && next.notes === savedDetails.notes) {
        batchDetailDrafts.delete(detailKey);
        delete detailForm.dataset.dirty;
      } else {
        batchDetailDrafts.set(detailKey, next);
        detailForm.dataset.dirty = "true";
      }
      saveDetails.disabled = isReleased || (next.date === savedDetails.date && next.recorder === savedDetails.recorder && next.notes === savedDetails.notes);
      queueMicrotask(() => {
        if (!batchDetailDrafts.has(detailKey)) delete detailForm.dataset.dirty;
      });
      releasePanel?.refresh();
    };
    for (const input of [dateInput, recorderInput, notesInput]) input.addEventListener("input", updateDetailDraft);
    detailForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      updateDetailDraft();
      const next = batchDetailDrafts.get(detailKey) || savedDetails;
      const previous = batchDetailDrafts.get(detailKey);
      batchDetailDrafts.delete(detailKey);
      const response = await runCommand(ctx, "saveBatchDetails", { id: batch.id, ...next });
      if (!response.ok) {
        const failedDraft = previous || next;
        if (failedDraft.date !== savedDetails.date || failedDraft.recorder !== savedDetails.recorder || failedDraft.notes !== savedDetails.notes) batchDetailDrafts.set(detailKey, failedDraft);
      }
    });
    detailForm.append(
      field("Batch date 批次日期", dateInput),
      field("Recorded by 记录人员", recorderInput),
      field("Special notes 本批次特殊情况", notesInput),
      saveDetails
    );
    const releasePanel = renderReleaseBlockers(workspace, ctx);
    const title = batchLabel(batch, state);
    const headerActions = [
      button("All batches", () => navigateWithDraftWarning(ctx, "batches", undefined, batch.id), "button button-secondary"),
      statusPill(batch.status)
    ];
    const metadata = el("section", { className: "card qc-ops-batch-meta-card" },
      el("div", { className: "qc-ops-section-heading" },
        el("div", {}, el("h2", {}, title), el("p", {}, `${text(batch.factory)} · ${text(batch.stage)} · ${text(batch.versionLabel)} · ${text(order?.number, batch.orderId)}`)),
        el("span", { className: isReleased ? "qc-ops-lock-label" : "qc-ops-edit-label" }, isReleased ? "Locked after release" : detailChanged ? "Unsaved batch details" : "Batch details")
      ),
      detailForm,
      el("div", { className: "qc-ops-batch-facts" },
        el("span", {}, el("strong", {}, "Batch quantity"), quantity(batch.quantity)),
        el("span", {}, el("strong", {}, "Physical lot number"), text(batch.lotNumber)),
        el("span", {}, el("strong", {}, "Purchase order line"), text(order?.number, batch.orderId)),
        el("span", {}, el("strong", {}, "PO progress"), batch.countForPO ? "Counts on release" : "Not counted"),
        el("span", {}, el("strong", {}, "Inspection basis"), `${text(workspace.variant?.label)} · ${text(workspace.version?.label || batch.versionLabel)}`)
      )
    );
    const intro = el("section", { className: "card qc-ops-inspection-card" },
      el("div", { className: "qc-ops-section-heading" },
        el("div", {}, el("h2", {}, "Batch inspection workspace"), el("p", {}, "Enter defective quantities and remarks in the familiar bilingual table. Inspection quantities are calculated from the locked batch basis and are read-only.")),
        el("span", { className: "qc-ops-note-pill" }, "Green rows mark important checks")
      ),
      el("p", { className: "qc-ops-table-note" }, isReleased
        ? "Released batch · inspection standards, saved results, and photos are read-only."
        : "Each row result must be saved before release. Photos and linked issues stay attached to their inspection row."),
      makeInspectionTable(workspace, state, ctx, () => releasePanel.refresh())
    );
    root.replaceChildren(
      pageHeading("Batches", "Create, inspect, and release one purchase-order line and product variant per batch.", headerActions),
      metadata,
      renderBatchAttachments({ ...workspace, attachments: Array.isArray(workspace.attachments) ? workspace.attachments : batchAttachments(batch, state) }, state, ctx),
      intro,
      releasePanel.element
    );
  }).catch((error) => {
    root.replaceChildren(
      pageHeading("Batches", "The batch workspace could not be loaded."),
      el("section", { className: "card qc-ops-error-card" }, el("p", {}, errorText(error)), button("Back to batches", () => ctx.navigate("batches"), "button button-secondary"))
    );
    notify(errorText(error), true);
  });
}

function orderedLines(state) {
  const variants = variantsById(state);
  return list(state.orders).flatMap((order) => list(order.lines).map((line) => ({ order, line, variant: variants.get(line.variantId) })))
    .filter((entry) => entry.variant);
}

function publishedVersions(state, familyId) {
  return list(state.versions).filter((version) => version.familyId === familyId && version.status === "published")
    .sort((left, right) => Number(right.sequence) - Number(left.sequence));
}

function lineOptionLabel(entry) {
  return `${text(entry.order.number)} · ${text(entry.variant.label)} · ${quantity(entry.line.orderedQty)} ordered`;
}

function applicablePairs(version, model) {
  const pairs = new Map();
  for (const item of list(version?.items)) {
    const models = list(item.models);
    if (models.length && !models.includes(model)) continue;
    if (!item.factory || !item.stage) continue;
    if (String(item.factory).toUpperCase() === "AP" && String(item.stage).toUpperCase() === "IQC") continue;
    const key = `${item.factory}::${item.stage}`;
    if (!pairs.has(key)) pairs.set(key, { factory: item.factory, stage: item.stage });
  }
  return Array.from(pairs.values());
}

function openNewBatchDialog(state, ctx) {
  const lines = orderedLines(state);
  const localToday = new Date();
  const today = `${localToday.getFullYear()}-${String(localToday.getMonth() + 1).padStart(2, "0")}-${String(localToday.getDate()).padStart(2, "0")}`;
  const orderLine = el("select", { required: true, name: "orderLine" },
    ...lines.map((entry) => el("option", { value: `${entry.order.id}::${entry.line.id}` }, lineOptionLabel(entry)))
  );
  const versionSelect = el("select", { required: true, name: "versionId" });
  const factorySelect = el("select", { required: true, name: "factory" });
  const stageSelect = el("select", { required: true, name: "stage" });
  const numberInput = el("input", { type: "text", required: true, maxLength: "80", name: "number", placeholder: "Enter a unique batch number" });
  const quantityInput = el("input", { type: "number", required: true, min: "1", step: "1", name: "quantity", inputMode: "numeric" });
  const lotInput = el("input", { type: "text", required: true, maxLength: "120", name: "lotNumber", placeholder: "Physical lot / shipment lot" });
  const dateInput = el("input", { type: "date", required: true, name: "date", value: today });
  const recorderInput = el("input", { type: "text", required: true, maxLength: "80", name: "recorder", autocomplete: "name" });
  const notesInput = el("textarea", { rows: "2", maxLength: "1000", name: "notes" });
  const countForPO = el("input", { type: "checkbox", name: "countForPO" });
  let countForPOTouched = false;
  const countHelp = el("small", { className: "qc-ops-hint" }, "Eligible OQC batches count the full quantity only after release. Enter the physical lot number to prevent duplicate fulfillment counting.");
  const versionHelp = el("small", { className: "qc-ops-hint" });
  const formError = el("p", { className: "qc-ops-form-error", role: "alert" });
  const submit = el("button", { type: "submit", className: "button button-primary" }, "Create batch");
  const cancel = button("Cancel", () => closeDialog(), "button button-secondary");
  const versionOptionsForSelection = () => {
    const [orderId, lineId] = orderLine.value.split("::");
    const entry = lines.find((item) => item.order.id === orderId && item.line.id === lineId);
    const versions = publishedVersions(state, entry?.variant?.familyId);
    setOptions(versionSelect, versions.map((version) => ({ value: version.id, label: version.label })), versions[0]?.id || "");
    versionHelp.textContent = versions.length
      ? `The latest published version is selected. You may choose a historical published version; the selected basis is locked on this batch.`
      : "No published version exists for this inspection family. Publish a valid version before creating a batch.";
    refreshApplicability();
  };
  const refreshApplicability = () => {
    const version = list(state.versions).find((item) => item.id === versionSelect.value);
    const [orderId, lineId] = orderLine.value.split("::");
    const selectedLine = lines.find((item) => item.order.id === orderId && item.line.id === lineId);
    const pairs = applicablePairs(version, selectedLine?.variant?.model);
    const factories = Array.from(new Set(pairs.map((pair) => pair.factory))).sort();
    const priorFactory = factorySelect.value;
    setOptions(factorySelect, factories.map((factory) => ({ value: factory, label: factory })), factories.includes(priorFactory) ? priorFactory : factories[0] || "");
    const stages = pairs.filter((pair) => pair.factory === factorySelect.value).map((pair) => pair.stage);
    const priorStage = stageSelect.value;
    setOptions(stageSelect, stages.map((stage) => ({ value: stage, label: stage })), stages.includes(priorStage) ? priorStage : stages[0] || "");
    updateCountEligibility();
    submit.disabled = !lines.length || !versionSelect.value || !factorySelect.value || !stageSelect.value;
    if (versionSelect.value && !factorySelect.value) {
      versionHelp.textContent = "This published version has no standards applicable to the selected variant. Choose another published version or update the standards.";
    }
  };
  const updateCountEligibility = () => {
    const eligibleOqc = stageSelect.value.toUpperCase() === "OQC";
    countForPO.disabled = !eligibleOqc;
    if (!eligibleOqc) countForPO.checked = false;
    else if (!countForPOTouched) countForPO.checked = true;
    countHelp.textContent = eligibleOqc
      ? "Final shipment: count the full quantity toward this PO line only after release. The physical lot number prevents counting the same goods twice."
      : "Only OQC batches are eligible to count toward PO fulfillment. IQC batches cannot be counted.";
  };
  orderLine.addEventListener("change", versionOptionsForSelection);
  versionSelect.addEventListener("change", refreshApplicability);
  factorySelect.addEventListener("change", refreshApplicability);
  stageSelect.addEventListener("change", updateCountEligibility);
  countForPO.addEventListener("change", () => { countForPOTouched = true; });
  versionOptionsForSelection();
  const form = el("form", { className: "qc-ops-form qc-ops-new-batch-form" },
    field("Purchase order line 采购订单行", orderLine),
    field("Product variant 产品规格", el("output", { className: "qc-ops-derived-output" }, "Selected from PO line")),
    field("Published version 设计版本", versionSelect), versionHelp,
    el("div", { className: "qc-ops-form-grid" }, field("Factory 工厂", factorySelect), field("Inspection stage 检验阶段", stageSelect)),
    field("Batch number 批次编号", numberInput),
    field("Batch quantity 批次数量", quantityInput),
    field("Physical lot number 实物批号", lotInput),
    el("div", { className: "qc-ops-form-grid" }, field("Batch date 批次日期", dateInput), field("Recorded by 记录人员", recorderInput)),
    field("Special notes 本批次特殊情况", notesInput),
    el("label", { className: "qc-ops-checkbox-field" }, countForPO, el("span", {}, "Final shipment · count released quantity toward PO")),
    countHelp,
    formError,
    el("div", { className: "qc-ops-dialog-actions" }, cancel, submit)
  );
  const derivedOutput = form.querySelector("output");
  const updateVariantOutput = () => {
    const [, lineId] = orderLine.value.split("::");
    const entry = lines.find((item) => item.line.id === lineId);
    derivedOutput.textContent = entry?.variant?.label || "—";
  };
  orderLine.addEventListener("change", updateVariantOutput);
  updateVariantOutput();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    formError.textContent = "";
    const [orderId, lineId] = orderLine.value.split("::");
    if (!orderId || !lineId || !versionSelect.value || !factorySelect.value || !stageSelect.value) {
      formError.textContent = "Choose an order line with a published version and applicable factory/stage standards.";
      return;
    }
    if (!form.reportValidity()) return;
    const result = await runCommand(ctx, "createBatch", {
      number: numberInput.value.trim(),
      orderId,
      lineId,
      quantity: Number(quantityInput.value),
      factory: factorySelect.value,
      stage: stageSelect.value,
      lotNumber: lotInput.value.trim(),
      countForPO: Boolean(countForPO.checked),
      versionId: versionSelect.value,
      date: dateInput.value,
      recorder: recorderInput.value.trim(),
      notes: notesInput.value
    });
    if (!result.ok) {
      formError.textContent = errorText(result.error);
      return;
    }
    closeDialog(true);
    const createdId = result.result?.entityId || result.result?.batchId;
    if (createdId) ctx.navigate("batches", createdId);
    else ctx.navigate("batches");
  });
  if (!lines.length) {
    formError.textContent = "Create a purchase order and line before creating a batch.";
    submit.disabled = true;
  }
  showDialog("New inspection batch", form);
}

function renderBatchList(root, ctx) {
  const state = ctx.state || {};
  const batches = list(state.batches).slice().sort((left, right) => String(right.date || right.createdAt || "").localeCompare(String(left.date || left.createdAt || "")));
  const displayNumbers = resolveBatchDisplayNumbers(state);
  const orders = list(state.orders);
  const variants = variantsById(state);
  const createButton = button("New batch", () => openNewBatchDialog(state, ctx), "button button-primary");
  const createableLines = orderedLines(state).filter((entry) => publishedVersions(state, entry.variant.familyId)
    .some((version) => applicablePairs(version, entry.variant.model).length > 0));
  createButton.disabled = createableLines.length === 0;
  const actions = [createButton, historicalBatchImportControl(ctx)];
  const toolbar = el("div", { className: "qc-ops-list-toolbar" });
  const search = el("input", { type: "search", placeholder: "Search batch, product, PO, source file, or version", "aria-label": "Search batches" });
  const familyById = new Map(list(state.families).map((family) => [family.id, family]));
  const plural = { Family: "families", Factory: "factories", Stage: "stages" };
  const filterSelect = (label, entries) => el("select", { "aria-label": `Filter batches by ${label.toLocaleLowerCase()}` },
    el("option", { value: "all" }, `All ${plural[label] || `${label.toLocaleLowerCase()}s`}`),
    entries.map(({ value, label: entryLabel }) => el("option", { value }, entryLabel ?? value)),
  );
  const families = [...new Set(batches.map((batch) => batch.familyId || variants.get(batch.variantId)?.familyId).filter(Boolean))].sort();
  const factories = [...new Set(batches.map((batch) => batch.factory).filter((value) => value !== null && value !== undefined && value !== ""))].map(String).sort();
  const stages = [...new Set(batches.map((batch) => batch.stage).filter((value) => value !== null && value !== undefined && value !== ""))].map(String).sort();
  const family = filterSelect("Family", families.map((value) => ({ value, label: familyById.get(value)?.name || value })));
  const factory = filterSelect("Factory", factories.map((value) => ({ value })));
  const stage = filterSelect("Stage", stages.map((value) => ({ value })));
  toolbar.append(field("Search", search), field("Family", family), field("Factory", factory), field("Stage", stage));
  const table = el("table", { className: "qc-ops-list-table qc-ops-batch-list-table" },
    el("thead", {}, el("tr", {}, ...["Batch", "Attachments", "Product / model", "Purchase order", "Factory / stage", "Quantity", "Physical lot", "Date", ""].map((label) => el("th", { scope: "col" }, label)))),
    el("tbody")
  );
  const tbody = table.querySelector("tbody");
  for (const batch of batches) {
    const displayNumber = displayNumbers.get(batch.id) ?? batch.number;
    const variant = variants.get(batch.variantId);
    const order = orders.find((item) => item.id === batch.orderId);
    const batchFamily = batch.familyId || variant?.familyId || "";
    const attachments = batchAttachments(batch, state);
    const searchText = [displayNumber, batchFamily, familyById.get(batchFamily)?.name, batch.productLabel, batch.model, batch.color, variant?.label, order?.number, batch.factory, batch.stage, batch.lotNumber, batch.versionLabel, ...attachments.map((asset) => asset.name)]
      .filter((value) => value !== null && value !== undefined).join(" ").toLocaleLowerCase();
    const attachmentCell = el("td", { className: "qc-ops-list-attachments" });
    if (attachments.length) {
      attachmentCell.append(...attachments.map((asset) => {
        const title = asset.name || "Attachment";
        const actions = [];
        if (asset.dataUrl && canOpenAttachment(asset)) {
          actions.push(button(asset.sourcePdf ? "Open PDF" : "Open", () => { void openAttachment(asset); }, "button-quiet qc-ops-list-attachment-open"));
        }
        if (asset.dataUrl) actions.push(button("Download", () => {
          void downloadFile(title, asset.dataUrl, asset.mimeType).catch((error) => notify(errorText(error, "The attachment could not be downloaded."), true));
        }, "button-quiet qc-ops-list-attachment-download"));
        return el("div", { className: "qc-ops-list-attachment" },
          el("span", { className: "qc-ops-list-attachment-name", title }, title),
          el("span", { className: "qc-ops-list-attachment-actions" }, actions.length ? actions : el("span", {}, "Unavailable")),
        );
      }));
    } else {
      attachmentCell.append("—");
    }
    const tr = el("tr", {
      "data-family": batchFamily,
      "data-factory": batch.factory || "",
      "data-stage": batch.stage || "",
      "data-search": searchText,
    },
      el("td", {}, text(displayNumber)),
      attachmentCell,
      el("td", {}, batchProductLabel(batch, state)),
      el("td", {}, text(order?.number)),
      el("td", {}, [batch.factory, batch.stage].filter((value) => value !== null && value !== undefined && value !== "").join(" · ") || "—"),
      el("td", { className: "qc-ops-number" }, isHistoricalBatch(batch) ? sourceValue(batch.quantity) : quantity(batch.quantity)),
      el("td", {}, text(batch.lotNumber)),
      el("td", {}, dateLabel(batch.date)),
      el("td", {}, button("Open", () => ctx.navigate("batches", batch.id), "button button-secondary qc-ops-small-button")),
    );
    tbody.append(tr);
  }
  const updateFilters = () => {
    const query = search.value.trim().toLowerCase();
    for (const row of tbody.rows) {
      const familyMatches = family.value === "all" || row.dataset.family === family.value;
      const factoryMatches = factory.value === "all" || row.dataset.factory === factory.value;
      const stageMatches = stage.value === "all" || row.dataset.stage === stage.value;
      const searchMatches = !query || row.dataset.search.includes(query);
      row.hidden = !familyMatches || !factoryMatches || !stageMatches || !searchMatches;
    }
  };
  search.addEventListener("input", updateFilters);
  for (const select of [family, factory, stage]) select.addEventListener("change", updateFilters);
  const sections = [];
  if (!batches.length && !orders.length) {
    sections.push(el("section", { className: "card qc-ops-empty-card" },
      el("h2", {}, "Start with a purchase order"),
      el("p", {}, "A batch belongs to one explicit purchase order line and one product variant. Create an order first, then return here to create an inspection batch."),
      button("Open purchase orders", () => ctx.navigate("orders"), "button button-primary")
    ));
  } else if (!batches.length && orders.length && !createableLines.length) {
    sections.push(el("section", { className: "card qc-ops-empty-card" },
      el("h2", {}, "Publish an inspection basis before creating batches"),
      el("p", {}, "At least one PO line needs a published version with applicable standards for its model. Review and publish a valid design version first."),
      button("Open standards", () => ctx.navigate("standards"), "button button-primary")
    ));
  }
  if (rowDrafts.size || batchDetailDrafts.size) {
    const pendingBatchIds = new Set([
      ...Array.from(rowDrafts.keys(), (key) => key.split("::")[0]),
      ...Array.from(batchDetailDrafts.keys())
    ]);
    sections.unshift(el("section", { className: "card qc-ops-draft-warning" },
      el("strong", {}, "Unsaved edits are held in this tab"),
      el("p", {}, `${rowDrafts.size} inspection row(s) and ${batchDetailDrafts.size} batch detail set(s) still need saving. They will remain available while this tab stays open.`),
      ...Array.from(pendingBatchIds).map((batchId) => {
        const batch = batches.find((item) => item.id === batchId);
        return batch ? button(`Resume ${text(batch.number)}`, () => ctx.navigate("batches", batchId, true), "button button-secondary qc-ops-small-button") : null;
      })
    ));
  }
  if (batches.length) {
    sections.push(el("section", { className: "card qc-ops-list-card" }, toolbar, el("div", { className: "qc-ops-table-scroll" }, table)));
  } else if (orders.length && createableLines.length) {
    sections.push(el("section", { className: "card qc-ops-empty-card" },
      el("h2", {}, "No batches yet"),
      el("p", {}, "Once a purchase order and published inspection version are ready, create the first batch here."),
      createButton
    ));
  }
  root.replaceChildren(pageHeading("Batches", "Browse batch records, open their inspection tables, and access batch attachments.", actions), ...sections);
}

export function clearBatchDrafts() {
  rowDrafts.clear();
  batchDetailDrafts.clear();
}

window.addEventListener("masterqc:discard-operation-drafts", clearBatchDrafts);

export async function renderBatchesPage(root, ctx) {
  if (ctx.selectedId) return renderBatchDetail(root, ctx);
  renderBatchList(root, ctx);
}
