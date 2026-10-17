// Operational batch detail: batch facts, the editable batch-details form, the inspection table, the
// release panel, and deletion. Historical batches are handed to qc-batch-historical.js. Edits save
// through the manual save controller, which also flushes them before in-app departure.

import { button, dateLabel, el, errorText, field, list, notify, pageHeading, quantity, statusPill, text } from "./qc-ops-common.js";
import { createSingleFlight } from "./qc-ui.js";
import { applySaveStatus, batchRowDrafts, clearDraftsForBatch, createBatchRowRegistry, deleteDetailDraft, getDetailDraft, pruneSavedBatchDrafts, reconcileSavedDetailDraft, reconcileSavedRowDraft, setDetailDraft } from "./qc-batch-drafts.js";
import { createManualSaveController } from "./qc-manual-save.js";
import { batchReleaseBlockers } from "../core/qc-inspections.js";
import { resolveBatchDisplayNumber } from "../core/qc-batch-display.js";
import { batchProducts, isHistoricalBatch, navigateWithDraftWarning, orderById, productLabel, totalProductQuantity } from "./qc-batch-model.js";
import { batchAttachments, renderBatchAttachments } from "./qc-batch-attachments.js";
import { makeOperationalInspectionTable, settleRowDraftAfterSave } from "./qc-batch-rows.js";
import { renderHistoricalBatchDetail } from "./qc-batch-historical.js";

function savedDetailsFrom(batch) {
  return { date: batch.date || "", recorder: batch.recorder || "", notes: batch.notes || "" };
}

function validIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function renderReleaseBlockers(workspace, ctx, manualSaveController) {
  const blockerHost = el("div", { className: "qc-ops-release-blockers" });
  // A second click while the release is pending is ignored, so the batch is released once.
  const releaseFlight = createSingleFlight({ controls: () => [release] });
  const release = button("Release full batch", () => {
    void releaseFlight(async () => {
      const releaseSavedBatch = async () => {
        const result = await ctx.run("releaseBatch", { id: workspace.batch.id });
        if (result.ok) notify("The full batch was released.");
      };
      if (manualSaveController?.hasPending()) {
        await ctx.resolveManualChanges?.("release this batch", releaseSavedBatch);
        return;
      }
      await releaseSavedBatch();
    });
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

export function renderBatchDetail(root, ctx) {
  root.replaceChildren(el("p", { className: "qc-ops-loading" }, "Loading batch workspace…"));
  // A superseded render, or one whose root has left the document, must not change the page, report
  // errors, or register a save controller. Its batch is simply not shown.
  const isCurrent = () => root.isConnected && (ctx.isCurrentRender?.() ?? true);
  return ctx.service.getBatchWorkspace(ctx.selectedId).then((workspace) => {
    if (!isCurrent()) return;
    const state = ctx.state || {};
    const batch = workspace.batch;
    if (!batch) throw new Error("The selected batch could not be found.");
    if (isHistoricalBatch(batch)) {
      renderHistoricalBatchDetail(root, ctx, workspace);
      return;
    }
    const isReleased = batch.status === "released";
    const savedDetails = savedDetailsFrom(batch);
    pruneSavedBatchDrafts(batch, list(workspace.rows), { historical: false, savedDetails });
    const draftDetails = getDetailDraft(batch.id) || savedDetails;
    const order = workspace.order || orderById(state).get(batch.orderId);
    const products = batchProducts(batch, state, workspace);
    const detailForm = el("form", { className: "qc-ops-batch-meta qc-ops-detail-form", "data-autosave-form": "true" });
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
    const rows = createBatchRowRegistry();
    const onRowDraftChange = (rowId = null, status = null, createIssueButton = null, inputState = null) => {
      if (rowId && status) {
        rows.register(rowId, status, createIssueButton, inputState);
        return;
      }
      releasePanel?.refresh();
    };
    const detailsDiffer = (value) => value.date !== (savedDetails.date || "") ||
      value.recorder !== (savedDetails.recorder || "") || value.notes !== (savedDetails.notes || "");
    const hasChanges = () => batchRowDrafts(batch.id).length > 0 ||
      Boolean(getDetailDraft(batch.id) && detailsDiffer(getDetailDraft(batch.id)));
    const readSnapshot = () => ({
      details: getDetailDraft(batch.id) ? readDetailValue() : null,
      rows: batchRowDrafts(batch.id).map(([rowId, draft]) => {
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
        const submittedRows = new Map(snapshot.rows.map((entry) => [entry.rowId, entry.input]));
        for (const savedRow of list(savedBatch.rows)) {
          const currentRow = list(workspace.rows).find((candidate) => candidate.id === savedRow.id);
          if (currentRow) Object.assign(currentRow, savedRow);
          if (submittedRows.has(savedRow.id)) reconcileSavedRowDraft(batch.id, savedRow.id, submittedRows.get(savedRow.id));
          const rowInputState = rows.inputState(savedRow.id);
          if (!rowInputState) continue;
          settleRowDraftAfterSave(batch.id, savedRow.id, rowInputState, currentRow ?? savedRow, { historical: false });
          rowInputState.createIssueButton.disabled = isReleased;
        }
        if (snapshot.details) {
          reconcileSavedDetailDraft(batch.id, snapshot.details);
          Object.assign(savedDetails, savedDetailsFrom(savedBatch));
          batch.date = savedDetails.date;
          batch.recorder = savedDetails.recorder;
          batch.notes = savedDetails.notes;
          const currentDetails = readDetailValue();
          if (detailsDiffer(currentDetails)) {
            setDetailDraft(batch.id, { date: currentDetails.date, recorder: currentDetails.recorder, notes: currentDetails.notes });
          } else {
            deleteDetailDraft(batch.id);
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
        for (const [rowId, rowInputState] of rows.inputEntries()) {
          const savedRow = list(workspace.rows).find((candidate) => candidate.id === rowId);
          rowInputState.reset(savedRow);
          rowInputState.updateStatus();
        }
        saveError.textContent = "";
      },
      onStatus: (status) => {
        applySaveStatus(detailStatus, status);
        rows.applyStatus(batch.id, status);
        releasePanel?.refresh();
      },
    });
    ctx.registerManualSaveController?.(manualSaveController);
    const updateDetailDraft = () => {
      const current = readDetailValue();
      if (detailsDiffer(current)) setDetailDraft(batch.id, { date: current.date, recorder: current.recorder, notes: current.notes });
      else deleteDetailDraft(batch.id);
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
    const deleteFlight = createSingleFlight({ controls: () => [deleteBatchButton] });
    const deleteBatchButton = button("Delete", () => {
      if (!window.confirm(`Delete batch ${text(workspace.displayNumber ?? resolveBatchDisplayNumber(state, batch.id, batch.number), "Batch")}? This action cannot be undone.`)) return;
      void deleteFlight(async () => {
        const deleteSavedBatch = async () => {
          // The deleted batch is not re-rendered; the page moves to the batch list at once.
          const response = await ctx.run("deleteBatch", { id: batch.id }, { render: false });
          if (!response.ok) return;
          clearDraftsForBatch(batch.id);
          await ctx.navigate("batches", null, true);
        };
        if (manualSaveController.hasPending()) await ctx.resolveManualChanges?.("delete this batch", deleteSavedBatch);
        else await deleteSavedBatch();
      });
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
    if (!isCurrent()) return;
    root.replaceChildren(
      pageHeading("Batches", "The batch workspace could not be loaded."),
      el("section", { className: "card qc-ops-error-card" }, el("p", {}, errorText(error)), button("Back to batches", () => ctx.navigate("batches"), "button button-secondary"))
    );
    notify(errorText(error), true);
  });
}
