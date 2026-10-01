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
import { getBatchVersionItems, getBatchVersions, getBatchVersionReadiness } from "../core/qc-batch-versions.js";
import { getBatchProducts, getBatchRowProduct } from "../core/qc-batch-products.js";

const rowDrafts = new Map();
const batchDetailDrafts = new Map();

function hasDraftsForBatch(batchId) {
  const prefix = `${batchId}::`;
  return Array.from(rowDrafts.keys()).some((key) => key.startsWith(prefix)) || batchDetailDrafts.has(String(batchId));
}

function navigateWithDraftWarning(ctx, route, id, batchId) {
  if (batchId && hasDraftsForBatch(batchId) && route === "batch-report") {
    showDialog("Unsaved inspection edits", el("div", { className: "discard-prompt" },
      el("p", {}, "The report includes saved values only. Unsaved drafts remain in this tab."),
      el("div", { className: "button-row" },
        button("Stay on this batch", () => closeDialog(true), "button-secondary"),
        button("View saved report", () => {
          closeDialog(true);
          ctx.navigate(route, id, true);
        }, "button-primary"),
      ),
    ));
    return;
  }
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

function productLabel(product, state) {
  const variant = product?.variant || variantsById(state).get(product?.variantId);
  return text(variant?.label || product?.productLabel, product?.variantId || "Product");
}

function batchProducts(batch, state, workspace = null) {
  if (Array.isArray(workspace?.products) && workspace.products.length) return workspace.products;
  return getBatchProducts(batch).map((product) => ({
    ...product,
    variant: variantsById(state).get(product.variantId) || null,
    version: list(state.versions).find((version) => version.id === product.versionId) || null,
  }));
}

function batchProductNames(batch, state, workspace = null) {
  if (isHistoricalBatch(batch)) return [batchProductLabel(batch, state)];
  return batchProducts(batch, state, workspace).map((product) => productLabel(product, state)).filter(Boolean);
}

function totalProductQuantity(batch, state, workspace = null) {
  if (isHistoricalBatch(batch)) return batch.quantity;
  const products = batchProducts(batch, state, workspace);
  if (!products.length) return batch.quantity;
  return products.reduce((total, product) => total + Number(product.quantity || 0), 0);
}

function rowProduct(row, batch, state, workspace = null) {
  const product = getBatchRowProduct(batch, row);
  const resolved = batchProducts(batch, state, workspace).find((candidate) => candidate.lineId === product?.lineId || candidate.lineId === row.productLineId);
  return { ...product, ...resolved, ...product };
}

function batchLabel(batch, state) {
  const order = orderById(state).get(batch.orderId);
  const products = batchProductNames(batch, state).join(", ");
  return `${text(batch.number, "Batch")} · ${text(products, batch.variantId)} · ${text(order?.number, batch.orderId)}`;
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
  const multipleProducts = batchProducts(workspace.batch, state, workspace).length > 1;
  const draft = stateForRow(row, workspace.batch.id);
  const dirty = rowHasDraft(row, workspace.batch.id);
  const tr = el("tr", { className: row.important ? "qc-ops-important-row" : "" });
  const no = el("td", { className: "qc-ops-no" }, text(row.no, String(index + 1)));
  tr.append(no);
  if (multipleProducts) {
    const product = rowProduct(row, workspace.batch, state, workspace);
    tr.append(el("td", { className: "qc-ops-product-context" },
      el("strong", {}, text(row.productLabel || productLabel(product, state))),
      el("small", {}, `${quantity(row.productQuantity ?? product.quantity)} units`),
    ));
  }
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
  const multipleProducts = !isHistoricalBatch(workspace.batch) && batchProducts(workspace.batch, state, workspace).length > 1;
  const table = el("table", { className: `qc-ops-inspection-table${multipleProducts ? " qc-ops-mixed-product-table" : ""}` });
  const colgroup = el("colgroup");
  const widths = ["34px", ...(multipleProducts ? ["118px"] : []), "100px", "185px", "80px", "60px", "76px", "55px", "55px", "52px", "52px", "52px", "52px", "52px", "44px", "64px", "165px", "128px"];
  for (const width of widths) {
    colgroup.append(el("col", { style: { width } }));
  }
  const thead = el("thead", {},
    el("tr", { className: "qc-ops-group-head" },
      el("th", { rowSpan: "2", scope: "col" }, "No.", el("br"), el("span", { lang: "zh" }, "序号")),
      multipleProducts ? el("th", { rowSpan: "2", scope: "col" }, "Product / qty", el("br"), el("span", { lang: "zh" }, "产品 / 数量")) : null,
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
    const alreadyReleased = workspace.batch.status === "released";
    const blockers = alreadyReleased ? [] : list(workspace.releaseBlockers).map((message) => String(message));
    const changedRows = list(workspace.rows).filter((row) => rowHasDraft(row, workspace.batch.id)).length;
    const details = batchDetailDrafts.get(detailDraftKey(workspace.batch.id));
    const changedDetails = details && (details.date !== (workspace.batch.date || "") || details.recorder !== (workspace.batch.recorder || "") || details.notes !== (workspace.batch.notes || ""));
    if (changedRows) blockers.push(`${changedRows} row result(s) have unsaved edits. Save each changed row before release.`);
    if (changedDetails) blockers.push("Batch date, recorder, or notes have unsaved edits. Save batch details before release.");
    const blockerList = blockers.length
      ? el("ul", { className: "qc-ops-blocker-list" }, ...blockers.map((message) => el("li", {}, message)))
      : null;
    if (alreadyReleased) blockerHost.replaceChildren(statusPill("released"));
    else blockerHost.replaceChildren(...(blockerList ? [blockerList] : []));
    release.disabled = alreadyReleased || blockers.length > 0;
  };
  refresh();
  return { element: el("section", { className: "card qc-ops-release-card" },
    el("div", { className: "qc-ops-section-heading" },
      el("h2", {}, "Full-batch release"),
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
    }, "button-quiet qc-ops-small-button"));
  } else {
    actions.push(el("span", { className: "qc-ops-hint" }, "File unavailable"));
  }
  const locked = batch.status === "released" || asset.sourcePdf === true;
  if (!asset.sourcePdf) {
    const remove = button("Remove", () => {
      if (!window.confirm(`Remove “${text(asset.name, "this attachment")}” from this batch? The file remains in the file library.`)) return;
      void runCommand(ctx, "removeBatchAttachment", { batchId: batch.id, assetId: asset.id });
    }, "button-danger qc-ops-small-button");
    remove.disabled = locked;
    if (batch.status === "released") remove.title = "Released batch attachments are read-only.";
    actions.push(remove);
  }
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
      el("div", {}, el("strong", {}, text(asset.name, "Attachment"))),
      attachmentActions(asset, batch, ctx),
    ))
    : [el("li", { className: "qc-ops-attachment-empty" }, "No attachments")];
  return el("section", { className: "card qc-ops-attachments-card" },
    el("div", { className: "qc-ops-section-heading" },
      el("h2", {}, "Attachments"),
      add,
    ),
    el("ul", { className: "qc-ops-attachment-list" }, items),
    fileInput,
  );
}

function historicalSourceEvidence(batch, state) {
  const inspection = list(state.history?.inspections).find((item) => item.id === batch.historyInspectionId) ?? null;
  const source = inspection ? list(state.history?.sources).find((item) => item.id === inspection.sourceId) ?? null : null;
  return { inspection, source };
}

function normalizeHistoricalDate(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{4})([-/])(\d{1,2})\2(\d{1,2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[3]);
  const day = Number(match[4]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function hasHistoricalValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function normalizeHistoricalNote(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

function renderHistoricalBatchDetail(root, ctx, workspace) {
  const batch = workspace.batch;
  const state = ctx.state || {};
  const { inspection, source } = historicalSourceEvidence(batch, state);
  const family = list(state.families).find((item) => item.id === batch.familyId);
  const attachmentsWorkspace = { ...workspace, attachments: Array.isArray(workspace.attachments) ? workspace.attachments : batchAttachments(batch, state) };
  const attachmentNames = new Set(list(attachmentsWorkspace.attachments).map((asset) => asset?.name).filter(hasHistoricalValue));
  const productLabel = batchProductLabel({ ...batch, productLabel: batch.model || batch.productLabel }, state);
  const model = String(batch.model || "").trim();
  const modelAddsInformation = model && !productLabel.toLocaleLowerCase().includes(model.toLocaleLowerCase());
  const batchDate = normalizeHistoricalDate(batch.date);
  const printedDate = normalizeHistoricalDate(inspection?.printedDate);
  const printedDateMatchesBatch = batchDate !== null && printedDate !== null && batchDate === printedDate;
  const sourceFacts = [
    ["Family", family?.name || batch.familyId],
    ...(modelAddsInformation ? [["Model", batch.model]] : []),
    ["Color", batch.color],
    ...(!attachmentNames.has(source?.fileName) ? [["Source PDF", source?.fileName]] : []),
    ...(!printedDateMatchesBatch && hasHistoricalValue(inspection?.printedDate) ? [["Printed date", dateLabel(inspection.printedDate)]] : []),
  ].filter(([, value]) => hasHistoricalValue(value));
  const batchNotes = batch.notes === null || batch.notes === undefined ? "" : String(batch.notes);
  const inspectionNotes = inspection?.notes === null || inspection?.notes === undefined ? "" : String(inspection.notes);
  const normalizedBatchNotes = normalizeHistoricalNote(batchNotes);
  const normalizedInspectionNotes = normalizeHistoricalNote(inspectionNotes);
  const anomalies = [...list(source?.anomalies), ...list(inspection?.anomalies)];
  const metadata = el("section", { className: "card qc-ops-batch-meta-card qc-ops-historical-meta-card" },
    el("div", { className: "qc-ops-section-heading" },
      el("h2", {}, historicalBatchLabel(workspace.displayNumber)),
    ),
    el("dl", { className: "qc-ops-historical-facts" },
      el("div", {}, el("dt", {}, "Product"), el("dd", {}, productLabel)),
      el("div", {}, el("dt", {}, "Factory / stage"), el("dd", {}, [batch.factory, batch.stage].filter((value) => value !== null && value !== undefined && value !== "").join(" · ") || "—")),
      el("div", {}, el("dt", {}, "Quantity"), el("dd", {}, sourceValue(batch.quantity))),
      el("div", {}, el("dt", {}, "Date"), el("dd", {}, dateLabel(batch.date))),
      el("div", {}, el("dt", {}, "Version"), el("dd", {}, text(batch.versionLabel))),
      el("div", {}, el("dt", {}, "Recorded by"), el("dd", {}, text(inspection?.recorder))),
    ),
    el("details", { className: "qc-ops-historical-provenance" },
      el("summary", {}, "More details"),
      el("dl", { className: "qc-ops-historical-source-facts" },
        ...sourceFacts.flatMap(([label, value]) => [el("dt", {}, label), el("dd", {}, sourceValue(value))]),
      ),
      normalizedBatchNotes ? el("p", { className: "qc-ops-historical-notes" }, el("strong", {}, "Batch notes:"), el("br", {}), batchNotes) : null,
      normalizedInspectionNotes && normalizedInspectionNotes !== normalizedBatchNotes
        ? el("p", { className: "qc-ops-historical-notes" }, el("strong", {}, "Inspection notes: "), inspectionNotes)
        : null,
      anomalies.length ? el("ul", { className: "qc-ops-historical-anomalies" }, anomalies.map((anomaly) => el("li", {}, typeof anomaly === "string" ? anomaly : JSON.stringify(anomaly)))) : null,
      inspection?.raw ? el("details", { className: "qc-ops-historical-raw" }, el("summary", {}, "Preserved source fields"), el("pre", {}, JSON.stringify(inspection.raw, null, 2))) : null,
    ),
  );
  const intro = el("section", { className: "card qc-ops-inspection-card" },
    el("div", { className: "qc-ops-section-heading" },
      el("h2", {}, "Batch inspection table"),
      el("span", { className: "qc-ops-note-pill" }, "Read-only"),
    ),
    makeInspectionTable(workspace, state, ctx, null),
  );
  root.replaceChildren(
    pageHeading("Batches", "", [
      button("All batches", () => ctx.navigate("batches"), "button button-secondary"),
      button("View report", () => ctx.navigate("batch-report", batch.id), "button button-secondary"),
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
    const products = batchProducts(batch, state, workspace);
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
      button("View report", () => navigateWithDraftWarning(ctx, "batch-report", batch.id, batch.id), "button button-secondary"),
      statusPill(batch.status)
    ];
    const metadata = el("section", { className: "card qc-ops-batch-meta-card" },
      el("div", { className: "qc-ops-section-heading" },
        el("div", {}, el("h2", {}, title), el("p", {}, `${text(batch.factory)} · ${text(batch.stage)} · ${text(order?.number, batch.orderId)}`)),
        el("span", { className: isReleased ? "qc-ops-lock-label" : "qc-ops-edit-label" }, isReleased ? "Locked after release" : detailChanged ? "Unsaved batch details" : "Batch details")
      ),
      detailForm,
      el("div", { className: "qc-ops-batch-facts" },
        el("span", {}, el("strong", {}, "Total batch quantity"), quantity(totalProductQuantity(batch, state, workspace))),
        el("span", {}, el("strong", {}, "Purchase order"), text(order?.number, batch.orderId)),
        el("span", {}, el("strong", {}, "PO progress"), batch.countForPO ? "Counts on release" : "Not counted"),
      ),
      el("section", { className: "qc-ops-product-locks" },
        el("h3", {}, "Products and locked design versions"),
        el("div", { className: "qc-ops-product-lock-list" }, products.map((product) => el("div", {},
          el("strong", {}, productLabel(product, state)),
          el("span", {}, `${quantity(product.quantity)} units`),
          el("span", {}, `Version ${text(product.version?.label || product.versionLabel)}`),
        ))),
      )
    );
    const intro = el("section", { className: "card qc-ops-inspection-card" },
      el("div", { className: "qc-ops-section-heading" },
        el("h2", {}, "Batch inspection workspace"),
        el("span", { className: "qc-ops-note-pill" }, "Green rows mark important checks")
      ),
      makeInspectionTable(workspace, state, ctx, () => releasePanel.refresh())
    );
    root.replaceChildren(
      pageHeading("Batches", "Create and inspect batches with product-specific quantities and locked design versions.", headerActions),
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

function lineOptionLabel(entry, orderLines = []) {
  const sameVariant = orderLines.filter((candidate) => candidate.variant.id === entry.variant.id);
  const lineSuffix = sameVariant.length > 1 ? ` · Line ${sameVariant.indexOf(entry) + 1}` : "";
  return `${text(entry.variant.label)} · ${quantity(entry.line.orderedQty)} ordered${lineSuffix}`;
}

function applicablePairs(version, model) {
  const pairs = new Map();
  for (const item of getBatchVersionItems(version)) {
    const models = list(item.models);
    if (models.length && !models.includes(model)) continue;
    if (!item.factory || !item.stage) continue;
    if (String(item.factory).toUpperCase() === "AP" && String(item.stage).toUpperCase() === "IQC") continue;
    const key = `${item.factory}::${item.stage}`;
    if (!pairs.has(key)) pairs.set(key, { factory: item.factory, stage: item.stage });
  }
  return Array.from(pairs.values());
}

function hasReadyVersionForModel(state, familyId, model) {
  return getBatchVersions(state, familyId).some((version) => applicablePairs(version, model)
    .some((pair) => getBatchVersionReadiness(version, pair.factory, pair.stage, model).ready));
}

function openNewBatchDialog(state, ctx) {
  const lines = orderedLines(state);
  const orders = list(state.orders).filter((order) => lines.some((entry) => entry.order.id === order.id));
  if (!lines.length) {
    const message = "Create a purchase order with at least one product line before creating a batch.";
    showDialog("New inspection batch", el("div", { className: "qc-ops-new-batch-form" },
      el("p", {}, message),
      el("div", { className: "qc-ops-dialog-actions" },
        button("Open purchase orders", () => { closeDialog(); ctx.navigate("orders"); }, "button-primary"),
        button("Cancel", () => closeDialog(), "button-secondary"),
      ),
    ));
    return;
  }
  const localToday = new Date();
  const today = `${localToday.getFullYear()}-${String(localToday.getMonth() + 1).padStart(2, "0")}-${String(localToday.getDate()).padStart(2, "0")}`;
  const orderSelect = el("select", { required: true, name: "orderId" },
    ...orders.map((order) => el("option", { value: order.id }, text(order.number, "Purchase order")))
  );
  const productsHost = el("div", { className: "qc-ops-product-entries" });
  const addProduct = button("Add product", () => addProductEntry(), "button button-secondary");
  const productEntries = [];
  const factorySelect = el("select", { required: true, name: "factory" });
  const stageSelect = el("select", { required: true, name: "stage" });
  const numberInput = el("input", { type: "text", required: true, maxLength: "80", name: "number", placeholder: "Enter a unique batch number" });
  const dateInput = el("input", { type: "date", required: true, name: "date", value: today });
  const recorderInput = el("input", { type: "text", required: true, maxLength: "80", name: "recorder", autocomplete: "name" });
  const notesInput = el("textarea", { rows: "2", maxLength: "1000", name: "notes" });
  const applicabilityHelp = el("small", { className: "qc-ops-hint" });
  const standardsAction = button("Open standards", () => { closeDialog(); ctx.navigate("standards"); }, "button-secondary");
  const showStandardsAction = (visible) => {
    standardsAction.hidden = !visible;
    standardsAction.style.display = visible ? "" : "none";
  };
  showStandardsAction(false);
  const formError = el("p", { className: "qc-ops-form-error", role: "alert" });
  const submit = el("button", { type: "submit", className: "button button-primary", disabled: true }, "Create batch");
  const cancel = button("Cancel", () => closeDialog(), "button button-secondary");
  const currentOrderLines = () => lines.filter((entry) => entry.order.id === orderSelect.value);
  const findLine = (lineId) => currentOrderLines().find((entry) => entry.line.id === lineId);
  const selectedVersion = (entry) => list(state.versions).find((version) => version.id === entry.versionSelect.value);
  const readyPairs = (entry) => {
    const line = findLine(entry.lineSelect.value);
    const version = selectedVersion(entry);
    if (!line || !version) return [];
    return applicablePairs(version, line.variant.model).filter((pair) => getBatchVersionReadiness(version, pair.factory, pair.stage, line.variant.model).ready);
  };
  const refreshProductOptions = () => {
    const used = new Set(productEntries.map((entry) => entry.lineSelect.value).filter(Boolean));
    for (const entry of productEntries) {
      const selected = entry.lineSelect.value;
      const available = currentOrderLines().filter((line) => line.line.id === selected || !used.has(line.line.id));
      setOptions(entry.lineSelect, available.map((line) => ({ value: line.line.id, label: lineOptionLabel(line, currentOrderLines()) })), selected || available[0]?.line.id || "");
    }
    addProduct.disabled = currentOrderLines().every((line) => productEntries.some((entry) => entry.lineSelect.value === line.line.id));
    for (const entry of productEntries) entry.remove.disabled = productEntries.length <= 1;
  };
  const refreshEntryVersion = (entry, preferredVersionId = "") => {
    const line = findLine(entry.lineSelect.value);
    const versions = getBatchVersions(state, line?.variant?.familyId);
    const previous = preferredVersionId || entry.versionSelect.value;
    setOptions(entry.versionSelect, versions.map((version) => ({ value: version.id, label: version.label })), versions.some((version) => version.id === previous) ? previous : versions[0]?.id || "");
  };
  const refreshApplicability = () => {
    const commonPairs = productEntries.map(readyPairs).reduce((shared, pairs, index) => {
      const keys = new Set(pairs.map((pair) => `${pair.factory}::${pair.stage}`));
      return index === 0 ? pairs : shared.filter((pair) => keys.has(`${pair.factory}::${pair.stage}`));
    }, []);
    const factories = Array.from(new Set(commonPairs.map((pair) => pair.factory))).sort();
    const priorFactory = factorySelect.value;
    setOptions(factorySelect, factories.map((factory) => ({ value: factory, label: factory })), factories.includes(priorFactory) ? priorFactory : factories[0] || "");
    const stages = commonPairs.filter((pair) => pair.factory === factorySelect.value).map((pair) => pair.stage);
    const priorStage = stageSelect.value;
    setOptions(stageSelect, stages.map((stage) => ({ value: stage, label: stage })), stages.includes(priorStage) ? priorStage : stages[0] || "");
    const everyProductHasVersion = productEntries.every((entry) => Boolean(entry.lineSelect.value && entry.versionSelect.value));
    const hasCommonBasis = commonPairs.some((pair) => pair.factory === factorySelect.value && pair.stage === stageSelect.value);
    applicabilityHelp.textContent = hasCommonBasis ? "" : "No shared factory and stage has ready standards for every selected product.";
    applicabilityHelp.hidden = hasCommonBasis;
    showStandardsAction(!hasCommonBasis || !everyProductHasVersion);
    updateSubmitState(hasCommonBasis && everyProductHasVersion);
  };
  const updateSubmitState = (hasCommonBasis = false) => {
    const lineIds = productEntries.map((entry) => entry.lineSelect.value);
    const duplicateLines = lineIds.some((id, index) => id && lineIds.indexOf(id) !== index);
    const duplicateNumber = Boolean(numberInput.value.trim()) && list(state.batches).some((batch) => String(batch.number || "").trim().toLocaleLowerCase() === numberInput.value.trim().toLocaleLowerCase());
    const quantities = productEntries.map((entry) => Number(entry.quantityInput.value));
    const quantitiesReady = quantities.every((value) => Number.isSafeInteger(value) && value > 0) && Number.isSafeInteger(quantities.reduce((sum, value) => sum + value, 0));
    const productsReady = productEntries.length > 0 && !duplicateLines && productEntries.every((entry) => entry.lineSelect.value && entry.versionSelect.value);
    const ordinaryFieldsReady = Boolean(orderSelect.value && numberInput.value.trim() && dateInput.value && recorderInput.value.trim());
    submit.disabled = !(hasCommonBasis && productsReady && quantitiesReady && ordinaryFieldsReady && !duplicateNumber);
    formError.textContent = duplicateLines ? "Select each purchase order line only once." : duplicateNumber ? "This batch number is already in use." : "";
  };
  const refreshAll = () => {
    refreshProductOptions();
    for (const entry of productEntries) refreshEntryVersion(entry);
    refreshApplicability();
  };
  function addProductEntry(lineId = "") {
    const lineSelect = el("select", { required: true, name: "lineId" });
    const quantityInput = el("input", { type: "number", required: true, min: "1", step: "1", name: "productQuantity", inputMode: "numeric" });
    const versionSelect = el("select", { required: true, name: "versionId" });
    const remove = button("Remove", () => {
      if (productEntries.length <= 1) return;
      const index = productEntries.indexOf(entry);
      if (index >= 0) productEntries.splice(index, 1);
      card.remove();
      refreshAll();
    }, "button button-secondary qc-ops-small-button");
    const entry = { lineSelect, quantityInput, versionSelect, remove };
    const card = el("div", { className: "qc-ops-product-entry" },
      el("div", { className: "qc-ops-product-entry-fields" },
        field("Product from this PO", lineSelect),
        field("Product quantity", quantityInput),
        field("Design version", versionSelect),
      ),
      remove,
    );
    productEntries.push(entry);
    productsHost.append(card);
    refreshProductOptions();
    if (lineId && Array.from(lineSelect.options).some((option) => option.value === lineId)) lineSelect.value = lineId;
    refreshEntryVersion(entry);
    lineSelect.addEventListener("change", () => { entry.versionSelect.value = ""; refreshEntryVersion(entry); refreshProductOptions(); refreshApplicability(); });
    versionSelect.addEventListener("change", refreshApplicability);
    quantityInput.addEventListener("input", () => updateSubmitState(Boolean(factorySelect.value && stageSelect.value)));
    refreshApplicability();
  }
  const resetProductsForOrder = () => {
    productEntries.splice(0);
    productsHost.replaceChildren();
    const first = currentOrderLines()[0];
    if (first) addProductEntry(first.line.id);
    else refreshApplicability();
  };
  orderSelect.addEventListener("change", resetProductsForOrder);
  factorySelect.addEventListener("change", refreshApplicability);
  stageSelect.addEventListener("change", refreshApplicability);
  for (const input of [numberInput, dateInput, recorderInput]) input.addEventListener("input", () => updateSubmitState(Boolean(factorySelect.value && stageSelect.value)));
  numberInput.addEventListener("change", () => updateSubmitState(Boolean(factorySelect.value && stageSelect.value)));
  const form = el("form", { className: "qc-ops-form qc-ops-new-batch-form" },
    field("Purchase order 采购订单", orderSelect),
    el("div", { className: "qc-ops-product-entry-heading" }, el("strong", {}, "Products and quantities"), addProduct),
    productsHost,
    applicabilityHelp, standardsAction,
    el("div", { className: "qc-ops-form-grid" }, field("Factory 工厂", factorySelect), field("Inspection stage 检验阶段", stageSelect)),
    field("Batch number 批次编号", numberInput),
    el("div", { className: "qc-ops-form-grid" }, field("Batch date 批次日期", dateInput), field("Recorded by 记录人员", recorderInput)),
    field("Special notes 本批次特殊情况", notesInput),
    formError,
    el("div", { className: "qc-ops-dialog-actions" }, cancel, submit)
  );
  resetProductsForOrder();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    formError.textContent = "";
    if (!form.reportValidity()) return;
    const selectedProducts = productEntries.map((entry) => ({
      lineId: entry.lineSelect.value,
      quantity: Number(entry.quantityInput.value),
      versionId: entry.versionSelect.value,
    }));
    if (!orderSelect.value || !factorySelect.value || !stageSelect.value || !selectedProducts.length || selectedProducts.some((product) => !product.lineId || !product.versionId || !Number.isSafeInteger(product.quantity) || product.quantity <= 0) || !Number.isSafeInteger(selectedProducts.reduce((sum, product) => sum + product.quantity, 0))) {
      formError.textContent = "Choose a PO, a product quantity and version for each product, and a shared factory/stage.";
      return;
    }
    if (new Set(selectedProducts.map((product) => product.lineId)).size !== selectedProducts.length) {
      formError.textContent = "Select each purchase order line only once.";
      return;
    }
    if (list(state.batches).some((batch) => String(batch.number || "").trim().toLocaleLowerCase() === numberInput.value.trim().toLocaleLowerCase())) {
      formError.textContent = "This batch number is already in use.";
      return;
    }
    const commonKeys = productEntries.map(readyPairs).reduce((shared, pairs, index) => {
      const keys = new Set(pairs.map((pair) => `${pair.factory}::${pair.stage}`));
      return index === 0 ? pairs.map((pair) => `${pair.factory}::${pair.stage}`) : shared.filter((key) => keys.has(key));
    }, []);
    if (!commonKeys.includes(`${factorySelect.value}::${stageSelect.value}`)) {
      formError.textContent = "Choose a factory and stage with ready standards for every selected product.";
      return;
    }
    const result = await runCommand(ctx, "createBatch", {
      number: numberInput.value.trim(),
      orderId: orderSelect.value,
      products: selectedProducts,
      factory: factorySelect.value,
      stage: stageSelect.value,
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
  showDialog("New inspection batch", form);
}

function renderBatchList(root, ctx) {
  const state = ctx.state || {};
  const batches = list(state.batches).slice().sort((left, right) => String(right.date || right.createdAt || "").localeCompare(String(left.date || left.createdAt || "")));
  const displayNumbers = resolveBatchDisplayNumbers(state);
  const orders = list(state.orders);
  const variants = variantsById(state);
  const createButton = button("New batch", () => openNewBatchDialog(state, ctx), "button button-primary");
  const orderLines = orderedLines(state);
  const createableLines = orderLines.filter((entry) => hasReadyVersionForModel(state, entry.variant.familyId, entry.variant.model));
  const actions = [createButton, historicalBatchImportControl(ctx)];
  const toolbar = el("div", { className: "qc-ops-list-toolbar" });
  const search = el("input", { type: "search", placeholder: "Search batch, product, PO, source file, or version", "aria-label": "Search batches" });
  const familyById = new Map(list(state.families).map((family) => [family.id, family]));
  const plural = { Family: "families", Factory: "factories", Stage: "stages" };
  const filterSelect = (label, entries) => el("select", { "aria-label": `Filter batches by ${label.toLocaleLowerCase()}` },
    el("option", { value: "all" }, `All ${plural[label] || `${label.toLocaleLowerCase()}s`}`),
    entries.map(({ value, label: entryLabel }) => el("option", { value }, entryLabel ?? value)),
  );
  const families = [...new Set(batches.flatMap((batch) => isHistoricalBatch(batch)
    ? [batch.familyId || variants.get(batch.variantId)?.familyId]
    : batchProducts(batch, state).map((product) => product.familyId || variants.get(product.variantId)?.familyId)).filter(Boolean))].sort();
  const factories = [...new Set(batches.map((batch) => batch.factory).filter((value) => value !== null && value !== undefined && value !== ""))].map(String).sort();
  const stages = [...new Set(batches.map((batch) => batch.stage).filter((value) => value !== null && value !== undefined && value !== ""))].map(String).sort();
  const family = filterSelect("Family", families.map((value) => ({ value, label: familyById.get(value)?.name || value })));
  const factory = filterSelect("Factory", factories.map((value) => ({ value })));
  const stage = filterSelect("Stage", stages.map((value) => ({ value })));
  toolbar.append(field("Search", search), field("Family", family), field("Factory", factory), field("Stage", stage));
  const table = el("table", { className: "qc-ops-list-table qc-ops-batch-list-table" },
    el("thead", {}, el("tr", {}, ...["Batch", "Attachments", "Product / model", "Purchase order", "Factory / stage", "Total quantity", "Date", ""].map((label) => el("th", { scope: "col" }, label)))),
    el("tbody")
  );
  const tbody = table.querySelector("tbody");
  for (const batch of batches) {
    const displayNumber = displayNumbers.get(batch.id) ?? batch.number;
    const variant = variants.get(batch.variantId);
    const order = orders.find((item) => item.id === batch.orderId);
    const products = isHistoricalBatch(batch) ? [] : batchProducts(batch, state);
    const batchFamilies = isHistoricalBatch(batch)
      ? [batch.familyId || variant?.familyId].filter(Boolean)
      : products.map((product) => product.familyId || variants.get(product.variantId)?.familyId).filter(Boolean);
    const batchProductSummary = isHistoricalBatch(batch)
      ? batchProductLabel(batch, state)
      : products.length
        ? products.map((product) => `${productLabel(product, state)} · ${quantity(product.quantity)} units`).join("\n")
        : text(variant?.label, batch.variantId);
    const attachments = batchAttachments(batch, state);
    const searchText = [displayNumber, ...batchFamilies, ...batchFamilies.map((familyId) => familyById.get(familyId)?.name), batch.productLabel, batch.model, batch.color, variant?.label,
      ...products.flatMap((product) => [productLabel(product, state), product.quantity, product.versionLabel]),
      order?.number, batch.factory, batch.stage, batch.versionLabel, ...attachments.map((asset) => asset.name)]
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
      "data-family": batchFamilies.join(" "),
      "data-factory": batch.factory || "",
      "data-stage": batch.stage || "",
      "data-search": searchText,
    },
      el("td", {}, text(displayNumber)),
      attachmentCell,
      el("td", { className: "qc-ops-list-products" }, ...String(batchProductSummary).split("\n").map((item) => el("span", {}, item))),
      el("td", {}, text(order?.number)),
      el("td", {}, [batch.factory, batch.stage].filter((value) => value !== null && value !== undefined && value !== "").join(" · ") || "—"),
      el("td", { className: "qc-ops-number" }, isHistoricalBatch(batch) ? sourceValue(batch.quantity) : quantity(totalProductQuantity(batch, state))),
      el("td", {}, dateLabel(batch.date)),
      el("td", {}, button("Open", () => ctx.navigate("batches", batch.id), "button button-secondary qc-ops-small-button")),
    );
    tbody.append(tr);
  }
  const updateFilters = () => {
    const query = search.value.trim().toLowerCase();
    for (const row of tbody.rows) {
      const familyMatches = family.value === "all" || row.dataset.family.split(" ").includes(family.value);
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
      button("Open purchase orders", () => ctx.navigate("orders"), "button button-primary")
    ));
  } else if (!batches.length && orders.length && !orderLines.length) {
    sections.push(el("section", { className: "card qc-ops-empty-card" },
      el("h2", {}, "Add a purchase order line"),
      button("Open purchase orders", () => ctx.navigate("orders"), "button button-primary")
    ));
  } else if (!batches.length && orderLines.length && !createableLines.length) {
    sections.push(el("section", { className: "card qc-ops-empty-card" },
      el("h2", {}, "Review design versions"),
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
      el("p", {}, `${rowDrafts.size} inspection row(s) and ${batchDetailDrafts.size} batch detail set(s) need saving.`),
      ...Array.from(pendingBatchIds).map((batchId) => {
        const batch = batches.find((item) => item.id === batchId);
        return batch ? button(`Resume ${text(batch.number)}`, () => ctx.navigate("batches", batchId, true), "button button-secondary qc-ops-small-button") : null;
      })
    ));
  }
  if (batches.length) {
    sections.push(el("section", { className: "card qc-ops-list-card" }, toolbar, el("div", { className: "qc-ops-table-scroll" }, table)));
  } else if (orders.length && orderLines.length && createableLines.length) {
    sections.push(el("section", { className: "card qc-ops-empty-card" },
      el("h2", {}, "No batches yet"),
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
