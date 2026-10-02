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
import { createInspectionAutosaveController } from "./qc-inspection-autosave.js";
import {
  attachmentCanPreview,
  attachmentDownload,
  createAttachmentPreview,
  issueAttachmentCategory,
  MEBIBYTE,
  normalizedMimeType,
  readAttachmentFile,
} from "./qc-attachments.js";
import { getBatchProducts, getBatchRowProduct } from "../core/qc-batch-products.js";
import { hasRequiredIssuePhoto, remainingIssueDraftAfterDiscussion, submitDiscussionEntry } from "./qc-issue-drafts.js";

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

function rowHasSavedIssueResult(row) {
  const legacyTimeOmitted = row && !Object.hasOwn(row, "actualTimeSeconds");
  return Boolean(row?.savedAt) && row.defectiveQty !== null && row.defectiveQty !== undefined &&
    (row.actualTimeSeconds !== null && row.actualTimeSeconds !== undefined || legacyTimeOmitted);
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

function hasDiscussionDraft(draft) {
  return Boolean(draft.discussionAuthorName || draft.discussionText);
}

function hasIssueDraft(issue, draft) {
  return draftDiffers(issue, draft) || hasDiscussionDraft(draft);
}

function sourcePhotos(issue, state) {
  const photoIds = sourcePhotoIds(issue);
  const assets = new Map(list(state.assets).map((asset) => [asset.id, asset]));
  return photoIds.map((id) => assets.get(id)).filter(Boolean);
}

function sourcePhotoIds(issue) {
  const snapshot = sourceSnapshot(issue);
  const row = snapshot.row || snapshot;
  return list(row.photoIds ?? snapshot.photoIds);
}

function issueAttachments(issue, state) {
  if (Array.isArray(issue.attachments)) return issue.attachments;
  const assets = new Map(list(state.assets).map((asset) => [asset.id, asset]));
  return list(issue.attachmentIds).map((id) => assets.get(id)).filter(Boolean);
}

function newRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [...bytes].map((byte, index) => `${index === 4 || index === 6 || index === 8 || index === 10 ? "-" : ""}${byte.toString(16).padStart(2, "0")}`).join("");
}

function renderIssueAttachments(issue, state, ctx, readOnly, markDraftForPreservation, onIssueUpdated = null, runIssueCommand = null) {
  const host = el("section", { className: "qc-ops-issue-attachments" });
  const previewHost = el("div", { className: "qc-ops-issue-attachment-preview-host" });
  const pendingOperations = new Set();
  const removeButtons = new Set();
  let disabled = readOnly;
  let disposed = false;
  let previewCleanup = () => {};
  let pendingOperationError = null;
  const startOperation = (work) => {
    pendingOperationError = null;
    const operation = Promise.resolve().then(work);
    pendingOperations.add(operation);
    operation.then(
      () => pendingOperations.delete(operation),
      () => pendingOperations.delete(operation),
    );
    return operation;
  };
  const issueCommand = (type, data, options) => runIssueCommand
    ? runIssueCommand(type, data, options)
    : runCommand(ctx, type, data, options);
  const flushPending = async () => {
    while (pendingOperations.size) await Promise.allSettled([...pendingOperations]);
    return !pendingOperationError;
  };
  const clearPreview = () => {
    previewCleanup();
    previewCleanup = () => {};
    previewHost.replaceChildren();
  };
  const showInlinePreview = (asset) => {
    clearPreview();
    const preview = createAttachmentPreview(asset);
    previewCleanup = preview.cleanup;
    const closePreview = button("Close preview", clearPreview, "button-quiet qc-ops-small-button");
    previewHost.replaceChildren(el("div", { className: "qc-ops-attachment-preview" },
      el("strong", { className: "qc-ops-attachment-preview-name" }, text(asset.name, "Attachment")),
      preview.element,
      closePreview,
    ));
    if (preview.load) {
      void preview.load(preview.element).catch((error) => {
        preview.element.textContent = error instanceof Error ? error.message : "The file preview could not be loaded.";
      });
    }
  };

  const photoInput = el("input", { type: "file", accept: "image/*", multiple: true, className: "qc-ops-hidden-file", disabled: readOnly, "aria-label": "Choose issue photos" });
  const fileInput = el("input", { type: "file", multiple: true, className: "qc-ops-hidden-file", disabled: readOnly, "aria-label": "Choose issue files" });
  const photoButton = button("Add photos", () => photoInput.click(), "button-secondary qc-ops-small-button");
  const fileButton = button("Add files", () => fileInput.click(), "button-secondary qc-ops-small-button");
  photoButton.disabled = disabled;
  fileButton.disabled = disabled;

  const upload = async (input) => {
    const selected = Array.from(input.files || []);
    if (!selected.length || disposed) return;
    markDraftForPreservation();
    try {
      const files = await Promise.all(selected.map(async (file) => {
        const mimeType = normalizedMimeType(file.name, file.type);
        const category = issueAttachmentCategory(mimeType);
        const payload = await readAttachmentFile(file, {
          maxBytes: category === "photo" ? 5 * MEBIBYTE : 10 * MEBIBYTE,
          category: category === "photo" ? "photo" : null,
        });
        return { ...payload, category };
      }));
      if (disposed) return;
      const response = await issueCommand("addIssueAttachments", { id: issue.id, files }, { render: false });
      if (!response.ok) {
        pendingOperationError = response.error || new Error("The issue evidence could not be saved.");
        return;
      }
      input.value = "";
      const latestState = response.state || state;
      const latestIssue = list(latestState.issues).find((entry) => entry.id === issue.id) || issue;
      onIssueUpdated?.(latestIssue, latestState);
      render(latestIssue, latestState);
      markDraftForPreservation();
    } catch (error) {
      pendingOperationError = error;
      notify(errorText(error, "Could not read the selected file."), true);
    }
  };
  photoInput.addEventListener("change", () => { void startOperation(() => upload(photoInput)); });
  fileInput.addEventListener("change", () => { void startOperation(() => upload(fileInput)); });

  const removeAttachment = async (asset) => {
    if (disposed || disabled) return;
    if (!window.confirm(`Remove “${text(asset.name, "this file")}” from this issue?`)) return;
    markDraftForPreservation();
    try {
      const response = await issueCommand("removeIssueAttachment", { id: issue.id, assetId: asset.id }, { render: false });
      if (!response.ok) {
        pendingOperationError = response.error || new Error("The issue attachment could not be removed.");
        return;
      }
      const latestState = response.state || state;
      const latestIssue = list(latestState.issues).find((entry) => entry.id === issue.id) || issue;
      onIssueUpdated?.(latestIssue, latestState);
      render(latestIssue, latestState);
      markDraftForPreservation();
    } catch (error) {
      pendingOperationError = error;
      notify(errorText(error, "Could not remove the attachment."), true);
    }
  };

  const render = (currentIssue, currentState) => {
    clearPreview();
    const attachments = issueAttachments(currentIssue, currentState);
    const listHost = attachments.length
      ? el("ul", { className: "qc-ops-issue-attachment-list" }, ...attachments.map((asset) => {
        const category = asset.category || issueAttachmentCategory(asset.mimeType);
        const assetName = text(asset.name, "Attachment");
        const thumbnail = category === "photo" && asset.dataUrl
          ? el("img", {
            className: "qc-ops-issue-attachment-thumbnail",
            src: asset.dataUrl,
            alt: assetName,
            title: assetName,
            loading: "lazy",
          })
          : null;
        const preview = attachmentCanPreview(asset)
          ? button("Preview", () => showInlinePreview(asset), "button-quiet qc-ops-small-button")
          : null;
        if (preview) preview.setAttribute("aria-label", `Preview ${assetName}`);
        const download = attachmentDownload(asset);
        download.setAttribute("aria-label", `Download ${assetName}`);
        const remove = button("Remove", () => { void startOperation(() => removeAttachment(asset)); }, "button-quiet qc-ops-attachment-remove");
        remove.setAttribute("aria-label", `Remove ${assetName} from this issue`);
        remove.disabled = disabled;
        removeButtons.add(remove);
        return el("li", {},
          thumbnail,
          el("span", { className: "qc-ops-issue-attachment-name", title: assetName }, assetName),
          el("small", {}, category === "photo" ? "Photo" : "File"),
          preview,
          download,
          remove,
        );
      }))
      : el("p", { className: "qc-ops-empty-issue-attachments" }, "No evidence");
    host.replaceChildren(
      el("div", { className: "qc-ops-section-heading" }, el("h3", {}, "Evidence"),
        el("div", { className: "qc-ops-issue-attachment-actions" }, photoButton, fileButton)),
      listHost,
      previewHost,
      photoInput,
      fileInput,
    );
  };
  render(issue, state);
  return {
    element: host,
    cleanup() {
      disposed = true;
      clearPreview();
    },
    flushPending,
    hasPending: () => pendingOperations.size > 0,
    setDisabled(value) {
      disabled = readOnly || Boolean(value);
      photoButton.disabled = disabled;
      fileButton.disabled = disabled;
      photoInput.disabled = disabled;
      fileInput.disabled = disabled;
      removeButtons.forEach((remove) => { remove.disabled = disabled; });
    },
  };
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
    Object.hasOwn(issue, "reportedBy") ? `Reported by: ${text(issue.reportedBy)}` : "",
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
  const sourceIds = sourcePhotoIds(issue);
  const evidence = sourcePhotos(issue, state);
  const evidenceBlock = sourceIds.length || evidence.length
    ? el("div", { className: "qc-ops-issue-evidence" },
      el("strong", {}, "Source photos"),
      evidence.length ? el("div", { className: "qc-ops-issue-evidence-list" }, ...evidence.map((asset) => el("figure", {},
        el("img", { src: asset.dataUrl, alt: asset.name || "Inspection source photo" }),
        el("figcaption", {}, text(asset.name, "Inspection photo"))
      ))) : null,
      sourceIds.length > evidence.length
        ? el("p", {}, "Some inspection source photos are unavailable in this workspace.")
        : null
    )
    : null;
  return el("section", { className: "qc-ops-source-card" },
    el("div", { className: "qc-ops-source-heading" },
      el("div", {}, el("small", {}, "Immutable source snapshot"), el("h3", {}, sourceTitle), sourceTitleZh ? el("p", { lang: "zh" }, sourceTitleZh) : null),
      statusPill(issue.status)
    ),
    String(issue.description || "").trim() ? el("div", { className: "qc-ops-issue-description" },
      el("strong", {}, "Description"), el("p", {}, String(issue.description).trim())) : null,
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
  let currentIssue = issue;
  let currentState = state;
  const readOnly = currentIssue.status === "closed";
  const draft = issueDraft(currentIssue);
  const owner = el("input", { type: "text", maxLength: "200", value: draft.owner, disabled: readOnly, name: "owner" });
  const disposition = el("textarea", { rows: "3", maxLength: "1200", disabled: readOnly, name: "disposition" }, draft.disposition);
  const confirmationInputs = [0, 1, 2].map((index) => el("input", {
    type: "text", maxLength: "100", value: draft.confirmations[index] || "", disabled: readOnly, name: `confirmation${index + 1}`
  }));
  const discussionAuthorName = el("input", {
    type: "text", maxLength: "200", value: draft.discussionAuthorName || "", disabled: readOnly,
    name: "discussionAuthorName", "aria-required": "true"
  });
  const discussionText = el("textarea", { rows: "2", maxLength: "1200", disabled: readOnly, name: "discussionText", placeholder: "Add a separate discussion entry" }, draft.discussionText || "");
  const discussionList = el("div", { className: "qc-ops-discussion-host" }, renderDiscussion(currentIssue));
  const formError = el("p", { className: "qc-ops-form-error", role: "alert" });
  const saveStatus = el("p", { className: "save-status qc-ops-issue-save-status", role: "status", "aria-live": "polite" });
  const form = el("form", { className: "qc-ops-form qc-ops-issue-form", "data-preserve-drafts": "true", "data-issue-id": currentIssue.id });
  if (hasIssueDraft(currentIssue, draft)) form.dataset.dirty = "true";

  const captureDraft = () => ({
    owner: owner.value,
    disposition: disposition.value,
    confirmations: confirmationInputs.map((input) => input.value),
    discussionAuthorName: discussionAuthorName.value,
    discussionText: discussionText.value
  });
  const updateIssueListProjection = () => {
    const row = [...document.querySelectorAll("tr[data-issue-id]")].find((item) => item.dataset.issueId === currentIssue.id);
    const ownerCell = row?.querySelector("[data-issue-owner]");
    if (ownerCell) ownerCell.textContent = currentIssue.owner || "Unassigned";
    if (row) row.dataset.search = [currentIssue.number, currentIssue.title, currentIssue.reportedBy, currentIssue.owner, sourceText(currentIssue, currentState), currentIssue.disposition].join(" ").toLowerCase();
  };
  const adoptLatestIssue = (latestIssue, latestState) => {
    if (!latestIssue) return false;
    const latestRevision = Number(latestState?.revision);
    const currentRevision = Number(currentState?.revision);
    if (Number.isFinite(latestRevision) && Number.isFinite(currentRevision) && latestRevision < currentRevision) return false;
    currentIssue = latestIssue;
    currentState = latestState || currentState;
    Object.assign(issue, latestIssue);
    updateIssueListProjection();
    return true;
  };
  const storeDraft = (current) => {
    if (hasIssueDraft(currentIssue, current)) issueDrafts.set(currentIssue.id, current);
    else issueDrafts.delete(currentIssue.id);
  };
  const markDraftForPreservation = () => {
    const current = captureDraft();
    storeDraft(current);
    if (hasIssueDraft(currentIssue, current)) form.dataset.dirty = "true";
    else delete form.dataset.dirty;
    return current;
  };

  const runEvidenceCommand = async (type, data, options = {}) => {
    if (autosaveController && !(await autosaveController.flushAll())) {
      return { ok: false, blocked: true, error: new Error("Disposition changes could not be saved.") };
    }
    return runCommand(ctx, type, data, { ...options, autosave: true, render: false });
  };
  const evidence = renderIssueAttachments(currentIssue, currentState, ctx, readOnly, markDraftForPreservation, (nextIssue, nextState) => {
    adoptLatestIssue(nextIssue, nextState);
  }, runEvidenceCommand);
  const dispositionInputs = [owner, disposition, ...confirmationInputs];
  const initialDisposition = dispositionValue(savedIssueDraft(currentIssue));
  const initialDispositionComplete = Boolean(initialDisposition.owner && initialDisposition.disposition && initialDisposition.confirmations.every(Boolean));
  saveStatus.textContent = initialDispositionComplete ? "Saved" : "Saved · Incomplete";
  const autosaveController = readOnly ? null : createInspectionAutosaveController();
  let closeSubmitting = false;
  let discussionSubmitting = false;
  let deleteSubmitting = false;
  let runtime = null;
  let dialog = null;
  let discussionButton;
  let closeButton;
  let deleteButton;
  let deleteConfirmation;
  let cancelDeleteButton;
  let confirmDeleteButton;

  const reloadLatestButton = button("Reload latest data", async () => {
    if (runtime?.busy) return;
    if (runtime) runtime.busy = true;
    try {
      await evidence.flushPending();
      if (!dialog?.open) return;
      const dialogTitle = document.querySelector("#qc-dialog .dialog-header h2")?.textContent || `${text(currentIssue.number, "Issue")} · ${text(currentIssue.title)}`;
      showDialog("Unsaved edits", el("div", { className: "discard-prompt" },
        el("p", {}, "Some edits could not be saved. Reloading will discard this tab’s drafts."),
        el("div", { className: "button-row" },
          button("Keep editing", () => showDialog(dialogTitle, form), "button-secondary"),
          button("Discard edits and reload", () => {
            closeDialog(true);
            runtime?.dispose();
            window.dispatchEvent(new CustomEvent("masterqc:discard-operation-drafts"));
            void ctx.refresh?.();
          }, "button-danger"),
        ),
      ));
    } finally {
      if (runtime) runtime.busy = false;
    }
  }, "button button-secondary");
  reloadLatestButton.hidden = true;

  const autosaveEntry = autosaveController?.register(currentIssue.id, {
    initial: initialDisposition,
    initiallySaved: true,
    isValid: (value) => typeof value.owner === "string" && typeof value.disposition === "string" &&
      Array.isArray(value.confirmations) && value.confirmations.length === 3 && value.confirmations.every((name) => typeof name === "string"),
    isComplete: (value) => Boolean(value.owner.trim() && value.disposition.trim() && value.confirmations.every((name) => name.trim())),
    save: (value) => runCommand(ctx, "saveIssue", { id: currentIssue.id, ...value }, { autosave: true, render: false, silent: true }),
    refreshCommitted: () => ctx.refreshState?.({ render: false }),
    verifyCommitted: (latestState, sentValue) => {
      const saved = list(latestState?.issues).find((item) => item.id === currentIssue.id);
      return Boolean(saved && sameDisposition(savedIssueDraft(saved), sentValue));
    },
    onStatus: (status) => { saveStatus.textContent = status; },
    onSaved: (value, response) => {
      formError.textContent = "";
      reloadLatestButton.hidden = true;
      const latestState = response?.state || currentState;
      const latestIssue = list(latestState.issues).find((item) => item.id === currentIssue.id) || {
        ...currentIssue,
        ...value,
        confirmations: [...value.confirmations],
      };
      adoptLatestIssue(latestIssue, latestState);
      const liveDraft = captureDraft();
      storeDraft(liveDraft);
      if (hasIssueDraft(currentIssue, liveDraft)) form.dataset.dirty = "true";
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
  if (autosaveEntry && draftDiffers(currentIssue, draft)) autosaveEntry.update(dispositionValue(draft));

  const lifecycleController = autosaveController ? {
    async flushAll() {
      const saved = await autosaveController.flushAll();
      if (!saved) return false;
      return evidence.flushPending();
    },
    hasPending() {
      return autosaveController.hasPending() || evidence.hasPending();
    },
    dispose() {
      autosaveController.dispose();
      evidence.cleanup();
    },
  } : null;
  const flushDisposition = async () => {
    const current = markDraftForPreservation();
    autosaveEntry?.update(dispositionValue(current), { immediate: true });
    if (!lifecycleController?.hasPending()) return true;

    const wasDisabled = dispositionInputs.map((input) => input.disabled);
    dispositionInputs.forEach((input) => { input.disabled = true; });
    const saved = await lifecycleController.flushAll();
    dispositionInputs.forEach((input, index) => { input.disabled = wasDisabled[index]; });
    if (!saved) {
      if (!formError.textContent) formError.textContent = "Disposition changes could not be saved.";
      return false;
    }
    const latest = markDraftForPreservation();
    if (draftDiffers(currentIssue, latest)) {
      formError.textContent = "Disposition changes could not be confirmed.";
      return false;
    }
    return true;
  };

  closeButton = button("Close issue", async () => {
    if (closeSubmitting || discussionSubmitting) return;
    closeSubmitting = true;
    closeButton.disabled = true;
    if (runtime) runtime.busy = true;
    let controls;
    let wasDisabled;
    try {
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
      controls = [...dispositionInputs, discussionAuthorName, discussionText];
      wasDisabled = controls.map((input) => input.disabled);
      controls.forEach((input) => { input.disabled = true; });
      evidence.setDisabled(true);
      discussionButton.disabled = true;
      closeButton.disabled = true;
      const result = await runCommand(ctx, "closeIssue", { id: currentIssue.id }, { render: false });
      if (result.ok) {
        const latestIssue = list(result.state?.issues).find((item) => item.id === currentIssue.id);
        if (latestIssue) adoptLatestIssue(latestIssue, result.state);
        issueDrafts.delete(currentIssue.id);
        closeDialog(true);
        runtime?.dispose();
        await ctx.navigate("issues", null, true);
      }
    } finally {
      closeSubmitting = false;
      if (controls && wasDisabled) controls.forEach((input, index) => { input.disabled = wasDisabled[index]; });
      evidence.setDisabled(false);
      if (discussionButton) discussionButton.disabled = readOnly;
      if (closeButton) closeButton.disabled = readOnly;
      if (runtime) runtime.busy = false;
    }
  }, "button button-danger");
  closeButton.disabled = readOnly;

  const linkedBatch = list(currentState.batches).find((batch) => batch.id === currentIssue.batchId);
  const protectedBatchIssue = Boolean(linkedBatch &&
    (linkedBatch.kind === "historical" || linkedBatch.status === "historical" || linkedBatch.status === "released"));
  const runIssueDeletion = async () => {
    if (deleteSubmitting || closeSubmitting || discussionSubmitting || runtime?.busy || protectedBatchIssue) return;
    deleteSubmitting = true;
    if (runtime) runtime.busy = true;
    const mutableInputs = [...dispositionInputs, discussionAuthorName, discussionText];
    const priorDisabled = mutableInputs.map((input) => input.disabled);
    mutableInputs.forEach((input) => { input.disabled = true; });
    evidence.setDisabled(true);
    if (discussionButton) discussionButton.disabled = true;
    if (closeButton) closeButton.disabled = true;
    if (deleteButton) deleteButton.disabled = true;
    if (cancelDeleteButton) cancelDeleteButton.disabled = true;
    if (confirmDeleteButton) confirmDeleteButton.disabled = true;
    reloadLatestButton.disabled = true;
    let deleted = false;
    try {
      if (!(await flushDisposition())) return;
      if (!(await evidence.flushPending())) {
        formError.textContent = "Issue evidence changes could not be saved. Try again before deleting this issue.";
        return;
      }
      markDraftForPreservation();
      const response = await runCommand(ctx, "deleteIssue", { id: currentIssue.id }, { render: false });
      if (!response.ok && !response.committed) {
        formError.textContent = errorText(response.error, "The issue could not be deleted.");
        return;
      }
      if (response.committed && !response.ok && typeof ctx.refreshState === "function") {
        const refresh = await ctx.refreshState({ render: false });
        if (!refresh?.ok) notify("The issue was deleted, but the latest issue list could not be loaded. Reload before continuing.", true);
        else currentState = refresh.state;
      }
      deleted = true;
      issueDrafts.delete(currentIssue.id);
      runtime?.dispose();
      closeDialog(true);
      await ctx.navigate("issues", null, true);
    } finally {
      deleteSubmitting = false;
      if (!deleted) {
        mutableInputs.forEach((input, index) => { input.disabled = priorDisabled[index]; });
        evidence.setDisabled(false);
        if (discussionButton) discussionButton.disabled = readOnly;
        if (closeButton) closeButton.disabled = readOnly;
        if (deleteButton) deleteButton.disabled = protectedBatchIssue;
        if (cancelDeleteButton) cancelDeleteButton.disabled = false;
        if (confirmDeleteButton) confirmDeleteButton.disabled = false;
        reloadLatestButton.disabled = false;
      }
      if (runtime) runtime.busy = false;
    }
  };
  cancelDeleteButton = button("Cancel", () => {
    if (deleteSubmitting || runtime?.busy) return;
    deleteConfirmation.hidden = true;
    deleteButton.hidden = false;
    deleteButton.focus();
  }, "button button-secondary");
  confirmDeleteButton = button("Confirm delete", async () => {
    if (deleteConfirmation.hidden) return;
    await runIssueDeletion();
  }, "button button-danger");
  deleteConfirmation = el("section", {
    className: "qc-ops-delete-confirmation",
    hidden: true,
    role: "group",
    ariaLabel: "Confirm issue deletion",
  },
    el("p", {}, `Delete issue ${text(currentIssue.number, "Issue")}? Its discussion and uploaded evidence will be removed. This action cannot be undone.`),
    el("div", { className: "button-row" }, cancelDeleteButton, confirmDeleteButton),
  );
  deleteButton = button("Delete issue", () => {
    if (deleteSubmitting || closeSubmitting || discussionSubmitting || runtime?.busy || protectedBatchIssue) return;
    deleteButton.hidden = true;
    deleteConfirmation.hidden = false;
    cancelDeleteButton.focus();
  }, "button button-danger");
  deleteButton.disabled = protectedBatchIssue;
  if (protectedBatchIssue) deleteButton.title = "Issues linked to released or historical batches cannot be deleted.";

  discussionButton = button("Add discussion entry", async () => {
    if (discussionSubmitting || closeSubmitting) return;
    discussionSubmitting = true;
    discussionButton.disabled = true;
    closeButton.disabled = true;
    if (runtime) runtime.busy = true;
    try {
      if (!(await flushDisposition())) return;
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
      discussionButton.disabled = true;
      closeButton.disabled = true;
      const response = await submitDiscussionEntry(ctx, currentIssue.id, entryText, authorName);
      if (!response.ok) return;
      const latestState = response.state || currentState;
      const latestIssue = list(latestState.issues).find((entry) => entry.id === currentIssue.id);
      if (!latestIssue) {
        notify("The discussion entry was saved, but the updated Issue could not be reloaded.", true);
        return;
      }
      adoptLatestIssue(latestIssue, latestState);
      discussionList.replaceChildren(renderDiscussion(currentIssue));
      const latestDraft = issueDrafts.get(currentIssue.id) || current;
      const remainingDraft = remainingIssueDraftAfterDiscussion(latestDraft, current);
      if (discussionAuthorName.value === current.discussionAuthorName) discussionAuthorName.value = remainingDraft.discussionAuthorName;
      if (discussionText.value === current.discussionText) discussionText.value = remainingDraft.discussionText;
      if (hasIssueDraft(currentIssue, remainingDraft)) issueDrafts.set(currentIssue.id, remainingDraft);
      else issueDrafts.delete(currentIssue.id);
      if (hasIssueDraft(currentIssue, remainingDraft)) form.dataset.dirty = "true";
      else delete form.dataset.dirty;
    } finally {
      discussionSubmitting = false;
      if (discussionButton) discussionButton.disabled = readOnly;
      if (closeButton) closeButton.disabled = readOnly;
      if (runtime) runtime.busy = false;
    }
  }, "button button-secondary");
  discussionButton.disabled = readOnly;

  const updateDraft = ({ autosave = false } = {}) => {
    const next = captureDraft();
    storeDraft(next);
    if (hasIssueDraft(currentIssue, next)) form.dataset.dirty = "true";
    else delete form.dataset.dirty;
    if (autosave) {
      formError.textContent = "";
      autosaveEntry?.update(dispositionValue(next));
    }
    queueMicrotask(() => {
      const savedDraft = issueDrafts.get(currentIssue.id);
      if (!savedDraft || !hasIssueDraft(currentIssue, savedDraft)) delete form.dataset.dirty;
    });
  };
  dispositionInputs.forEach((input) => {
    input.addEventListener("input", () => updateDraft({ autosave: true }));
    input.addEventListener("blur", () => autosaveEntry?.update(dispositionValue(captureDraft()), { immediate: true }));
  });
  [discussionAuthorName, discussionText].forEach((input) => input.addEventListener("input", () => updateDraft()));
  form.addEventListener("submit", (event) => event.preventDefault());
  form.append(
    sourceCard(currentIssue, currentState),
    evidence.element,
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
    deleteConfirmation,
    el("div", { className: "qc-ops-dialog-actions" }, closeButton, deleteButton)
  );
  dialog = showDialog(`${text(currentIssue.number, "Issue")} · ${text(currentIssue.title)}`, form);
  dialog.dataset.operationDraftId = currentIssue.id;
  dialog.dataset.issueId = currentIssue.id;
  if (!issueDialogCloseListeners.has(dialog)) {
    dialog.addEventListener("close", () => {
      const activeRuntime = activeIssueDialogRuntime;
      if (!dialog.open && activeRuntime?.dialog === dialog) activeRuntime.dispose();
    });
    issueDialogCloseListeners.add(dialog);
  }
  const unregisterAutosave = lifecycleController ? ctx.registerAutosaveController?.(lifecycleController) : null;
  runtime = {
    dialog,
    form,
    autosaveController: lifecycleController,
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
      if (unregisterAutosave) unregisterAutosave();
      else if (lifecycleController) lifecycleController.dispose();
      else evidence.cleanup();
      if (activeIssueDialogRuntime === this) activeIssueDialogRuntime = null;
    },
    busy: false,
    disposed: false,
  };
  if (activeIssueDialogRuntime) activeIssueDialogRuntime.dispose();
  activeIssueDialogRuntime = runtime;
}

export function openNewIssueDialog(state, ctx, options = {}) {
  const requestId = options.requestId || newRequestId();
  const fixedBatch = options.batchId ? list(state.batches).find((batch) => batch.id === options.batchId) : null;
  const fixedRow = fixedBatch ? list(fixedBatch.rows).find((row) => row.id === options.rowId) : null;
  const reportedByInput = el("input", { type: "text", required: true, maxLength: "200", name: "reportedBy", value: options.reportedBy || "" });
  const initialOwnerInput = el("input", { type: "text", maxLength: "200", name: "owner", value: options.owner || "" });
  const titleInput = el("input", {
    type: "text", required: true, maxLength: "180", name: "title", placeholder: "Describe the issue", value: options.title || "",
  });
  const descriptionInput = el("textarea", { rows: "3", maxLength: "2000", name: "description" }, options.description || "");
  const formError = el("p", { className: "qc-ops-form-error", role: "alert" });
  const form = el("form", { className: "qc-ops-form qc-ops-new-issue-form", "data-preserve-drafts": "true" });
  const selectedFiles = [];
  const selectedFileHost = el("div", { className: "qc-ops-selected-issue-files" });
  const photoInput = el("input", { type: "file", accept: "image/*", multiple: true, className: "qc-ops-hidden-file", "aria-label": "Choose issue photos" });
  const fileInput = el("input", { type: "file", multiple: true, className: "qc-ops-hidden-file", "aria-label": "Choose issue files" });
  const photosButton = button("Choose photos", () => photoInput.click(), "button-secondary");
  const filesButton = button("Choose files", () => fileInput.click(), "button-secondary");
  const renderSelectedFiles = () => {
    selectedFileHost.replaceChildren(...(selectedFiles.length
      ? [el("ul", { className: "qc-ops-selected-issue-file-list" }, ...selectedFiles.map((entry) => {
        const remove = button("Remove", () => {
          const index = selectedFiles.findIndex((candidate) => candidate.id === entry.id);
          if (index >= 0) selectedFiles.splice(index, 1);
          renderSelectedFiles();
        }, "button-quiet qc-ops-small-button");
        return el("li", {},
          el("span", { title: entry.file.name }, text(entry.file.name, "Attachment")),
          el("small", {}, entry.category === "photo" ? "Photo" : "File"),
          remove,
        );
      }))]
      : []));
  };
  const collectFiles = (input) => {
    for (const file of Array.from(input.files || [])) {
      const mimeType = normalizedMimeType(file.name, file.type);
      selectedFiles.push({ id: newRequestId(), file, category: issueAttachmentCategory(mimeType) });
    }
    input.value = "";
    renderSelectedFiles();
    if (selectedFiles.some((entry) => entry.category === "photo")) formError.textContent = "";
  };
  photoInput.addEventListener("change", () => collectFiles(photoInput));
  fileInput.addEventListener("change", () => collectFiles(fileInput));
  reportedByInput.addEventListener("input", () => {
    if (reportedByInput.value.trim()) formError.textContent = "";
  });

  const editableBatches = list(state.batches).filter((batch) => batch.kind !== "historical" && batch.status !== "released");
  const batchSelect = el("select", { name: "batchId" }, el("option", { value: "" }, "No batch link"), ...editableBatches.map((batch) => {
    const products = getBatchProducts(batch).map((product) => ({ ...product, variant: variantById(state).get(product.variantId) }));
    const summary = products.length ? productSummary(products, state) : text(variantById(state).get(batch.variantId)?.label, batch.variantId);
    return el("option", { value: batch.id }, `${text(batch.number)} · ${summary} · ${text(batch.factory)} ${text(batch.stage)}`);
  }));
  const rowSelect = el("select", { name: "rowId", disabled: true }, el("option", { value: "" }, "No inspection row"));
  const updateRows = () => {
    const batch = list(state.batches).find((entry) => entry.id === batchSelect.value);
    const rows = list(batch?.rows).filter(rowHasSavedIssueResult);
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

  const fixedContext = fixedBatch
    ? el("p", { className: "qc-ops-fixed-issue-source" }, `${text(fixedBatch.number)} · ${text(fixedRow?.no)} · ${text(fixedRow?.title)}`)
    : null;
  const associationFields = fixedBatch
    ? fixedContext
    : el("div", { className: "qc-ops-form-grid" },
      field("Related batch (optional)", batchSelect),
      field("Inspection row (optional)", rowSelect),
    );
  const submit = el("button", { type: "submit", className: "button button-primary" }, "Create issue");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    formError.textContent = "";
    const reportedBy = reportedByInput.value.trim();
    if (!reportedBy) {
      formError.textContent = "Enter the name of the person reporting this issue.";
      reportedByInput.focus();
      return;
    }
    if (!form.reportValidity()) return;
    if (!hasRequiredIssuePhoto(selectedFiles)) {
      formError.textContent = "Choose at least one photo.";
      photosButton.focus();
      return;
    }
    submit.disabled = true;
    const data = { reportedBy, owner: initialOwnerInput.value.trim(), title: titleInput.value.trim(), requestId, files: [] };
    const description = descriptionInput.value.trim();
    if (description) data.description = description;
    const batchId = fixedBatch?.id || batchSelect.value;
    const rowId = fixedRow?.id || rowSelect.value;
    if (batchId) data.batchId = batchId;
    if (rowId) data.rowId = rowId;
    try {
      data.files = await Promise.all(selectedFiles.map(async (entry) => {
        const payload = await readAttachmentFile(entry.file, {
          maxBytes: entry.category === "photo" ? 5 * MEBIBYTE : 10 * MEBIBYTE,
          category: entry.category === "photo" ? "photo" : null,
        });
        return { ...payload, category: entry.category };
      }));
    } catch (error) {
      formError.textContent = errorText(error, "Could not read the selected file.");
      submit.disabled = false;
      return;
    }
    const result = await runCommand(ctx, "createIssue", data);
    if (!result.ok) {
      formError.textContent = errorText(result.error);
      submit.disabled = false;
      return;
    }
    closeDialog(true);
    const issueId = result.result?.entityId || result.result?.issueId;
    if (issueId) ctx.navigate("issues", issueId, true);
    else ctx.navigate("issues", null, true);
  });
  form.append(
    field("Reported by", reportedByInput),
    field("Initial disposition owner (optional)", initialOwnerInput),
    field("Issue title", titleInput),
    field("Description", descriptionInput),
    associationFields,
    el("div", { className: "qc-ops-new-issue-files" },
      el("div", { className: "qc-ops-new-issue-file-actions" },
        el("span", { className: "qc-ops-new-issue-photo-required" }, "Photos · required"),
        photosButton,
        filesButton,
      ),
      selectedFileHost,
      photoInput,
      fileInput,
    ),
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
  const isInteractiveTarget = (target) => target instanceof Element && Boolean(target.closest(
    "button, a, input, select, textarea, summary, label, form, [contenteditable='true'], [role='button'], [role='link']"
  ));
  for (const issue of issues) {
    const source = sourceText(issue, state);
    const searchText = [issue.number, issue.title, issue.reportedBy, issue.owner, source, issue.disposition].join(" ").toLowerCase();
    const row = el("tr", {
      className: "qc-ops-issue-row",
      tabIndex: 0,
      ariaLabel: `Open issue ${issue.number}`,
      "data-issue-id": issue.id,
      "data-status": issue.status,
      "data-search": searchText,
    },
      el("td", {}, text(issue.number)),
      el("td", {}, el("strong", {}, text(issue.title)), el("small", { className: "qc-ops-subline" }, source)),
      el("td", { "data-issue-owner": "true" }, text(issue.owner, "Unassigned")),
      el("td", {}, statusPill(issue.status)),
      el("td", {}, dateLabel(issue.createdAt))
    );
    const openIssue = () => {
      if (ctx.selectedId !== issue.id) ctx.navigate("issues", issue.id);
      else openIssueDialog(issue, state, ctx);
    };
    row.addEventListener("click", (event) => {
      if (isInteractiveTarget(event.target)) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && (row.contains(selection.anchorNode) || row.contains(selection.focusNode))) return;
      openIssue();
    });
    row.addEventListener("keydown", (event) => {
      if ((event.key !== "Enter" && event.key !== " ") || isInteractiveTarget(event.target)) return;
      event.preventDefault();
      openIssue();
    });
    tbody.append(row);
  }
  const updateFilters = () => {
    const query = search.value.trim().toLowerCase();
    for (const row of tbody.rows) row.hidden = (status.value !== "all" && row.dataset.status !== status.value) || (query && !row.dataset.search.includes(query));
  };
  search.addEventListener("input", updateFilters);
  status.addEventListener("change", updateFilters);
  const table = el("table", { className: "qc-ops-list-table" },
    el("thead", {}, el("tr", {}, ...["Issue", "Source", "Owner", "Status", "Created"].map((label) => el("th", { scope: "col" }, label)))),
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
