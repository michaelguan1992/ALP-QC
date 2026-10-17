// Rules for command results and command failures, kept free of DOM and service access so they can be
// tested directly. The session in qc-session.js applies them to the loaded workspace state.

export const STALE_REVISION_MESSAGE = "Someone else changed this record. Reload the latest data, then reapply your change.";
export const REVISION_RETRY_BLOCKED_MESSAGE = "Reload the latest data before saving again.";
export const SHARED_CHANGE_MESSAGE = "Newer changes from other users are available.";

// Only errors without a structured status or code, such as those from an older server, fall back to the message.
const LEGACY_STALE_MESSAGE = /revision|stale|reload|changed in another|changed since your last view|another (?:tab|browser|window) changed/i;
const UNKNOWN_OUTCOME_CODES = new Set(["request_timeout", "network_error"]);

export function messageOf(error, fallback = "The change could not be saved.") {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return fallback;
}

/** A request timed out or never reached the server, so the change may or may not have been saved. */
export function isUnknownOutcomeError(error) {
  return UNKNOWN_OUTCOME_CODES.has(error?.code);
}

/** The server rejected a save because the same record changed after the revision the page had loaded. */
export function isStaleRevisionError(error) {
  if (!error || isUnknownOutcomeError(error)) return false;
  if (error.code === "stale_revision" || error.status === 409) return true;
  if (error.status === undefined && error.code === undefined) return LEGACY_STALE_MESSAGE.test(String(error.message ?? ""));
  return false;
}

export function staleRevisionError(cause = null) {
  const error = new Error(STALE_REVISION_MESSAGE);
  error.code = "stale_revision";
  error.status = 409;
  if (cause) error.cause = cause;
  return error;
}

/**
 * A command result may be applied to the loaded state only when the server applied it to exactly that
 * state: it was not rebased, and it advanced the revision by one. Anything else needs a full reload.
 */
export function canProjectCommandResult(result, baseRevision) {
  if (!result || result.rebased === true || result.result?.rebased === true) return false;
  const revision = Number(result.revision ?? result.result?.revision);
  return Number.isSafeInteger(baseRevision) && Number.isSafeInteger(revision) && revision === baseRevision + 1;
}
