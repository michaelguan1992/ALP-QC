// The loaded workspace state for the page shell: command submission, projection of accepted results,
// reloads, stale and unknown-outcome handling, and the shared-change notice. It touches no DOM. The
// shell supplies callbacks for rendering, notices, and other tabs; the rules live in qc-command-rules.js.

import {
  REVISION_RETRY_BLOCKED_MESSAGE,
  STALE_REVISION_MESSAGE,
  canProjectCommandResult,
  isStaleRevisionError,
  isUnknownOutcomeError,
  messageOf,
  staleRevisionError,
} from "./qc-command-rules.js";

const PROJECTED_COLLECTIONS = ["batches", "issues", "audit", "orders"];

/** Applies a command's changed records to the loaded state. Returns the new state, or null if nothing applies. */
function projectChanges(current, commandResult) {
  const changes = commandResult?.changes;
  if (!changes || !current) return null;
  const next = { ...current };
  for (const collection of PROJECTED_COLLECTIONS) {
    const updates = changes[collection];
    if (!Array.isArray(updates) || !updates.length) continue;
    const values = [...(Array.isArray(next[collection]) ? next[collection] : [])];
    for (const update of updates) {
      if (!update?.id) continue;
      const index = values.findIndex((value) => value?.id === update.id);
      if (index < 0) values.push(update);
      else values[index] = { ...values[index], ...update };
    }
    next[collection] = values;
  }
  const revision = Number(commandResult.revision ?? commandResult.result?.revision);
  if (Number.isSafeInteger(revision) && revision >= Number(next.revision || 0)) next.revision = revision;
  return next;
}

/**
 * Creates the session. `service` is the core HTTP facade. The callbacks are optional:
 * - `notify(message, isError)` shows a transient message,
 * - `render()` re-renders the current page after the loaded state changes,
 * - `announceRevision(revision)` tells other tabs of this workspace about a new revision,
 * - `onNotices({ blocking, sharedChange })` reports the warning and notice state.
 */
export function createQCSession({
  service,
  notify = () => {},
  render = () => {},
  announceRevision = () => {},
  onNotices = () => {},
} = {}) {
  let state = null;
  // Counts loaded states. A stale rejection blocks commands until this changes, so a resubmit cannot repeat the same stale revision.
  let generation = 0;
  let staleGuard = null;
  let blocking = "";
  let needsAuthoritativeRefresh = false;
  let commandsInFlight = 0;
  // The newest revision another tab or a poll has reported. The notice shows while it is newer than the loaded state.
  let remoteRevision = 0;
  let queue = Promise.resolve();

  function notices() {
    return { blocking, sharedChange: Boolean(state) && remoteRevision > Number(state.revision) };
  }

  function publish() {
    onNotices(notices());
  }

  function enqueue(work) {
    const pending = queue.then(work, work);
    queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  // Every loaded state passes through here. Earlier stale and unknown-outcome conditions end with it.
  function accept(next) {
    state = next;
    generation += 1;
    staleGuard = null;
    needsAuthoritativeRefresh = false;
    blocking = "";
    if (remoteRevision <= Number(next.revision)) remoteRevision = 0;
    publish();
  }

  function failedCommand(error, options) {
    if (isUnknownOutcomeError(error)) {
      needsAuthoritativeRefresh = true;
      blocking = messageOf(error);
      publish();
      if (!options.silent) notify(blocking, true);
      return { ok: false, error, unknownOutcome: true, reloadRequired: true };
    }
    if (isStaleRevisionError(error)) {
      staleGuard = { generation };
      blocking = STALE_REVISION_MESSAGE;
      publish();
      if (!options.silent) notify(STALE_REVISION_MESSAGE, true);
      return { ok: false, error: staleRevisionError(error), stale: true, reloadRequired: true };
    }
    if (!options.silent) notify(messageOf(error), true);
    return { ok: false, error, stale: false };
  }

  function run(type, data, options = {}) {
    return enqueue(async () => {
      if (!state) return { ok: false, error: new Error("The QC workspace is not ready.") };

      if (staleGuard && staleGuard.generation === generation) {
        const error = new Error(REVISION_RETRY_BLOCKED_MESSAGE);
        error.code = "stale_revision";
        error.status = 409;
        if (!options.silent) notify(error.message, true);
        return { ok: false, error, stale: true, blocked: true, reloadRequired: true };
      }

      if (needsAuthoritativeRefresh) {
        try {
          accept(await service.getState({ mode: "lightweight" }));
        } catch (error) {
          blocking = "The saved change is awaiting a fresh read. Reload before making another change.";
          publish();
          if (!options.silent) notify(messageOf(error, "The latest data could not be loaded."), true);
          return { ok: false, error, reloadRequired: true };
        }
      }

      const baseRevision = state.revision;
      commandsInFlight += 1;
      try {
        let result;
        try {
          // `request` lets an endpoint other than /command (such as a restore) use the same bookkeeping.
          result = await (options.request ? options.request(baseRevision) : service.command(type, data, baseRevision));
        } catch (error) {
          return failedCommand(error, options);
        }

        const commandRevision = Number(result?.revision ?? result?.result?.revision);
        const projected = canProjectCommandResult(result, baseRevision) ? projectChanges(state, result) : null;
        if (projected) {
          accept(projected);
          announceRevision(state.revision);
          if (options.render !== false) render();
          publish();
          return { ok: true, result, state, revision: state.revision, refreshed: true, projected: true };
        }

        try {
          const latest = await service.getState({ mode: "lightweight" });
          accept(latest);
          announceRevision(latest.revision);
          if (options.render !== false) render();
          publish();
          return { ok: true, result, state: latest, revision: latest.revision, refreshed: true };
        } catch (readError) {
          // The change is committed, so the page keeps the revision the server reported and asks for a reload.
          if (Number.isSafeInteger(commandRevision) && commandRevision >= baseRevision) {
            state = { ...state, revision: commandRevision };
          }
          needsAuthoritativeRefresh = true;
          blocking = "The change was saved, but the updated data could not be reloaded. Reload before making another change.";
          publish();
          if (!options.silent) notify(messageOf(readError, "The change was saved, but the page could not reload."), true);
          return { ok: false, committed: true, refreshed: false, result, revision: commandRevision, error: readError, reloadRequired: true };
        }
      } finally {
        commandsInFlight -= 1;
      }
    });
  }

  /** Reloads the workspace state on the user's request and renders the current page. */
  function loadLatest() {
    return enqueue(async () => {
      commandsInFlight += 1;
      try {
        const latest = await service.getState({ mode: "lightweight" });
        accept(latest);
        announceRevision(latest.revision);
        render();
        publish();
        return { ok: true, state: latest };
      } catch (error) {
        blocking = "The latest data could not be loaded. Your current page is still open; try again.";
        publish();
        return { ok: false, error };
      } finally {
        commandsInFlight -= 1;
      }
    });
  }

  /** Reloads the state for a dialog that keeps its own entries. The page re-renders only when `render` is set. */
  function refreshState({ render: shouldRender = false } = {}) {
    return enqueue(async () => {
      commandsInFlight += 1;
      try {
        const latest = await service.getState({ mode: "lightweight" });
        accept(latest);
        announceRevision(latest.revision);
        if (shouldRender) render();
        publish();
        return { ok: true, state: latest };
      } catch (error) {
        blocking = "The latest data could not be loaded. Reload before making another change.";
        publish();
        return { ok: false, error };
      } finally {
        commandsInFlight -= 1;
      }
    });
  }

  /** Records a revision reported by another tab or by the poll. Nothing reloads automatically. */
  function noteRemoteRevision(revision) {
    const value = Number(revision);
    if (!Number.isSafeInteger(value)) return;
    if (value > remoteRevision) remoteRevision = value;
    publish();
  }

  async function checkForSharedChanges() {
    if (!state || commandsInFlight > 0) return;
    try {
      noteRemoteRevision(await service.getRevision());
    } catch {
      // Keep the page and its unsaved edits; the next check tries again.
    }
  }

  return Object.freeze({
    get state() {
      return state;
    },
    get notices() {
      return notices();
    },
    setInitialState(next) {
      accept(next);
      publish();
    },
    run,
    loadLatest,
    refreshState,
    noteRemoteRevision,
    checkForSharedChanges,
  });
}
