import test from "node:test";
import assert from "node:assert/strict";
import { createQCSession } from "../qc-session.js";
import { REVISION_RETRY_BLOCKED_MESSAGE, SHARED_CHANGE_MESSAGE, STALE_REVISION_MESSAGE } from "../qc-command-rules.js";

const TIMEOUT_MESSAGE = "The server did not respond in time. The change may or may not have been saved. Reload the latest data to check before trying again.";

// A minimal stand-in for the HTTP facade. The test decides each command's outcome through `nextCommand`.
function fakeService(revision = 4) {
  const service = {
    revision,
    order: [],
    commands: [],
    stateFailure: null,
    nextCommand: async () => ({ revision: service.revision + 1 }),
    async getState() {
      service.order.push("getState");
      if (service.stateFailure) throw service.stateFailure;
      return { revision: service.revision, batches: [], issues: [], orders: [], audit: [] };
    },
    async getRevision() {
      return service.revision;
    },
    async command(type, data, expectedRevision) {
      service.order.push("command");
      service.commands.push({ type, data, expectedRevision });
      return service.nextCommand(type, data, expectedRevision);
    },
  };
  return service;
}

function makeSession(service) {
  const log = { notify: [], renders: 0, announced: [], notices: [] };
  const session = createQCSession({
    service,
    notify: (message, isError) => log.notify.push({ message, isError: Boolean(isError) }),
    render: () => { log.renders += 1; },
    announceRevision: (revision) => log.announced.push(revision),
    onNotices: (notices) => log.notices.push(notices),
  });
  session.setInitialState({ revision: service.revision, batches: [], issues: [], orders: [], audit: [] });
  return { session, log };
}

function failure(message, fields = {}) {
  return Object.assign(new Error(message), fields);
}

test("an accepted change based on the loaded revision is applied to the loaded state without a reload", async () => {
  const service = fakeService(4);
  service.nextCommand = async () => ({
    entityId: "batch-1",
    revision: 5,
    changes: { batches: [{ id: "batch-1", status: "draft", recorder: "Ann" }] },
  });
  const { session, log } = makeSession(service);

  const result = await session.run("saveBatchChanges", { batchId: "batch-1", rows: [] });

  assert.equal(result.ok, true);
  assert.equal(result.projected, true);
  assert.equal(service.order.includes("getState"), false);
  assert.equal(session.state.revision, 5);
  assert.equal(session.state.batches[0].recorder, "Ann");
  assert.deepEqual(log.announced, [5]);
  assert.equal(log.renders, 1);
});

test("a rebased result takes the full reload path instead of being projected", async () => {
  const service = fakeService(4);
  service.nextCommand = async () => {
    service.revision = 6;
    return { revision: 5, rebased: true, changes: { batches: [{ id: "batch-1", status: "draft" }] } };
  };
  const { session } = makeSession(service);

  const result = await session.run("saveBatchChanges", { batchId: "batch-1", rows: [] });

  assert.equal(result.ok, true);
  assert.equal(result.projected, undefined);
  assert.deepEqual(service.order, ["command", "getState"]);
  assert.equal(session.state.revision, 6, "the page takes the server's view, including other users' changes");
  assert.equal(session.state.batches.length, 0, "the rebased projection is not applied");
});

test("a result that skipped revisions reloads, because other changes intervened", async () => {
  const service = fakeService(4);
  service.nextCommand = async () => {
    service.revision = 7;
    return { revision: 7, changes: { batches: [{ id: "batch-1" }] } };
  };
  const { session } = makeSession(service);

  const result = await session.run("saveBatchChanges", { batchId: "batch-1", rows: [] });

  assert.equal(result.projected, undefined);
  assert.deepEqual(service.order, ["command", "getState"]);
  assert.equal(session.state.revision, 7);
});

test("a command that changed nothing reloads rather than projecting", async () => {
  const service = fakeService(4);
  service.nextCommand = async () => ({ revision: 4, changes: { batches: [] } });
  const { session } = makeSession(service);

  const result = await session.run("autosaveInspection", { batchId: "batch-1" });

  assert.equal(result.projected, undefined);
  assert.deepEqual(service.order, ["command", "getState"]);
});

test("a stale rejection blocks the next command until a fresh state has loaded", async () => {
  const service = fakeService(4);
  service.nextCommand = async () => {
    throw failure("This data changed since your last view.", { code: "stale_revision", status: 409 });
  };
  const { session, log } = makeSession(service);

  const first = await session.run("saveIssue", { id: "issue-1", owner: "Ann" }, { silent: true });

  assert.equal(first.ok, false);
  assert.equal(first.stale, true);
  assert.equal(first.reloadRequired, true);
  assert.equal(first.error.message, STALE_REVISION_MESSAGE);
  assert.equal(session.notices.blocking, STALE_REVISION_MESSAGE);
  assert.equal(service.commands.length, 1);

  // Resubmitting without a reload is refused locally; it does not send the same stale revision again.
  const second = await session.run("saveIssue", { id: "issue-1", owner: "Ann" }, { silent: true });
  assert.equal(second.blocked, true);
  assert.equal(second.error.message, REVISION_RETRY_BLOCKED_MESSAGE);
  assert.equal(service.commands.length, 1);
  assert.deepEqual(log.notify, []);

  // Once the latest data is loaded, the submit is sent again with the fresh revision.
  service.nextCommand = async (_type, _data, expectedRevision) => ({ revision: expectedRevision + 1 });
  const reload = await session.refreshState();
  assert.equal(reload.ok, true);
  assert.equal(session.notices.blocking, "");

  const third = await session.run("saveIssue", { id: "issue-1", owner: "Ann" });
  assert.equal(third.ok, true);
  assert.equal(service.commands.length, 2);
  assert.equal(service.commands[1].expectedRevision, 4);
});

test("a 409 status without a code is treated as stale, and the message is normalised", async () => {
  const service = fakeService(4);
  service.nextCommand = async () => { throw failure("Conflict.", { status: 409 }); };
  const { session, log } = makeSession(service);

  const result = await session.run("saveBatchChanges", { batchId: "batch-1", rows: [] });

  assert.equal(result.stale, true);
  assert.equal(result.error.message, STALE_REVISION_MESSAGE);
  assert.deepEqual(log.notify, [{ message: STALE_REVISION_MESSAGE, isError: true }]);
});

test("an ordinary validation failure is not stale and leaves the state unchanged", async () => {
  const service = fakeService(4);
  service.nextCommand = async () => { throw failure("Quantity must be a positive whole number.", { status: 400 }); };
  const { session, log } = makeSession(service);

  const result = await session.run("createBatch", { products: [] });

  assert.equal(result.ok, false);
  assert.equal(result.stale, false);
  assert.equal(result.reloadRequired, undefined);
  assert.equal(session.notices.blocking, "");
  assert.deepEqual(log.notify, [{ message: "Quantity must be a positive whole number.", isError: true }]);
  assert.equal(session.state.revision, 4);
});

test("a timed-out command reloads before the next command and is not mistaken for a stale revision", async () => {
  const service = fakeService(4);
  service.nextCommand = async () => {
    throw failure(TIMEOUT_MESSAGE, { code: "request_timeout" });
  };
  const { session, log } = makeSession(service);

  const failed = await session.run("saveBatchChanges", { batchId: "batch-1", rows: [] });

  assert.equal(failed.unknownOutcome, true);
  assert.equal(failed.stale, undefined);
  assert.equal(failed.reloadRequired, true);
  assert.equal(session.notices.blocking, TIMEOUT_MESSAGE);
  assert.deepEqual(log.notify, [{ message: TIMEOUT_MESSAGE, isError: true }]);

  service.order = [];
  service.nextCommand = async (_type, _data, expectedRevision) => ({ revision: expectedRevision + 1 });
  const next = await session.run("saveBatchChanges", { batchId: "batch-1", rows: [] });

  assert.equal(next.ok, true);
  assert.deepEqual(service.order, ["getState", "command", "getState"], "the next action reloads first");
  assert.equal(session.notices.blocking, "");
});

test("the automatic reload before a command clears the outcome notice, even when that command then fails", async () => {
  const service = fakeService(4);
  service.nextCommand = async () => {
    throw failure(TIMEOUT_MESSAGE, { code: "request_timeout" });
  };
  const { session, log } = makeSession(service);
  await session.run("saveBatchChanges", { batchId: "batch-1", rows: [] }, { silent: true });
  assert.equal(session.notices.blocking, TIMEOUT_MESSAGE);

  service.nextCommand = async () => { throw failure("Quantity must be a positive whole number.", { status: 400 }); };
  const next = await session.run("createBatch", {}, { silent: true });

  assert.equal(next.ok, false);
  assert.deepEqual(service.order.slice(-2), ["getState", "command"]);
  assert.equal(session.notices.blocking, "", "the outcome is known again after the reload");
  assert.equal(log.notices.at(-1).blocking, "", "the page's warning is cleared as well");
});

test("a network failure is an unknown outcome, and silent commands do not toast it", async () => {
  const service = fakeService(4);
  service.nextCommand = async () => {
    throw failure("Could not reach the QC server. Check your connection; unsaved edits are still on this page.", { code: "network_error" });
  };
  const { session, log } = makeSession(service);

  const result = await session.run("saveIssue", { id: "issue-1" }, { silent: true });

  assert.equal(result.unknownOutcome, true);
  assert.equal(result.reloadRequired, true);
  assert.equal(session.notices.blocking.startsWith("Could not reach the QC server."), true);
  assert.deepEqual(log.notify, []);
});

test("a committed change whose reload fails keeps the reported revision and asks for a reload", async () => {
  const service = fakeService(4);
  // Without changes the result cannot be projected, so the page has to reload, and that reload fails.
  service.nextCommand = async () => ({ revision: 5 });
  service.stateFailure = failure("Could not reach the QC server.", { code: "network_error" });
  const { session } = makeSession(service);

  const result = await session.run("saveBatchChanges", { batchId: "batch-1", rows: [] });

  assert.equal(result.ok, false);
  assert.equal(result.committed, true);
  assert.equal(result.reloadRequired, true);
  assert.equal(session.state.revision, 5);
  assert.match(session.notices.blocking, /was saved, but the updated data could not be reloaded/);
});

test("a newer revision from another tab shows a notice and never reloads by itself", async () => {
  const service = fakeService(4);
  const { session, log } = makeSession(service);

  session.noteRemoteRevision(6);

  assert.equal(session.notices.sharedChange, true);
  assert.equal(session.notices.blocking, "");
  assert.equal(service.order.length, 0);
  assert.equal(log.renders, 0);
  assert.equal(log.notices.at(-1).sharedChange, true);
  assert.equal(SHARED_CHANGE_MESSAGE, "Newer changes from other users are available.");
});

test("the poll reports the server revision as a notice, and the user's reload clears it", async () => {
  const service = fakeService(4);
  const { session, log } = makeSession(service);
  service.revision = 9;

  await session.checkForSharedChanges();
  assert.equal(session.notices.sharedChange, true);
  assert.equal(service.order.length, 0, "the poll does not load the state");

  const reload = await session.loadLatest();
  assert.equal(reload.ok, true);
  assert.equal(session.notices.sharedChange, false);
  assert.equal(session.state.revision, 9);
  assert.equal(log.renders, 1);
});

test("a notice from an older revision does not stay after a reload that reaches it", async () => {
  const service = fakeService(4);
  const { session } = makeSession(service);

  session.noteRemoteRevision(5);
  assert.equal(session.notices.sharedChange, true);

  service.revision = 5;
  await session.refreshState();
  assert.equal(session.notices.sharedChange, false);
});

test("a poll that cannot reach the server keeps the page and raises no notice", async () => {
  const service = fakeService(4);
  service.getRevision = async () => { throw failure("Could not reach the QC server.", { code: "network_error" }); };
  const { session } = makeSession(service);

  await session.checkForSharedChanges();

  assert.equal(session.notices.sharedChange, false);
  assert.equal(session.state.revision, 4);
});

test("a custom request replaces the /command call but keeps the revision bookkeeping", async () => {
  const service = fakeService(4);
  const { session } = makeSession(service);
  const seenRevisions = [];

  const result = await session.run("importBackup", null, {
    request: async (revision) => {
      seenRevisions.push(revision);
      service.revision = 5;
      return { revision: 5, counts: { added: { batches: 2 } } };
    },
    silent: true,
  });

  assert.deepEqual(seenRevisions, [4]);
  assert.equal(service.commands.length, 0);
  assert.equal(result.ok, true);
  assert.equal(result.result.counts.added.batches, 2);
  assert.equal(session.state.revision, 5);
});

test("silent commands report failures only through their result, not as toasts", async () => {
  const service = fakeService(4);
  service.nextCommand = async () => { throw failure("Quantity must be a positive whole number.", { status: 400 }); };
  const { session, log } = makeSession(service);

  const result = await session.run("createVariant", {}, { silent: true });

  assert.equal(result.ok, false);
  assert.equal(result.error.message, "Quantity must be a positive whole number.");
  assert.deepEqual(log.notify, []);
});
