(function () {
  "use strict";

  const service = window.PrototypeService.create();
  const elements = {
    batchSelect: document.querySelector("#batch-select"),
    batchStatus: document.querySelector("#batch-status"),
    actionStatus: document.querySelector("#action-status"),
    tableHelp: document.querySelector("#table-help"),
    itemName: document.querySelector("#item-name"),
    batchQuantity: document.querySelector("#batch-quantity"),
    batchDate: document.querySelector("#batch-date"),
    batchRecorder: document.querySelector("#batch-recorder"),
    sourceVersion: document.querySelector("#source-version"),
    specialNotes: document.querySelector("#special-notes"),
    saveBatchDetails: document.querySelector("#save-batch-details"),
    inspectionRows: document.querySelector("#inspection-rows"),
    rowTemplate: document.querySelector("#inspection-row-template"),
    releaseButton: document.querySelector("#release-button"),
    newBatchDialog: document.querySelector("#new-batch-dialog"),
    newBatchForm: document.querySelector("#new-batch-form"),
    newBatchError: document.querySelector("#new-batch-error"),
    poLine: document.querySelector("#po-line"),
    newBatchQuantity: document.querySelector("#new-batch-quantity"),
    newBatchDate: document.querySelector("#new-batch-date"),
    newBatchRecorder: document.querySelector("#new-batch-recorder"),
    newBatchNotes: document.querySelector("#new-batch-notes"),
    poProgressContent: document.querySelector("#po-progress-content"),
    issueDialog: document.querySelector("#issue-dialog"),
    issueTitle: document.querySelector("#issue-title"),
    issueOrigin: document.querySelector("#issue-origin"),
    issueOwner: document.querySelector("#issue-owner"),
    issueDisposition: document.querySelector("#issue-disposition"),
    confirmations: [
      document.querySelector("#confirmation-one"),
      document.querySelector("#confirmation-two"),
      document.querySelector("#confirmation-three")
    ],
    issueDiscussion: document.querySelector("#issue-discussion"),
    discussionEntry: document.querySelector("#discussion-entry"),
    issueError: document.querySelector("#issue-error"),
    issueClosureHelp: document.querySelector("#issue-closure-help"),
    saveIssue: document.querySelector("#save-issue"),
    closeIssue: document.querySelector("#close-issue"),
    photoDialog: document.querySelector("#photo-dialog"),
    photoDialogTitle: document.querySelector("#photo-dialog-title"),
    photoPreviewList: document.querySelector("#photo-preview-list")
  };

  const rowDrafts = new Map();
  const detailDrafts = new Map();
  let overview = service.getOverview();
  let workspace = service.getBatchWorkspace(overview.currentBatchId);
  let activeIssueId = null;
  let photoContext = null;

  function formatNumber(value) {
    return Number(value || 0).toLocaleString("en-US");
  }

  function showMessage(message, state) {
    elements.actionStatus.textContent = message || "";
    elements.actionStatus.dataset.state = state || "";
  }

  function setDialogError(element, message) {
    element.textContent = message || "";
  }

  function errorMessage(error) {
    return error instanceof Error ? error.message : "The prototype action could not be completed.";
  }

  function rowDraftKey(batchId, rowId) {
    return `${batchId}::${rowId}`;
  }

  function detailDraftDiffers(batch, draft) {
    return Boolean(draft && (
      draft.recorder !== batch.recorder ||
      draft.batchDate !== batch.batchDate ||
      draft.specialNotes !== batch.specialNotes
    ));
  }

  function rowDraftDiffers(item, draft) {
    if (!draft) return false;
    const saved = item.inspection || {};
    return draft.defectiveQty !== String(saved.defectiveQty ?? "") ||
      draft.remarks !== String(saved.remarks ?? "");
  }

  function makeBilingual(container, english, chinese, englishClass, chineseClass) {
    const en = document.createElement("span");
    en.className = englishClass;
    en.textContent = english || "—";
    const zh = document.createElement("span");
    zh.className = chineseClass;
    zh.lang = "zh";
    zh.textContent = chinese || "—";
    container.replaceChildren(en, zh);
  }

  function makeBatchOptions() {
    elements.batchSelect.replaceChildren();
    for (const batch of overview.batches) {
      const option = document.createElement("option");
      option.value = batch.id;
      option.textContent = `${batch.displayName} · ${batch.id} · ${batch.status === "released" ? "Released" : "Draft"}`;
      option.selected = batch.id === workspace.batch.id;
      elements.batchSelect.append(option);
    }
  }

  function renderMetadata() {
    const batch = workspace.batch;
    const isReleased = batch.status === "released";
    elements.itemName.textContent = batch.displayName;
    elements.batchQuantity.textContent = formatNumber(batch.quantity);
    elements.sourceVersion.textContent = batch.sourceRevision;
    elements.batchStatus.textContent = isReleased ? "Released · read-only" : "Draft · editable";
    elements.batchStatus.dataset.state = isReleased ? "released" : "draft";
    elements.tableHelp.textContent = isReleased
      ? "Released batch · read-only. Calculated inspection quantities, locked standards, and defective rates are shown for reference; existing row photos remain viewable."
      : "Enter defective quantities and remarks, save each row, and attach photos to that inspection row. Inspection quantity is calculated from batch quantity × the inspection percentage, rounded up; standards and computed rates are reference values.";
    elements.tableHelp.dataset.state = isReleased ? "read-only" : "editable";

    const detailDraft = detailDrafts.get(batch.id);
    elements.batchDate.value = detailDraft ? detailDraft.batchDate : batch.batchDate;
    elements.batchRecorder.value = detailDraft ? detailDraft.recorder : batch.recorder;
    elements.specialNotes.value = detailDraft ? detailDraft.specialNotes : batch.specialNotes;
    elements.batchDate.disabled = isReleased;
    elements.batchRecorder.disabled = isReleased;
    elements.specialNotes.disabled = isReleased;
    elements.saveBatchDetails.disabled = isReleased;
    elements.releaseButton.disabled = isReleased;
  }

  function displayRate(item, draft) {
    const inspectedText = String(item.inspection.inspectedQty ?? "");
    const defectiveText = draft ? draft.defectiveQty : String(item.inspection.defectiveQty ?? "");
    if (inspectedText === "" || defectiveText === "") return item.inspection.saved && item.inspection.defectiveRate != null
      ? `${Number(item.inspection.defectiveRate).toFixed(2)}%`
      : "—";
    const inspected = Number(inspectedText);
    const defective = Number(defectiveText);
    if (!Number.isInteger(inspected) || !Number.isInteger(defective) || inspected < 0 || defective < 0 || defective > inspected) return "Check quantities";
    return inspected === 0 ? "—" : `${((defective / inspected) * 100).toFixed(2)}%`;
  }

  function makePhotoThumb(photo, item, isReleased) {
    const button = document.createElement("button");
    button.className = "photo-thumb-button";
    button.type = "button";
    button.dataset.action = "preview-photos";
    button.setAttribute("aria-label", `Preview ${photo.name} for ${item.taskEnglish}`);
    const image = document.createElement("img");
    image.className = "photo-thumb";
    image.src = photo.dataUrl;
    image.alt = photo.name;
    button.append(image);
    if (isReleased) button.disabled = false;
    return button;
  }

  function makeInspectionRow(item, index) {
    const row = elements.rowTemplate.content.firstElementChild.cloneNode(true);
    const batch = workspace.batch;
    const isReleased = batch.status === "released";
    const draftKey = rowDraftKey(batch.id, item.id);
    const draft = rowDrafts.get(draftKey);
    row.dataset.rowId = item.id;
    row.querySelector(".row-number").textContent = String(index + 1);
    makeBilingual(row.querySelector(".task-cell"), item.taskEnglish, item.taskChinese, "task-en", "task-zh");
    makeBilingual(row.querySelector(".spec-cell"), item.specificationEnglish, item.specificationChinese, "standard-en", "standard-zh");
    makeBilingual(row.querySelector(".method-cell"), item.deviceEnglish, item.deviceChinese, "device-en", "device-zh");
    row.querySelector(".sampling-cell").textContent = item.samplingRule;
    const inspectedInput = row.querySelector(".inspected-qty");
    const defectiveInput = row.querySelector(".defective-qty");
    const remarks = row.querySelector(".row-remarks");
    inspectedInput.value = String(item.inspection.inspectedQty ?? "");
    defectiveInput.value = draft ? draft.defectiveQty : String(item.inspection.defectiveQty ?? "");
    remarks.value = draft ? draft.remarks : String(item.inspection.remarks ?? "");
    inspectedInput.readOnly = true;
    defectiveInput.disabled = isReleased;
    remarks.disabled = isReleased;
    inspectedInput.setAttribute("aria-label", `Inspection quantity, calculated and read-only · ${item.taskEnglish}`);
    inspectedInput.title = `Calculated from batch quantity ${formatNumber(batch.quantity)} and the inspection percentage, rounded up`;
    defectiveInput.setAttribute("aria-label", `Defective quantity · ${item.taskEnglish}`);
    remarks.setAttribute("aria-label", `Remarks · ${item.taskEnglish}`);
    row.querySelector(".defective-rate-cell").textContent = displayRate(item, draft);
    for (const [cellIndex, rate] of item.history.slice(0, 4).entries()) {
      row.querySelectorAll(".history-cell")[cellIndex].textContent = rate;
    }
    row.querySelector(".time-cell").textContent = String(item.timeSeconds);
    row.querySelector(".procedure-cell").textContent = "Demo only · no source link";
    const saveInspection = row.querySelector(".save-inspection");
    const issueButton = row.querySelector(".open-issue");
    saveInspection.disabled = isReleased;
    issueButton.disabled = isReleased && !item.issue;
    issueButton.textContent = item.issue ? "Open issue" : "Create issue";
    const issueStatus = row.querySelector(".issue-status");
    if (item.issue) {
      issueStatus.textContent = item.issue.status === "open" ? `Open · ${item.issue.id} · blocks release` : `Closed · ${item.issue.id}`;
      issueStatus.dataset.state = item.issue.status;
    } else {
      issueStatus.textContent = "No linked issue";
      issueStatus.dataset.state = "none";
    }

    const photos = row.querySelector(".photo-list");
    if (item.photos.length) {
      for (const photo of item.photos) photos.append(makePhotoThumb(photo, item, isReleased));
    } else {
      const empty = document.createElement("span");
      empty.className = "empty-photos";
      empty.textContent = "No row photos";
      photos.append(empty);
    }
    row.querySelector(".add-photos").disabled = isReleased;
    row.querySelector(".add-demo-photo").disabled = isReleased;
    row.querySelector(".photo-input").disabled = isReleased;
    return row;
  }

  function renderRows() {
    const fragment = document.createDocumentFragment();
    workspace.items.forEach((item, index) => fragment.append(makeInspectionRow(item, index)));
    elements.inspectionRows.replaceChildren(fragment);
  }

  function renderPurchaseProgress() {
    const progress = service.getPurchaseOrderProgress();
    const table = document.createElement("table");
    table.className = "po-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["Variant", "PO line", "Ordered", "Released", "Remaining", "Excess", "Batches"]) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = label;
      headRow.append(th);
    }
    thead.append(headRow);
    const tbody = document.createElement("tbody");
    for (const line of progress) {
      const row = document.createElement("tr");
      const batchList = line.batches.length ? line.batches.map((batch) => `${batch.id} · ${formatNumber(batch.quantity)} · ${batch.status}`).join("; ") : "No batches";
      for (const value of [line.displayName, line.id, formatNumber(line.orderedQty), formatNumber(line.releasedQty), formatNumber(line.remainingQty), formatNumber(line.excessQty), batchList]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      tbody.append(row);
    }
    table.append(thead, tbody);
    elements.poProgressContent.replaceChildren(table);
  }

  function renderAll() {
    overview = service.getOverview();
    workspace = service.getBatchWorkspace(overview.currentBatchId);
    makeBatchOptions();
    renderMetadata();
    renderRows();
    renderPurchaseProgress();
    updateReleaseLabel();
  }

  function updateReleaseLabel() {
    const batch = workspace.batch;
    elements.releaseButton.textContent = batch.status === "released" ? "Released" : "Release batch";
    elements.releaseButton.disabled = batch.status === "released";
  }

  function itemForRow(rowId) {
    return workspace.items.find((item) => item.id === rowId);
  }

  function readRowInputs(rowElement, item) {
    return {
      inspectedQty: String(item.inspection.inspectedQty ?? ""),
      defectiveQty: rowElement.querySelector(".defective-qty").value,
      remarks: rowElement.querySelector(".row-remarks").value
    };
  }

  function showCurrentIssue(issue) {
    activeIssueId = issue.id;
    const snapshot = issue.sourceSnapshot;
    elements.issueTitle.textContent = `${snapshot.taskEnglish} · ${snapshot.taskChinese}`;
    elements.issueOrigin.textContent = `Source snapshot: ${snapshot.batchName} · ${snapshot.rowId} · ${snapshot.saved ? `inspection ${snapshot.inspectedQty}, defects ${snapshot.defectiveQty}, rate ${snapshot.defectiveRate == null ? "—" : `${Number(snapshot.defectiveRate).toFixed(2)}%`}` : "inspection not yet saved"} · ${snapshot.photoIds.length} row photo(s). Findings / inspection remarks: ${snapshot.remarks || "No remarks recorded"}. Standard: ${snapshot.standardEnglish} ${snapshot.standardChinese}`;
    elements.issueOwner.value = issue.owner;
    elements.issueDisposition.value = issue.formalDisposition;
    elements.confirmations.forEach((field, index) => { field.value = issue.confirmations[index] || ""; });
    elements.discussionEntry.value = "";
    elements.closeIssue.disabled = issue.status === "closed";
    elements.saveIssue.disabled = issue.status === "closed";
    elements.issueOwner.disabled = issue.status === "closed";
    elements.issueDisposition.disabled = issue.status === "closed";
    elements.confirmations.forEach((field) => { field.disabled = issue.status === "closed"; });
    elements.discussionEntry.disabled = issue.status === "closed";
    document.querySelector("#add-discussion").disabled = issue.status === "closed";
    elements.issueClosureHelp.textContent = issue.status === "closed"
      ? `Issue closed ${issue.closedAt ? new Date(issue.closedAt).toLocaleString() : ""}. The linked issue remains in the batch record.`
      : "An issue stays open until the required disposition and all three names are saved and staff explicitly close it.";
    setDialogError(elements.issueError, "");
    renderDiscussion(issue);
    if (!elements.issueDialog.open) elements.issueDialog.showModal();
  }

  function renderDiscussion(issue) {
    const fragment = document.createDocumentFragment();
    if (!issue.discussion.length) {
      const empty = document.createElement("li");
      empty.textContent = "No discussion entries.";
      fragment.append(empty);
    }
    for (const entry of issue.discussion) {
      const item = document.createElement("li");
      const text = document.createElement("span");
      text.textContent = entry.text;
      const time = document.createElement("time");
      time.dateTime = entry.createdAt;
      time.textContent = new Date(entry.createdAt).toLocaleString();
      item.append(text, time);
      fragment.append(item);
    }
    elements.issueDiscussion.replaceChildren(fragment);
  }

  function showPhotoDialog(rowId) {
    const item = itemForRow(rowId);
    if (!item) return;
    photoContext = { batchId: workspace.batch.id, rowId };
    renderPhotoDialog();
    if (!elements.photoDialog.open) elements.photoDialog.showModal();
  }

  function renderPhotoDialog() {
    if (!photoContext) return;
    workspace = service.getBatchWorkspace(photoContext.batchId);
    const item = itemForRow(photoContext.rowId);
    if (!item) return;
    const isReleased = workspace.batch.status === "released";
    elements.photoDialogTitle.textContent = `${item.taskEnglish} · ${item.taskChinese}`;
    const fragment = document.createDocumentFragment();
    if (!item.photos.length) {
      const empty = document.createElement("p");
      empty.className = "dialog-help";
      empty.textContent = "No photos are attached to this inspection row.";
      fragment.append(empty);
    }
    for (const photo of item.photos) {
      const card = document.createElement("div");
      card.className = "photo-preview";
      const image = document.createElement("img");
      image.src = photo.dataUrl;
      image.alt = photo.name;
      const name = document.createElement("p");
      name.textContent = photo.name;
      const remove = document.createElement("button");
      remove.className = "button button-small button-light remove-photo";
      remove.type = "button";
      remove.dataset.photoId = photo.id;
      remove.textContent = "Remove photo";
      remove.disabled = isReleased;
      card.append(image, name, remove);
      fragment.append(card);
    }
    elements.photoPreviewList.replaceChildren(fragment);
  }

  function localToday() {
    const now = new Date();
    const offset = now.getTimezoneOffset() * 60000;
    return new Date(now.getTime() - offset).toISOString().slice(0, 10);
  }

  function populatePoLines() {
    elements.poLine.replaceChildren();
    for (const line of overview.orderLines) {
      const option = document.createElement("option");
      option.value = line.id;
      option.textContent = `${line.displayName} · ${line.poNumber} · ordered ${formatNumber(line.orderedQty)}`;
      option.selected = line.id === workspace.batch.poLineId;
      elements.poLine.append(option);
    }
  }

  document.querySelector("#new-batch-button").addEventListener("click", () => {
    overview = service.getOverview();
    elements.newBatchForm.reset();
    populatePoLines();
    elements.newBatchDate.value = localToday();
    setDialogError(elements.newBatchError, "");
    elements.newBatchDialog.showModal();
  });

  elements.batchSelect.addEventListener("change", () => {
    try {
      service.selectBatch(elements.batchSelect.value);
      showMessage("Batch selected.");
      renderAll();
    } catch (error) {
      showMessage(errorMessage(error), "error");
      renderAll();
    }
  });

  elements.newBatchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      service.createBatch({
        poLineId: elements.poLine.value,
        quantity: elements.newBatchQuantity.value,
        batchDate: elements.newBatchDate.value,
        recorder: elements.newBatchRecorder.value,
        specialNotes: elements.newBatchNotes.value
      });
      elements.newBatchDialog.close();
      showMessage("New AP OQC demo batch created.");
      renderAll();
    } catch (error) {
      setDialogError(elements.newBatchError, errorMessage(error));
    }
  });

  elements.saveBatchDetails.addEventListener("click", () => {
    const batchId = workspace.batch.id;
    try {
      const details = {
        recorder: elements.batchRecorder.value,
        batchDate: elements.batchDate.value,
        specialNotes: elements.specialNotes.value
      };
      service.saveBatchDetails(batchId, details);
      detailDrafts.delete(batchId);
      showMessage("Batch details saved.");
      renderAll();
    } catch (error) {
      showMessage(errorMessage(error), "error");
    }
  });

  for (const field of [elements.batchDate, elements.batchRecorder, elements.specialNotes]) {
    field.addEventListener("input", () => {
      detailDrafts.set(workspace.batch.id, {
        batchDate: elements.batchDate.value,
        recorder: elements.batchRecorder.value,
        specialNotes: elements.specialNotes.value
      });
    });
  }

  elements.inspectionRows.addEventListener("input", (event) => {
    const row = event.target.closest("tr[data-row-id]");
    if (!row || !event.target.matches(".defective-qty, .row-remarks")) return;
    const item = itemForRow(row.dataset.rowId);
    const draft = readRowInputs(row, item);
    rowDrafts.set(rowDraftKey(workspace.batch.id, row.dataset.rowId), draft);
    row.querySelector(".defective-rate-cell").textContent = displayRate(item, draft);
  });

  elements.inspectionRows.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const row = button.closest("tr[data-row-id]");
    if (!row) return;
    const rowId = row.dataset.rowId;
    const batchId = workspace.batch.id;

    if (button.classList.contains("save-inspection")) {
      try {
        service.saveInspection(batchId, rowId, readRowInputs(row, itemForRow(rowId)));
        rowDrafts.delete(rowDraftKey(batchId, rowId));
        showMessage(`${itemForRow(rowId).taskEnglish} record saved.`);
        renderAll();
      } catch (error) {
        showMessage(errorMessage(error), "error");
      }
      return;
    }

    if (button.classList.contains("open-issue")) {
      try {
        const draft = rowDrafts.get(rowDraftKey(batchId, rowId));
        const item = itemForRow(rowId);
        if (rowDraftDiffers(item, draft)) {
          service.saveInspection(batchId, rowId, readRowInputs(row, item));
          rowDrafts.delete(rowDraftKey(batchId, rowId));
        }
        const issue = item.issue
          ? service.getIssue(item.issue.id)
          : service.createIssueFromInspection(batchId, rowId);
        renderAll();
        showCurrentIssue(issue);
      } catch (error) {
        showMessage(errorMessage(error), "error");
      }
      return;
    }

    if (button.classList.contains("add-photos")) {
      row.querySelector(".photo-input").click();
      return;
    }

    if (button.classList.contains("add-demo-photo")) {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420"><rect width="640" height="420" fill="#eef2ed"/><path d="M74 300 210 150l90 94 74-78 192 134Z" fill="#bfd8bf" stroke="#4e6952" stroke-width="8"/><circle cx="454" cy="100" r="35" fill="#e4be55"/><text x="320" y="380" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" fill="#27372a">DEMO IMAGE · NOT QC EVIDENCE</text></svg>';
      try {
        service.addPhoto(batchId, rowId, { name: "DEMO diagram · not QC evidence.svg", dataUrl: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}` });
        showMessage("Clearly labeled demo image added to this row only.");
        renderAll();
      } catch (error) {
        showMessage(errorMessage(error), "error");
      }
      return;
    }

    if (button.dataset.action === "preview-photos") showPhotoDialog(rowId);
  });

  elements.inspectionRows.addEventListener("change", async (event) => {
    if (!event.target.matches(".photo-input")) return;
    const row = event.target.closest("tr[data-row-id]");
    const files = [...event.target.files];
    const batchId = workspace.batch.id;
    const rowId = row ? row.dataset.rowId : "";
    event.target.value = "";
    if (!row || !files.length) return;
    try {
      const data = await Promise.all(files.map((file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ name: file.name, dataUrl: String(reader.result) });
        reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
        reader.readAsDataURL(file);
      })));
      for (const photo of data) service.addPhoto(batchId, rowId, photo);
      const sourceItem = workspace.items.find((item) => item.id === rowId);
      showMessage(`${data.length} photo(s) added to ${sourceItem ? sourceItem.taskEnglish : rowId}.`);
      renderAll();
    } catch (error) {
      showMessage(errorMessage(error), "error");
    }
  });

  elements.releaseButton.addEventListener("click", () => {
    const batch = workspace.batch;
    const details = detailDrafts.get(batch.id);
    if (detailDraftDiffers(batch, details)) {
      showMessage("Save the edited batch details before release.", "error");
      return;
    }
    const unsaved = workspace.items.find((item) => rowDraftDiffers(item, rowDrafts.get(rowDraftKey(batch.id, item.id))));
    if (unsaved) {
      showMessage(`Save the edited ${unsaved.taskEnglish} row before release.`, "error");
      return;
    }
    try {
      service.releaseBatch(batch.id);
      showMessage("Batch released. Its full quantity is counted once in PO progress.");
      renderAll();
    } catch (error) {
      showMessage(errorMessage(error), "error");
    }
  });

  elements.newBatchDialog.addEventListener("click", (event) => {
    if (event.target.closest(".close-dialog")) elements.newBatchDialog.close();
  });
  elements.issueDialog.addEventListener("click", (event) => {
    if (event.target.closest(".close-dialog")) elements.issueDialog.close();
  });
  elements.photoDialog.addEventListener("click", (event) => {
    if (event.target.closest(".close-dialog")) elements.photoDialog.close();
  });

  elements.issueDialog.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!activeIssueId) return;
    try {
      const issue = service.saveIssueDisposition(activeIssueId, {
        owner: elements.issueOwner.value,
        formalDisposition: elements.issueDisposition.value,
        confirmations: elements.confirmations.map((field) => field.value)
      });
      renderAll();
      showCurrentIssue(issue);
      setDialogError(elements.issueError, "Disposition fields saved. The issue remains open until explicitly closed.");
    } catch (error) {
      setDialogError(elements.issueError, errorMessage(error));
    }
  });

  document.querySelector("#add-discussion").addEventListener("click", () => {
    if (!activeIssueId) return;
    try {
      const issue = service.addIssueDiscussion(activeIssueId, elements.discussionEntry.value);
      elements.discussionEntry.value = "";
      setDialogError(elements.issueError, "Discussion entry added separately from formal disposition.");
      renderDiscussion(issue);
    } catch (error) {
      setDialogError(elements.issueError, errorMessage(error));
    }
  });

  elements.closeIssue.addEventListener("click", () => {
    if (!activeIssueId) return;
    try {
      const issue = service.closeIssue(activeIssueId);
      renderAll();
      showCurrentIssue(issue);
      setDialogError(elements.issueError, "Issue closed by explicit action.");
    } catch (error) {
      setDialogError(elements.issueError, errorMessage(error));
    }
  });

  elements.photoPreviewList.addEventListener("click", (event) => {
    const button = event.target.closest(".remove-photo");
    if (!button || !photoContext) return;
    try {
      service.removePhoto(photoContext.batchId, photoContext.rowId, button.dataset.photoId);
      renderAll();
      renderPhotoDialog();
    } catch (error) {
      showMessage(errorMessage(error), "error");
    }
  });

  document.querySelectorAll(".close-dialog").forEach((button) => {
    button.addEventListener("click", () => {
      const dialog = button.closest("dialog");
      if (dialog && dialog.open) dialog.close();
    });
  });

  renderAll();
})();
