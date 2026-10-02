export function hasRequiredIssuePhoto(files) {
  return Array.isArray(files) && files.some((entry) => entry?.category === "photo");
}

export function hasActionLogDraft(draft) {
  return Boolean(draft && (
    draft.actionSubmitterName ||
    draft.actionType ||
    draft.actionSummary ||
    draft.actionResult ||
    (Array.isArray(draft.actionFiles) && draft.actionFiles.length)
  ));
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

export function remainingIssueDraftAfterActionLog(currentDraft, submittedDraft) {
  const remaining = { ...currentDraft };
  for (const [key, emptyValue] of [
    ["actionSubmitterName", ""],
    ["actionType", ""],
    ["actionSummary", ""],
    ["actionResult", ""],
  ]) {
    if (currentDraft[key] === submittedDraft[key]) remaining[key] = emptyValue;
  }
  const currentFiles = Array.isArray(currentDraft.actionFiles) ? currentDraft.actionFiles : [];
  const submittedFiles = Array.isArray(submittedDraft.actionFiles) ? submittedDraft.actionFiles : [];
  remaining.actionFiles = currentFiles.filter((file) => !submittedFiles.includes(file));
  if (currentDraft.actionRequestId === submittedDraft.actionRequestId) remaining.actionRequestId = "";
  return remaining;
}

export function submitDiscussionEntry(ctx, issueId, text, authorName) {
  return ctx.run("addDiscussion", { id: issueId, text, authorName }, { render: false });
}
