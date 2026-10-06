import {
  button,
  computedSourceQuantity,
  dateLabel,
  el,
  errorText,
  field,
  list,
  notify,
  pageHeading,
  quantity,
  safeProcedureUrl,
  setOptions,
  sourcePercent,
  statusPill,
  text
} from "./qc-ops-common.js";
import { closeDialog, showDialog } from "./qc-ui.js";
import { attachmentCanPreview, downloadAttachment, MEBIBYTE, previewAttachment, readAttachmentFile } from "./qc-attachments.js";
import { openNewIssueDialog } from "./qc-ops-issues.js";
import { resolveBatchDisplayNumber, resolveBatchDisplayNumbers } from "../core/qc-batch-display.js";
import { getBatchVersionItems, getBatchVersions, getBatchVersionReadiness, getSharedBatchVersionChoices } from "../core/qc-batch-versions.js";
import { getBatchProducts, getBatchRowProduct } from "../core/qc-batch-products.js";
import { createManualSaveController } from "./qc-manual-save.js";
import { batchReleaseBlockers } from "../core/qc-inspections.js";

const rowDrafts = new Map();
const batchDetailDrafts = new Map();

function navigateWithDraftWarning(ctx, route, id) {
  void ctx.navigate(route, id);
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

function clearDraftsForBatch(batchId) {
  const prefix = `${batchId}::`;
  for (const key of rowDrafts.keys()) {
    if (key.startsWith(prefix)) rowDrafts.delete(key);
  }
  batchDetailDrafts.delete(detailDraftKey(batchId));
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

function stateForRow(row, batchId) {
  const key = rowKey(batchId, row.id);
  return rowDrafts.get(key) || {
    defectiveQty: row.defectiveQty === null || row.defectiveQty === undefined ? "" : String(row.defectiveQty),
    actualTimeSeconds: row.actualTimeSeconds === null || row.actualTimeSeconds === undefined ? "" : String(row.actualTimeSeconds),
    remarks: String(row.remarks || "")
  };
}

function nullableNumberFromInput(input) {
  if (input.validity.badInput) return { value: null, invalid: true };
  if (input.value === "") return { value: null, invalid: false };
  const value = Number(input.value);
  return { value, invalid: !Number.isFinite(value) };
}

function normalizedRemarks(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sameInspectionValues(row, values) {
  if (!row || (row.defectiveQty ?? null) !== values.defectiveQty || normalizedRemarks(row.remarks) !== normalizedRemarks(values.remarks)) return false;
  if (values.actualTimeSeconds === undefined) return !Object.hasOwn(row, "actualTimeSeconds");
  return (row.actualTimeSeconds ?? null) === values.actualTimeSeconds;
}

function savedDetailsFrom(batch) {
  return { date: batch.date || "", recorder: batch.recorder || "", notes: batch.notes || "" };
}

function validIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function getRowPhotos(row, workspace, state) {
  if (Array.isArray(row.photos) && row.photos.length) return row.photos;
  const assets = new Map(list(state.assets).map((asset) => [asset.id, asset]));
  return list(row.photoIds).map((id) => assets.get(id)).filter(Boolean);
}

function getRowIssues(row, workspace) {
  if (Array.isArray(row.issues)) return row.issues;
  return list(workspace.issues).filter((issue) => issue.rowId === row.id || issue.sourceSnapshot?.rowId === row.id);
}

const ROW_ATTACHMENT_CATEGORIES = [
  ["videos", "Videos"],
  ["procedures", "Procedures"],
  ["log", "Log"],
];

function getRowAttachments(row, state) {
  if (row.attachments && typeof row.attachments === "object") return row.attachments;
  const assets = new Map(list(state.assets).map((asset) => [asset.id, asset]));
  const ids = row.attachmentIds && typeof row.attachmentIds === "object" ? row.attachmentIds : {};
  return Object.fromEntries(ROW_ATTACHMENT_CATEGORIES.map(([category]) => [category, assets.get(ids[category]) || null]));
}

function rateLabel(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value.includes("%") || value === "—" ? value : `${value}%`;
  const rate = Number(value);
  if (!Number.isFinite(rate)) return "—";
  return `${rate.toFixed(2)}%`;
}

function currentRate(row, draft) {
  if (draft.defectiveQty === "") return "—";
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

function makePhotoDialog(photo, row, ctx) {
  void previewAttachment(photo, ctx.service, `${text(row.title)} · ${text(photo.name, "Photo")}`);
}

function operationalTaskTitle(row, workspace, state) {
  const title = text(row.title, "");
  const product = rowProduct(row, workspace.batch, state, workspace);
  const family = list(state.families).find((entry) => entry.id === (product.familyId || product.variant?.familyId));
  const models = list(family?.models);
  if (!models.length || !workspace.batch.factory || !workspace.batch.stage) return title;
  const base = `${models.join("/")}·${workspace.batch.factory}·${workspace.batch.stage}`;
  const version = String(row.versionLabel || product.version?.label || product.versionLabel || "").trim();
  const suffixes = [version ? `[${base}·${version}]` : null, `[${base}]`].filter(Boolean);
  const suffix = suffixes.find((candidate) => title.endsWith(candidate));
  return suffix ? title.slice(0, -suffix.length).trimEnd() : title;
}

function operationalDetailFact(label, value) {
  return el("div", {}, el("dt", {}, label), el("dd", {}, value));
}

function legacyEvidenceDisclosure(row, workspace, state, ctx) {
  const remarks = String(row.remarks || "");
  const photos = getRowPhotos(row, workspace, state);
  const photoCount = photos.length || list(row.photoIds).length;
  if (!remarks.trim() && !photoCount) return null;
  const summaryParts = ["Source evidence"];
  if (photoCount) summaryParts.push(`${photoCount} photo${photoCount === 1 ? "" : "s"}`);
  if (remarks.trim()) summaryParts.push("remarks");
  const photoList = photos.length
    ? el("ul", { className: "qc-ops-legacy-photo-list" }, ...photos.map((photo) => {
      const name = text(photo?.name, "Inspection photo");
      const actions = [];
      if (attachmentCanPreview(photo)) {
        actions.push(button("Preview", () => makePhotoDialog(photo, row, ctx), "button-quiet qc-ops-small-button"));
      }
      if (photo?.dataUrl || photo?.id) {
        actions.push(button("Download", () => {
          void downloadAttachment(photo, ctx.service, name).catch((error) => notify(errorText(error, "The photo could not be downloaded."), true));
        }, "button-quiet qc-ops-small-button"));
      }
      return el("li", {}, el("span", { title: name }, name), ...actions);
    }))
    : photoCount ? el("span", { className: "qc-ops-empty-photo" }, `${photoCount} photo${photoCount === 1 ? "" : "s"} unavailable`) : null;
  return el("details", { className: "qc-ops-legacy-evidence" },
    el("summary", {}, summaryParts.join(" · ")),
    remarks.trim() ? el("p", { className: "qc-ops-legacy-remarks" }, remarks) : null,
    photoList,
  );
}

function renderRowAttachmentCell(row, workspace, state, ctx, readOnly) {
  const attachments = getRowAttachments(row, state);
  const cell = el("td", { className: "qc-ops-row-attachments" });
  for (const [category, label] of ROW_ATTACHMENT_CATEGORIES) {
    const asset = attachments?.[category] || null;
    const input = el("input", {
      type: "file",
      accept: category === "videos" ? ".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm" : undefined,
      className: "qc-ops-hidden-file",
      "aria-label": `${label} for ${text(row.title)}`,
      disabled: readOnly,
    });
    const choose = button(asset ? "Replace" : "Add", () => input.click(), "button-secondary qc-ops-small-button");
    choose.disabled = readOnly;
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const payload = await readAttachmentFile(file, { maxBytes: 10 * MEBIBYTE, category: category === "videos" ? "video" : null });
        const response = await ctx.run("setRowAttachment", {
          batchId: workspace.batch.id,
          rowId: row.id,
          category,
          file: payload,
        });
        if (response.ok) input.value = "";
      } catch (error) {
        notify(errorText(error, `Could not read the selected ${label.toLowerCase()} file.`), true);
      }
    });
    const slot = el("div", { className: "qc-ops-row-attachment-slot" },
      el("strong", {}, label),
      asset ? el("span", { className: "qc-ops-row-attachment-name", title: text(asset.name) }, text(asset.name, "Attachment")) : null,
      asset && attachmentCanPreview(asset)
        ? button("Preview", () => { void previewAttachment(asset, ctx.service, `${text(row.title)} · ${label}`); }, "button-quiet qc-ops-small-button")
        : null,
      asset && (asset.dataUrl || asset.id) ? button("Download", () => {
        void downloadAttachment(asset, ctx.service).catch((error) => notify(errorText(error, "The file could not be downloaded."), true));
      }, "button-quiet qc-ops-small-button") : null,
      choose,
      asset ? button("Remove", () => {
        if (!window.confirm(`Remove “${text(asset.name, "this attachment")}” from this inspection row?`)) return;
        void ctx.run("removeRowAttachment", { batchId: workspace.batch.id, rowId: row.id, category });
      }, "button-quiet qc-ops-attachment-remove") : null,
      input,
    );
    const remove = slot.querySelector(".qc-ops-attachment-remove");
    if (remove) remove.disabled = readOnly;
    cell.append(slot);
  }
  return cell;
}

function renderInspectionRow(row, index, workspace, state, ctx, manualSaveController, onDraftChange = null, displayNumbers = null) {
  const readOnly = workspace.batch.status === "released";
  const draft = stateForRow(row, workspace.batch.id);
  const key = rowKey(workspace.batch.id, row.id);
  const fullTitle = text(row.title);
  const important = row.displayImportant ?? row.important;
  const tr = el("tr", { className: important === true ? "qc-ops-important-row" : "" });
  tr.append(el("td", { className: "qc-ops-no" }, text(row.no, String(index + 1))));
  const task = el("th", { scope: "row", className: "qc-ops-task" });
  task.setAttribute("aria-label", fullTitle);
  setBilingual(task, operationalTaskTitle(row, workspace, state), row.titleZh);
  if (important === true) task.append(el("span", { className: "qc-ops-important-badge" }, "Important"));
  const details = el("details", { className: "qc-ops-row-details", open: true }, el("summary", {}, "Details"));
  const specificationValue = el("span", {}, text(row.specification, "—"), row.specificationZh ? el("small", { lang: "zh" }, row.specificationZh) : null);
  const methodValue = el("span", {}, text(row.devices, "—"), row.devicesZh ? el("small", { lang: "zh" }, row.devicesZh) : null);
  details.append(el("dl", { className: "qc-ops-operational-details" },
    operationalDetailFact("Specification", specificationValue),
    operationalDetailFact("Equipment / method", methodValue),
    operationalDetailFact("Sampling", sourcePercent(row.samplingPercent)),
    operationalDetailFact("Recording", text(row.recordingRule, "—")),
  ));
  task.append(details);
  const inspectedInput = el("input", {
    className: "qc-ops-inspected-input",
    type: "number",
    min: "0",
    step: "1",
    value: String(row.inspectedQty ?? ""),
    readOnly: true,
    "aria-label": `Calculated inspection quantity for ${text(row.title)}`
  });
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
  const actualTimeInput = el("input", {
    className: "qc-ops-actual-time-input",
    type: "number",
    min: "0",
    step: "any",
    inputMode: "decimal",
    value: draft.actualTimeSeconds,
    disabled: readOnly,
    "aria-label": `Actual time in seconds for ${text(row.title)}`
  });
  const legacyTimeOmitted = !Object.hasOwn(row, "actualTimeSeconds");
  let actualTimeTouched = legacyTimeOmitted && rowDrafts.get(key)?.actualTimeSeconds !== undefined;
  const rowFormId = `qc-row-form-${workspace.batch.id}-${row.id}`.replace(/[^A-Za-z0-9_-]/g, "-");
  defectiveInput.setAttribute("form", rowFormId);
  actualTimeInput.setAttribute("form", rowFormId);
  const liveRate = el("strong", { className: "qc-ops-live-rate" }, currentRate(row, draft));
  const history = list(row.history);
  const historyValue = history.length
    ? el("ul", { className: "qc-ops-result-history-list" }, ...history.slice(0, 4).map((entry, historyIndex) => el("li", {},
      el("strong", {}, `Prior ${historyIndex + 1}: ${rateLabel(entry.rate ?? entry.defectiveRate)}`),
      el("small", {}, text(displayNumbers?.get(entry.batchId) ?? resolveBatchDisplayNumber(state, entry.batchId, entry.batchNumber || entry.number || entry.batchId))),
      el("small", {}, dateLabel(entry.date)),
    )))
    : el("span", { className: "qc-ops-empty-history" }, "—");
  const results = el("td", { className: "qc-ops-results" },
    el("div", { className: "qc-ops-results-grid" },
      el("label", { className: "qc-ops-result-field" }, el("span", {}, "Inspection qty"), inspectedInput),
      el("label", { className: "qc-ops-result-field" }, el("span", {}, "Defective qty"), defectiveInput),
      el("div", { className: "qc-ops-result-field qc-ops-rate-field" }, el("span", {}, "Rate"), liveRate),
      el("label", { className: "qc-ops-result-field" }, el("span", {}, "Time (seconds)"), actualTimeInput),
      el("div", { className: "qc-ops-result-history" }, el("span", {}, "History"), historyValue),
    )
  );
  const linkedIssues = getRowIssues(row, workspace);
  const createIssueButton = makeAction("Create issue", async () => {
    const latestState = ctx.state || state;
    openNewIssueDialog(latestState, ctx, {
      batchId: workspace.batch.id,
      rowId: row.id,
      stayOnBatch: true,
    });
  }, "button button-secondary qc-ops-small-button");
  createIssueButton.disabled = readOnly;
  const rowForm = el("form", { id: rowFormId, className: "qc-ops-row-form", "data-autosave-form": "true" });
  let rowState = el("span", { hidden: true });
  rowForm.addEventListener("submit", (event) => event.preventDefault());
  const issueControls = linkedIssues.map((issue) => makeAction(
    `Open ${text(issue.number, "issue")} · ${text(issue.status)}`,
    () => navigateWithDraftWarning(ctx, "issues", issue.id, workspace.batch.id),
    "button button-quiet qc-ops-row-issue-link"
  ));
  rowForm.append(
    el("div", { className: "qc-ops-row-issues" }, ...issueControls),
    el("div", { className: "qc-ops-row-actions" }, createIssueButton, rowState),
  );
  const legacyEvidence = legacyEvidenceDisclosure(row, workspace, state, ctx);
  if (legacyEvidence) rowForm.append(legacyEvidence);

  const readRowValue = () => {
    const defective = nullableNumberFromInput(defectiveInput);
    const actualTime = nullableNumberFromInput(actualTimeInput);
    return {
      defectiveQty: defective.value,
      actualTimeSeconds: legacyTimeOmitted && !actualTimeTouched ? undefined : actualTime.value,
      remarks: row.remarks ?? "",
      invalidDefectiveQty: defective.invalid,
      invalidActualTimeSeconds: actualTime.invalid,
    };
  };
  const valueForPersistence = (value) => ({
    defectiveQty: value.defectiveQty,
    ...(value.actualTimeSeconds === undefined ? {} : { actualTimeSeconds: value.actualTimeSeconds }),
    remarks: value.remarks,
  });
  const updateRowStatus = (status = null) => {
    const visibleStatus = status === "Saving…" || status === "Save failed" ? status : "";
    rowState.textContent = visibleStatus;
    rowState.hidden = !visibleStatus;
    rowState.className = visibleStatus === "Saving…" ? "qc-ops-save-pending"
      : visibleStatus === "Save failed" ? "qc-ops-save-failed" : "";
  };
  const rowInputState = {
    defectiveInput,
    actualTimeInput,
    actualTimeTouched: () => actualTimeTouched,
    read: readRowValue,
    createIssueButton,
    updateStatus: updateRowStatus,
    reset(savedRow) {
      defectiveInput.value = savedRow?.defectiveQty === null || savedRow?.defectiveQty === undefined ? "" : String(savedRow.defectiveQty);
      actualTimeInput.value = savedRow?.actualTimeSeconds === null || savedRow?.actualTimeSeconds === undefined ? "" : String(savedRow.actualTimeSeconds);
      actualTimeTouched = false;
      liveRate.textContent = currentRate(savedRow || row, {
        defectiveQty: defectiveInput.value,
        actualTimeSeconds: actualTimeInput.value,
        remarks: savedRow?.remarks ?? "",
      });
      createIssueButton.disabled = readOnly;
    },
  };
  onDraftChange?.(row.id, rowState, createIssueButton, rowInputState);
  const markRowDraft = () => {
    const value = readRowValue();
    const nextDraft = {
      defectiveQty: defectiveInput.value,
      actualTimeSeconds: legacyTimeOmitted && !actualTimeTouched ? undefined : actualTimeInput.value,
      remarks: row.remarks ?? "",
      invalidDefectiveQty: value.invalidDefectiveQty,
      invalidActualTimeSeconds: value.invalidActualTimeSeconds,
    };
    if (!value.invalidDefectiveQty && !value.invalidActualTimeSeconds && sameInspectionValues(row, valueForPersistence(value))) {
      rowDrafts.delete(key);
    } else {
      rowDrafts.set(key, nextDraft);
    }
    liveRate.textContent = currentRate(row, rowDrafts.get(key) || nextDraft);
    updateRowStatus();
    createIssueButton.disabled = readOnly;
    manualSaveController?.noteChanges();
    onDraftChange?.();
  };
  actualTimeInput.addEventListener("input", () => { actualTimeTouched = true; });
  actualTimeInput.addEventListener("change", () => { actualTimeTouched = true; });
  for (const input of [defectiveInput, actualTimeInput]) {
    input.addEventListener("input", markRowDraft);
    input.addEventListener("change", markRowDraft);
  }
  tr.append(task, results, el("td", { className: "qc-ops-remarks" }, rowForm), renderRowAttachmentCell(row, workspace, state, ctx, readOnly));
  return tr;
}

function renderHistoricalInspectionRow(row, index, workspace, state, ctx) {
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

  const computed = computedSourceQuantity(batch, row);
  const inspectionQuantity = el("td", { className: "qc-ops-number" }, sourceValue(row.sourceInspectedQty));
  if (computed !== null) inspectionQuantity.append(el("small", { className: "qc-ops-historical-comparison" }, `Web formula: ${quantity(computed)}`));
  const defective = row.defectiveQty === null || row.defectiveQty === undefined || row.defectiveQty === "" ? "—" : String(row.defectiveQty);
  tr.append(
    inspectionQuantity,
    el("td", { className: "qc-ops-number" }, defective),
    el("td", { className: "qc-ops-number qc-ops-rate" }, sourcePercent(row.sourceDefectiveRate)),
  );
  for (let historyIndex = 0; historyIndex < 4; historyIndex += 1) {
    tr.append(el("td", { className: "qc-ops-history" }, el("span", { className: "qc-ops-empty-history" }, "—")));
  }

  const procedure = el("td", { className: "qc-ops-link" });
  const procedureUrl = safeProcedureUrl(row.procedureUrl);
  procedure.append(procedureUrl ? el("a", { href: procedureUrl, target: "_blank", rel: "noopener noreferrer" }, "Open procedure") : sourceValue(row.procedureUrl));
  const remarks = el("td", { className: "qc-ops-remarks" }, legacyEvidenceDisclosure(row, workspace, state, ctx));
  if (list(row.anomalies).length) {
    remarks.append(el("details", { className: "qc-ops-historical-raw" },
      el("summary", {}, "Source review notes"),
      el("ul", {}, list(row.anomalies).map((anomaly) => el("li", {}, typeof anomaly === "string" ? anomaly : JSON.stringify(anomaly)))),
    ));
  }
  const attachments = getRowAttachments(row, state);
  const attachmentSlots = ROW_ATTACHMENT_CATEGORIES.flatMap(([category, label]) => {
    const asset = attachments?.[category];
    if (!asset) return [];
    const slot = el("div", { className: "qc-ops-row-attachment-slot" },
      el("strong", {}, label),
      el("span", { className: "qc-ops-row-attachment-name", title: text(asset.name) }, text(asset.name, "Attachment")),
      attachmentCanPreview(asset)
        ? button("Preview", () => { void previewAttachment(asset, ctx.service, `${text(row.title)} · ${label}`); }, "button-quiet qc-ops-small-button")
        : null,
      asset && (asset.dataUrl || asset.id) ? button("Download", () => {
        void downloadAttachment(asset, ctx.service).catch((error) => notify(errorText(error, "The file could not be downloaded."), true));
      }, "button-quiet qc-ops-small-button") : null,
    );
    return [slot];
  });
  const attachmentCell = el("td", { className: "qc-ops-row-attachments qc-ops-row-attachments-readonly" }, ...attachmentSlots);
  tr.append(
    el("td", { className: "qc-ops-number" }, row.timeSeconds === null || row.timeSeconds === undefined ? "—" : `${row.timeSeconds}s`),
    procedure,
    remarks,
    attachmentCell,
  );
  return tr;
}

function renderRows(workspace, state, ctx, onDraftChange, displayNumbers) {
  const body = el("tbody", { className: "qc-ops-table-body" });
  list(workspace.rows).forEach((row, index) => body.append(isHistoricalBatch(workspace.batch)
    ? renderHistoricalInspectionRow(row, index, workspace, state, ctx)
    : renderInspectionRow(row, index, workspace, state, ctx, null, onDraftChange, displayNumbers)));
  return body;
}

function makeInspectionTable(workspace, state, ctx, onDraftChange) {
  const displayNumbers = resolveBatchDisplayNumbers(state);
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
      el("th", { rowSpan: "2", scope: "col" }, "Attachments", el("br"), el("span", { lang: "zh" }, "附件"))
    ),
    el("tr", { className: "qc-ops-sub-head" },
      el("th", { scope: "col" }, "Inspection qty", el("br"), el("span", { lang: "zh" }, "检验数量")),
      el("th", { scope: "col" }, "Defective qty", el("br"), el("span", { lang: "zh" }, "不良数")),
      el("th", { scope: "col" }, "Defective rate", el("br"), el("span", { lang: "zh" }, "不良率")),
      ...[1, 2, 3, 4].map((index) => el("th", { scope: "col" }, `Prior ${index}`, el("br"), el("span", { lang: "zh" }, `历史 ${index}`)))
    )
  );
  table.append(colgroup, thead, renderRows(workspace, state, ctx, onDraftChange, displayNumbers));
  return el("div", { className: "qc-ops-table-scroll", tabindex: "0", "aria-label": "Batch inspection table; scroll horizontally to see all columns" }, table);
}

function renderOperationalRows(workspace, state, ctx, manualSaveController, onDraftChange) {
  const body = el("tbody", { className: "qc-ops-operational-body" });
  const displayNumbers = resolveBatchDisplayNumbers(state);
  const products = batchProducts(workspace.batch, state, workspace);
  const multipleProducts = products.length > 1;
  let previousProductKey = null;
  let groupIndex = -1;
  list(workspace.rows).forEach((row, index) => {
    const product = rowProduct(row, workspace.batch, state, workspace);
    const productKey = product?.lineId || row.productLineId || product?.variantId || row.productLabel || "product";
    if (multipleProducts && productKey !== previousProductKey) {
      groupIndex += 1;
      const label = text(row.productLabel || productLabel(product, state), "Product");
      const productQuantity = row.productQuantity ?? product?.quantity;
      body.append(el("tr", { className: `qc-ops-product-group-row${groupIndex % 2 ? " qc-ops-product-group-row-alt" : ""}` },
        el("th", { colSpan: "5", scope: "rowgroup" },
          el("strong", {}, label),
          el("span", {}, `${quantity(productQuantity)} units`),
        )
      ));
    }
    previousProductKey = productKey;
    body.append(renderInspectionRow(row, index, workspace, state, ctx, manualSaveController, onDraftChange, displayNumbers));
  });
  return body;
}

function makeOperationalInspectionTable(workspace, state, ctx, manualSaveController, onDraftChange) {
  const table = el("table", { className: "qc-ops-inspection-table qc-ops-operational-table" });
  const colgroup = el("colgroup", {},
    el("col", { style: { width: "4.5%" } }),
    el("col", { style: { width: "35.5%" } }),
    el("col", { style: { width: "21%" } }),
    el("col", { style: { width: "21%" } }),
    el("col", { style: { width: "18%" } }),
  );
  const thead = el("thead", {}, el("tr", {},
    el("th", { scope: "col" }, "No.", el("span", { lang: "zh" }, "序号")),
    el("th", { scope: "col" }, "QC task / Details", el("span", { lang: "zh" }, "检验项目 / 规格")),
    el("th", { scope: "col" }, "Results", el("span", { lang: "zh" }, "检验结果")),
    el("th", { scope: "col" }, "Remarks", el("span", { lang: "zh" }, "备注")),
    el("th", { scope: "col" }, "Attachments", el("span", { lang: "zh" }, "附件")),
  ));
  table.append(colgroup, thead, renderOperationalRows(workspace, state, ctx, manualSaveController, onDraftChange));
  return el("div", { className: "qc-ops-table-scroll qc-ops-operational-scroll", tabindex: "0", "aria-label": "Batch inspection table; scroll horizontally to see all columns" }, table);
}

function renderReleaseBlockers(workspace, ctx, manualSaveController) {
  const blockerHost = el("div", { className: "qc-ops-release-blockers" });
  const release = button("Release full batch", async () => {
    const releaseSavedBatch = async () => {
      const result = await ctx.run("releaseBatch", { id: workspace.batch.id });
      if (result.ok) notify("The full batch was released.");
    };
    if (manualSaveController?.hasPending()) {
      await ctx.resolveManualChanges?.("release this batch", releaseSavedBatch);
      return;
    }
    await releaseSavedBatch();
  }, "button button-danger");
  const refresh = () => {
    const alreadyReleased = workspace.batch.status === "released";
    const blockers = alreadyReleased ? [] : list(workspace.releaseBlockers).map((message) => String(message));
    const blockerList = blockers.length
      ? el("ul", { className: "qc-ops-blocker-list" }, ...blockers.map((message) => el("li", {}, message)))
      : null;
    if (alreadyReleased) blockerHost.replaceChildren(statusPill("released"));
    else blockerHost.replaceChildren(...(blockerList ? [blockerList] : []));
    release.disabled = alreadyReleased || blockers.length > 0 && !manualSaveController?.hasPending();
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

function attachmentActions(asset, batch, ctx) {
  const actions = [];
  if (attachmentCanPreview(asset)) {
    actions.push(button("Open", () => { void previewAttachment(asset, ctx.service); }, "button-quiet qc-ops-small-button"));
  }
  if (asset.dataUrl || (asset.id && typeof ctx.service?.getAsset === "function")) {
    actions.push(button("Download", () => {
      void downloadAttachment(asset, ctx.service).catch((error) => notify(errorText(error, "The attachment could not be downloaded."), true));
    }, "button-quiet qc-ops-small-button"));
  } else {
    actions.push(el("span", { className: "qc-ops-hint" }, "File unavailable"));
  }
  const locked = batch.status === "released" || asset.sourcePdf === true;
  if (!asset.sourcePdf) {
    const remove = button("Remove", () => {
      if (!window.confirm(`Remove “${text(asset.name, "this attachment")}” from this batch? The file remains in the file library.`)) return;
      void ctx.run("removeBatchAttachment", { batchId: batch.id, assetId: asset.id });
    }, "button-danger qc-ops-small-button");
    remove.disabled = locked;
    if (batch.status === "released") remove.title = "Released batch attachments are read-only.";
    actions.push(remove);
  }
  return el("div", { className: "qc-ops-attachment-actions" }, actions);
}

function renderBatchAttachments(workspace, state, ctx, { compact = false } = {}) {
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
        const payload = await readAttachmentFile(file, { maxBytes: 10 * MEBIBYTE });
        const response = await ctx.run("addBatchAttachment", {
          batchId: batch.id,
          ...payload,
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
    : compact ? [] : [el("li", { className: "qc-ops-attachment-empty" }, "No attachments")];
  const section = el("section", { className: "card qc-ops-attachments-card" },
    el("div", { className: "qc-ops-section-heading" },
      compact ? null : el("h2", {}, "Attachments"),
      add,
    ),
    el("ul", { className: "qc-ops-attachment-list" }, items),
    fileInput,
  );
  if (!compact) return section;
  return el("details", { className: "qc-ops-attachments-disclosure" },
    el("summary", {}, `Attachments · ${attachmentList.length}`),
    section,
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
    const savedDetails = savedDetailsFrom(batch);
    const draftDetails = batchDetailDrafts.get(detailKey) || savedDetails;
    const order = workspace.order || orderById(state).get(batch.orderId);
    const products = batchProducts(batch, state, workspace);
    const detailForm = el("form", { className: "qc-ops-batch-meta qc-ops-detail-form" });
    const dateInput = el("input", { type: "date", value: draftDetails.date, disabled: isReleased, name: "date", "aria-label": "Batch date 批次日期" });
    const recorderInput = el("input", { type: "text", maxLength: "80", value: draftDetails.recorder, disabled: isReleased, name: "recorder", autocomplete: "name", "aria-label": "Recorded by 记录人员" });
    const notesInput = el("textarea", { rows: "2", maxLength: "1000", disabled: isReleased, name: "notes", "aria-label": "Special notes 本批次特殊情况" }, draftDetails.notes);
    const dateSummary = el("span", {}, `Date: ${dateLabel(savedDetails.date)}`);
    const recorderSummary = el("span", {}, `Recorded by: ${text(savedDetails.recorder)}`);
    const notesSummary = el("span", { className: "qc-ops-detail-note-summary", title: savedDetails.notes }, `Notes: ${text(savedDetails.notes, "—")}`);
    const detailStatus = el("span", { hidden: true });
    const detailSummary = el("summary", { className: "qc-ops-batch-details-summary" },
      el("strong", {}, "Batch details"), dateSummary, recorderSummary, notesSummary, detailStatus);
    const readDetailValue = () => ({
      date: dateInput.value,
      recorder: recorderInput.value,
      notes: notesInput.value,
      invalidDate: dateInput.validity.badInput,
    });
    let releasePanel = null;
    const saveError = el("p", { className: "qc-ops-form-error qc-ops-save-error", role: "alert" });
  const rowStatusElements = new Map();
  const rowInputStates = new Map();
  const onRowDraftChange = (rowId = null, status = null, createIssueButton = null, inputState = null) => {
    if (rowId && status) {
      rowStatusElements.set(rowId, { status, createIssueButton });
      rowInputStates.set(rowId, inputState);
      return;
    }
    releasePanel?.refresh();
  };
    const rowsDraftedForBatch = () => [...rowDrafts.entries()]
      .filter(([key]) => key.startsWith(`${batch.id}::`));
    const detailsDiffer = (value) => value.date !== (savedDetails.date || "") ||
      value.recorder !== (savedDetails.recorder || "") || value.notes !== (savedDetails.notes || "");
    const hasChanges = () => rowsDraftedForBatch().length > 0 || Boolean(
      batchDetailDrafts.has(detailKey) && detailsDiffer(batchDetailDrafts.get(detailKey))
    );
    const readSnapshot = () => ({
      details: batchDetailDrafts.has(detailKey) ? readDetailValue() : null,
      rows: rowsDraftedForBatch().map(([key, draft]) => {
        const rowId = key.slice(`${batch.id}::`.length);
        const row = list(workspace.rows).find((candidate) => candidate.id === rowId);
        const defectiveQty = draft.defectiveQty === "" ? null : Number(draft.defectiveQty);
        const actualTimeSeconds = draft.actualTimeSeconds === undefined
          ? undefined
          : draft.actualTimeSeconds === "" ? null : Number(draft.actualTimeSeconds);
        return {
          rowId,
          defectiveQty,
          ...(actualTimeSeconds === undefined ? {} : { actualTimeSeconds }),
          remarks: String(draft.remarks ?? row?.remarks ?? ""),
          input: structuredClone(draft),
          invalidDefectiveQty: draft.invalidDefectiveQty === true,
          invalidActualTimeSeconds: draft.invalidActualTimeSeconds === true,
          inspectedQty: row?.inspectedQty,
        };
      }),
    });
    const readCommandData = (snapshot) => ({
      batchId: batch.id,
      ...(snapshot.details ? { details: {
        date: snapshot.details.date,
        recorder: snapshot.details.recorder,
        notes: snapshot.details.notes,
      } } : {}),
      rows: snapshot.rows.map(({ input, invalidDefectiveQty, invalidActualTimeSeconds, inspectedQty, ...row }) => row),
    });
    const manualSaveController = createManualSaveController({
      hasChanges,
      readSnapshot,
      saveOnExit: true,
      validate: (snapshot) => {
        if (snapshot.details && (snapshot.details.invalidDate || !validIsoDate(snapshot.details.date) ||
          snapshot.details.recorder.length > 80 || snapshot.details.notes.length > 1000 || !snapshot.details.recorder.trim())) {
          return "Enter a valid batch date and recorded-by name before saving batch details.";
        }
        for (const row of snapshot.rows) {
          if (row.invalidDefectiveQty || row.invalidActualTimeSeconds ||
            row.defectiveQty !== null && (!Number.isInteger(row.defectiveQty) || row.defectiveQty < 0 || row.defectiveQty > Number(row.inspectedQty)) ||
            row.actualTimeSeconds !== undefined && row.actualTimeSeconds !== null && (!Number.isFinite(row.actualTimeSeconds) || row.actualTimeSeconds < 0)) {
            return "Check defective quantity and time values before saving.";
          }
        }
        return true;
      },
      save: (snapshot) => ctx.run("saveBatchChanges", readCommandData(snapshot), { manualSave: true, render: false, silent: true }),
      onError: (error) => {
        saveError.textContent = `This page remains open because the changes could not be saved: ${errorText(error, "Check the highlighted changes and try again.")}`;
      },
      onSaved: (snapshot, response) => {
        saveError.textContent = "";
        const savedBatch = list(response.state?.batches).find((candidate) => candidate.id === batch.id) ||
          list(response.result?.changes?.batches).find((candidate) => candidate.id === batch.id);
        if (!savedBatch) throw new Error("The saved batch changes could not be confirmed.");
        Object.assign(batch, savedBatch);
        Object.assign(workspace.batch, savedBatch);
        for (const savedRow of list(savedBatch.rows)) {
          const currentRow = list(workspace.rows).find((candidate) => candidate.id === savedRow.id);
          if (currentRow) Object.assign(currentRow, savedRow);
          const rowInputState = rowInputStates.get(savedRow.id);
          if (rowInputState) {
            const currentValue = rowInputState.read();
            const persistenceValue = {
              defectiveQty: currentValue.defectiveQty,
              ...(currentValue.actualTimeSeconds === undefined ? {} : { actualTimeSeconds: currentValue.actualTimeSeconds }),
              remarks: currentValue.remarks,
            };
            const key = rowKey(batch.id, savedRow.id);
            if (currentValue.invalidDefectiveQty || currentValue.invalidActualTimeSeconds || !sameInspectionValues(savedRow, persistenceValue)) {
              rowDrafts.set(key, {
                defectiveQty: rowInputState.defectiveInput.value,
                actualTimeSeconds: rowInputState.actualTimeTouched() ? rowInputState.actualTimeInput.value : undefined,
                remarks: String(currentValue.remarks || ""),
                invalidDefectiveQty: currentValue.invalidDefectiveQty,
                invalidActualTimeSeconds: currentValue.invalidActualTimeSeconds,
              });
            } else {
              rowDrafts.delete(key);
            }
            rowInputState.updateStatus();
            rowInputState.createIssueButton.disabled = isReleased;
          }
        }
        if (snapshot.details) {
          Object.assign(savedDetails, savedDetailsFrom(savedBatch));
          batch.date = savedDetails.date;
          batch.recorder = savedDetails.recorder;
          batch.notes = savedDetails.notes;
          const currentDetails = readDetailValue();
          if (detailsDiffer(currentDetails)) {
            batchDetailDrafts.set(detailKey, { date: currentDetails.date, recorder: currentDetails.recorder, notes: currentDetails.notes });
          } else {
            batchDetailDrafts.delete(detailKey);
          }
          dateSummary.textContent = `Date: ${dateLabel(savedDetails.date)}`;
          recorderSummary.textContent = `Recorded by: ${text(savedDetails.recorder)}`;
          notesSummary.textContent = `Notes: ${text(savedDetails.notes, "—")}`;
          notesSummary.title = savedDetails.notes;
        }
        const currentState = response.state || ctx.state || state;
        workspace.releaseBlockers = batchReleaseBlockers(currentState, savedBatch);
        releasePanel?.refresh();
      },
      onDiscard: () => {
        clearDraftsForBatch(batch.id);
        dateInput.value = savedDetails.date;
        recorderInput.value = savedDetails.recorder;
        notesInput.value = savedDetails.notes;
        for (const [rowId, rowInputState] of rowInputStates) {
          const savedRow = list(workspace.rows).find((candidate) => candidate.id === rowId);
          rowInputState.reset(savedRow);
          rowInputState.updateStatus();
        }
        saveError.textContent = "";
      },
      onStatus: (status) => {
        const visibleStatus = status === "Saving…" || status === "Save failed" ? status : "";
        detailStatus.textContent = visibleStatus;
        detailStatus.hidden = !visibleStatus;
        detailStatus.className = visibleStatus === "Saving…" ? "qc-ops-save-pending"
          : visibleStatus === "Save failed" ? "qc-ops-save-failed" : "";
        for (const [rowId, elements] of rowStatusElements) {
          const key = rowKey(batch.id, rowId);
          if (!rowDrafts.has(key)) continue;
          elements.status.textContent = visibleStatus;
          elements.status.hidden = !visibleStatus;
          elements.status.className = visibleStatus === "Saving…" ? "qc-ops-save-pending"
            : visibleStatus === "Save failed" ? "qc-ops-save-failed" : "";
        }
        releasePanel?.refresh();
      },
    });
    ctx.registerManualSaveController?.(manualSaveController);
    const updateDetailDraft = () => {
      const current = readDetailValue();
      if (detailsDiffer(current)) batchDetailDrafts.set(detailKey, { date: current.date, recorder: current.recorder, notes: current.notes });
      else batchDetailDrafts.delete(detailKey);
      manualSaveController.noteChanges();
      releasePanel?.refresh();
    };
    for (const input of [dateInput, recorderInput, notesInput]) {
      input.addEventListener("input", updateDetailDraft);
      input.addEventListener("change", updateDetailDraft);
    }
    detailForm.addEventListener("submit", (event) => event.preventDefault());
    detailForm.append(
      field("Batch date 批次日期", dateInput),
      field("Recorded by 记录人员", recorderInput),
      field("Special notes 本批次特殊情况", notesInput),
      saveError,
    );
    const saveState = el("div", { className: "qc-ops-manual-save-actions" }, detailStatus, saveError);
    releasePanel = renderReleaseBlockers(workspace, ctx, manualSaveController);
    const sharedVersionAtBatchLevel = typeof batch.versionLabel === "string" && batch.versionLabel.trim() !== "" &&
      products.every((product) => product.versionLabel === batch.versionLabel);
    const deleteBatchButton = button("Delete", async () => {
      if (!window.confirm(`Delete batch ${text(workspace.displayNumber ?? resolveBatchDisplayNumber(state, batch.id, batch.number), "Batch")}? This action cannot be undone.`)) return;
      const deleteSavedBatch = async () => {
        const response = await ctx.run("deleteBatch", { id: batch.id });
        if (!response.ok) return;
        clearDraftsForBatch(batch.id);
        ctx.navigate("batches", null, true);
      };
      if (manualSaveController.hasPending()) await ctx.resolveManualChanges?.("delete this batch", deleteSavedBatch);
      else await deleteSavedBatch();
    }, "button button-danger");
    deleteBatchButton.disabled = batch.status !== "draft";
    const headerActions = [
      button("All batches", () => navigateWithDraftWarning(ctx, "batches", undefined, batch.id), "button button-secondary"),
      button("View report", () => navigateWithDraftWarning(ctx, "batch-report", batch.id, batch.id), "button button-secondary"),
      saveState,
      deleteBatchButton,
      statusPill(batch.status)
    ];
    const versionFacts = products.map((product) => ({
      product: productLabel(product, state),
      version: text(product.version?.label || product.versionLabel),
    }));
    const versionLabels = Array.from(new Set(versionFacts.map((entry) => entry.version)));
    const versionSummary = sharedVersionAtBatchLevel
      ? text(batch.versionLabel)
      : versionLabels.length === 1
        ? versionLabels[0]
        : versionFacts.map((entry) => `${entry.product} ${entry.version}`).join(" · ");
    const productFact = products.length === 1
      ? el("span", {}, el("strong", {}, "Product"), text(productLabel(products[0], state)))
      : products.length === 0 && batch.variantId
        ? el("span", {}, el("strong", {}, "Product"), productLabel({ variantId: batch.variantId }, state))
        : null;
    const metadata = el("section", { className: "card qc-ops-batch-meta-card qc-ops-operational-summary-card" },
      el("div", { className: "qc-ops-batch-facts qc-ops-summary-facts" },
        el("span", {}, el("strong", {}, "PO"), text(order?.number, batch.orderId)),
        el("span", {}, el("strong", {}, "Version"), text(versionSummary)),
        el("span", {}, el("strong", {}, "Factory"), text(batch.factory)),
        el("span", {}, el("strong", {}, "Stage"), text(batch.stage)),
        productFact,
        el("span", {}, el("strong", {}, "Total"), `${quantity(totalProductQuantity(batch, state, workspace))} units`),
      ),
      el("details", { className: "qc-ops-batch-details" }, detailSummary, detailForm),
    );
    const intro = el("section", { className: "card qc-ops-inspection-card" },
      el("div", { className: "qc-ops-section-heading" }, el("h2", {}, "Batch inspection")),
      makeOperationalInspectionTable(workspace, state, ctx, manualSaveController, onRowDraftChange)
    );
    root.replaceChildren(
      pageHeading(text(workspace.displayNumber ?? resolveBatchDisplayNumber(state, batch.id, batch.number), "Batch"), "", headerActions),
      metadata,
      intro,
      renderBatchAttachments({ ...workspace, attachments: Array.isArray(workspace.attachments) ? workspace.attachments : batchAttachments(batch, state) }, state, ctx, { compact: true }),
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
  const versionSelect = el("select", { required: true, name: "versionLabel" });
  const productsHost = el("div", { className: "qc-ops-product-entries" });
  const addProduct = button("Add product", () => addProductEntry(), "button button-secondary");
  const productEntries = [];
  const factorySelect = el("select", { required: true, name: "factory" });
  const stageSelect = el("select", { required: true, name: "stage" });
  const dateInput = el("input", { type: "date", required: true, name: "date", value: today });
  const recorderInput = el("input", { type: "text", required: true, maxLength: "80", name: "recorder", autocomplete: "name" });
  const notesInput = el("textarea", { rows: "2", maxLength: "1000", name: "notes" });
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
  const selectedModel = () => {
    const firstEntry = productEntries[0];
    const firstLine = firstEntry ? findLine(firstEntry.lineSelect.value) : null;
    return firstLine ? String(firstLine.variant.model ?? "").trim() : null;
  };
  const readyPairs = (entry) => {
    const line = findLine(entry.lineSelect.value);
    if (!line) return [];
    const pairs = getBatchVersions(state, line.variant.familyId).flatMap((version) =>
      applicablePairs(version, line.variant.model).filter((pair) => getBatchVersionReadiness(version, pair.factory, pair.stage, line.variant.model).ready));
    return Array.from(new Map(pairs.map((pair) => [`${pair.factory}::${pair.stage}`, pair])).values());
  };
  const refreshProductOptions = () => {
    const model = selectedModel();
    if (model !== null) {
      for (const entry of productEntries.slice(1)) {
        const selectedLine = findLine(entry.lineSelect.value);
        if (selectedLine && String(selectedLine.variant.model ?? "").trim() !== model) entry.lineSelect.value = "";
      }
    }
    for (const [index, entry] of productEntries.entries()) {
      const selected = entry.lineSelect.value;
      const usedByOthers = new Set(productEntries.filter((candidate) => candidate !== entry).map((candidate) => candidate.lineSelect.value).filter(Boolean));
      const available = currentOrderLines().filter((line) => {
        const matchesModel = index === 0 || model === null || String(line.variant.model ?? "").trim() === model;
        return matchesModel && (line.line.id === selected || !usedByOthers.has(line.line.id));
      });
      const selectedStillAvailable = available.some((line) => line.line.id === selected);
      setOptions(entry.lineSelect, [
        { value: "", label: "Select product" },
        ...available.map((line) => ({ value: line.line.id, label: lineOptionLabel(line, currentOrderLines()) }))
      ], selectedStillAvailable ? selected : "");
    }
    const eligibleLines = currentOrderLines().filter((line) => model === null || String(line.variant.model ?? "").trim() === model);
    addProduct.disabled = !eligibleLines.some((line) => !productEntries.some((entry) => entry.lineSelect.value === line.line.id));
    for (const entry of productEntries) entry.remove.disabled = productEntries.length <= 1;
  };
  let commonReadyPairs = [];
  let sharedVersionChoices = [];
  const selectedVariantIds = () => productEntries.map((entry) => findLine(entry.lineSelect.value)?.variant?.id).filter(Boolean);
  const sharedChoicesFor = (factory, stage) => getSharedBatchVersionChoices(state, selectedVariantIds(), factory, stage);
  const refreshApplicability = () => {
    const firstPairs = productEntries.length ? readyPairs(productEntries[0]) : [];
    commonReadyPairs = firstPairs.filter((pair) => productEntries.every((entry) =>
      readyPairs(entry).some((candidate) => candidate.factory === pair.factory && candidate.stage === pair.stage)) &&
      sharedChoicesFor(pair.factory, pair.stage).length > 0);
    const factories = Array.from(new Set(commonReadyPairs.map((pair) => pair.factory))).sort();
    const priorFactory = factorySelect.value;
    setOptions(factorySelect, factories.map((factory) => ({ value: factory, label: factory })), factories.includes(priorFactory) ? priorFactory : factories[0] || "");
    const stages = commonReadyPairs.filter((pair) => pair.factory === factorySelect.value).map((pair) => pair.stage);
    const priorStage = stageSelect.value;
    setOptions(stageSelect, stages.map((stage) => ({ value: stage, label: stage })), stages.includes(priorStage) ? priorStage : stages[0] || "");
    const hasCommonBasis = commonReadyPairs.some((pair) => pair.factory === factorySelect.value && pair.stage === stageSelect.value);
    sharedVersionChoices = hasCommonBasis ? sharedChoicesFor(factorySelect.value, stageSelect.value) : [];
    const previousLabel = versionSelect.value;
    setOptions(versionSelect, sharedVersionChoices.map((choice) => ({ value: choice.label, label: choice.label })),
      sharedVersionChoices.some((choice) => choice.label === previousLabel) ? previousLabel : sharedVersionChoices[0]?.label || "");
    versionSelect.disabled = sharedVersionChoices.length === 0;
    showStandardsAction(!hasCommonBasis || sharedVersionChoices.length === 0);
    updateSubmitState();
  };
  const updateSubmitState = () => {
    const lineIds = productEntries.map((entry) => entry.lineSelect.value);
    const duplicateLines = lineIds.some((id, index) => id && lineIds.indexOf(id) !== index);
    const selectedModels = productEntries.map((entry) => findLine(entry.lineSelect.value)).filter(Boolean)
      .map((line) => String(line.variant.model ?? "").trim());
    const mixedModels = new Set(selectedModels).size > 1;
    const quantities = productEntries.map((entry) => Number(entry.quantityInput.value));
    const quantitiesReady = quantities.every((value) => Number.isSafeInteger(value) && value > 0) && Number.isSafeInteger(quantities.reduce((sum, value) => sum + value, 0));
    const productsReady = productEntries.length > 0 && !duplicateLines && productEntries.every((entry) => entry.lineSelect.value);
    const selectedVersionIsReady = sharedVersionChoices.some((choice) => choice.label === versionSelect.value);
    const ordinaryFieldsReady = Boolean(orderSelect.value && dateInput.value && recorderInput.value.trim());
    const hasCommonBasis = commonReadyPairs.some((pair) => pair.factory === factorySelect.value && pair.stage === stageSelect.value);
    submit.disabled = !(hasCommonBasis && selectedVersionIsReady && productsReady && !mixedModels && quantitiesReady && ordinaryFieldsReady);
    formError.textContent = mixedModels ? "Choose products from the same model."
      : duplicateLines ? "Select each purchase order line only once."
      : productEntries.length && productsReady && !selectedVersionIsReady ? "No shared design version is available for these products."
        : "";
  };
  const refreshAll = () => {
    refreshProductOptions();
    refreshApplicability();
  };
  function addProductEntry(lineId = "") {
    const lineSelect = el("select", { required: true, name: "lineId" });
    const quantityInput = el("input", { type: "number", required: true, min: "1", step: "1", name: "productQuantity", inputMode: "numeric" });
    const remove = button("Remove", () => {
      if (productEntries.length <= 1) return;
      const index = productEntries.indexOf(entry);
      if (index >= 0) productEntries.splice(index, 1);
      card.remove();
      refreshAll();
    }, "button button-secondary qc-ops-small-button");
    const entry = { lineSelect, quantityInput, remove };
    const card = el("div", { className: "qc-ops-product-entry" },
      el("div", { className: "qc-ops-product-entry-fields" },
        field("Product from this PO", lineSelect),
        field("Product quantity", quantityInput),
      ),
      remove,
    );
    productEntries.push(entry);
    productsHost.append(card);
    refreshProductOptions();
    if (lineId && Array.from(lineSelect.options).some((option) => option.value === lineId)) lineSelect.value = lineId;
    lineSelect.addEventListener("change", () => { refreshProductOptions(); refreshApplicability(); });
    quantityInput.addEventListener("input", updateSubmitState);
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
  versionSelect.addEventListener("change", updateSubmitState);
  for (const input of [dateInput, recorderInput]) input.addEventListener("input", updateSubmitState);
  const form = el("form", { className: "qc-ops-form qc-ops-new-batch-form" },
    el("div", { className: "qc-ops-form-grid" }, field("Purchase order 采购订单", orderSelect), field("Design version 设计版本", versionSelect)),
    el("div", { className: "qc-ops-product-entry-heading" }, el("strong", {}, "Products and quantities"), addProduct),
    productsHost,
    standardsAction,
    el("div", { className: "qc-ops-form-grid" }, field("Factory 工厂", factorySelect), field("Inspection stage 检验阶段", stageSelect)),
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
    }));
    if (!orderSelect.value || !factorySelect.value || !stageSelect.value || !selectedProducts.length || !versionSelect.value || selectedProducts.some((product) => !product.lineId || !Number.isSafeInteger(product.quantity) || product.quantity <= 0) || !Number.isSafeInteger(selectedProducts.reduce((sum, product) => sum + product.quantity, 0))) {
      formError.textContent = selectedProducts.length && !versionSelect.value
        ? "No shared design version is available for these products."
        : "Choose a PO, product quantities, a design version, and a shared factory/stage.";
      return;
    }
    if (new Set(selectedProducts.map((product) => product.lineId)).size !== selectedProducts.length) {
      formError.textContent = "Select each purchase order line only once.";
      return;
    }
    const productModels = selectedProducts.map((product) => {
      const line = findLine(product.lineId);
      return String(line?.variant.model ?? "").trim();
    });
    if (new Set(productModels).size > 1) {
      formError.textContent = "Choose products from the same model.";
      return;
    }
    const selectedSharedChoice = sharedChoicesFor(factorySelect.value, stageSelect.value)
      .find((choice) => choice.label === versionSelect.value);
    if (!selectedSharedChoice) {
      formError.textContent = "No shared design version is available for these products.";
      return;
    }
    const result = await ctx.run("createBatch", {
      orderId: orderSelect.value,
      products: selectedProducts,
      versionLabel: versionSelect.value,
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
  const actions = [createButton];
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
    el("thead", {}, el("tr", {}, ...["Batch", "Purchase order", "Total quantity", "Date"].map((label) => el("th", { scope: "col" }, label)))),
    el("tbody")
  );
  const tbody = table.querySelector("tbody");
  const isInteractiveTarget = (target) => target instanceof Element && Boolean(target.closest(
    "button, a, input, select, textarea, summary, label, form, [contenteditable='true'], [role='button'], [role='link']"
  ));
  for (const batch of batches) {
    const displayNumber = displayNumbers.get(batch.id) ?? batch.number;
    const variant = variants.get(batch.variantId);
    const order = orders.find((item) => item.id === batch.orderId);
    const products = isHistoricalBatch(batch) ? [] : batchProducts(batch, state);
    const batchFamilies = isHistoricalBatch(batch)
      ? [batch.familyId || variant?.familyId].filter(Boolean)
      : products.map((product) => product.familyId || variants.get(product.variantId)?.familyId).filter(Boolean);
    const attachments = batchAttachments(batch, state);
    const searchText = [displayNumber, ...batchFamilies, ...batchFamilies.map((familyId) => familyById.get(familyId)?.name), batch.productLabel, batch.model, batch.color, variant?.label,
      ...products.flatMap((product) => [productLabel(product, state), product.quantity, product.versionLabel]),
      order?.number, batch.factory, batch.stage, batch.versionLabel, ...attachments.map((asset) => asset.name)]
      .filter((value) => value !== null && value !== undefined).join(" ").toLocaleLowerCase();
    const tr = el("tr", {
      className: "qc-ops-batch-row",
      tabIndex: 0,
      ariaLabel: `Open batch ${displayNumber}`,
      "data-family": batchFamilies.join(" "),
      "data-factory": batch.factory || "",
      "data-stage": batch.stage || "",
      "data-search": searchText,
    },
      el("td", {}, text(displayNumber)),
      el("td", {}, text(order?.number)),
      el("td", { className: "qc-ops-number" }, isHistoricalBatch(batch) ? sourceValue(batch.quantity) : quantity(totalProductQuantity(batch, state))),
      el("td", {}, dateLabel(batch.date)),
    );
    tr.addEventListener("click", (event) => {
      if (isInteractiveTarget(event.target)) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && (tr.contains(selection.anchorNode) || tr.contains(selection.focusNode))) return;
      ctx.navigate("batches", batch.id);
    });
    tr.addEventListener("keydown", (event) => {
      if ((event.key !== "Enter" && event.key !== " ") || isInteractiveTarget(event.target)) return;
      event.preventDefault();
      ctx.navigate("batches", batch.id);
    });
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
        return batch ? button(`Resume ${text(displayNumbers.get(batch.id) ?? batch.number)}`, () => ctx.navigate("batches", batchId, true), "button button-secondary qc-ops-small-button") : null;
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
  root.replaceChildren(pageHeading("Batches", "", actions), ...sections);
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
