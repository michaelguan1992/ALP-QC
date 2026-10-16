const dialogHost = document.querySelector("#dialog-host") ?? document.body;
const toastHost = document.querySelector("#toast-host") ?? document.body;
let currentDialogBody = null;
let currentDialogTitle = "";
// Handles Escape and the header Close button for the content on screen; null means the default dialog close.
let currentCloseRequest = null;

function appendChild(parent, child) {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) {
    child.forEach((item) => appendChild(parent, item));
  } else if (child instanceof Node) {
    parent.append(child);
  } else if (typeof child === "string" || typeof child === "number") {
    parent.append(document.createTextNode(String(child)));
  }
}

const propertyNames = new Set([
  "value", "checked", "disabled", "multiple", "selected", "required", "readOnly",
  "tabIndex", "autofocus", "maxLength", "min", "max", "step", "type", "name",
  "id", "title", "role", "placeholder", "accept", "htmlFor", "colSpan", "rowSpan",
  "hidden", "open", "dateTime", "download", "target", "rel", "href", "src",
  "ariaLabel", "ariaDescribedBy", "ariaLive", "spellcheck", "autoComplete",
]);

/** Create an element with safe text children and explicit DOM properties. */
export function el(tag, props = {}, ...children) {
  if (props === null || typeof props !== "object" || Array.isArray(props) || props instanceof Node) {
    children.unshift(props);
    props = {};
  }
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "className") {
      node.className = String(value);
    } else if (key === "dataset" && typeof value === "object") {
      for (const [dataKey, dataValue] of Object.entries(value)) node.dataset[dataKey] = String(dataValue);
    } else if (key === "style" && typeof value === "object") {
      Object.assign(node.style, value);
    } else if (/^on[A-Z]/.test(key) && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "ariaLabel" || key === "ariaDescribedBy" || key === "ariaLive") {
      const attribute = ({ ariaLabel: "aria-label", ariaDescribedBy: "aria-describedby", ariaLive: "aria-live" })[key];
      node.setAttribute(attribute, String(value));
    } else if (propertyNames.has(key)) {
      if (key === "role" || key === "title") {
        node.setAttribute(key, String(value));
      } else {
        try { node[key] = value; } catch { node.setAttribute(key, String(value)); }
      }
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, String(value));
    }
  }
  children.forEach((child) => appendChild(node, child));
  return node;
}

export function field(label, input, help = "") {
  const wrapper = el("label", { className: "field" }, el("span", { className: "field-label" }, label), input);
  if (help) wrapper.append(el("span", { className: "field-help" }, help));
  return wrapper;
}

export function button(label, handler, className = "") {
  const node = el("button", { type: "button", className: `button ${className}`.trim() }, label);
  if (handler) node.addEventListener("click", handler);
  return node;
}

function asContentNode(content) {
  if (content instanceof Node) return content;
  const fragment = document.createDocumentFragment();
  appendChild(fragment, content);
  return fragment;
}

function ensureDialog() {
  let dialog = document.querySelector("#qc-dialog");
  if (!dialog) {
    dialog = el("dialog", { id: "qc-dialog", className: "qc-dialog" });
    // Escape goes through the same close-request path as the Close button instead of closing natively.
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      requestDialogClose();
    });
    dialogHost.append(dialog);
  }
  return dialog;
}

function setDialogContent(title, content) {
  const dialog = ensureDialog();
  const header = el("header", { className: "dialog-header" },
    el("h2", {}, title),
    button("Close", () => requestDialogClose(), "button-quiet dialog-close"),
  );
  const body = el("div", { className: "dialog-content" }, asContentNode(content));
  dialog.replaceChildren(el("div", { className: "dialog-frame" }, header, body));
  currentDialogBody = body;
  currentDialogTitle = title;
  if (!dialog.open) dialog.showModal();
  return dialog;
}

/**
 * Shows content in the shared dialog. `onCloseRequest`, when given, decides what Escape and the
 * Close button do for this content (for example, routing through an unsaved-changes guard).
 */
export function showDialog(title, content, { onCloseRequest = null } = {}) {
  const dialog = setDialogContent(title, content);
  currentCloseRequest = typeof onCloseRequest === "function" ? onCloseRequest : null;
  return dialog;
}

/** Captures the content on screen so a prompt can replace it and then restore it. */
export function captureDialogState() {
  const dialog = document.querySelector("#qc-dialog");
  if (!dialog?.open) return null;
  return {
    dialog,
    title: currentDialogTitle,
    nodes: [...(currentDialogBody?.childNodes ?? [])],
    closeRequest: currentCloseRequest,
  };
}

/** Restores content captured by captureDialogState, including its close behavior. */
export function restoreDialogState(state) {
  if (!state?.dialog?.open) return false;
  showDialog(state.title, state.nodes, { onCloseRequest: state.closeRequest });
  return true;
}

function findDirtyDialogForm(dialog) {
  // Issue forms are guarded by their own manual-save controller, so the generic check leaves them alone.
  return [...dialog.querySelectorAll('form[data-dirty="true"]')].find((form) => !form.dataset.issueId) ?? null;
}

/** Runs the close behavior of the content on screen (Escape, Close button). */
export function requestDialogClose() {
  if (currentCloseRequest) return currentCloseRequest();
  return closeDialog();
}

export function closeDialog(force = false) {
  const dialog = document.querySelector("#qc-dialog");
  if (!dialog?.open) return true;
  const dirtyForm = findDirtyDialogForm(dialog);
  if (dirtyForm && !force) {
    const previous = captureDialogState();
    const discardDetail = {
      formId: dirtyForm.id || "",
      draftType: dirtyForm.dataset.draftType || "",
      draftId: dirtyForm.dataset.draftId || "",
      issueId: dirtyForm.dataset.issueId || "",
    };
    showDialog("Unsaved changes", el("div", { className: "discard-prompt" },
      el("p", {}, "This form has unsaved changes. Keep editing or discard them?"),
      el("div", { className: "button-row" },
        button("Keep editing", () => restoreDialogState(previous), "button-secondary"),
        button("Discard changes", () => {
          window.dispatchEvent(new CustomEvent("masterqc:discard-dialog-draft", { detail: discardDetail }));
          closeDialog(true);
        }, "button-danger"),
      ),
    ), { onCloseRequest: () => restoreDialogState(previous) });
    return false;
  }
  dialog.close();
  currentDialogBody = null;
  currentDialogTitle = "";
  currentCloseRequest = null;
  return true;
}

export function notify(message, error = false) {
  const toast = el("div", {
    className: `toast${error ? " toast-error" : ""}`,
    role: error ? "alert" : "status",
  }, message);
  toastHost.append(toast);
  window.setTimeout(() => toast.remove(), 6000);
  return toast;
}

export function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("The file could not be read.")));
    reader.readAsDataURL(file);
  });
}

function safeFilename(value) {
  const cleaned = String(value || "download")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "download";
}

export function blobFromDataUrl(dataUrl, fallbackMimeType = "application/octet-stream") {
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

export async function downloadFile(name, contents, mimeType = "application/octet-stream") {
  let blob;
  if (contents instanceof Blob) {
    blob = contents;
  } else if (typeof contents === "string" && contents.startsWith("data:")) {
    blob = blobFromDataUrl(contents, mimeType);
  } else {
    blob = new Blob([contents], { type: mimeType });
  }
  const url = URL.createObjectURL(blob);
  const anchor = el("a", { href: url, download: safeFilename(name), hidden: true });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function markFormDirty(event) {
  const form = event.target instanceof Element ? event.target.closest("form") : null;
  if (form) form.dataset.dirty = "true";
}

document.addEventListener("input", markFormDirty);
document.addEventListener("change", markFormDirty);
