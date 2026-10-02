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
  statusPill,
  text,
  timestampLabel
} from "./qc-ops-common.js";
import { closeDialog, showDialog } from "./qc-ui.js";
import { getBatchProducts, getBatchRowProduct } from "../core/qc-batch-products.js";
import { createInspectionAutosaveController } from "./qc-inspection-autosave.js";

const issueDrafts = new Map();
let activeIssueDialogRuntime = null;
const issueDialogCloseListeners = new WeakSet();

function hasUnsavedIssueWork() {
  return issueDrafts.size > 0 || Boolean(activeIssueDialogRuntime?.autosaveController?.hasPending?.());
}

document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const closeButton = target?.closest("#qc-dialog .dialog-close");
  const runtime = activeIssueDialogRuntime;
  const dialog = closeButton?.closest("dialog");
  if (!runtime || runtime.dialog !== dialog || runtime.form !== dialog?.querySelector("form[data-issue-id]")) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  void runtime.closeFromHeader();
}, true);

window.addEventListener("beforeunload", (event) => {
  if (hasUnsavedIssueWork()) {
    event.preventDefault();
    event.returnValue = "";
  }
});

function batchById(state) {
  return new Map(list(state.batches).map((batch) => [batch.id, batch]));
}

function variantById(state) {
  return new Map(list(state.variants).map((variant) => [variant.id, variant]));
}

function issueProducts(issue, state) {
  const snapshot = sourceSnapshot(issue);
  const batchSnapshot = snapshot.batch || {};
  const currentBatch = batchById(state).get(issue.batchId || batchSnapshot.id);
  const rawProducts = list(snapshot.products).length
    ? list(snapshot.products)
    : getBatchProducts(batchSnapshot).length
      ? getBatchProducts(batchSnapshot)
      : getBatchProducts(currentBatch || {});
  const variants = variantById(state);
  return rawProducts.map((product) => ({
    ...product,
    variant: product.variant || variants.get(product.variantId) || null,
  }));
}

function issueProductLabel(product, state) {
  const variant = product?.variant || variantById(state).get(product?.variantId);
  return text(product?.variantLabel || product?.productLabel || product?.label || variant?.label, product?.variantId || "Product");
}

function productSummary(products, state) {
  return products.map((product) => {
    const quantityLabel = product.quantity === null || product.quantity === undefined ? "quantity unknown" : `${quantity(product.quantity)} units`;
    const version = product.version?.label || product.versionLabel;
    return `${issueProductLabel(product, state)} · ${quantityLabel}${version ? ` · Version ${version}` : ""}`;
  }).join("; ");
}

function issueRowProduct(issue, state) {
  const snapshot = sourceSnapshot(issue);
  const row = snapshot.row || (sourceRow(issue) ? snapshot : null);
  if (!row) return null;
  const batchSnapshot = snapshot.batch || batchById(state).get(issue.batchId) || {};
  const linked = getBatchRowProduct(batchSnapshot, row) || {};
  const products = issueProducts(issue, state);
  const matched = products.find((product) => product.lineId === (row.productLineId || linked.lineId));
  return { ...linked, ...matched, ...row };
}

function sourceSnapshot(issue) {
  return issue.sourceSnapshot || {};
}

function sourceBatch(issue, state) {
  const snapshot = sourceSnapshot(issue);
  const fromSnapshot = snapshot.batch || {};
  return snapshot.batchNumber || fromSnapshot.number || fromSnapshot.batchNumber || batchById(state).get(issue.batchId || fromSnapshot.id)?.number || "Standalone issue";
}

function sourceRow(issue) {
  const snapshot = sourceSnapshot(issue);
  const row = snapshot.row || snapshot;
  return row.title || row.titleZh || row.no || row.id || issue.rowId ? row : null;
}

function sourceText(issue, state) {
  const row = sourceRow(issue);
  const products = issueProducts(issue, state);
  const rowProduct = issueRowProduct(issue, state);
  const parts = [sourceBatch(issue, state)];
  if (rowProduct?.variantLabel || rowProduct?.productLabel || rowProduct?.productLineId || rowProduct?.variantId) {
    parts.push(`Inspection product: ${text(rowProduct.variantLabel || rowProduct.productLabel, issueProductLabel(rowProduct, state))}`);
  }
  if (products.length) parts.push(productSummary(products, state));
  if (row) parts.push(text(row.title || row.titleZh || row.no || row.id));
  return parts.join(" · ");
}

function quantityOrDash(value) {
  return value === null || value === undefined || value === "" ? "—" : quantity(value);
}

function issueDraft(issue) {
  return issueDrafts.get(issue.id) || {
    owner: String(issue.owner || ""),
    disposition: String(issue.disposition || ""),
    confirmations: [0, 1, 2].map((index) => String(issue.confirmations?.[index] || "")),
    discussionAuthorName: "",
    discussionText: ""
  };
}

function savedIssueDraft(issue) {
  return {
    owner: String(issue.owner || ""),
    disposition: String(issue.disposition || ""),
    confirmations: [0, 1, 2].map((index) => String(issue.confirmations?.[index] || ""))
  };
}

function draftDiffers(issue, draft) {
  const saved = savedIssueDraft(issue);
  return !sameDisposition(dispositionValue(draft), dispositionValue(saved));
}

function hasDiscussionDraft(draft) {
  return Boolean(draft.discussionAuthorName || draft.discussionText);
}

function hasIssueDraft(issue, draft) {
  return draftDiffers(issue, draft) || hasDiscussionDraft(draft);
}

function dispositionValue(draft) {
  return {
    owner: draft.owner.trim(),
    disposition: draft.disposition.trim(),
    confirmations: draft.confirmations.map((name) => name.trim()),
  };
}

function sameDisposition(left, right) {
  return left.owner === right.owner && left.disposition === right.disposition &&
    left.confirmations.length === right.confirmations.length &&
    left.confirmations.every((value, index) => value === right.confirmations[index]);
}

function sourcePhotos(issue, state) {
  const snapshot = sourceSnapshot(issue);
  const row = snapshot.row || snapshot;
  const photoIds = list(row.photoIds || snapshot.photoIds);
  const assets = new Map(list(state.assets).map((asset) => [asset.id, asset]));
  return photoIds.map((id) => assets.get(id)).filter(Boolean);
}

function sourceCard(issue, state) {
  const snapshot = sourceSnapshot(issue);
  const row = snapshot.row || null;
  const batch = snapshot.batch || {};
  const sourceTitle = row?.title || snapshot.title || "Standalone issue";
  const sourceTitleZh = row?.titleZh;
  const products = issueProducts(issue, state);
  const rowProduct = issueRowProduct(issue, state);
  const rowProductName = rowProduct ? text(row?.variantLabel || row?.productLabel || rowProduct.variantLabel, issueProductLabel(rowProduct, state)) : "";
  const rowProductQuantity = row?.productQuantity ?? rowProduct?.productQuantity ?? rowProduct?.quantity;
  const rowVersion = row?.versionLabel || rowProduct?.versionLabel || rowProduct?.version?.label;
  const metadata = [
    `Batch: ${text(snapshot.batchNumber || batch.number || batch.batchNumber, "Standalone")}`,
    rowProduct ? `Inspection product: ${rowProductName} · ${rowProductQuantity === null || rowProductQuantity === undefined ? "quantity unknown" : `${quantity(rowProductQuantity)} units`}${rowVersion ? ` · Version ${rowVersion}` : ""}` : "",
    products.length ? `Products in batch: ${productSummary(products, state)}` : `Product: ${text(snapshot.variantLabel || batch.variantLabel)}`,
    `Factory / stage: ${text(snapshot.factory || batch.factory)} · ${text(snapshot.stage || batch.stage)}`,
    `Batch date: ${dateLabel(snapshot.date || batch.date)}`,
    products.length ? "" : `Version: ${text(snapshot.versionLabel || batch.versionLabel)}`,
    row ? `Inspection row: ${text(row.no || row.id)}` : "No inspection row linked"
  ].filter(Boolean);
  const facts = [
    ["Inspection quantity", row?.inspectedQty],
    ["Defective quantity", row?.defectiveQty],
    ["Defective rate", row?.defectiveRate === null || row?.defectiveRate === undefined ? "—" : `${Number(row.defectiveRate).toFixed(2)}%`],
    ["Inspection saved", row?.savedAt ? timestampLabel(row.savedAt) : "Not saved at issue creation"]
  ];
  const evidence = sourcePhotos(issue, state);
  const evidenceBlock = el("div", { className: "qc-ops-issue-evidence" },
    el("strong", {}, `Source photos (${evidence.length})`),
    evidence.length ? el("div", { className: "qc-ops-issue-evidence-list" }, ...evidence.map((asset) => el("figure", {},
      el("img", { src: asset.dataUrl, alt: asset.name || "Issue source photo" }),
      el("figcaption", {}, text(asset.name, "Inspection photo"))
    ))) : el("p", {}, row?.photoIds?.length ? "Some source photos are unavailable in this browser snapshot." : "No row photos were attached when this issue was created.")
  );
  return el("section", { className: "qc-ops-source-card" },
    el("div", { className: "qc-ops-source-heading" },
      el("div", {}, el("small", {}, "Immutable source snapshot"), el("h3", {}, sourceTitle), sourceTitleZh ? el("p", { lang: "zh" }, sourceTitleZh) : null),
      statusPill(issue.status)
    ),
    el("p", { className: "qc-ops-source-meta" }, metadata.join(" · ")),
    row ? el("div", { className: "qc-ops-source-standard" },
      el("strong", {}, "Inspection standard"),
      el("p", {}, text(row.specification || row.specificationZh, "No standard text in source snapshot")),
      row.remarks ? el("p", {}, el("strong", {}, "Recorded remarks: "), row.remarks) : null
    ) : null,
    row ? el("dl", { className: "qc-ops-source-facts" }, ...facts.map(([label, value]) => el("div", {}, el("dt", {}, label), el("dd", {}, label === "Inspection quantity" || label === "Defective quantity" ? quantityOrDash(value) : text(value))))) : null,
    evidenceBlock
  );
}

function renderDiscussion(issue) {
  if (!list(issue.discussion).length) return el("p", { className: "qc-ops-empty-discussion" }, "No discussion entries yet.");
  return el("ol", { className: "qc-ops-discussion-list" }, ...list(issue.discussion).map((entry) => {
    const authorName = String(entry.authorName || "").trim();
    return el("li", {},
      el("p", {}, authorName ? [el("strong", { className: "qc-ops-discussion-author" }, authorName), " ", entry.text] : entry.text),
      el("time", {}, timestampLabel(entry.createdAt))
    );
  }));
}

function openIssueDialog(issue, state, ctx) {
  const readOnly = issue.status === "closed";
  const draft = issueDraft(issue);
  const owner = el("input", { type: "text", maxLength: "100", value: draft.owner, disabled: readOnly, name: "owner" });
  const disposition = el("textarea", { rows: "3", maxLength: "1200", disabled: readOnly, name: "disposition" }, draft.disposition);
  const confirmationInputs = [0, 1, 2].map((index) => el("input", {
    type: "text", maxLength: "100", value: draft.confirmations[index] || "", disabled: readOnly, name: `confirmation${index + 1}`
  }));
  const discussionAuthorName = el("input", {
    type: "text", maxLength: "200", value: draft.discussionAuthorName || "", disabled: readOnly,
    name: "discussionAuthorName", "aria-required": "true"
  });
  const discussionText = el("textarea", { rows: "2", maxLength: "1200", disabled: readOnly, name: "discussionText", placeholder: "Add a separate discussion entry" }, draft.discussionText || "");
  const discussionList = el("div", { className: "qc-ops-discussion-host" }, renderDiscussion(issue));
  const formError = el("p", { className: "qc-ops-form-error", role: "alert" });
  const form = el("form", { className: "qc-ops-form qc-ops-issue-form", "data-preserve-drafts": "true", "data-issue-id": issue.id });
  if (hasIssueDraft(issue, draft)) form.dataset.dirty = "true";
  const captureDraft = () => ({
    owner: owner.value,
    disposition: disposition.value,
    confirmations: confirmationInputs.map((input) => input.value),
    discussionAuthorName: discussionAuthorName.value,
    discussionText: discussionText.value
  });
  const storeDraft = (current) => {
    if (hasIssueDraft(issue, current)) issueDrafts.set(issue.id, current);
    else issueDrafts.delete(issue.id);
  };
  const markDraftForPreservation = () => {
    const current = captureDraft();
    storeDraft(current);
    if (hasIssueDraft(issue, current)) form.dataset.dirty = "true";
    else delete form.dataset.dirty;
    return current;
  };
  const dispositionInputs = [owner, disposition, ...confirmationInputs];
  const initialDisposition = dispositionValue(savedIssueDraft(issue));
  const initialDispositionComplete = Boolean(initialDisposition.owner.trim() && initialDisposition.disposition.trim() && initialDisposition.confirmations.every((name) => name.trim()));
  const saveStatus = el("p", { className: "save-status qc-ops-issue-save-status", role: "status", "aria-live": "polite" }, initialDispositionComplete ? "Saved" : "Saved · Incomplete");
  const reloadLatestButton = button("Reload latest data", () => {
    const dialogTitle = document.querySelector("#qc-dialog .dialog-header h2")?.textContent || `${text(issue.number, "Issue")} · ${text(issue.title)}`;
    showDialog("Unsaved edits", el("div", { className: "discard-prompt" },
      el("p", {}, "Some edits could not be saved. Reloading will discard this tab’s drafts."),
      el("div", { className: "button-row" },
        button("Keep editing", () => showDialog(dialogTitle, form), "button-secondary"),
        button("Discard edits and reload", () => {
          closeDialog(true);
          activeIssueDialogRuntime?.dispose();
          window.dispatchEvent(new CustomEvent("masterqc:discard-operation-drafts"));
          void ctx.refresh?.();
        }, "button-danger"),
      ),
    ));
  }, "button button-secondary");
  reloadLatestButton.hidden = true;
  const autosaveController = readOnly ? null : createInspectionAutosaveController();
  const autosaveEntry = autosaveController?.register(issue.id, {
    initial: initialDisposition,
    initiallySaved: true,
    isValid: (value) => typeof value.owner === "string" && typeof value.disposition === "string" &&
      Array.isArray(value.confirmations) && value.confirmations.length === 3 && value.confirmations.every((name) => typeof name === "string"),
    isComplete: (value) => Boolean(value.owner.trim() && value.disposition.trim() && value.confirmations.every((name) => name.trim())),
    save: (value) => runCommand(ctx, "saveIssue", { id: issue.id, ...value }, { autosave: true, render: false, silent: true }),
    refreshCommitted: () => ctx.refreshState?.({ render: false }),
    verifyCommitted: (latestState, sentValue) => {
      const saved = list(latestState?.issues).find((item) => item.id === issue.id);
      return Boolean(saved && sameDisposition(savedIssueDraft(saved), sentValue));
    },
    onStatus: (status) => { saveStatus.textContent = status; },
    onSaved: (value) => {
      reloadLatestButton.hidden = true;
      Object.assign(issue, value);
      issue.confirmations = [...value.confirmations];
      const row = [...document.querySelectorAll(".app-main tr[data-issue-id]")].find((item) => item.dataset.issueId === issue.id);
      const ownerCell = row?.querySelector("[data-issue-owner]");
      if (ownerCell) ownerCell.textContent = value.owner || "Unassigned";
      if (row) row.dataset.search = [issue.number, issue.title, value.owner, sourceText(issue, state), issue.disposition].join(" ").toLowerCase();
      storeDraft(captureDraft());
      if (hasIssueDraft(issue, captureDraft())) form.dataset.dirty = "true";
      else delete form.dataset.dirty;
    },
    onSaveError: (error) => {
      const message = error instanceof Error ? error.message : String(error || "The disposition could not be saved.");
      formError.textContent = message;
      reloadLatestButton.hidden = !/revision|stale|another tab changed|changed since your last view/i.test(message);
    },
    onSyncError: (error) => {
      const message = error instanceof Error ? error.message : String(error || "The saved disposition could not be verified.");
      formError.textContent = message;
      reloadLatestButton.hidden = false;
    },
  });
  if (autosaveEntry && draftDiffers(issue, draft)) autosaveEntry.update(dispositionValue(draft));
  let closeSubmitting = false;
  const flushDisposition = async () => {
    const current = markDraftForPreservation();
    autosaveEntry?.update(dispositionValue(current), { immediate: true });
    if (!autosaveController?.hasPending()) return true;

    const wasDisabled = dispositionInputs.map((input) => input.disabled);
    dispositionInputs.forEach((input) => { input.disabled = true; });
    const saved = await autosaveController.flushAll();
    dispositionInputs.forEach((input, index) => { input.disabled = wasDisabled[index]; });
    if (!saved) {
      if (!formError.textContent) formError.textContent = "Disposition changes could not be saved.";
      return false;
    }
    const latest = markDraftForPreservation();
    if (draftDiffers(issue, latest)) {
      formError.textContent = "Disposition changes could not be confirmed.";
      return false;
    }
    return true;
  };
  const closeButton = button("Close issue", async () => {
    if (closeSubmitting) return;
    if (!(await flushDisposition())) return;
    const current = markDraftForPreservation();
    if (current.discussionText.trim()) {
      notify("Add the discussion entry or clear it before closing this issue.", true);
      return;
    }
    if (!current.owner.trim() || !current.disposition.trim() || current.confirmations.some((name) => !name.trim())) {
      notify("An owner, formal disposition, and all three confirmation names are required before closure.", true);
      return;
    }
    closeSubmitting = true;
    const controls = [...dispositionInputs, discussionAuthorName, discussionText];
    const wasDisabled = controls.map((input) => input.disabled);
    controls.forEach((input) => { input.disabled = true; });
    discussionButton.disabled = true;
    closeButton.disabled = true;
    const runtime = activeIssueDialogRuntime;
    if (runtime?.form === form) runtime.busy = true;
    try {
      const result = await runCommand(ctx, "closeIssue", { id: issue.id }, { render: false });
      if (result.ok) {
        const savedIssue = list(result.state?.issues).find((item) => item.id === issue.id);
        if (savedIssue) Object.assign(issue, savedIssue);
        issueDrafts.delete(issue.id);
        closeDialog(true);
        activeIssueDialogRuntime?.dispose();
        await ctx.navigate("issues", null, true);
      }
    } finally {
      closeSubmitting = false;
      controls.forEach((input, index) => { input.disabled = wasDisabled[index]; });
      discussionButton.disabled = readOnly;
      closeButton.disabled = readOnly;
      if (runtime?.form === form) runtime.busy = false;
    }
  }, "button button-danger");
  closeButton.disabled = readOnly;
  let discussionSubmitting = false;
  const discussionButton = button("Add discussion entry", async () => {
    if (discussionSubmitting || !(await flushDisposition()) || discussionSubmitting) return;
    const current = markDraftForPreservation();
    const authorName = current.discussionAuthorName.trim();
    if (!authorName) {
      notify("You must enter your name before adding a discussion entry.", true);
      discussionAuthorName.focus();
      return;
    }
    const entryText = current.discussionText.trim();
    if (!entryText) {
      notify("Enter a discussion entry before adding it.", true);
      discussionText.focus();
      return;
    }
    discussionSubmitting = true;
    discussionButton.disabled = true;
    closeButton.disabled = true;
    const runtime = activeIssueDialogRuntime;
    if (runtime?.form === form) runtime.busy = true;
    try {
      const response = await runCommand(ctx, "addDiscussion", { id: issue.id, text: entryText, authorName }, { render: false });
      if (response.ok) {
        const savedIssue = list(response.state?.issues).find((item) => item.id === issue.id);
        if (savedIssue) {
          Object.assign(issue, savedIssue);
          discussionList.replaceChildren(renderDiscussion(issue));
        }
        const latestDraft = issueDrafts.get(issue.id) || current;
        const clearAuthor = latestDraft.discussionAuthorName === current.discussionAuthorName && discussionAuthorName.value === current.discussionAuthorName;
        const clearText = latestDraft.discussionText === current.discussionText && discussionText.value === current.discussionText;
        if (clearAuthor) discussionAuthorName.value = "";
        if (clearText) discussionText.value = "";
        const remainingDraft = {
          ...latestDraft,
          discussionAuthorName: clearAuthor ? "" : latestDraft.discussionAuthorName,
          discussionText: clearText ? "" : latestDraft.discussionText
        };
        if (hasIssueDraft(issue, remainingDraft)) issueDrafts.set(issue.id, remainingDraft);
        else issueDrafts.delete(issue.id);
        if (hasIssueDraft(issue, remainingDraft)) form.dataset.dirty = "true";
        else delete form.dataset.dirty;
      }
    } finally {
      discussionSubmitting = false;
      discussionButton.disabled = readOnly;
      closeButton.disabled = readOnly;
      if (runtime?.form === form) runtime.busy = false;
    }
  }, "button button-secondary");
  discussionButton.disabled = readOnly;
  const updateDraft = ({ autosave = false } = {}) => {
    const next = captureDraft();
    storeDraft(next);
    if (hasIssueDraft(issue, next)) form.dataset.dirty = "true";
    else delete form.dataset.dirty;
    if (autosave) {
      formError.textContent = "";
      autosaveEntry?.update(dispositionValue(next));
    }
    queueMicrotask(() => {
      const savedDraft = issueDrafts.get(issue.id);
      if (!savedDraft || !hasIssueDraft(issue, savedDraft)) delete form.dataset.dirty;
    });
  };
  dispositionInputs.forEach((input) => {
    input.addEventListener("input", () => updateDraft({ autosave: true }));
    input.addEventListener("blur", () => autosaveEntry?.update(dispositionValue(captureDraft()), { immediate: true }));
  });
  [discussionAuthorName, discussionText].forEach((input) => input.addEventListener("input", () => updateDraft()));
  form.addEventListener("submit", (event) => event.preventDefault());
  form.append(
    sourceCard(issue, state),
    el("div", { className: "qc-ops-form-grid" }, field("Disposition owner", owner), field("Formal disposition", disposition)),
    el("fieldset", { className: "qc-ops-confirmations" },
      el("legend", {}, "Manual confirmations · names entered by staff"),
      ...confirmationInputs.map((input, index) => field(`Confirmation ${index + 1}`, input))
    ),
    saveStatus,
    el("section", { className: "qc-ops-discussion" },
      el("h3", {}, "Discussion"),
      discussionList,
      field("Your name", discussionAuthorName),
      field("New discussion entry", discussionText),
      discussionButton
    ),
    formError,
    reloadLatestButton,
    el("div", { className: "qc-ops-dialog-actions" }, closeButton)
  );
  const dialog = showDialog(`${text(issue.number, "Issue")} · ${text(issue.title)}`, form);
  dialog.dataset.operationDraftId = issue.id;
  dialog.dataset.issueId = issue.id;
  if (!issueDialogCloseListeners.has(dialog)) {
    dialog.addEventListener("close", () => {
      const runtime = activeIssueDialogRuntime;
      if (!dialog.open && runtime?.dialog === dialog) runtime.dispose();
    });
    issueDialogCloseListeners.add(dialog);
  }
  const unregisterAutosave = autosaveController ? ctx.registerAutosaveController?.(autosaveController) : null;
  const runtime = {
    dialog,
    form,
    autosaveController,
    async closeFromHeader() {
      if (this.busy) return;
      this.busy = true;
      try {
        if (!(await flushDisposition()) || activeIssueDialogRuntime !== this || !dialog.open) return;
        if (closeDialog()) this.dispose();
      } finally {
        this.busy = false;
      }
    },
    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      unregisterAutosave?.();
      if (activeIssueDialogRuntime === this) activeIssueDialogRuntime = null;
    },
    busy: false,
    disposed: false,
  };
  if (activeIssueDialogRuntime) activeIssueDialogRuntime.dispose();
  activeIssueDialogRuntime = runtime;
}

function openNewIssueDialog(state, ctx) {
  const titleInput = el("input", { type: "text", required: true, maxLength: "180", name: "title", placeholder: "Describe the issue" });
  const editableBatches = list(state.batches).filter((batch) => batch.kind !== "historical" && batch.status !== "released");
  const batchSelect = el("select", { name: "batchId" }, el("option", { value: "" }, "No batch link"), ...editableBatches.map((batch) => {
    const products = getBatchProducts(batch).map((product) => ({ ...product, variant: variantById(state).get(product.variantId) }));
    const summary = products.length ? productSummary(products, state) : text(variantById(state).get(batch.variantId)?.label, batch.variantId);
    return el("option", { value: batch.id }, `${text(batch.number)} · ${summary} · ${text(batch.factory)} ${text(batch.stage)}`);
  }));
  const rowSelect = el("select", { name: "rowId", disabled: true }, el("option", { value: "" }, "No inspection row"));
  const formError = el("p", { className: "qc-ops-form-error", role: "alert" });
  const form = el("form", { className: "qc-ops-form qc-ops-new-issue-form" });
  const updateRows = () => {
    const batch = list(state.batches).find((entry) => entry.id === batchSelect.value);
    const rows = list(batch?.rows);
    rowSelect.disabled = !batch || !rows.length;
    rowSelect.replaceChildren(el("option", { value: "" }, "No inspection row"), ...rows.map((row) => {
      const product = getBatchRowProduct(batch, row) || {};
      const label = text(row.productLabel, issueProductLabel(product, state));
      const productQty = row.productQuantity ?? product.quantity;
      const productContext = row.productLineId || product.lineId
        ? `${label} · ${productQty === null || productQty === undefined ? "quantity unknown" : `${quantity(productQty)} units`} · `
        : "";
      return el("option", { value: row.id }, `${productContext}${text(row.no)} · ${text(row.title)}${row.titleZh ? ` · ${row.titleZh}` : ""}`);
    }));
  };
  batchSelect.addEventListener("change", updateRows);
  const submit = el("button", { type: "submit", className: "button button-primary" }, "Create issue");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    formError.textContent = "";
    if (!form.reportValidity()) return;
    const data = { title: titleInput.value.trim() };
    if (batchSelect.value) data.batchId = batchSelect.value;
    if (rowSelect.value) data.rowId = rowSelect.value;
    const result = await runCommand(ctx, "createIssue", data);
    if (!result.ok) {
      formError.textContent = errorText(result.error);
      return;
    }
    closeDialog(true);
    const issueId = result.result?.entityId || result.result?.issueId;
    if (issueId) ctx.navigate("issues", issueId, true);
    else ctx.navigate("issues", null, true);
  });
  form.append(
    field("Issue title", titleInput),
    field("Related batch (optional)", batchSelect),
    field("Inspection row (optional)", rowSelect),
    formError,
    el("div", { className: "qc-ops-dialog-actions" }, button("Cancel", () => closeDialog(), "button button-secondary"), submit)
  );
  updateRows();
  showDialog("Create issue", form);
}

function renderIssueListPage(root, ctx) {
  const state = ctx.state || {};
  const issues = list(state.issues).slice().sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
  const create = button("New issue", () => openNewIssueDialog(state, ctx), "button button-primary");
  const filters = el("div", { className: "qc-ops-list-toolbar" },
    field("Search", el("input", { type: "search", placeholder: "Search issue, owner, batch, or row", "aria-label": "Search issues" })),
    field("Status", el("select", { "aria-label": "Filter issues by status" },
      el("option", { value: "all" }, "All issues"), el("option", { value: "open" }, "Open"), el("option", { value: "closed" }, "Closed")
    ))
  );
  const search = filters.querySelector('input[type="search"]');
  const status = filters.querySelector("select");
  const tbody = el("tbody");
  for (const issue of issues) {
    const source = sourceText(issue, state);
    const searchText = [issue.number, issue.title, issue.owner, source, issue.disposition].join(" ").toLowerCase();
    const open = button("Open", () => {
      if (ctx.selectedId !== issue.id) ctx.navigate("issues", issue.id);
      else openIssueDialog(issue, state, ctx);
    }, "button button-secondary qc-ops-small-button");
    const ownerCell = el("td", { "data-issue-owner": "" }, text(issue.owner, "Unassigned"));
    tbody.append(el("tr", { "data-issue-id": issue.id, "data-status": issue.status, "data-search": searchText },
      el("td", {}, text(issue.number)),
      el("td", {}, el("strong", {}, text(issue.title)), el("small", { className: "qc-ops-subline" }, source)),
      ownerCell,
      el("td", {}, statusPill(issue.status)),
      el("td", {}, dateLabel(issue.createdAt)),
      el("td", {}, open)
    ));
  }
  const updateFilters = () => {
    const query = search.value.trim().toLowerCase();
    for (const row of tbody.rows) row.hidden = (status.value !== "all" && row.dataset.status !== status.value) || (query && !row.dataset.search.includes(query));
  };
  search.addEventListener("input", updateFilters);
  status.addEventListener("change", updateFilters);
  const table = el("table", { className: "qc-ops-list-table" },
    el("thead", {}, el("tr", {}, ...["Issue", "Source", "Owner", "Status", "Created", ""].map((label) => el("th", { scope: "col" }, label)))),
    tbody
  );
  const sections = [];
  if (!issues.length) sections.push(el("section", { className: "card qc-ops-empty-card" },
    el("h2", {}, "No issues recorded"),
    create
  ));
  else sections.push(el("section", { className: "card qc-ops-list-card" }, filters, el("div", { className: "qc-ops-table-scroll" }, table)));
  root.replaceChildren(pageHeading("Issues", "Track source evidence, discussion, formal disposition, three manual confirmations, and explicit closure.", [create]), ...sections);
  if (ctx.selectedId) {
    const issue = issues.find((item) => item.id === ctx.selectedId);
    if (issue) openIssueDialog(issue, state, ctx);
  }
}

export function clearIssueDrafts() {
  issueDrafts.clear();
}

window.addEventListener("masterqc:discard-operation-drafts", clearIssueDrafts);
window.addEventListener("masterqc:discard-dialog-draft", (event) => {
  const issueId = event.detail?.operationDraftId || document.querySelector("#qc-dialog")?.dataset.operationDraftId;
  if (issueId) issueDrafts.delete(issueId);
});

export function renderIssuesPage(root, ctx) {
  renderIssueListPage(root, ctx);
}
