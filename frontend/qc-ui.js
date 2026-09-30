const dialogHost = document.querySelector("#dialog-host") ?? document.body;
const toastHost = document.querySelector("#toast-host") ?? document.body;
let currentDialogBody = null;
let currentDialogTitle = "";

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
    dialogHost.append(dialog);
  }
  return dialog;
}

function setDialogContent(title, content) {
  const dialog = ensureDialog();
  const header = el("header", { className: "dialog-header" },
    el("h2", {}, title),
    button("Close", () => closeDialog(), "button-quiet dialog-close"),
  );
  const body = el("div", { className: "dialog-content" }, asContentNode(content));
  dialog.replaceChildren(el("div", { className: "dialog-frame" }, header, body));
  currentDialogBody = body;
  currentDialogTitle = title;
  if (!dialog.open) dialog.showModal();
  return dialog;
}

export function showDialog(title, content) {
  const dialog = setDialogContent(title, content);
  const cancelHandler = (event) => event.preventDefault();
  dialog.removeEventListener("cancel", dialog._qcCancelHandler);
  dialog._qcCancelHandler = cancelHandler;
  dialog.addEventListener("cancel", cancelHandler);
  return dialog;
}

export function closeDialog(force = false) {
  const dialog = document.querySelector("#qc-dialog");
  if (!dialog?.open) return true;
  const dirtyForm = dialog.querySelector('form[data-dirty="true"]');
  if (dirtyForm && !force) {
    const previousNodes = [...(currentDialogBody?.childNodes ?? [])];
    const title = currentDialogTitle;
    setDialogContent("Unsaved changes", el("div", { className: "discard-prompt" },
      el("p", {}, "This form has unsaved changes. Keep editing or discard them?"),
      el("div", { className: "button-row" },
        button("Keep editing", () => setDialogContent(title, previousNodes), "button-secondary"),
        button("Discard changes", () => {
          window.dispatchEvent(new CustomEvent("masterqc:discard-dialog-draft", {
            detail: {
              formId: dirtyForm.id || "",
              draftType: dirtyForm.dataset.draftType || "",
              draftId: dirtyForm.dataset.draftId || "",
              issueId: dirtyForm.dataset.issueId || "",
            },
          }));
          closeDialog(true);
        }, "button-danger"),
      ),
    ));
    return false;
  }
  dialog.close();
  currentDialogBody = null;
  currentDialogTitle = "";
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

export async function downloadFile(name, contents, mimeType = "application/octet-stream") {
  let blob;
  if (contents instanceof Blob) {
    blob = contents;
  } else if (typeof contents === "string" && contents.startsWith("data:")) {
    const comma = contents.indexOf(",");
    if (comma < 0) throw new Error("The stored file data is invalid.");
    const metadata = contents.slice(0, comma);
    const payload = contents.slice(comma + 1);
    const mediaType = metadata.match(/^data:([^;,]+)/)?.[1] || mimeType;
    let bytes;
    if (/;base64/i.test(metadata)) {
      const binary = atob(payload);
      bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(payload));
    }
    blob = new Blob([bytes], { type: mediaType });
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
