// Attachment controls for the batch pages: the batch attachment list, the Videos, Procedures and Log
// slots on each inspection row, and the source-evidence photos kept on legacy rows. Each control uses
// the shared preview, download, and remove handling of the attachment library.

import { button, el, errorText, list, notify, text } from "./qc-ops-common.js";
import { createSingleFlight, uploadingLabel } from "./qc-ui.js";
import { attachmentCanPreview, downloadAttachment, formatMebibytes, previewAttachment, readAttachmentFile } from "./qc-attachments.js";
import { DOCUMENT_MAX_BYTES } from "../core/qc-domain.js";
import { inspectionControlName, isHistoricalBatch } from "./qc-batch-model.js";

function getRowPhotos(row, workspace, state) {
  if (Array.isArray(row.photos) && row.photos.length) return row.photos;
  const assets = new Map(list(state.assets).map((asset) => [asset.id, asset]));
  return list(row.photoIds).map((id) => assets.get(id)).filter(Boolean);
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

function makePhotoDialog(photo, row, ctx) {
  void previewAttachment(photo, ctx.service, `${text(row.title)} · ${text(photo.name, "Photo")}`);
}

export function legacyEvidenceDisclosure(row, workspace, state, ctx) {
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
        const preview = button("Preview", () => makePhotoDialog(photo, row, ctx), "button-quiet qc-ops-small-button");
        preview.setAttribute("aria-label", inspectionControlName({ action: "Preview", slot: "photo", fileName: name }, row));
        actions.push(preview);
      }
      if (photo?.dataUrl || photo?.id) {
        const download = button("Download", () => {
          void downloadAttachment(photo, ctx.service, name).catch((error) => notify(errorText(error, "The photo could not be downloaded."), true));
        }, "button-quiet qc-ops-small-button");
        download.setAttribute("aria-label", inspectionControlName({ action: "Download", slot: "photo", fileName: name }, row));
        actions.push(download);
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

export function renderRowAttachmentCell(row, workspace, state, ctx, readOnly) {
  const attachments = getRowAttachments(row, state);
  const cell = el("td", { className: "qc-ops-row-attachments" });
  for (const [category, label] of ROW_ATTACHMENT_CATEGORIES) {
    const asset = attachments?.[category] || null;
    const assetName = text(asset?.name, "Attachment");
    const input = el("input", {
      type: "file",
      accept: category === "videos" ? ".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm" : undefined,
      className: "qc-ops-hidden-file",
      "aria-label": `${label} for ${text(row.title)}`,
      disabled: readOnly,
    });
    const choose = button(asset ? "Replace" : "Add", () => input.click(), "button-secondary qc-ops-small-button");
    choose.setAttribute("aria-label", inspectionControlName({ action: asset ? "Replace" : "Add", slot: label }, row));
    choose.disabled = readOnly;
    const slotStatus = el("span", { className: "upload-feedback", role: "status", ariaLive: "polite", hidden: true });
    const slotFlight = createSingleFlight({ controls: () => [choose, removeButton] });
    const uploadSlotFile = async () => {
      const file = input.files?.[0];
      if (!file) return;
      slotStatus.textContent = uploadingLabel(file.size);
      slotStatus.hidden = false;
      try {
        const payload = await readAttachmentFile(file, { maxBytes: DOCUMENT_MAX_BYTES, category: category === "videos" ? "video" : null });
        const response = await ctx.run("setRowAttachment", {
          batchId: workspace.batch.id,
          rowId: row.id,
          category,
          file: payload,
        });
        if (response.ok) input.value = "";
      } catch (error) {
        notify(errorText(error, `Could not read the selected ${label.toLowerCase()} file.`), true);
      } finally {
        slotStatus.hidden = true;
      }
    };
    input.addEventListener("change", () => { void slotFlight(uploadSlotFile); });
    const previewButton = asset && attachmentCanPreview(asset)
      ? button("Preview", () => { void previewAttachment(asset, ctx.service, `${text(row.title)} · ${label}`); }, "button-quiet qc-ops-small-button")
      : null;
    if (previewButton) previewButton.setAttribute("aria-label", inspectionControlName({ action: "Preview", slot: label, fileName: assetName }, row));
    const downloadButton = asset && (asset.dataUrl || asset.id)
      ? button("Download", () => {
        void downloadAttachment(asset, ctx.service).catch((error) => notify(errorText(error, "The file could not be downloaded."), true));
      }, "button-quiet qc-ops-small-button")
      : null;
    if (downloadButton) downloadButton.setAttribute("aria-label", inspectionControlName({ action: "Download", slot: label, fileName: assetName }, row));
    const removeButton = asset
      ? button("Remove", () => {
        if (!window.confirm(`Remove “${text(asset.name, "this attachment")}” from this inspection row?`)) return;
        void slotFlight(() => ctx.run("removeRowAttachment", { batchId: workspace.batch.id, rowId: row.id, category }));
      }, "button-quiet qc-ops-attachment-remove")
      : null;
    if (removeButton) {
      removeButton.setAttribute("aria-label", inspectionControlName({ action: "Remove", slot: label, fileName: assetName }, row));
      removeButton.disabled = readOnly;
    }
    const slot = el("div", { className: "qc-ops-row-attachment-slot" },
      el("strong", {}, label),
      asset ? el("span", { className: "qc-ops-row-attachment-name", title: text(asset.name) }, assetName) : null,
      previewButton,
      downloadButton,
      choose,
      removeButton,
      slotStatus,
      input,
    );
    cell.append(slot);
  }
  return cell;
}

export function batchAttachments(batch, state) {
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
      void removeFlight(() => ctx.run("removeBatchAttachment", { batchId: batch.id, assetId: asset.id }));
    }, "button-danger qc-ops-small-button");
    const removeFlight = createSingleFlight({ controls: () => [remove] });
    remove.disabled = locked;
    if (batch.status === "released") remove.title = "Released batch attachments are read-only.";
    actions.push(remove);
  }
  return el("div", { className: "qc-ops-attachment-actions" }, actions);
}

export function renderBatchAttachments(workspace, state, ctx, { compact = false } = {}) {
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
  const uploadStatus = el("p", { className: "upload-feedback", role: "status", ariaLive: "polite", hidden: true });
  const uploadFlight = createSingleFlight({ controls: () => [add] });
  const uploadBatchFiles = async () => {
    const files = Array.from(fileInput.files || []);
    if (!files.length) return;
    try {
      // Each batch attachment is its own request, so the per-file limit also bounds every request.
      for (const file of files) {
        if (file.size > DOCUMENT_MAX_BYTES) {
          notify(`${file.name} exceeds the ${formatMebibytes(DOCUMENT_MAX_BYTES)} per-file limit.`, true);
          continue;
        }
        uploadStatus.textContent = uploadingLabel(file.size);
        uploadStatus.hidden = false;
        try {
          const payload = await readAttachmentFile(file, { maxBytes: DOCUMENT_MAX_BYTES });
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
    } finally {
      uploadStatus.hidden = true;
      fileInput.value = "";
    }
  };
  fileInput.addEventListener("change", () => { void uploadFlight(uploadBatchFiles); });
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
    uploadStatus,
    el("ul", { className: "qc-ops-attachment-list" }, items),
    fileInput,
  );
  if (!compact) return section;
  return el("details", { className: "qc-ops-attachments-disclosure" },
    el("summary", {}, `Attachments · ${attachmentList.length}`),
    section,
  );
}
