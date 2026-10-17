import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createQCHttpService } from "../../core/qc-http-service.js";

const MINUTE = 60_000;

async function settleMicrotasks() {
  // Lets the transport's rejection reach the caller. setImmediate is not mocked, so this always runs.
  await new Promise((resolve) => setImmediate(resolve));
}

function trackOutcome(settled, name, promise) {
  promise.then(() => settled.set(name, "resolved"), (error) => settled.set(name, error.code ?? error.message));
}

test("ordinary requests give up after 60 seconds while attachment uploads wait for 15 minutes", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const never = () => new Promise(() => {});
  const service = createQCHttpService({ fetchImpl: never, baseUrl: "http://127.0.0.1:4173" });
  const settled = new Map();

  trackOutcome(settled, "state", service.getState());
  trackOutcome(settled, "save", service.command("saveBatchChanges", { batchId: "b1", rows: [] }, 4));
  trackOutcome(settled, "upload", service.command("addDocument", { name: "a.pdf" }, 4));
  trackOutcome(settled, "restore", service.importBackup({ schemaVersion: 1 }, 4));

  mock.timers.tick(MINUTE - 1);
  await settleMicrotasks();
  assert.equal(settled.size, 0);

  mock.timers.tick(1);
  await settleMicrotasks();
  assert.equal(settled.get("state"), "request_timeout");
  assert.equal(settled.get("save"), "request_timeout");
  assert.equal(settled.has("upload"), false);
  assert.equal(settled.has("restore"), false);

  mock.timers.tick(15 * MINUTE - MINUTE - 1);
  await settleMicrotasks();
  assert.equal(settled.has("upload"), false);

  mock.timers.tick(1);
  await settleMicrotasks();
  assert.equal(settled.get("upload"), "request_timeout");
  assert.equal(settled.get("restore"), "request_timeout");
});

test("attachment reads and backup exports also use the long budget", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const service = createQCHttpService({ fetchImpl: () => new Promise(() => {}), baseUrl: "http://127.0.0.1:4173" });
  const settled = new Map();

  trackOutcome(settled, "asset", service.getAsset("asset-1"));
  trackOutcome(settled, "backup", service.exportBackup());

  mock.timers.tick(2 * MINUTE);
  await settleMicrotasks();
  assert.equal(settled.size, 0);

  mock.timers.tick(13 * MINUTE);
  await settleMicrotasks();
  assert.equal(settled.get("asset"), "request_timeout");
  assert.equal(settled.get("backup"), "request_timeout");
});

test("commands are posted to the workspace command endpoint with their type and revision", async () => {
  const calls = [];
  const service = createQCHttpService({
    workspace: "demo",
    baseUrl: "http://127.0.0.1:4173",
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ revision: 5 }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  assert.deepEqual(await service.command("saveIssue", { id: "i1" }, 4), { revision: 5 });
  assert.deepEqual(calls, [{
    url: "http://127.0.0.1:4173/api/qc/demo/command",
    method: "POST",
    body: { type: "saveIssue", data: { id: "i1" }, expectedRevision: 4 },
  }]);
});
