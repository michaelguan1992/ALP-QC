import test from "node:test";
import assert from "node:assert/strict";
import { formatNumberedDescription } from "../qc-source-description.js";

test("formats inline and already separated numbered points onto separate lines", () => {
  assert.equal(
    formatNumberedDescription("1. Keep the first point. 2.优化第二点\n3. Final point."),
    "1. Keep the first point.\n2.优化第二点\n3. Final point.",
  );
});

test("does not split decimal values, percentages, version labels, or measurements", () => {
  const source = "1. Keep 1.25m, 0.25%, version 26.08.19, and 32.3~34.0W. 2. Next point.";
  assert.equal(
    formatNumberedDescription(source),
    "1. Keep 1.25m, 0.25%, version 26.08.19, and 32.3~34.0W.\n2. Next point.",
  );
});

test("recognizes the source's punctuation-less sequential Chinese marker", () => {
  assert.equal(
    formatNumberedDescription("1. First point. 2. Second point. 3调整DN8 and check again. 4. Final point."),
    "1. First point.\n2. Second point.\n3调整DN8 and check again.\n4. Final point.",
  );
});

test("does not treat percentages or unit values as a missing numbered point", () => {
  const source = "1. Reduce to 2% or 2m, then continue with the same instruction.";
  assert.equal(formatNumberedDescription(source), source);
});

test("keeps non-numbered source text unchanged", () => {
  const source = "Version 26.08.19 uses 1.25m and 0.25% tolerance.";
  assert.equal(formatNumberedDescription(source), source);
});
