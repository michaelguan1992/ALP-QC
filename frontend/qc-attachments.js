import { button, downloadFile, el, notify, readFileAsDataURL, showDialog } from "./qc-ui.js";

export const MEBIBYTE = 1024 * 1024;

const previewableImages = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/avif",
]);
const videoTypes = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const extensionTypes = new Map([
  [".avif", "image/avif"], [".bmp", "image/bmp"], [".csv", "text/csv"],
  [".doc", "application/msword"], [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".gif", "image/gif"], [".jpeg", "image/jpeg"], [".jpg", "image/jpeg"], [".log", "text/plain"],
  [".markdown", "text/markdown"], [".md", "text/markdown"], [".mov", "video/quicktime"], [".mp4", "video/mp4"],
  [".pdf", "application/pdf"], [".png", "image/png"], [".ppt", "application/vnd.ms-powerpoint"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"], [".txt", "text/plain"],
  [".webm", "video/webm"], [".webp", "image/webp"], [".xls", "application/vnd.ms-excel"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], [".zip", "application/zip"],
]);

let activeDialogPreviewCleanup = null;
const assetContentsByService = new WeakMap();
const MAX_CACHED_ASSETS = 32;
const MAX_CACHED_ASSET_BYTES = 32 * MEBIBYTE;

export function normalizedMimeType(name, mimeType = "") {
  const supplied = String(mimeType || "").split(";", 1)[0].trim().toLowerCase();
  if (supplied && supplied !== "application/octet-stream") return supplied;
  const filename = String(name || "").toLowerCase();
  for (const [extension, type] of extensionTypes) {
    if (filename.endsWith(extension)) return type;
  }
  return supplied || "application/octet-stream";
}

export function issueAttachmentCategory(mimeType) {
  return String(mimeType || "").toLowerCase().startsWith("image/") ? "photo" : "file";
}

export async function readAttachmentFile(file, { maxBytes = null, category = null } = {}) {
  if (maxBytes !== null && file.size > maxBytes) {
    throw new Error(`${file.name || "The selected file"} exceeds the ${(maxBytes / MEBIBYTE).toFixed(0)} MiB per-file limit.`);
  }
  const mimeType = normalizedMimeType(file.name, file.type);
  if (category === "video" && !videoTypes.has(mimeType)) {
    throw new Error("Choose an MP4, MOV, or WebM video.");
  }
  if (category === "photo" && !mimeType.startsWith("image/")) {
    throw new Error("Choose an image file.");
  }
  const rawDataUrl = await readFileAsDataURL(file);
  const comma = rawDataUrl.indexOf(",");
  if (comma < 0) throw new Error("The selected file could not be read.");
  const encoding = /;base64/i.test(rawDataUrl.slice(0, comma)) ? ";base64" : "";
  return {
    name: String(file.name || "Attachment"),
    mimeType,
    dataUrl: `data:${mimeType}${encoding},${rawDataUrl.slice(comma + 1)}`,
  };
}

function blobFromDataUrl(dataUrl, fallbackMimeType = "application/octet-stream") {
  if (typeof dataUrl !== "string") throw new Error("The stored file data is invalid.");
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("The stored file data is invalid.");
  const metadata = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  const mimeType = metadata.match(/^data:([^;,]+)/)?.[1] || fallbackMimeType;
  let bytes;
  if (/;base64/i.test(metadata)) {
    const binary = atob(payload);
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(payload));
  }
  return new Blob([bytes], { type: mimeType });
}

function textFromDataUrl(dataUrl) {
  const blob = blobFromDataUrl(dataUrl, "text/plain");
  return blob.text();
}

export function attachmentCanPreview(asset) {
  const mimeType = normalizedMimeType(asset?.name, asset?.mimeType);
  return previewableImages.has(mimeType) || mimeType === "application/pdf" || videoTypes.has(mimeType) ||
    ["text/plain", "text/csv", "text/markdown"].includes(mimeType);
}

export async function loadAssetContent(asset, service) {
  if (typeof asset?.dataUrl === "string") return asset;
  if (!asset?.id || typeof service?.getAsset !== "function") throw new Error("The file content is unavailable.");
  let loadedAssetContents = assetContentsByService.get(service);
  if (!loadedAssetContents) {
    loadedAssetContents = new Map();
    assetContentsByService.set(service, loadedAssetContents);
  }
  const cacheKey = `${asset.id}:${asset.contentRevision ?? "unknown"}`;
  if (loadedAssetContents.has(cacheKey)) {
    const entry = loadedAssetContents.get(cacheKey);
    loadedAssetContents.delete(cacheKey);
    loadedAssetContents.set(cacheKey, entry);
    return entry.promise;
  }
  for (const key of loadedAssetContents.keys()) {
    if (key.startsWith(`${asset.id}:`) && key !== cacheKey) loadedAssetContents.delete(key);
  }
  const entry = { bytes: Math.max(0, Number(asset.decodedBytes) || 0), promise: null };
  const pending = Promise.resolve(service.getAsset(asset.id)).then((fullAsset) => {
    if (!fullAsset || typeof fullAsset.dataUrl !== "string") throw new Error("The file content is unavailable.");
    entry.bytes = Math.max(0, Number(fullAsset.decodedBytes ?? asset.decodedBytes) || 0);
    while (loadedAssetContents.size > MAX_CACHED_ASSETS || [...loadedAssetContents.values()].reduce((sum, cached) => sum + cached.bytes, 0) > MAX_CACHED_ASSET_BYTES) {
      const oldestKey = loadedAssetContents.keys().next().value;
      loadedAssetContents.delete(oldestKey);
      if (oldestKey === cacheKey && !loadedAssetContents.has(cacheKey)) break;
    }
    return { ...asset, ...fullAsset };
  });
  entry.promise = pending;
  loadedAssetContents.set(cacheKey, entry);
  try {
    return await pending;
  } catch (error) {
    if (loadedAssetContents.get(cacheKey) === entry) loadedAssetContents.delete(cacheKey);
    throw error;
  }
}

export function loadAssetImage(image, asset, service) {
  const setSource = (fullAsset) => {
    if (!image?.isConnected || typeof fullAsset?.dataUrl !== "string" || !fullAsset.dataUrl.startsWith("data:image/")) return false;
    image.src = fullAsset.dataUrl;
    return true;
  };
  if (typeof asset?.dataUrl === "string") {
    setSource(asset);
    return Promise.resolve(asset);
  }
  return loadAssetContent(asset, service).then((fullAsset) => {
    setSource(fullAsset);
    return fullAsset;
  }).catch((error) => {
    if (image?.isConnected) image.classList.add("qc-ops-asset-unavailable");
    notify(error instanceof Error ? error.message : "The image could not be loaded.", true);
    return null;
  });
}

export function previewAttachment(asset, service, title = null) {
  return loadAssetContent(asset, service)
    .then((fullAsset) => openAttachmentPreview(fullAsset, title))
    .catch((error) => {
      notify(error instanceof Error ? error.message : "The file preview could not be opened.", true);
      return null;
    });
}

export function downloadAttachment(asset, service, fallbackLabel = "Attachment") {
  return loadAssetContent(asset, service).then((fullAsset) => {
    const name = String(fullAsset.name || fallbackLabel);
    return downloadFile(name, fullAsset.dataUrl, fullAsset.mimeType);
  });
}

export function createAttachmentPreview(asset) {
  const name = String(asset?.name || "Attachment");
  const mimeType = normalizedMimeType(name, asset?.mimeType);
  if (previewableImages.has(mimeType) && typeof asset?.dataUrl === "string" && asset.dataUrl.startsWith("data:image/")) {
    return {
      element: el("img", { className: "qc-ops-attachment-preview-image", src: asset.dataUrl, alt: name }),
      cleanup() {},
    };
  }
  if (mimeType === "application/pdf" && asset?.dataUrl) {
    const url = URL.createObjectURL(blobFromDataUrl(asset.dataUrl, mimeType));
    return {
      element: el("iframe", {
        className: "qc-ops-attachment-preview-pdf",
        src: url,
        title: `${name} PDF preview`,
      }),
      cleanup: () => URL.revokeObjectURL(url),
    };
  }
  if (videoTypes.has(mimeType) && asset?.dataUrl) {
    const url = URL.createObjectURL(blobFromDataUrl(asset.dataUrl, mimeType));
    return {
      element: el("video", {
        className: "qc-ops-attachment-preview-video",
        src: url,
        controls: true,
        preload: "metadata",
      }),
      cleanup: () => URL.revokeObjectURL(url),
    };
  }
  if (["text/plain", "text/csv", "text/markdown"].includes(mimeType) && asset?.dataUrl) {
    return {
      element: el("pre", { className: "qc-ops-attachment-preview-text" }, "Loading preview…"),
      load: async (node) => { node.textContent = await textFromDataUrl(asset.dataUrl); },
      cleanup() {},
    };
  }
  return {
    element: el("p", { className: "qc-ops-attachment-preview-unavailable" }, "Preview unavailable."),
    cleanup() {},
  };
}

export function openAttachmentPreview(asset, title = null) {
  if (activeDialogPreviewCleanup) activeDialogPreviewCleanup();
  let preview;
  try {
    preview = createAttachmentPreview(asset);
  } catch (error) {
    notify(error instanceof Error ? error.message : "The file preview could not be opened.", true);
    return null;
  }
  const name = String(asset?.name || "Attachment");
  const previewNode = el("div", { className: "qc-ops-attachment-preview" }, preview.element);
  if (preview.load) {
    void preview.load(preview.element).catch((error) => {
      preview.element.textContent = error instanceof Error ? error.message : "The file preview could not be loaded.";
    });
  }
  const dialog = showDialog(title || `${name} · Preview`, el("div", { className: "qc-ops-dialog-content" },
    previewNode,
    el("div", { className: "qc-ops-dialog-actions" },
      button("Download", () => {
        void downloadFile(name, asset.dataUrl, asset.mimeType).catch((error) => notify(error instanceof Error ? error.message : "The file could not be downloaded.", true));
      }, "button-secondary"),
    ),
  ));
  activeDialogPreviewCleanup = preview.cleanup;
  dialog.addEventListener("close", () => {
    if (activeDialogPreviewCleanup === preview.cleanup) activeDialogPreviewCleanup = null;
    preview.cleanup();
  }, { once: true });
  return dialog;
}

export function attachmentDownload(asset, fallbackLabel = "Attachment", service = null) {
  const name = String(asset?.name || fallbackLabel);
  const action = button("Download", () => {
    void downloadAttachment(asset, service, fallbackLabel).catch((error) => notify(error instanceof Error ? error.message : "The file could not be downloaded.", true));
  }, "button-quiet qc-ops-small-button");
  action.disabled = !asset?.dataUrl && (!asset?.id || typeof service?.getAsset !== "function");
  return action;
}
