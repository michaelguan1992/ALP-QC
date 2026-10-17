// Historical batch detail: the facts and provenance of a batch imported from an original PDF, and
// the editable current results of its inspection rows. Printed source values stay read-only. Results
// save through the same manual save controller as operational batches.

import { button, dateLabel, el, errorText, list, pageHeading, text } from "./qc-ops-common.js";
import { applySaveStatus, batchRowDrafts, clearDraftsForBatch, createBatchRowRegistry, dismissBatchDraftNotice, openBatchDrafts, persistBatchDraftsNow, rebaseBatchDrafts, reconcileSavedRowDraft } from "./qc-batch-drafts.js";
import { createManualSaveController } from "./qc-manual-save.js";
import { NOT_SAVED_SEE_MESSAGE, isStaleRevisionError } from "./qc-command-rules.js";
import { renderDraftNotice } from "./qc-draft-notice.js";
import { displayColorLabel } from "../core/qc-batch-display.js";
import { findHistoricalSourceRow, historicalResultValues } from "../core/qc-historical-batches.js";
import { batchProductLabel, operationalTaskTitle, sourceValue } from "./qc-batch-model.js";
import { batchAttachments, renderBatchAttachments } from "./qc-batch-attachments.js";
import { makeOperationalInspectionTable, settleRowDraftAfterSave } from "./qc-batch-rows.js";

function historicalBatchLabel(displayNumber) {
  return text(displayNumber, "Batch");
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

export function renderHistoricalBatchDetail(root, ctx, workspace) {
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
    ["Color", displayColorLabel(batch.color)],
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

  const rows = createBatchRowRegistry();
  const onRowDraftChange = (rowId = null, status = null, createIssueButton = null, inputState = null) => {
    if (rowId && status) rows.register(rowId, status, createIssueButton, inputState);
  };
  const saveError = el("p", { className: "qc-ops-form-error qc-ops-save-error", role: "alert" });
  const saveStatus = el("span", { hidden: true });
  let saveFailureIsStale = false;
  let restoreNoticeElement = null;
  // Restores stored drafts when this page has none, and reconciles every draft with the saved results first.
  const draftNotice = openBatchDrafts(batch.id, {
    rows: list(workspace.rows),
    details: null,
    revision: ctx.state?.revision ?? null,
    historical: true,
    readOnly: workspace.batch.status === "released",
    describeRow: (row) => operationalTaskTitle(row, workspace, state),
  });
  const hasChanges = () => batchRowDrafts(batch.id).length > 0;
  const readSnapshot = () => ({
    rows: batchRowDrafts(batch.id).map(([rowId, draft]) => {
      const row = list(workspace.rows).find((candidate) => candidate.id === rowId);
      return {
        rowId,
        inspectedQty: draft.inspectedQty === "" ? null : Number(draft.inspectedQty),
        defectiveQty: draft.defectiveQty === "" ? null : Number(draft.defectiveQty),
        actualTimeSeconds: draft.actualTimeSeconds === "" || draft.actualTimeSeconds === undefined ? null : Number(draft.actualTimeSeconds),
        invalidInspectedQty: draft.invalidInspectedQty === true,
        invalidDefectiveQty: draft.invalidDefectiveQty === true,
        invalidActualTimeSeconds: draft.invalidActualTimeSeconds === true,
        previous: { inspectedQty: row?.inspectedQty ?? null, defectiveQty: row?.defectiveQty ?? null },
        input: structuredClone(draft),
      };
    }),
  });
  const manualSaveController = createManualSaveController({
    hasChanges,
    readSnapshot,
    saveOnExit: true,
    validate: (snapshot) => {
      for (const row of snapshot.rows) {
        if (row.invalidInspectedQty || row.invalidDefectiveQty || row.invalidActualTimeSeconds ||
          row.inspectedQty !== null && (!Number.isSafeInteger(row.inspectedQty) || row.inspectedQty < 0) ||
          row.defectiveQty !== null && (!Number.isSafeInteger(row.defectiveQty) || row.defectiveQty < 0) ||
          row.actualTimeSeconds !== null && (!Number.isFinite(row.actualTimeSeconds) || row.actualTimeSeconds < 0)) {
          return "Enter nonnegative whole-number quantities and a nonnegative actual time, or leave a field blank.";
        }
        const countsChanged = row.inspectedQty !== row.previous.inspectedQty || row.defectiveQty !== row.previous.defectiveQty;
        if (countsChanged && row.inspectedQty !== null && row.defectiveQty !== null && row.defectiveQty > row.inspectedQty) {
          return "Defective quantity cannot exceed inspection quantity when changing historical counts.";
        }
      }
      return true;
    },
    save: (snapshot) => ctx.run("saveBatchChanges", {
      batchId: batch.id,
      rows: snapshot.rows.map(({ rowId, inspectedQty, defectiveQty, actualTimeSeconds }) => ({
        rowId, inspectedQty, defectiveQty, actualTimeSeconds,
      })),
    }, { manualSave: true, render: false, silent: true }),
    onError: (error) => {
      saveFailureIsStale = isStaleRevisionError(error);
      saveError.textContent = saveFailureIsStale
        ? NOT_SAVED_SEE_MESSAGE
        : `This page remains open because the changes could not be saved: ${errorText(error, "Check the highlighted changes and try again.")}`;
    },
    onSaved: (snapshot, response) => {
      saveFailureIsStale = false;
      saveError.textContent = "";
      dismissBatchDraftNotice(batch.id);
      restoreNoticeElement?.remove();
      restoreNoticeElement = null;
      const latestState = response.state || ctx.state || state;
      const savedBatch = list(latestState.batches).find((candidate) => candidate.id === batch.id) ||
        list(response.result?.changes?.batches).find((candidate) => candidate.id === batch.id);
      if (!savedBatch) throw new Error("The saved historical results could not be confirmed.");
      Object.assign(batch, savedBatch);
      Object.assign(workspace.batch, savedBatch);
      const submittedRows = new Map(snapshot.rows.map((entry) => [entry.rowId, entry.input]));
      for (const savedRow of list(savedBatch.rows)) {
        const currentRow = list(workspace.rows).find((candidate) => candidate.id === savedRow.id);
        if (!currentRow) continue;
        Object.assign(currentRow, savedRow, historicalResultValues(savedRow, findHistoricalSourceRow(latestState, savedBatch, savedRow)));
        if (submittedRows.has(savedRow.id)) reconcileSavedRowDraft(batch.id, savedRow.id, submittedRows.get(savedRow.id));
        const rowInputState = rows.inputState(savedRow.id);
        if (rowInputState) settleRowDraftAfterSave(batch.id, savedRow.id, rowInputState, currentRow, { historical: true });
      }
      // The saved results are now the page's own, so every draft that is still changed is judged against them.
      rebaseBatchDrafts(batch.id);
      persistBatchDraftsNow(batch.id);
    },
    onDiscard: () => {
      clearDraftsForBatch(batch.id);
      for (const [rowId, rowInputState] of rows.inputEntries()) {
        const savedRow = list(workspace.rows).find((candidate) => candidate.id === rowId);
        rowInputState.reset(savedRow);
        rowInputState.updateStatus();
      }
      saveError.textContent = "";
      saveFailureIsStale = false;
      restoreNoticeElement?.remove();
      restoreNoticeElement = null;
    },
    onStatus: (status) => {
      applySaveStatus(saveStatus, status === "Save failed" && saveFailureIsStale ? "" : status);
      rows.applyStatus(batch.id, status);
    },
  });
  ctx.registerManualSaveController?.(manualSaveController);
  const intro = el("section", { className: "card qc-ops-inspection-card" },
    el("div", { className: "qc-ops-section-heading" },
      el("h2", {}, "Batch inspection"),
      saveStatus,
    ),
    saveError,
    makeOperationalInspectionTable(workspace, state, ctx, manualSaveController, onRowDraftChange)
  );
  // "Discard restored edits" discards this batch's unsent results through the controller, which also resets the inputs.
  const restoreAction = () => {
    if (draftNotice?.applied > 0) {
      if (!manualSaveController.discardAll()) return;
    } else {
      dismissBatchDraftNotice(batch.id);
    }
    restoreNoticeElement?.remove();
    restoreNoticeElement = null;
  };
  restoreNoticeElement = draftNotice ? renderDraftNotice(draftNotice, { onAction: restoreAction }) : null;

  root.replaceChildren(
    pageHeading("Batches", "", [
      button("All batches", () => ctx.navigate("batches"), "button button-secondary"),
      button("View report", () => ctx.navigate("batch-report", batch.id), "button button-secondary"),
    ]),
    ...(restoreNoticeElement ? [restoreNoticeElement] : []),
    metadata,
    intro,
    renderBatchAttachments(attachmentsWorkspace, state, ctx),
  );
}
