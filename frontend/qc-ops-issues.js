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

window.addEventListener("beforeunload", (event) => {
  if (issueDrafts.size) {
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
  return draft.owner !== saved.owner || draft.disposition !== saved.disposition ||
    draft.confirmations.some((value, index) => value !== saved.confirmations[index]);
}

function hasDiscussionDraft(draft) {
  return Boolean(draft.discussionAuthorName || draft.discussionText);
}

function hasIssueDraft(issue, draft) {
  return draftDiffers(issue, draft) || hasDiscussionDraft(draft);
}

function sourcePhotos(issue, state) {
  const snapshot = sourceSnapshot(issue);
  const row = snapshot.row || snapshot;
  const photoIds = list(row.photoIds || snapshot.photoIds);
  const assets = new Map(list(state.assets).map((asset) => [asset.id, asset]));
  return photoIds.map((id) => assets.get(id)).filter(Boolean);
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

function renderIssueAttachments(issue, state, ctx, readOnly, markDraftForPreservation, onIssueUpdated = null) {
  const host = el("section", { className: "qc-ops-issue-attachments" });
  const previewHost = el("div", { className: "qc-ops-issue-attachment-preview-host" });
  let previewCleanup = () => {};
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
  photoButton.disabled = readOnly;
  fileButton.disabled = readOnly;

  const upload = async (input) => {
    const selected = Array.from(input.files || []);
    if (!selected.length) return;
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
      const response = await runCommand(ctx, "addIssueAttachments", { id: issue.id, files }, { render: false });
      if (!response.ok) return;
      input.value = "";
      const latestState = response.state || state;
      const latestIssue = list(latestState.issues).find((entry) => entry.id === issue.id) || issue;
      onIssueUpdated?.(latestIssue, latestState);
      render(latestIssue, latestState);
      markDraftForPreservation();
    } catch (error) {
      notify(errorText(error, "Could not read the selected file."), true);
    }
  };
  photoInput.addEventListener("change", () => { void upload(photoInput); });
  fileInput.addEventListener("change", () => { void upload(fileInput); });

  const removeAttachment = async (asset) => {
    if (!window.confirm(`Remove “${text(asset.name, "this file")}” from this issue?`)) return;
    markDraftForPreservation();
    const response = await runCommand(ctx, "removeIssueAttachment", { id: issue.id, assetId: asset.id }, { render: false });
    if (!response.ok) return;
    const latestState = response.state || state;
    const latestIssue = list(latestState.issues).find((entry) => entry.id === issue.id) || issue;
    onIssueUpdated?.(latestIssue, latestState);
    render(latestIssue, latestState);
    markDraftForPreservation();
  };

  const render = (currentIssue, currentState) => {
    clearPreview();
    const attachments = issueAttachments(currentIssue, currentState);
    const listHost = attachments.length
      ? el("ul", { className: "qc-ops-issue-attachment-list" }, ...attachments.map((asset) => {
        const preview = attachmentCanPreview(asset)
          ? button("Preview", () => showInlinePreview(asset), "button-quiet qc-ops-small-button")
          : null;
        const category = asset.category || issueAttachmentCategory(asset.mimeType);
        const remove = button("Remove", () => { void removeAttachment(asset); }, "button-quiet qc-ops-attachment-remove");
        remove.disabled = readOnly;
        return el("li", {},
          el("span", { className: "qc-ops-issue-attachment-name", title: text(asset.name) }, text(asset.name, "Attachment")),
          el("small", {}, category === "photo" ? "Photo" : "File"),
          preview,
          attachmentDownload(asset),
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
  return { element: host, cleanup: clearPreview };
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
  const discussionList = el("div", { className: "qc-ops-discussion-host" }, renderDiscussion(currentIssue));
  const formError = el("p", { className: "qc-ops-form-error", role: "alert" });
  const form = el("form", { className: "qc-ops-form qc-ops-issue-form", "data-preserve-drafts": "true", "data-issue-id": currentIssue.id });
  if (hasIssueDraft(currentIssue, draft)) form.dataset.dirty = "true";
  const captureDraft = () => ({
    owner: owner.value,
    disposition: disposition.value,
    confirmations: confirmationInputs.map((input) => input.value),
    discussionAuthorName: discussionAuthorName.value,
    discussionText: discussionText.value
  });
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
  const evidence = renderIssueAttachments(currentIssue, currentState, ctx, readOnly, markDraftForPreservation, (nextIssue, nextState) => {
    currentIssue = nextIssue;
    currentState = nextState;
  });
  const saveButton = el("button", { type: "submit", className: "button button-primary", disabled: readOnly }, "Save disposition");
  const closeButton = button("Close issue", async () => {
    const current = markDraftForPreservation();
    if (current.discussionText.trim()) {
      notify("Add the discussion entry or clear it before closing this issue.", true);
      return;
    }
    if (draftDiffers(currentIssue, current)) {
      notify("Save the current disposition fields before closing this issue.", true);
      return;
    }
    if (!current.owner.trim() || !current.disposition.trim() || current.confirmations.some((name) => !name.trim())) {
      notify("An owner, formal disposition, and all three confirmation names are required before closure.", true);
      return;
    }
    const result = await runCommand(ctx, "closeIssue", { id: currentIssue.id });
    if (result.ok) {
      issueDrafts.delete(currentIssue.id);
      closeDialog(true);
    }
  }, "button button-danger");
  closeButton.disabled = readOnly;
  const discussionButton = button("Add discussion entry", async () => {
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
    try {
      const response = await submitDiscussionEntry(ctx, currentIssue.id, entryText, authorName);
      if (!response.ok) return;
      const latestState = response.state || currentState;
      const latestIssue = list(latestState.issues).find((entry) => entry.id === currentIssue.id);
      if (!latestIssue) {
        notify("The discussion entry was saved, but the updated Issue could not be reloaded.", true);
        return;
      }
      currentIssue = latestIssue;
      currentState = latestState;
      discussionList.replaceChildren(renderDiscussion(currentIssue));
      const latestDraft = issueDrafts.get(currentIssue.id) || current;
      const remainingDraft = remainingIssueDraftAfterDiscussion(latestDraft, current);
      if (remainingDraft.discussionAuthorName === "") discussionAuthorName.value = "";
      if (remainingDraft.discussionText === "") discussionText.value = "";
      if (hasIssueDraft(currentIssue, remainingDraft)) issueDrafts.set(currentIssue.id, remainingDraft);
      else issueDrafts.delete(currentIssue.id);
      if (hasIssueDraft(currentIssue, remainingDraft)) form.dataset.dirty = "true";
      else delete form.dataset.dirty;
    } finally {
      discussionButton.disabled = readOnly;
    }
  }, "button button-secondary");
  discussionButton.disabled = readOnly;
  const updateDraft = () => {
    const next = captureDraft();
    storeDraft(next);
    if (hasIssueDraft(currentIssue, next)) form.dataset.dirty = "true";
    else delete form.dataset.dirty;
    queueMicrotask(() => {
      const savedDraft = issueDrafts.get(currentIssue.id);
      if (!savedDraft || !hasIssueDraft(currentIssue, savedDraft)) delete form.dataset.dirty;
    });
  };
  [owner, disposition, discussionAuthorName, discussionText, ...confirmationInputs].forEach((input) => input.addEventListener("input", updateDraft));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    formError.textContent = "";
    const next = markDraftForPreservation();
    const normalized = {
      owner: next.owner.trim(),
      disposition: next.disposition.trim(),
      confirmations: next.confirmations.map((name) => name.trim()),
      discussionAuthorName: next.discussionAuthorName,
      discussionText: next.discussionText
    };
    const response = await runCommand(ctx, "saveIssue", { id: currentIssue.id, owner: normalized.owner, disposition: normalized.disposition, confirmations: normalized.confirmations });
    if (!response.ok) {
      const failedDraft = issueDrafts.get(currentIssue.id) || normalized;
      if (hasIssueDraft(currentIssue, failedDraft)) issueDrafts.set(currentIssue.id, failedDraft);
    }
    if (response.ok) {
      const latestDraft = issueDrafts.get(currentIssue.id) || normalized;
      const savedDraft = {
        ...latestDraft,
        owner: latestDraft.owner === next.owner ? normalized.owner : latestDraft.owner,
        disposition: latestDraft.disposition === next.disposition ? normalized.disposition : latestDraft.disposition,
        confirmations: latestDraft.confirmations.map((name, index) => name === next.confirmations[index] ? normalized.confirmations[index] : name)
      };
      const hasUnsavedDispositionDraft = savedDraft.owner !== normalized.owner || savedDraft.disposition !== normalized.disposition ||
        savedDraft.confirmations.some((name, index) => name !== normalized.confirmations[index]);
      if (hasDiscussionDraft(savedDraft) || hasUnsavedDispositionDraft) issueDrafts.set(currentIssue.id, savedDraft);
      else issueDrafts.delete(currentIssue.id);
      closeDialog(true);
    }
  });
  form.append(
    sourceCard(currentIssue, currentState),
    evidence.element,
    el("div", { className: "qc-ops-form-grid" }, field("Disposition owner", owner), field("Formal disposition", disposition)),
    el("fieldset", { className: "qc-ops-confirmations" },
      el("legend", {}, "Manual confirmations · names entered by staff"),
      ...confirmationInputs.map((input, index) => field(`Confirmation ${index + 1}`, input))
    ),
    el("section", { className: "qc-ops-discussion" },
      el("h3", {}, "Discussion"),
      discussionList,
      field("Your name", discussionAuthorName),
      field("New discussion entry", discussionText),
      discussionButton
    ),
    formError,
    el("div", { className: "qc-ops-dialog-actions" }, button("Done", () => {
      markDraftForPreservation();
      closeDialog(true);
    }, "button button-secondary"), saveButton, closeButton)
  );
  const dialog = showDialog(`${text(currentIssue.number, "Issue")} · ${text(currentIssue.title)}`, form);
  dialog.dataset.operationDraftId = currentIssue.id;
  dialog.dataset.issueId = currentIssue.id;
  dialog.addEventListener("close", evidence.cleanup, { once: true });
}

export function openNewIssueDialog(state, ctx, options = {}) {
  const requestId = options.requestId || newRequestId();
  const fixedBatch = options.batchId ? list(state.batches).find((batch) => batch.id === options.batchId) : null;
  const fixedRow = fixedBatch ? list(fixedBatch.rows).find((row) => row.id === options.rowId) : null;
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
    if (!form.reportValidity()) return;
    if (!hasRequiredIssuePhoto(selectedFiles)) {
      formError.textContent = "Choose at least one photo.";
      photosButton.focus();
      return;
    }
    submit.disabled = true;
    const data = { title: titleInput.value.trim(), requestId, files: [] };
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
  for (const issue of issues) {
    const source = sourceText(issue, state);
    const searchText = [issue.number, issue.title, issue.owner, source, issue.disposition].join(" ").toLowerCase();
    const open = button("Open", () => {
      if (ctx.selectedId !== issue.id) ctx.navigate("issues", issue.id);
      else openIssueDialog(issue, state, ctx);
    }, "button button-secondary qc-ops-small-button");
    tbody.append(el("tr", { "data-status": issue.status, "data-search": searchText },
      el("td", {}, text(issue.number)),
      el("td", {}, el("strong", {}, text(issue.title)), el("small", { className: "qc-ops-subline" }, source)),
      el("td", {}, text(issue.owner, "Unassigned")),
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
