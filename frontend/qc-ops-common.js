import { el, field, button, notify } from "./qc-ui.js";

export { el, field, button, notify };

export function list(value) {
  return Array.isArray(value) ? value : [];
}

export function text(value, fallback = "—") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

export function quantity(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString("en-US") : "—";
}

export function dateLabel(value) {
  if (!value) return "—";
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

export function timestampLabel(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString();
}

export function sourcePercent(value) {
  if (value === null || value === undefined || value === "") return "—";
  const printed = String(value);
  if (/%\s*$/.test(printed)) return printed;
  return /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(printed.trim()) ? `${printed}%` : printed;
}

export function computedSourceQuantity(batch, row) {
  if (row.status === "missing-from-source" || batch.quantity === null || batch.quantity === undefined || batch.quantity === "" || row.sourceInspectedQty === null || row.sourceInspectedQty === undefined || row.sourceInspectedQty === "" || row.samplingPercent === null || row.samplingPercent === undefined || row.samplingPercent === "") return null;
  const batchQuantity = Number(batch.quantity);
  const samplingPercent = Number(String(row.samplingPercent).replace(/%\s*$/, ""));
  const sourceQuantity = Number(row.sourceInspectedQty);
  if (!Number.isFinite(batchQuantity) || batchQuantity < 0 || !Number.isFinite(samplingPercent) || samplingPercent < 0 || samplingPercent > 100 || !Number.isFinite(sourceQuantity)) return null;
  const computed = Math.ceil(batchQuantity * samplingPercent / 100);
  return computed === sourceQuantity ? null : computed;
}

export function errorText(error, fallback = "The operation could not be completed.") {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return fallback;
}

export function setOptions(select, options, selectedValue = "") {
  const fragment = document.createDocumentFragment();
  for (const option of options) {
    fragment.append(el("option", { value: option.value }, option.label));
  }
  select.replaceChildren(fragment);
  if (options.some((option) => option.value === selectedValue)) select.value = selectedValue;
}

export function pageHeading(title, _description, actions = []) {
  return el("header", { className: "page-heading qc-ops-heading" },
    el("div", {}, el("h1", {}, title)),
    actions.length ? el("div", { className: "qc-ops-heading-actions" }, ...actions) : null
  );
}

export function statusPill(status) {
  const raw = status === null || status === undefined || status === "" ? "unknown" : String(status);
  const value = raw.toLocaleLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const knownLabels = { released: "Released", closed: "Closed", open: "Open", draft: "Draft", historical: "Historical" };
  const label = knownLabels[value] || raw.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toLocaleUpperCase());
  return el("span", { className: `qc-ops-status qc-ops-status-${value}` }, label);
}

export function csvCell(value, { textField = false } = {}) {
  let cell = value === null || value === undefined ? "" : String(value);
  if (textField && (/^[\t\r\n]/.test(cell) || /^[ \u00a0]*[=+\-@]/.test(cell))) cell = `'${cell}`;
  return `"${cell.replaceAll('"', '""')}"`;
}

export function csvRow(values) {
  return values.map((value) => csvCell(value.value, { textField: Boolean(value.textField) })).join(",");
}

export function safeFilename(value, fallback = "masterqc-export") {
  const safe = String(value || fallback)
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe || fallback;
}

export function safeProcedureUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value, window.location.href);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
