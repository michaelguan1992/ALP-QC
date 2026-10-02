export function hasRequiredIssuePhoto(files) {
  return Array.isArray(files) && files.some((entry) => entry?.category === "photo");
}

export function remainingIssueDraftAfterDiscussion(currentDraft, submittedDraft) {
  return {
    ...currentDraft,
    discussionAuthorName: currentDraft.discussionAuthorName === submittedDraft.discussionAuthorName
      ? ""
      : currentDraft.discussionAuthorName,
    discussionText: currentDraft.discussionText === submittedDraft.discussionText
      ? ""
      : currentDraft.discussionText,
  };
}

export function submitDiscussionEntry(ctx, issueId, text, authorName) {
  return ctx.run("addDiscussion", { id: issueId, text, authorName }, { render: false });
}
