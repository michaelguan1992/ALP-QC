import test from "node:test";
import assert from "node:assert/strict";
import {
  STALE_REVISION_MESSAGE,
  canProjectCommandResult,
  isStaleRevisionError,
  isUnknownOutcomeError,
  messageOf,
  staleRevisionError,
} from "../qc-command-rules.js";

const TIMEOUT_MESSAGE = "The server did not respond in time. The change may or may not have been saved. Reload the latest data to check before trying again.";

function failure(message, fields = {}) {
  return Object.assign(new Error(message), fields);
}

test("a stale revision is recognised by its code or its 409 status", () => {
  assert.equal(isStaleRevisionError(failure("Someone else changed this record.", { code: "stale_revision", status: 409 })), true);
  assert.equal(isStaleRevisionError(failure("Changed.", { status: 409 })), true);
  assert.equal(isStaleRevisionError(failure("Changed.", { status: 409, code: "stale_revision" })), true);
});

test("a structured error that is not a conflict is not stale, even when its message mentions revisions", () => {
  assert.equal(isStaleRevisionError(failure("Expected revision must be a non-negative whole number.", { status: 400, code: "invalid_revision" })), false);
  assert.equal(isStaleRevisionError(failure("Reload the page to sign in again.", { status: 401 })), false);
});

test("an error without a status or code is stale only when its message says so", () => {
  assert.equal(isStaleRevisionError(failure("This data changed since your last view. Reload the latest state and retry.")), true);
  assert.equal(isStaleRevisionError(failure("The workspace revision moved on.")), true);
  assert.equal(isStaleRevisionError(failure("Quantity must be a positive whole number.")), false);
  assert.equal(isStaleRevisionError(null), false);
});

test("a timeout or network failure is never stale, even though its guidance says to reload", () => {
  const timeout = failure(TIMEOUT_MESSAGE, { code: "request_timeout" });
  assert.equal(isStaleRevisionError(timeout), false);
  assert.equal(isUnknownOutcomeError(timeout), true);
  const network = failure("Could not reach the QC server. Check your connection; unsaved edits are still on this page.", { code: "network_error" });
  assert.equal(isStaleRevisionError(network), false);
  assert.equal(isUnknownOutcomeError(network), true);
  assert.equal(isUnknownOutcomeError(failure("Changed.", { status: 409 })), false);
});

test("the normalised stale error carries the blocking message and keeps the cause", () => {
  const cause = failure("This data changed since your last view.", { status: 409 });
  const error = staleRevisionError(cause);
  assert.equal(error.message, STALE_REVISION_MESSAGE);
  assert.equal(error.code, "stale_revision");
  assert.equal(error.status, 409);
  assert.equal(error.cause, cause);
});

test("messageOf reads Error and string values and falls back otherwise", () => {
  assert.equal(messageOf(new Error("Saved elsewhere.")), "Saved elsewhere.");
  assert.equal(messageOf("Plain text."), "Plain text.");
  assert.equal(messageOf(null), "The change could not be saved.");
  assert.equal(messageOf(undefined, "Fallback."), "Fallback.");
});

test("a result is projected only when it advanced the loaded revision by exactly one and was not rebased", () => {
  assert.equal(canProjectCommandResult({ revision: 5, changes: {} }, 4), true);
  assert.equal(canProjectCommandResult({ result: { revision: 5 } }, 4), true);
});

test("a rebased result is never projected, whether the flag is at the top level or inside the result", () => {
  assert.equal(canProjectCommandResult({ revision: 5, rebased: true, changes: {} }, 4), false);
  assert.equal(canProjectCommandResult({ result: { revision: 5, rebased: true } }, 4), false);
});

test("a result that did not advance the loaded revision by one needs a full reload", () => {
  assert.equal(canProjectCommandResult({ revision: 4, changes: {} }, 4), false, "no-op command");
  assert.equal(canProjectCommandResult({ revision: 6, changes: {} }, 4), false, "another client changed the workspace");
  assert.equal(canProjectCommandResult({}, 4), false, "no revision reported");
  assert.equal(canProjectCommandResult(null, 4), false);
  assert.equal(canProjectCommandResult({ revision: 5 }, undefined), false, "no loaded revision");
});
