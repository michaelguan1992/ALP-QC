export const QC_SCHEMA_VERSION = 1;
export const BACKUP_FORMAT = "masterqc-web-backup";
export const BACKUP_FORMAT_VERSION = 1;
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ASSET_TOTAL_MAX_BYTES = 30 * 1024 * 1024;
export const BACKUP_MAX_BYTES = 50 * 1024 * 1024;

export const PHOTO_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const VIDEO_MIMES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const OFFICE_MIMES = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip",
]);
export const DOCUMENT_MIMES = new Set([
  ...PHOTO_MIMES,
  ...VIDEO_MIMES,
  ...OFFICE_MIMES,
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/markdown",
]);
export const ROW_ATTACHMENT_CATEGORIES = new Set(["videos", "procedures", "log"]);
export const TEXT_EXTENSIONS = new Set([".txt", ".csv", ".md", ".markdown", ".log"]);
export const MIME_EXTENSIONS = new Map([
  ["application/pdf", new Set([".pdf"])],
  ["application/msword", new Set([".doc"])],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", new Set([".docx"])],
  ["application/vnd.ms-excel", new Set([".xls"])],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", new Set([".xlsx"])],
  ["application/vnd.ms-powerpoint", new Set([".ppt"])],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", new Set([".pptx"])],
  ["application/zip", new Set([".zip"])],
  ["image/png", new Set([".png"])],
  ["image/jpeg", new Set([".jpg", ".jpeg"])],
  ["image/webp", new Set([".webp"])],
  ["image/gif", new Set([".gif"])],
  ["text/csv", new Set([".csv"])],
  ["text/markdown", new Set([".md", ".markdown"])],
  ["video/mp4", new Set([".mp4"])],
  ["video/quicktime", new Set([".mov"])],
  ["video/webm", new Set([".webm"])],
]);
export const DANGEROUS_EXTENSIONS = /\.(?:html?|xhtml|svg|js|mjs|cjs|wasm|hta|jar|exe|bat|cmd|sh|ps1)$/i;

const SEEDED_VARIANT_IDS = [
  ["S11", "Red", "10000000-0000-4000-8000-000000000111"],
  ["S11", "Yellow", "10000000-0000-4000-8000-000000000112"],
  ["S12", "Red", "10000000-0000-4000-8000-000000000121"],
  ["S12", "Yellow", "10000000-0000-4000-8000-000000000122"],
  ["S13", "Red", "10000000-0000-4000-8000-000000000131"],
  ["S13", "Yellow", "10000000-0000-4000-8000-000000000132"],
  ["S14", "Red", "10000000-0000-4000-8000-000000000141"],
  ["S14", "Yellow", "10000000-0000-4000-8000-000000000142"],
  ["S15", "Red", "10000000-0000-4000-8000-000000000151"],
  ["S15", "Yellow", "10000000-0000-4000-8000-000000000152"],
];

export function createInitialQCState() {
  const families = [
    { id: "s11-s14", name: "S11–S14", models: ["S11", "S12", "S13", "S14"] },
    { id: "s15", name: "S15", models: ["S15"] },
  ];
  const variants = SEEDED_VARIANT_IDS.map(([model, color, id]) => ({
    id,
    familyId: model === "S15" ? "s15" : "s11-s14",
    model,
    color,
    label: color === "Red" ? model : `${model} ${color}`,
    active: true,
  }));

  return {
    schemaVersion: QC_SCHEMA_VERSION,
    revision: 0,
    families,
    variants,
    versions: [],
    orders: [],
    batches: [],
    issues: [],
    assets: [],
    history: { sources: [], inspections: [], anomalies: [] },
    audit: [],
  };
}

export function clone(value) {
  return structuredClone(value);
}

export function fail(message) {
  throw new Error(message);
}

export function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  return value;
}

export function requireArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be a list.`);
  return value;
}

export function requireString(value, label, { maxLength = 1000, allowBlank = false } = {}) {
  if (typeof value !== "string") fail(`${label} must be text.`);
  const normalized = value.trim();
  if (!allowBlank && !normalized) fail(`${label} is required.`);
  if (normalized.length > maxLength) fail(`${label} must be ${maxLength} characters or fewer.`);
  return normalized;
}

export function requireBoolean(value, label) {
  if (typeof value !== "boolean") fail(`${label} must be true or false.`);
  return value;
}

export function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive whole number.`);
  return value;
}

export function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a whole number of zero or more.`);
  return value;
}

export function requireDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${label} must use YYYY-MM-DD.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(`${label} must be a real calendar date.`);
  return value;
}

export function isIsoTimestamp(value) {
  return typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

export function requireTimestamp(value, label) {
  if (!isIsoTimestamp(value)) fail(`${label} must be an ISO timestamp.`);
  return value;
}

export function normalizeFactory(value) {
  const normalized = String(value ?? "").trim().normalize("NFC");
  const text = normalized.toLocaleLowerCase();
  if (["ap", "奥途莱 ap", "autoline pro", "autoline pro ap"].includes(text)) return "AP";
  if (["ui", "优米特 ui", "youmite", "youmite ui"].includes(text)) return "UI";
  return normalized.length <= 100 ? normalized : "";
}

export function factoryKey(value) {
  return normalizeFactory(value).toLocaleLowerCase();
}

export function normalizeStage(value) {
  const text = String(value ?? "").trim().toLocaleLowerCase();
  if (["iqc", "iqc来料", "iqc incoming"].includes(text)) return "IQC";
  if (["oqc", "oqc成品", "oqc outgoing"].includes(text)) return "OQC";
  return "";
}

export function normalizeDataUrl(dataUrl, label) {
  if (typeof dataUrl !== "string") fail(`${label} must be a base64 data URL.`);
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  if (!match || match[2].length % 4 !== 0) fail(`${label} must be a valid base64 data URL.`);
  const payload = match[2];
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const decodedBytes = Math.max(0, (payload.length * 3) / 4 - padding);
  return { mimeType: match[1].toLocaleLowerCase(), decodedBytes };
}

export function safeFilename(value) {
  const name = requireString(value, "File name", { maxLength: 200 });
  if (/[\\/\u0000-\u001f\u007f]/.test(name) || name === "." || name === "..") {
    fail("File name cannot contain path separators or control characters.");
  }
  return name;
}

export function makeId(idFactory) {
  const id = idFactory();
  if (typeof id !== "string" || !id.trim()) fail("The ID generator must return a non-empty string.");
  return id;
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function deepEqual(left, right) {
  return stableStringify(left) === stableStringify(right);
}

export function ensureUnique(values, label) {
  if (new Set(values).size !== values.length) fail(`${label} must be unique.`);
}

export function addAudit(state, { idFactory, now, action, entityId, summary }) {
  const usedIds = new Set(state.audit.map((entry) => entry.id));
  let id = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = makeId(idFactory);
    if (!usedIds.has(candidate)) {
      id = candidate;
      break;
    }
  }
  if (!id) fail("The ID generator could not create a unique audit event ID.");
  state.audit.push({
    id,
    at: now(),
    action,
    entityId,
    summary,
  });
}
