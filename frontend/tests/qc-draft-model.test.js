import test from "node:test";
import assert from "node:assert/strict";
import { ISSUE_FIELDS, ROW_FIELDS, classifyFields, describeDraftValue, rowFieldNames, sameNumber, sameText, sameTrimmedText } from "../qc-draft-model.js";

test("numeric comparisons treat blank as null and numeric text as its number", () => {
  assert.equal(sameNumber("", null), true);
  assert.equal(sameNumber("", undefined), true);
  assert.equal(sameNumber("0", 0), true, "zero is an entered result, not a blank");
  assert.equal(sameNumber("1.50", 1.5), true);
  assert.equal(sameNumber("", 0), false);
  assert.equal(sameNumber("abc", "abc"), false, "text that is not a number never counts as saved");
});

test("text comparisons differ by how much whitespace they ignore", () => {
  assert.equal(sameText("Ann", " Ann "), false);
  assert.equal(sameText(null, ""), true);
  assert.equal(sameTrimmedText(" Ann ", "Ann"), true);
});

test("row fields follow the batch kind", () => {
  assert.deepEqual(rowFieldNames(false), ["defectiveQty", "actualTimeSeconds", "remarks"]);
  assert.deepEqual(rowFieldNames(true), ["inspectedQty", "defectiveQty", "actualTimeSeconds", "remarks"]);
  assert.equal(ROW_FIELDS.defectiveQty.read({ defectiveQty: 0 }), "0");
  assert.equal(ROW_FIELDS.actualTimeSeconds.read({}), undefined, "a legacy row without a time is not compared");
});

test("a changed field whose saved value still matches its base is kept", () => {
  const result = classifyFields(ISSUE_FIELDS, {
    draft: { owner: "Ann", disposition: "Rework", confirmation1: "", confirmation2: "", confirmation3: "" },
    saved: { owner: "", disposition: "", confirmation1: "", confirmation2: "", confirmation3: "" },
    bases: { owner: "", disposition: "" },
  });

  assert.deepEqual(result.keep, { owner: "Ann", disposition: "Rework" });
  assert.deepEqual(result.conflicts, []);
});

test("a changed field that someone else has since changed is a conflict, not a keep", () => {
  const result = classifyFields(ISSUE_FIELDS, {
    draft: { owner: "Ann", disposition: "", confirmation1: "", confirmation2: "", confirmation3: "" },
    saved: { owner: "Bea", disposition: "", confirmation1: "", confirmation2: "", confirmation3: "" },
    bases: { owner: "" },
  });

  assert.deepEqual(result.keep, {});
  assert.deepEqual(result.conflicts, [{ name: "owner", label: "Disposition owner", value: "Ann" }]);
});

test("a draft that already equals the saved value is not a change, even when its base differs", () => {
  const result = classifyFields(ISSUE_FIELDS, {
    draft: { owner: "Bea", disposition: "", confirmation1: "", confirmation2: "", confirmation3: "" },
    saved: { owner: "Bea", disposition: "", confirmation1: "", confirmation2: "", confirmation3: "" },
    bases: { owner: "" },
  });

  assert.deepEqual(result, { keep: {}, conflicts: [] });
});

test("a field with no known base is kept, and a skipped field is left alone", () => {
  const result = classifyFields(ISSUE_FIELDS, {
    draft: { owner: "Ann", disposition: "Scrap", confirmation1: "", confirmation2: "", confirmation3: "" },
    saved: { owner: "", disposition: "", confirmation1: "", confirmation2: "", confirmation3: "" },
    bases: {},
    skip: (name) => name === "disposition",
  });

  assert.deepEqual(result.keep, { owner: "Ann" });
});

test("the restore notice shows blank values as blank and shortens long text", () => {
  assert.equal(describeDraftValue("   "), "blank");
  assert.equal(describeDraftValue(null), "blank");
  assert.equal(describeDraftValue("12.5"), "12.5");
  const long = describeDraftValue("x".repeat(200));
  assert.equal(long.length, 80);
  assert.ok(long.endsWith("…"));
});
