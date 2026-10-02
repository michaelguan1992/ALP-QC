import test from "node:test";
import assert from "node:assert/strict";
import {
  hasRequiredIssuePhoto,
  remainingIssueDraftAfterDiscussion,
  submitDiscussionEntry,
} from "../qc-issue-drafts.js";

test("issue creation requires a selected photo, including one chosen through the general file chooser", () => {
  assert.equal(hasRequiredIssuePhoto([]), false);
  assert.equal(hasRequiredIssuePhoto([{ category: "file" }]), false);
  assert.equal(hasRequiredIssuePhoto([{ category: "file" }, { category: "photo" }]), true);
  assert.equal(hasRequiredIssuePhoto(null), false);
});

test("successful discussion clears unchanged submitted fields but preserves text entered while pending", () => {
  const submitted = { discussionAuthorName: "Avery", discussionText: "Found a defect." };
  const current = { ...submitted, owner: "Jonson", disposition: "", confirmations: ["", "", ""] };
  assert.deepEqual(remainingIssueDraftAfterDiscussion(current, submitted), {
    ...current,
    discussionAuthorName: "",
    discussionText: "",
  });

  const newer = { ...current, discussionText: "Another issue to discuss." };
  assert.deepEqual(remainingIssueDraftAfterDiscussion(newer, submitted), {
    ...newer,
    discussionAuthorName: "",
    discussionText: "Another issue to discuss.",
  });
});

test("posting discussion requests a data refresh without rerendering the Issue dialog", async () => {
  let command;
  const ctx = { run: (...args) => { command = args; return Promise.resolve({ ok: true }); } };
  await submitDiscussionEntry(ctx, "issue-7", "Found a defect.", "Avery");
  assert.deepEqual(command, [
    "addDiscussion",
    { id: "issue-7", text: "Found a defect.", authorName: "Avery" },
    { render: false },
  ]);
});
