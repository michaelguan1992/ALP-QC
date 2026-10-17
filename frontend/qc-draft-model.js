// Field rules for unsent batch and Issue edits. Everything here is pure: it decides which fields differ
// from the saved record, which stored values may be restored, and how a value reads in the restore
// notice. Draft values are text, as the inputs hold them, so saved values are converted to the same text.

export function textOf(value) {
  return value === null || value === undefined ? "" : String(value);
}

/** The number a draft or saved entry stands for: blank is null, numeric text is its number, anything else NaN. */
function numericOf(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return Number.NaN;
}

export function sameNumber(left, right) {
  const a = numericOf(left);
  const b = numericOf(right);
  if (a === null || b === null) return a === b;
  return Number.isFinite(a) && a === b;
}

export function sameText(left, right) {
  return textOf(left) === textOf(right);
}

export function sameTrimmedText(left, right) {
  return textOf(left).trim() === textOf(right).trim();
}

/**
 * Inspection row fields a draft can hold. `read` gives the saved value as draft text; a row that does not
 * carry the time field yields undefined, the same as an untouched legacy row.
 */
export const ROW_FIELDS = Object.freeze({
  inspectedQty: Object.freeze({ label: "Inspection quantity", invalidFlag: "invalidInspectedQty", same: sameNumber, read: (row) => textOf(row.inspectedQty) }),
  defectiveQty: Object.freeze({ label: "Defective quantity", invalidFlag: "invalidDefectiveQty", same: sameNumber, read: (row) => textOf(row.defectiveQty) }),
  actualTimeSeconds: Object.freeze({
    label: "Time (seconds)",
    invalidFlag: "invalidActualTimeSeconds",
    same: sameNumber,
    read: (row) => (Object.hasOwn(row, "actualTimeSeconds") ? textOf(row.actualTimeSeconds) : undefined),
  }),
  remarks: Object.freeze({ label: "Remarks", invalidFlag: null, same: sameTrimmedText, read: (row) => textOf(row.remarks) }),
});

/** Row fields a draft may change. Operational rows calculate their inspection quantity, so it is not one of them. */
export function rowFieldNames(historical) {
  return historical
    ? ["inspectedQty", "defectiveQty", "actualTimeSeconds", "remarks"]
    : ["defectiveQty", "actualTimeSeconds", "remarks"];
}

/**
 * Batch details fields. The core stores the recorder and the notes trimmed, so they are compared trimmed: a space typed
 * at the end is not a change to restore or save.
 */
export const DETAIL_FIELDS = Object.freeze({
  date: Object.freeze({ label: "Batch date", same: sameText, read: (details) => textOf(details.date) }),
  recorder: Object.freeze({ label: "Recorded by", same: sameTrimmedText, read: (details) => textOf(details.recorder) }),
  notes: Object.freeze({ label: "Special notes", same: sameTrimmedText, read: (details) => textOf(details.notes) }),
});

/** Disposition fields of an Issue. Confirmations are compared trimmed, as the save command compares them. */
export const ISSUE_FIELDS = Object.freeze({
  owner: Object.freeze({ label: "Disposition owner", same: sameTrimmedText, read: (issue) => textOf(issue.owner) }),
  disposition: Object.freeze({ label: "Formal disposition", same: sameTrimmedText, read: (issue) => textOf(issue.disposition) }),
  confirmation1: Object.freeze({ label: "Confirmation 1", same: sameTrimmedText, read: (issue) => textOf(issue.confirmations?.[0]) }),
  confirmation2: Object.freeze({ label: "Confirmation 2", same: sameTrimmedText, read: (issue) => textOf(issue.confirmations?.[1]) }),
  confirmation3: Object.freeze({ label: "Confirmation 3", same: sameTrimmedText, read: (issue) => textOf(issue.confirmations?.[2]) }),
});

/** Picks the named fields out of a field table. */
export function pickFields(table, names) {
  return Object.fromEntries(names.filter((name) => table[name]).map((name) => [name, table[name]]));
}

/** The saved text of every field in `fields`, read from `source`. */
export function savedTextOf(fields, source) {
  return Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.read(source)]));
}

/**
 * Decides what becomes of each draft field when the draft is reconciled with the saved record.
 *
 * A field whose draft already equals the saved value is not a change at all, so it is dropped quietly. A
 * changed field is kept when its base (the saved text the user started editing from) still matches the
 * saved value, or when no base is known. A changed field whose saved value has moved on since the base is
 * a conflict: it is not applied, and the user is told. `skip` leaves a field alone (for example an entry
 * the user left invalid, which must never be saved as blank).
 */
export function classifyFields(fields, { draft, saved, bases = {}, skip = () => false }) {
  const keep = {};
  const conflicts = [];
  for (const [name, field] of Object.entries(fields)) {
    if (draft[name] === undefined || skip(name)) continue;
    if (field.same(draft[name], saved[name])) continue;
    const base = bases[name];
    if (base === undefined || field.same(base, saved[name])) keep[name] = draft[name];
    else conflicts.push({ name, label: field.label, value: draft[name] });
  }
  return { keep, conflicts };
}

/** How a draft value reads in the restore notice. Blank values say so, and long text is shortened. */
export function describeDraftValue(value) {
  const text = textOf(value).trim();
  if (!text) return "blank";
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}
