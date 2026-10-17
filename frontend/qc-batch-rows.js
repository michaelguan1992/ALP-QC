// Inspection rows for the operational and historical batch pages: the inspection table, the result
// inputs with their live rate, the draft state of each row, and the controls that link or create
// Issues. settleRowDraftAfterSave reconciles a row's draft after an acknowledged save.

import { button, dateLabel, el, list, quantity, sourcePercent, text } from "./qc-ops-common.js";
import { applySaveStatus, deleteRowDraft, getRowDraft, setRowDraft } from "./qc-batch-drafts.js";
import { openNewIssueDialog } from "./qc-ops-issues.js";
import { resolveBatchDisplayNumber, resolveBatchDisplayNumbers } from "../core/qc-batch-display.js";
import { findHistoricalSourceRow } from "../core/qc-historical-batches.js";
import {
  batchProducts, currentRate, inspectionControlName, isHistoricalBatch, navigateWithDraftWarning,
  nullableNumberFromInput, operationalTaskTitle, productLabel, rateLabel, rowProduct, sameInspectionValues, sourceValue,
} from "./qc-batch-model.js";
import { legacyEvidenceDisclosure, renderRowAttachmentCell } from "./qc-batch-attachments.js";

/** The row draft that the current inputs represent, in the same shape the drafts store. */
function draftFromInputs(rowInputState, { historical }) {
  const value = rowInputState.read();
  return {
    ...(historical ? { inspectedQty: rowInputState.inspectedInput.value } : {}),
    defectiveQty: rowInputState.defectiveInput.value,
    actualTimeSeconds: rowInputState.timeUntouched() ? undefined : rowInputState.actualTimeInput.value,
    remarks: String(value.remarks ?? ""),
    invalidInspectedQty: value.invalidInspectedQty,
    invalidDefectiveQty: value.invalidDefectiveQty,
    invalidActualTimeSeconds: value.invalidActualTimeSeconds,
  };
}

/** True when the visible inputs of a row hold exactly the persisted values. */
function inputsMatchSavedRow(rowInputState, savedRow, { historical }) {
  const value = rowInputState.read();
  if (value.invalidInspectedQty || value.invalidDefectiveQty || value.invalidActualTimeSeconds) return false;
  if (historical && (value.inspectedQty ?? null) !== (savedRow.inspectedQty ?? null)) return false;
  if ((value.defectiveQty ?? null) !== (savedRow.defectiveQty ?? null)) return false;
  if (!rowInputState.timeUntouched() && (value.actualTimeSeconds ?? null) !== (savedRow.actualTimeSeconds ?? null)) return false;
  return true;
}

/**
 * After an acknowledged save, a row draft that matches the saved row is cleared. Anything the inputs
 * still show differently is kept as a draft, so typed values are never lost.
 */
export function settleRowDraftAfterSave(batchId, rowId, rowInputState, persistedRow, { historical }) {
  if (inputsMatchSavedRow(rowInputState, persistedRow, { historical })) deleteRowDraft(batchId, rowId);
  else setRowDraft(batchId, rowId, draftFromInputs(rowInputState, { historical }));
  rowInputState.updateStatus();
}

function stateForRow(row, batchId) {
  return getRowDraft(batchId, row.id) || {
    inspectedQty: row.inspectedQty === null || row.inspectedQty === undefined ? "" : String(row.inspectedQty),
    defectiveQty: row.defectiveQty === null || row.defectiveQty === undefined ? "" : String(row.defectiveQty),
    actualTimeSeconds: row.actualTimeSeconds === null || row.actualTimeSeconds === undefined ? "" : String(row.actualTimeSeconds),
    remarks: String(row.remarks || "")
  };
}

function getRowIssues(row, workspace) {
  if (Array.isArray(row.issues)) return row.issues;
  return list(workspace.issues).filter((issue) => issue.rowId === row.id || issue.sourceSnapshot?.rowId === row.id);
}

function setBilingual(container, english, chinese, englishClass = "qc-ops-en", chineseClass = "qc-ops-zh") {
  container.replaceChildren(el("span", { className: englishClass }, text(english)));
  if (chinese) container.append(el("span", { className: chineseClass, lang: "zh" }, chinese));
}

function makeAction(label, handler, className = "button button-secondary") {
  return button(label, handler, className);
}

function operationalDetailFact(label, value) {
  return el("div", {}, el("dt", {}, label), el("dd", {}, value));
}

function renderInspectionRow(row, index, workspace, state, ctx, manualSaveController, onDraftChange = null, displayNumbers = null) {
  const historical = isHistoricalBatch(workspace.batch);
  const readOnly = workspace.batch.status === "released";
  const draft = stateForRow(row, workspace.batch.id);
  const fullTitle = text(row.title);
  const important = row.displayImportant ?? row.important;
  const tr = el("tr", { className: important === true ? "qc-ops-important-row" : "" });
  tr.append(el("td", { className: "qc-ops-no" }, text(row.no, String(index + 1))));
  const task = el("th", { scope: "row", className: "qc-ops-task" });
  task.setAttribute("aria-label", fullTitle);
  setBilingual(task, operationalTaskTitle(row, workspace, state), row.titleZh);
  if (historical && row.status === "missing-from-source") {
    task.append(el("span", { className: "qc-ops-historical-badge" }, "Missing from source"));
    if (row.missingEvidence) task.append(el("small", { className: "qc-ops-historical-evidence" }, row.missingEvidence));
  }
  const details = el("details", { className: "qc-ops-row-details", open: true }, el("summary", {}, "Details"));
  const specificationValue = el("span", {}, text(row.specification, "—"), row.specificationZh ? el("small", { lang: "zh" }, row.specificationZh) : null);
  const methodValue = el("span", {}, text(row.devices, "—"), row.devicesZh ? el("small", { lang: "zh" }, row.devicesZh) : null);
  details.append(el("dl", { className: "qc-ops-operational-details" },
    operationalDetailFact("Specification", specificationValue),
    operationalDetailFact("Equipment / method", methodValue),
    operationalDetailFact("Sampling", sourcePercent(row.samplingPercent)),
    operationalDetailFact("Recording", text(row.recordingRule, "—")),
  ));
  if (historical) {
    const sourceRow = findHistoricalSourceRow(state, workspace.batch, row);
    const sourceFacts = el("dl", { className: "qc-ops-operational-details qc-ops-historical-source-results" },
      operationalDetailFact("Printed inspection qty", sourceValue(sourceRow?.sourceInspectedQty)),
      operationalDetailFact("Printed defective qty", sourceValue(sourceRow?.defectiveQty)),
      operationalDetailFact("Printed defective rate", sourcePercent(sourceRow?.sourceDefectiveRate)),
      operationalDetailFact("Printed time (seconds)", sourceValue(sourceRow?.timeSeconds)),
    );
    const sourceDetails = el("details", { className: "qc-ops-historical-raw" },
      el("summary", {}, "Imported source values"),
      sourceFacts,
      row.anomalies?.length ? el("ul", {}, ...list(row.anomalies).map((anomaly) => el("li", {}, typeof anomaly === "string" ? anomaly : JSON.stringify(anomaly)))) : null,
      row.raw && Object.keys(row.raw).length ? el("details", {}, el("summary", {}, "Preserved source fields"), el("pre", {}, JSON.stringify(row.raw, null, 2))) : null,
    );
    details.append(sourceDetails);
  }
  task.append(details);
  const inspectedInput = el("input", {
    className: "qc-ops-inspected-input",
    type: "number",
    min: "0",
    step: "1",
    value: historical ? draft.inspectedQty : String(row.inspectedQty ?? ""),
    readOnly: !historical,
    disabled: readOnly,
    "aria-label": `${historical ? "Inspection quantity" : "Calculated inspection quantity"} for ${text(row.title)}`
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
  let actualTimeTouched = legacyTimeOmitted && getRowDraft(workspace.batch.id, row.id)?.actualTimeSeconds !== undefined;
  const rowFormId = `qc-row-form-${workspace.batch.id}-${row.id}`.replace(/[^A-Za-z0-9_-]/g, "-");
  defectiveInput.setAttribute("form", rowFormId);
  actualTimeInput.setAttribute("form", rowFormId);
  const liveRate = el("strong", { className: "qc-ops-live-rate" }, currentRate(row, draft, historical));
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
  createIssueButton.setAttribute("aria-label", inspectionControlName({ action: "Create issue" }, row));
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
    const inspected = historical ? nullableNumberFromInput(inspectedInput) : { value: row.inspectedQty, invalid: false };
    const defective = nullableNumberFromInput(defectiveInput);
    const actualTime = nullableNumberFromInput(actualTimeInput);
    return {
      inspectedQty: inspected.value,
      defectiveQty: defective.value,
      actualTimeSeconds: legacyTimeOmitted && !actualTimeTouched ? undefined : actualTime.value,
      remarks: row.remarks ?? "",
      invalidInspectedQty: inspected.invalid,
      invalidDefectiveQty: defective.invalid,
      invalidActualTimeSeconds: actualTime.invalid,
    };
  };
  const valueForPersistence = (value) => historical ? {
    inspectedQty: value.inspectedQty,
    defectiveQty: value.defectiveQty,
    actualTimeSeconds: value.actualTimeSeconds ?? null,
  } : {
    defectiveQty: value.defectiveQty,
    ...(value.actualTimeSeconds === undefined ? {} : { actualTimeSeconds: value.actualTimeSeconds }),
    remarks: value.remarks,
  };
  const updateRowStatus = (status = null) => applySaveStatus(rowState, status);
  const rowInputState = {
    defectiveInput,
    inspectedInput,
    actualTimeInput,
    actualTimeTouched: () => actualTimeTouched,
    timeUntouched: () => legacyTimeOmitted && !actualTimeTouched,
    read: readRowValue,
    createIssueButton,
    updateStatus: updateRowStatus,
    reset(savedRow) {
      inspectedInput.value = savedRow?.inspectedQty === null || savedRow?.inspectedQty === undefined ? "" : String(savedRow.inspectedQty);
      defectiveInput.value = savedRow?.defectiveQty === null || savedRow?.defectiveQty === undefined ? "" : String(savedRow.defectiveQty);
      actualTimeInput.value = savedRow?.actualTimeSeconds === null || savedRow?.actualTimeSeconds === undefined ? "" : String(savedRow.actualTimeSeconds);
      actualTimeTouched = false;
      liveRate.textContent = currentRate(savedRow || row, {
        inspectedQty: inspectedInput.value,
        defectiveQty: defectiveInput.value,
        actualTimeSeconds: actualTimeInput.value,
        remarks: savedRow?.remarks ?? "",
      }, historical);
      createIssueButton.disabled = readOnly;
    },
  };
  onDraftChange?.(row.id, rowState, createIssueButton, rowInputState);
  const markRowDraft = () => {
    const value = readRowValue();
    const nextDraft = {
      ...(historical ? { inspectedQty: inspectedInput.value } : {}),
      defectiveQty: defectiveInput.value,
      actualTimeSeconds: legacyTimeOmitted && !actualTimeTouched ? undefined : actualTimeInput.value,
      remarks: row.remarks ?? "",
      invalidInspectedQty: value.invalidInspectedQty,
      invalidDefectiveQty: value.invalidDefectiveQty,
      invalidActualTimeSeconds: value.invalidActualTimeSeconds,
    };
    const isUnchanged = historical
      ? !value.invalidInspectedQty && !value.invalidDefectiveQty && !value.invalidActualTimeSeconds &&
        row.inspectedQty === valueForPersistence(value).inspectedQty && row.defectiveQty === valueForPersistence(value).defectiveQty &&
        (row.actualTimeSeconds ?? null) === valueForPersistence(value).actualTimeSeconds
      : !value.invalidDefectiveQty && !value.invalidActualTimeSeconds && sameInspectionValues(row, valueForPersistence(value));
    if (isUnchanged) {
      deleteRowDraft(workspace.batch.id, row.id);
    } else {
      setRowDraft(workspace.batch.id, row.id, nextDraft);
    }
    liveRate.textContent = currentRate(row, getRowDraft(workspace.batch.id, row.id) || nextDraft, historical);
    updateRowStatus();
    createIssueButton.disabled = readOnly;
    manualSaveController?.noteChanges();
    onDraftChange?.();
  };
  actualTimeInput.addEventListener("input", () => { actualTimeTouched = true; });
  actualTimeInput.addEventListener("change", () => { actualTimeTouched = true; });
  for (const input of historical ? [inspectedInput, defectiveInput, actualTimeInput] : [defectiveInput, actualTimeInput]) {
    input.addEventListener("input", markRowDraft);
    input.addEventListener("change", markRowDraft);
  }
  tr.append(task, results, el("td", { className: "qc-ops-remarks" }, rowForm), renderRowAttachmentCell(row, workspace, state, ctx, readOnly));
  return tr;
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

export function makeOperationalInspectionTable(workspace, state, ctx, manualSaveController, onDraftChange) {
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
