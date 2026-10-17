// Issue detail dialog: the Issue runtime, its unsent edits (drafts), evidence, and manual disposition save.
// The list and creation pages live in qc-ops-issues.js; the pure Issue helpers live in qc-issue-model.js.
import { button, dateLabel, el, errorText, field, list, notify, quantity, statusPill, text, timestampLabel } from "./qc-ops-common.js";
import { closeDialog, showDialog, uploadingLabel } from "./qc-ui.js";
import { isStaleRevisionError, isUnknownOutcomeError, messageOf } from "./qc-command-rules.js";
import { createManualSaveController } from "./qc-manual-save.js";
import {
  assertUploadRequestSize,
  attachmentCanPreview,
  attachmentDownload,
  createAttachmentPreview,
  issueAttachmentCategory,
  loadAssetContent,
  loadAssetImage,
  normalizedMimeType,
  readAttachmentFile,
} from "./qc-attachments.js";
import { DOCUMENT_MAX_BYTES, PHOTO_MAX_BYTES } from "../core/qc-domain.js";
import { resolveBatchDisplayNumber } from "../core/qc-batch-display.js";
import { remainingIssueDraftAfterDiscussion } from "./qc-issue-drafts.js";
import {
  dispositionValue,
  draftDiffers,
  hasIssueDraft,
  hasProductContext,
  issueAttachments,
  issueProductLabel,
  issueProducts,
  issueRowProduct,
  otherBatchProducts,
  productSummary,
  quantityOrDash,
  sourcePhotoIds,
  sourcePhotos,
  sourceSnapshot,
  sourceText,
} from "./qc-issue-model.js";

// Unsent Issue edits, keyed by Issue id. They survive re-rendering so that a reload or a
// departure guard can still see them.
const issueDrafts = new Map();
let activeIssueDialogRuntime = null;
const issueDialogCloseListeners = new WeakSet();

export function hasUnsavedIssueWork() {
  return issueDrafts.size > 0 || Boolean(activeIssueDialogRuntime?.manualSaveController?.hasPending?.());
}

export function clearIssueDrafts() {
  issueDrafts.clear();
}

/** The unsent draft held for one Issue, or undefined when it has none. */
export function storedIssueDraft(issueId) {
  return issueDrafts.get(issueId);
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

window.addEventListener("beforeunload", (event) => {
  if (hasUnsavedIssueWork()) {
    event.preventDefault();
    event.returnValue = "";
  }
});

window.addEventListener("masterqc:discard-operation-drafts", clearIssueDrafts);
window.addEventListener("masterqc:discard-dialog-draft", (event) => {
  // Discard only the Issue named by the event. An event without an Issue id discards nothing.
  const issueId = event.detail?.issueId;
  if (issueId) issueDrafts.delete(issueId);
});

function renderIssueAttachments(issue, state, ctx, readOnly, markDraftForPreservation, onIssueUpdated = null, runIssueCommand = null) {
  const host = el("section", { className: "qc-ops-issue-attachments" });
  const previewHost = el("div", { className: "qc-ops-issue-attachment-preview-host" });
  const pendingOperations = new Set();
  const removeButtons = new Set();
  let disabled = readOnly;
  let disposed = false;
  let previewCleanup = () => {};
  let previewRequest = 0;
  let pendingOperationError = null;
  let uploadsInFlight = 0;
  const removing = new Set();
  const uploadStatus = el("p", { className: "upload-feedback", role: "status", ariaLive: "polite", hidden: true });
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
    : ctx.run(type, data, options);
  const flushPending = async () => {
    while (pendingOperations.size) await Promise.allSettled([...pendingOperations]);
    return !pendingOperationError;
  };
  const clearPreview = () => {
    previewRequest += 1;
    previewCleanup();
    previewCleanup = () => {};
    previewHost.replaceChildren();
  };
  const showInlinePreview = async (asset) => {
    clearPreview();
    const request = previewRequest;
    let fullAsset;
    try { fullAsset = await loadAssetContent(asset, ctx.service); }
    catch (error) {
      if (!disposed && request === previewRequest) notify(errorText(error, "The file preview could not be opened."), true);
      return;
    }
    if (disposed || request !== previewRequest) return;
    const preview = createAttachmentPreview(fullAsset);
    previewCleanup = preview.cleanup;
    const closePreview = button("Close preview", clearPreview, "button-quiet qc-ops-small-button");
    previewHost.replaceChildren(el("div", { className: "qc-ops-attachment-preview" },
      el("strong", { className: "qc-ops-attachment-preview-name" }, text(fullAsset.name, "Attachment")),
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

  // Adding files is locked while an upload is in flight, and the status shows the size being sent.
  const applyAddLocks = () => {
    const locked = disabled || uploadsInFlight > 0;
    photoButton.disabled = locked;
    fileButton.disabled = locked;
    photoInput.disabled = locked;
    fileInput.disabled = locked;
  };
  const setUploading = (active, bytes = 0) => {
    uploadsInFlight += active ? 1 : -1;
    uploadStatus.textContent = uploadsInFlight > 0 ? uploadingLabel(bytes) : "";
    uploadStatus.hidden = uploadsInFlight <= 0;
    applyAddLocks();
  };

  const upload = async (input) => {
    const selected = Array.from(input.files || []);
    if (!selected.length || disposed) return;
    markDraftForPreservation();
    setUploading(true, selected.reduce((sum, file) => sum + (Number(file.size) || 0), 0));
    try {
      assertUploadRequestSize(selected);
      const files = await Promise.all(selected.map(async (file) => {
        const mimeType = normalizedMimeType(file.name, file.type);
        const category = issueAttachmentCategory(mimeType);
        const payload = await readAttachmentFile(file, {
          maxBytes: category === "photo" ? PHOTO_MAX_BYTES : DOCUMENT_MAX_BYTES,
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
    } finally {
      setUploading(false);
    }
  };
  photoInput.addEventListener("change", () => { void startOperation(() => upload(photoInput)); });
  fileInput.addEventListener("change", () => { void startOperation(() => upload(fileInput)); });

  const removeAttachment = async (asset) => {
    if (disposed || disabled || removing.has(asset.id)) return;
    if (!window.confirm(`Remove “${text(asset.name, "this file")}” from this issue?`)) return;
    removing.add(asset.id);
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
    } finally {
      removing.delete(asset.id);
    }
  };

  const render = (currentIssue, currentState) => {
    clearPreview();
    const attachments = issueAttachments(currentIssue, currentState);
    const attachmentImages = [];
    const listHost = attachments.length
      ? el("ul", { className: "qc-ops-issue-attachment-list" }, ...attachments.map((asset) => {
        const category = asset.category || issueAttachmentCategory(asset.mimeType);
        const assetName = text(asset.name, "Attachment");
        const thumbnail = category === "photo" && (asset.dataUrl || asset.id)
          ? el("img", {
            className: "qc-ops-issue-attachment-thumbnail",
            ...(asset.dataUrl ? { src: asset.dataUrl } : {}),
            alt: assetName,
            title: assetName,
            loading: "lazy",
          })
          : null;
        if (thumbnail && !asset.dataUrl) attachmentImages.push([thumbnail, asset]);
        const preview = attachmentCanPreview(asset)
          ? button("Preview", () => showInlinePreview(asset), "button-quiet qc-ops-small-button")
          : null;
        if (preview) preview.setAttribute("aria-label", `Preview ${assetName}`);
        const download = attachmentDownload(asset, "Attachment", ctx.service);
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
      : null;
    host.replaceChildren(
      el("div", { className: "qc-ops-section-heading" }, el("h3", {}, "Evidence"),
        el("div", { className: "qc-ops-issue-attachment-actions" }, photoButton, fileButton)),
      uploadStatus,
      listHost,
      previewHost,
      photoInput,
      fileInput,
    );
    for (const [image, asset] of attachmentImages) void loadAssetImage(image, asset, ctx.service);
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
      applyAddLocks();
      removeButtons.forEach((remove) => { remove.disabled = disabled; });
    },
  };
}

function sourceCard(issue, state, ctx) {
  const snapshot = sourceSnapshot(issue);
  const row = snapshot.row || null;
  const batch = snapshot.batch || {};
  const sourceTitle = row?.title || snapshot.title || "";
  const sourceTitleZh = row?.titleZh || snapshot.titleZh;
  const products = issueProducts(issue, state);
  const rowProductSnapshot = issueRowProduct(issue, state);
  const rowProduct = hasProductContext(rowProductSnapshot) ? rowProductSnapshot : null;
  const rowProductName = rowProduct ? text(row?.variantLabel || row?.productLabel || rowProduct.variantLabel, issueProductLabel(rowProduct, state)) : "";
  const rowProductQuantity = row?.productQuantity ?? rowProduct?.productQuantity ?? rowProduct?.quantity;
  const rowVersion = row?.versionLabel || rowProduct?.versionLabel || rowProduct?.version?.label;
  const otherProducts = otherBatchProducts(products, row, rowProduct, state);
  const linkedBatchNumber = resolveBatchDisplayNumber(state, issue.batchId || batch.id, snapshot.batchNumber || batch.number || batch.batchNumber || "");
  const factory = snapshot.factory || batch.factory;
  const stage = snapshot.stage || batch.stage;
  const batchDate = snapshot.date || batch.date;
  const productLabel = snapshot.variantLabel || batch.variantLabel;
  const versionLabel = snapshot.versionLabel || batch.versionLabel;
  const sourceTitleIsIssueTitle = !sourceTitle || String(sourceTitle).trim() === String(issue.title || "").trim();
  const standardText = String(row?.specification || row?.specificationZh || "").trim();
  const metadata = [
    Object.hasOwn(issue, "reportedBy") ? `Reported by: ${text(issue.reportedBy)}` : "",
    linkedBatchNumber ? `Batch: ${text(linkedBatchNumber)}` : "",
    rowProduct ? `Inspection product: ${rowProductName} · ${rowProductQuantity === null || rowProductQuantity === undefined ? "quantity unknown" : `${quantity(rowProductQuantity)} units`}${rowVersion ? ` · Version ${rowVersion}` : ""}` : "",
    !rowProduct && products.length ? `Products in batch: ${productSummary(products, state)}` : "",
    rowProduct && otherProducts.length ? `Other products: ${productSummary(otherProducts, state)}` : "",
    !rowProduct && !products.length && productLabel ? `Product: ${text(productLabel)}` : "",
    factory || stage ? `Factory / stage: ${[factory, stage].filter(Boolean).map((value) => text(value)).join(" · ")}` : "",
    batchDate ? `Batch date: ${dateLabel(batchDate)}` : "",
    products.length || !versionLabel ? "" : `Version: ${text(versionLabel)}`,
    row ? `Inspection row: ${text(row.no || row.id)}` : ""
  ].filter(Boolean);
  const facts = [
    ["Inspection quantity", row?.inspectedQty],
    ["Defective quantity", row?.defectiveQty],
    ["Defective rate", row?.defectiveRate === null || row?.defectiveRate === undefined ? "—" : `${Number(row.defectiveRate).toFixed(2)}%`],
    ["Inspection saved", row?.savedAt ? timestampLabel(row.savedAt) : "Not saved at issue creation"]
  ];
  const sourceIds = sourcePhotoIds(issue);
  const evidence = sourcePhotos(issue, state);
  const showSourceTitle = !sourceTitleIsIssueTitle;
  const sourceImages = [];
  const evidenceBlock = sourceIds.length || evidence.length
    ? el("div", { className: "qc-ops-issue-evidence" },
      el("strong", {}, "Source photos"),
      evidence.length ? el("div", { className: "qc-ops-issue-evidence-list" }, ...evidence.map((asset) => {
        const image = el("img", {
          ...(asset.dataUrl ? { src: asset.dataUrl } : {}),
          alt: asset.name || "Inspection source photo",
          loading: "lazy",
        });
        if (!asset.dataUrl) sourceImages.push([image, asset]);
        return el("figure", {}, image, el("figcaption", {}, text(asset.name, "Inspection photo")));
      })) : null,
      sourceIds.length > evidence.length
        ? el("p", {}, "Some inspection source photos are unavailable in this workspace.")
        : null
    )
    : null;
  const card = el("section", { className: "qc-ops-source-card" },
    el("div", { className: "qc-ops-source-heading" },
      el("div", {}, row ? el("small", {}, "Inspection") : null, showSourceTitle ? el("h3", {}, sourceTitle) : null, sourceTitleZh ? el("p", { lang: "zh" }, sourceTitleZh) : null),
      statusPill(issue.status)
    ),
    String(issue.description || "").trim() ? el("div", { className: "qc-ops-issue-description" },
      el("strong", {}, "Description"), el("p", {}, String(issue.description).trim())) : null,
    metadata.length ? el("p", { className: "qc-ops-source-meta" }, metadata.join(" · ")) : null,
    row && (standardText || row.remarks) ? el("div", { className: "qc-ops-source-standard" },
      el("strong", {}, "Inspection standard"),
      standardText ? el("p", {}, standardText) : null,
      row.remarks ? el("p", {}, el("strong", {}, "Recorded remarks: "), row.remarks) : null
    ) : null,
    row ? el("dl", { className: "qc-ops-source-facts" }, ...facts.map(([label, value]) => el("div", {}, el("dt", {}, label), el("dd", {}, label === "Inspection quantity" || label === "Defective quantity" ? quantityOrDash(value) : text(value))))) : null,
    evidenceBlock
  );
  for (const [image, asset] of sourceImages) void loadAssetImage(image, asset, ctx.service);
  return card;
}

function renderDiscussion(issue) {
  if (!list(issue.discussion).length) return document.createDocumentFragment();
  return el("ol", { className: "qc-ops-discussion-list" }, ...list(issue.discussion).map((entry) => {
    const authorName = String(entry.authorName || "").trim();
    return el("li", {},
      el("p", {}, authorName ? [el("strong", { className: "qc-ops-discussion-author" }, authorName), " ", entry.text] : entry.text),
      el("time", {}, timestampLabel(entry.createdAt))
    );
  }));
}
export function openIssueDialog(issue, state, ctx) {
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
  const discussionText = el("textarea", { rows: "2", maxLength: "1200", disabled: readOnly, name: "discussionText" }, draft.discussionText || "");
  const discussionList = el("div", { className: "qc-ops-discussion-host" }, renderDiscussion(currentIssue));
  const formError = el("p", { className: "qc-ops-form-error", role: "alert" });
  const saveStatus = el("p", { className: "save-status qc-ops-issue-save-status", role: "status", "aria-live": "polite" });
  const form = el("form", { className: "qc-ops-form qc-ops-issue-form", "data-preserve-drafts": "true", "data-issue-id": currentIssue.id });

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
    return current;
  };

  const runEvidenceCommand = async (type, data, options = {}) => {
    return ctx.run(type, data, { ...options, autosave: true, render: false });
  };
  const evidence = renderIssueAttachments(currentIssue, currentState, ctx, readOnly, markDraftForPreservation, (nextIssue, nextState) => {
    adoptLatestIssue(nextIssue, nextState);
  }, runEvidenceCommand);
  const dispositionInputs = [owner, disposition, ...confirmationInputs];
  saveStatus.textContent = "Saved";
  let manualSaveController = null;
  let closeSubmitting = false;
  let discussionSubmitting = false;
  let deleteSubmitting = false;
  let runtime = null;
  let discussionButton;
  const saveButton = button("Save changes", () => { void manualSaveController?.saveAll(); }, "button-primary qc-ops-save-changes");
  saveButton.disabled = readOnly;
  let closeButton;
  let deleteButton;
  let deleteConfirmation;
  let cancelDeleteButton;
  let confirmDeleteButton;

  // Reload keeps the Issue edits as a draft and reopens the Issue over the refreshed data. It never saves.
  const reloadLatestButton = button("Reload latest data", async () => {
    if (runtime?.busy) return;
    if (!(await evidence.flushPending())) {
      formError.textContent = "Issue evidence changes could not be saved. Try again before reloading.";
      return;
    }
    markDraftForPreservation();
    const refreshed = await ctx.refreshState?.({ render: true });
    if (!refreshed?.ok) {
      formError.textContent = errorText(refreshed?.error, "The latest data could not be loaded. Your edits are still here.");
    }
  }, "button button-secondary");
  reloadLatestButton.hidden = true;

  manualSaveController = readOnly ? null : createManualSaveController({
    hasChanges: () => draftDiffers(currentIssue, captureDraft()),
    readSnapshot: () => dispositionValue(captureDraft()),
    validate: (value) => typeof value.owner === "string" && value.owner.length <= 200 &&
      typeof value.disposition === "string" && value.disposition.length <= 1200 &&
      Array.isArray(value.confirmations) && value.confirmations.length === 3 &&
      value.confirmations.every((name) => typeof name === "string" && name.length <= 100),
    save: (value) => ctx.run("saveIssue", { id: currentIssue.id, ...value }, { manualSave: true, render: false, silent: true }),
    onStatus: (status, meta) => {
      saveStatus.textContent = status;
      saveStatus.className = `save-status qc-ops-issue-save-status ${status === "Saved" ? "qc-ops-saved" : status === "Saving…" ? "qc-ops-save-pending" : status === "Save failed" ? "qc-ops-save-failed" : "qc-ops-unsaved"}`;
      saveButton.disabled = meta.saving || !meta.dirty;
    },
    onSaved: (value, response) => {
      formError.textContent = "";
      reloadLatestButton.hidden = true;
      const latestState = response?.state || currentState;
      const latestIssue = list(latestState.issues).find((item) => item.id === currentIssue.id);
      if (!latestIssue) throw new Error("The saved Issue changes could not be confirmed.");
      adoptLatestIssue(latestIssue, latestState);
      storeDraft(captureDraft());
      form.dataset.dirty = "false";
    },
    onError: (error) => {
      formError.textContent = messageOf(error, "The disposition could not be saved.");
      // A stale or unknown-outcome save is retried only after a reload; the Issue edits stay in the form.
      reloadLatestButton.hidden = !(isStaleRevisionError(error) || isUnknownOutcomeError(error));
    },
    onDiscard: () => {
      owner.value = String(currentIssue.owner || "");
      disposition.value = String(currentIssue.disposition || "");
      confirmationInputs.forEach((input, index) => { input.value = String(currentIssue.confirmations?.[index] || ""); });
      storeDraft(captureDraft());
      formError.textContent = "";
      form.dataset.dirty = "false";
    },
  });

  closeButton = button("Close issue", async () => {
    if (closeSubmitting || discussionSubmitting) return;
    closeSubmitting = true;
    closeButton.disabled = true;
    if (runtime) runtime.busy = true;
    try {
      const closeSavedIssue = async () => {
        const current = markDraftForPreservation();
        if (current.discussionText.trim() || current.discussionAuthorName.trim()) {
          formError.textContent = "Add or clear the discussion draft before closing this issue.";
          return;
        }
        if (!currentIssue.owner?.trim() || !currentIssue.disposition?.trim() || currentIssue.confirmations?.some((name) => !String(name || "").trim())) {
          formError.textContent = "An owner, formal disposition, and all three confirmation names are required before closure.";
          return;
        }
        if (!(await evidence.flushPending())) {
          formError.textContent = "Issue evidence changes could not be saved. Try again before closing this issue.";
          return;
        }
        const controls = [...dispositionInputs, discussionAuthorName, discussionText];
        const wasDisabled = controls.map((input) => input.disabled);
        controls.forEach((input) => { input.disabled = true; });
        evidence.setDisabled(true);
        discussionButton.disabled = true;
        closeButton.disabled = true;
        const result = await ctx.run("closeIssue", { id: currentIssue.id }, { render: false });
        controls.forEach((input, index) => { input.disabled = wasDisabled[index]; });
        evidence.setDisabled(false);
        if (!result.ok) {
          formError.textContent = errorText(result.error, "The issue could not be closed.");
          return;
        }
        const latestIssue = list(result.state?.issues).find((item) => item.id === currentIssue.id);
        if (latestIssue) adoptLatestIssue(latestIssue, result.state);
        issueDrafts.delete(currentIssue.id);
        closeDialog(true);
        runtime?.dispose();
        await ctx.navigate("issues", null, true);
      };
      if (manualSaveController?.hasPending()) {
        await ctx.resolveManualChanges?.("close this issue", closeSavedIssue, { keepDialog: true, controller: manualSaveController });
      } else {
        await closeSavedIssue();
      }
    } finally {
      closeSubmitting = false;
      evidence.setDisabled(false);
      if (discussionButton) discussionButton.disabled = readOnly;
      if (closeButton) closeButton.disabled = readOnly;
      if (runtime) runtime.busy = false;
    }
  }, "button button-danger");
  closeButton.disabled = readOnly;

  const linkedBatch = list(currentState.batches).find((batch) => batch.id === currentIssue.batchId);
  const protectedBatchIssue = Boolean(linkedBatch && linkedBatch.status === "released");
  const runIssueDeletion = async () => {
    if (deleteSubmitting || closeSubmitting || discussionSubmitting || runtime?.busy || protectedBatchIssue) return;
    deleteSubmitting = true;
    if (runtime) runtime.busy = true;
    let deleted = false;
    try {
      const deleteSavedIssue = async () => {
        if (!(await evidence.flushPending())) {
          formError.textContent = "Issue evidence changes could not be saved. Try again before deleting this issue.";
          return;
        }
        markDraftForPreservation();
        const response = await ctx.run("deleteIssue", { id: currentIssue.id }, { render: false });
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
      };
      if (manualSaveController?.hasPending()) {
        await ctx.resolveManualChanges?.("delete this issue", deleteSavedIssue, { keepDialog: true, controller: manualSaveController });
      } else {
        await deleteSavedIssue();
      }
    } finally {
      deleteSubmitting = false;
      if (runtime) runtime.busy = false;
      evidence.setDisabled(false);
      if (!deleted) {
        if (discussionButton) discussionButton.disabled = readOnly;
        if (closeButton) closeButton.disabled = readOnly;
      }
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
  if (protectedBatchIssue) deleteButton.title = "Issues linked to released batches cannot be deleted.";

  discussionButton = button("Add discussion entry", async () => {
    if (discussionSubmitting || closeSubmitting) return;
    discussionSubmitting = true;
    discussionButton.disabled = true;
    closeButton.disabled = true;
    if (runtime) runtime.busy = true;
    try {
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
      const response = await ctx.run("addDiscussion", { id: currentIssue.id, text: entryText, authorName }, { render: false });
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
    } finally {
      discussionSubmitting = false;
      if (discussionButton) discussionButton.disabled = readOnly;
      if (closeButton) closeButton.disabled = readOnly;
      if (runtime) runtime.busy = false;
    }
  }, "button button-secondary");
  discussionButton.disabled = readOnly;

  const updateDraft = () => {
    const next = captureDraft();
    storeDraft(next);
    formError.textContent = "";
    manualSaveController?.noteChanges();
  };
  dispositionInputs.forEach((input) => {
    input.addEventListener("input", updateDraft);
    input.addEventListener("change", updateDraft);
  });
  [discussionAuthorName, discussionText].forEach((input) => {
    input.addEventListener("input", updateDraft);
    input.addEventListener("change", updateDraft);
  });
  form.addEventListener("submit", (event) => event.preventDefault());
  form.append(
    sourceCard(currentIssue, currentState, ctx),
    evidence.element,
    el("div", { className: "qc-ops-form-grid" }, field("Disposition owner", owner), field("Formal disposition", disposition)),
    el("fieldset", { className: "qc-ops-confirmations" },
      el("legend", {}, "Confirmations"),
      ...confirmationInputs.map((input, index) => field(`Confirmation ${index + 1}`, input))
    ),
    el("div", { className: "qc-ops-manual-save-actions" }, saveButton, saveStatus),
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
  // Escape and the header Close button both go through the runtime, so unsaved edits get the Save/Discard/Cancel choice.
  const dialog = showDialog(`${text(currentIssue.number, "Issue")} · ${text(currentIssue.title)}`, form, {
    onCloseRequest: () => runtime?.closeFromHeader(),
  });
  dialog.dataset.issueId = currentIssue.id;
  if (!issueDialogCloseListeners.has(dialog)) {
    dialog.addEventListener("close", () => {
      const activeRuntime = activeIssueDialogRuntime;
      if (!dialog.open && activeRuntime?.dialog === dialog) activeRuntime.dispose();
      if (!dialog.open) delete dialog.dataset.issueId;
    });
    issueDialogCloseListeners.add(dialog);
  }
  const unregisterManualSave = manualSaveController ? ctx.registerManualSaveController?.(manualSaveController) : null;
  runtime = {
    dialog,
    form,
    manualSaveController,
    async closeFromHeader() {
      if (this.busy) return;
      this.busy = true;
      try {
        markDraftForPreservation();
        await ctx.resolveManualChanges?.("close this Issue", async () => {
          if (activeIssueDialogRuntime !== this || !dialog.open) return;
          closeDialog(true);
          this.dispose();
        }, { controller: manualSaveController });
      } finally {
        this.busy = false;
      }
    },
    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      if (unregisterManualSave) unregisterManualSave();
      else manualSaveController?.dispose();
      evidence.cleanup();
      if (activeIssueDialogRuntime === this) activeIssueDialogRuntime = null;
    },
    busy: false,
    disposed: false,
  };
  if (activeIssueDialogRuntime) activeIssueDialogRuntime.dispose();
  activeIssueDialogRuntime = runtime;
}

