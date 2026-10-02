import test from "node:test";
import assert from "node:assert/strict";
import { hasActionLogDraft, remainingIssueDraftAfterActionLog } from "../frontend/qc-issue-drafts.js";

test("action-log drafts are dirty when text, type, or evidence is present", () => {
  assert.equal(hasActionLogDraft({ actionSubmitterName: "", actionType: "", actionSummary: "", actionResult: "", actionFiles: [] }), false);
  assert.equal(hasActionLogDraft({ actionSubmitterName: "  ", actionType: "", actionSummary: "", actionResult: "", actionFiles: [] }), true);
  assert.equal(hasActionLogDraft({ actionFiles: [{ name: "evidence.txt" }] }), true);
});

test("submitting an action log clears only the submitted draft values and files", () => {
  const submittedFile = { name: "submitted.pdf" };
  const newerFile = { name: "newer.pdf" };
  const submitted = {
    actionSubmitterName: "Alex",
    actionType: "rework",
    actionSummary: "Repair the seam",
    actionResult: "Passed after repair",
    actionFiles: [submittedFile],
    actionRequestId: "request-1",
    discussionText: "Keep this discussion draft",
  };
  const current = {
    ...submitted,
    actionSummary: "Newer summary",
    actionFiles: [submittedFile, newerFile],
    actionRequestId: "request-2",
  };

  const remaining = remainingIssueDraftAfterActionLog(current, submitted);

  assert.equal(remaining.actionSubmitterName, "");
  assert.equal(remaining.actionType, "");
  assert.equal(remaining.actionSummary, "Newer summary");
  assert.equal(remaining.actionResult, "");
  assert.deepEqual(remaining.actionFiles, [newerFile]);
  assert.equal(remaining.actionRequestId, "request-2");
  assert.equal(remaining.discussionText, "Keep this discussion draft");
});
