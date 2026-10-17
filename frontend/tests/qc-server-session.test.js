import test from "node:test";
import assert from "node:assert/strict";
import { RELEASE_CHECK_INTERVAL_MS, SESSION_PATH, createReleaseWatch, readServerSession } from "../qc-server-session.js";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("the session is read from /api/session, and its release and actor are returned", async () => {
  const seen = [];
  const session = await readServerSession({
    fetchImpl: async (url, init) => {
      seen.push([url, init.method]);
      return jsonResponse(200, { release: "2026.10.17-b", actor: "ann" });
    },
  });

  assert.deepEqual(session, { release: "2026.10.17-b", actor: "ann" });
  assert.deepEqual(seen, [[SESSION_PATH, "GET"]]);
});

test("a server without the route, a failed request, or an unexpected body means unknown, and never rejects", async () => {
  assert.equal(await readServerSession({ fetchImpl: async () => jsonResponse(404, { error: "Not found." }) }), null);
  assert.equal(await readServerSession({ fetchImpl: async () => { throw new Error("Could not reach the QC server."); } }), null);
  assert.equal(await readServerSession({ fetchImpl: async () => jsonResponse(200, ["not", "an", "object"]) }), null);
  assert.equal(await readServerSession({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Bad JSON"); } }) }), null);
  assert.equal(await readServerSession({ fetchImpl: undefined }), null);
});

test("missing or blank fields are unknown individually", async () => {
  assert.deepEqual(await readServerSession({ fetchImpl: async () => jsonResponse(200, { release: "  ", actor: null }) }), { release: null, actor: null });
  assert.deepEqual(await readServerSession({ fetchImpl: async () => jsonResponse(200, { release: "r1" }) }), { release: "r1", actor: null });
});

test("a request that never answers is abandoned at its deadline", async () => {
  const session = await readServerSession({
    fetchImpl: () => new Promise(() => {}),
    timeoutMs: 10,
  });

  assert.equal(session, null);
});

test("a release that differs from the start-up release is announced once", async () => {
  let served = "r1";
  const announced = [];
  const watch = createReleaseWatch({
    startRelease: "r1",
    readSession: async () => ({ release: served, actor: "ann" }),
    onNewRelease: (release) => announced.push(release),
  });

  await watch.check();
  assert.deepEqual(announced, []);

  served = "r2";
  await watch.check();
  await watch.check();
  assert.deepEqual(announced, ["r2"]);
  assert.equal(watch.isAnnounced(), true);
});

test("a page whose start-up read failed adopts the first release it hears of, then notices a later change", async () => {
  let served = "r1";
  const announced = [];
  const watch = createReleaseWatch({
    startRelease: null,
    readSession: async () => ({ release: served, actor: null }),
    onNewRelease: (release) => announced.push(release),
  });

  await watch.check();
  assert.deepEqual(announced, [], "the first answer is the baseline, not a change");

  served = "r2";
  await watch.check();
  assert.deepEqual(announced, ["r2"]);
});

test("a server that reports no release, or a failing read, raises nothing", async () => {
  const announced = [];
  const unknown = createReleaseWatch({ startRelease: "r1", readSession: async () => null, onNewRelease: (release) => announced.push(release) });
  const failing = createReleaseWatch({ startRelease: "r1", readSession: async () => { throw new Error("Down."); }, onNewRelease: (release) => announced.push(release) });

  await unknown.check();
  await failing.check();

  assert.deepEqual(announced, []);
  assert.equal(unknown.isAnnounced(), false);
});

test("the periodic tick asks the server only once the check interval has passed", async () => {
  let clock = 0;
  let asked = 0;
  const watch = createReleaseWatch({
    startRelease: "r1",
    now: () => clock,
    readSession: async () => {
      asked += 1;
      return { release: "r1", actor: null };
    },
  });

  assert.equal(watch.tick(), null);
  assert.equal(asked, 0);

  clock = RELEASE_CHECK_INTERVAL_MS;
  await watch.tick();
  assert.equal(asked, 1);

  clock += 1000;
  assert.equal(watch.tick(), null, "a second tick right after a check does not ask again");
  assert.equal(asked, 1);
});

test("concurrent checks share one request while it is in flight", async () => {
  let asked = 0;
  let release;
  const watch = createReleaseWatch({
    startRelease: "r1",
    readSession: () => {
      asked += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });

  const first = watch.check();
  const second = watch.check();
  release({ release: "r1", actor: null });
  await Promise.all([first, second]);

  assert.equal(asked, 1);
});
