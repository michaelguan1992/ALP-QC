import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { createQCService } from "../core/qc-service.js";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";
import {
  ConfigurationError,
  createQCWorkspaceServices,
  createRequestHandler,
  createShutdownHandler,
  createStaticServer,
  removeLeftoverSnapshotFiles,
  resolveStaticTarget,
} from "../launcher/server.mjs";

const PUBLIC_ORIGIN = "https://qc.example.com";
const silentLogger = { info() {}, error() {} };

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "masterqc-hosted-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Calls the request handler in-process. Hosted tests send the Host header explicitly. The client address defaults to
// loopback, where the reverse proxy connects from.
async function invoke(handler, { method = "GET", url = "/", headers = {}, body = undefined, remoteAddress = "127.0.0.1" } = {}) {
  const requestHeaders = { host: "127.0.0.1:4173" };
  for (const [name, value] of Object.entries(headers)) requestHeaders[name.toLowerCase()] = value;
  if (body !== undefined) {
    requestHeaders["content-type"] ??= "application/json";
    requestHeaders["content-length"] = Buffer.byteLength(body);
  }
  const request = {
    method,
    url,
    headers: requestHeaders,
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body);
    },
  };
  const response = {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(statusCode, values) {
      this.statusCode = statusCode;
      this.headers = values;
    },
    end(value) {
      this.body = value === undefined ? "" : String(value);
    },
  };
  await handler(request, response);
  return { status: response.statusCode, headers: response.headers, text: response.body, json: () => JSON.parse(response.body) };
}

function fakeMainService(overrides = {}) {
  return {
    async getRevision() { return 3; },
    async getState() { return { revision: 3 }; },
    async initialize() { return { revision: 0 }; },
    async command() { return { revision: 4 }; },
    ...overrides,
  };
}

function hostedHandler(services, options = {}) {
  return createRequestHandler(async () => null, {
    services,
    publicOrigin: PUBLIC_ORIGIN,
    logger: silentLogger,
    ...options,
  });
}

// Opens a loopback server whose handler is built after the port is known, so the Host check sees the real port.
async function listenWithHandler(t, buildHandler) {
  let handler = null;
  const server = createHttpServer((request, response) => handler(request, response));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  handler = buildHandler(port);
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return { server, port };
}

// One connection per request, so closing the test server never waits on keep-alive sockets.
function sendRequest(port, { method = "GET", path: requestPath = "/", headers = {}, body = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: requestPath,
      method,
      headers,
      agent: false,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function waitForNoSnapshotFiles(directory) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const leftovers = (await readdir(directory)).filter((name) => name.startsWith(".snapshot-"));
    if (leftovers.length === 0) return;
    if (Date.now() > deadline) assert.fail(`Temporary snapshot files remained: ${leftovers.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("hosted mode accepts the public host and loopback, and refuses other Host values with 400", async () => {
  const handler = hostedHandler({ main: fakeMainService() });
  const revision = (host) => invoke(handler, { url: "/api/qc/main/revision", headers: { host } });

  assert.equal((await revision("qc.example.com")).status, 200);
  assert.equal((await revision("QC.example.com")).status, 200, "host names compare case-insensitively");
  assert.equal((await revision("127.0.0.1:4173")).status, 200, "loopback serves local health checks and tools");
  assert.equal((await invoke(handler, { url: "/healthz", headers: { host: "127.0.0.1:4173" } })).status, 200);

  const foreign = await revision("evil.example");
  assert.equal(foreign.status, 400);
  assert.equal(foreign.text, "Bad Request\n");
  assert.equal((await revision("qc.example.com:8443")).status, 400, "a port the public origin does not name is refused");
  assert.equal((await revision("")).status, 400);
});

test("hosted mode checks Origin exactly and requires a matching Origin on POST", async () => {
  const handler = hostedHandler({ main: fakeMainService() });
  const get = (origin) => invoke(handler, { url: "/api/qc/main/revision", headers: { host: "qc.example.com", origin } });

  assert.equal((await get(PUBLIC_ORIGIN)).status, 200);
  assert.equal((await get("http://127.0.0.1:4173")).status, 200, "the loopback origin is accepted");
  for (const origin of ["https://evil.example", "http://qc.example.com", "https://qc.example.com:8443", "https://qc.example.com.evil.example", "null"]) {
    const response = await get(origin);
    assert.equal(response.status, 403, origin);
    assert.equal(response.json().code, "origin_not_allowed", origin);
  }

  const post = (headers) => invoke(handler, {
    method: "POST",
    url: "/api/qc/main/initialize",
    headers: { host: "qc.example.com", ...headers },
    body: "{}",
  });
  const unsigned = await post({});
  assert.equal(unsigned.status, 403);
  assert.equal(unsigned.json().code, "origin_required");
  assert.equal((await post({ origin: PUBLIC_ORIGIN })).status, 200, "the public origin may POST");
  assert.equal((await post({ origin: "https://evil.example" })).status, 403);

  const staticPage = await invoke(handler, {
    url: "/frontend/index.html",
    headers: { host: "qc.example.com", origin: "https://evil.example" },
  });
  assert.equal(staticPage.status, 403, "a foreign Origin is refused even for static files");
});

test("X-Forwarded headers never change the Host or Origin decision", async () => {
  const handler = hostedHandler({ main: fakeMainService() });
  const spoofedHost = await invoke(handler, {
    url: "/api/qc/main/revision",
    headers: { host: "evil.example", "x-forwarded-host": "qc.example.com", "x-forwarded-proto": "https" },
  });
  assert.equal(spoofedHost.status, 400);

  const spoofedOrigin = await invoke(handler, {
    url: "/api/qc/main/revision",
    headers: { host: "qc.example.com", origin: "https://evil.example", "x-forwarded-host": "qc.example.com", "x-forwarded-origin": PUBLIC_ORIGIN },
  });
  assert.equal(spoofedOrigin.status, 403);
});

test("hosted mode answers demo routes with workspace_not_found, even when a demo service is supplied", async () => {
  const handler = hostedHandler({ main: fakeMainService(), demo: fakeMainService() }, { demoEnabled: false });

  const read = await invoke(handler, { url: "/api/qc/demo/revision", headers: { host: "qc.example.com" } });
  assert.equal(read.status, 404);
  assert.deepEqual(read.json(), { error: "QC workspace was not found.", code: "workspace_not_found" });

  const written = await invoke(handler, {
    method: "POST",
    url: "/api/qc/demo/command",
    headers: { host: "qc.example.com", origin: PUBLIC_ORIGIN },
    body: "{}",
  });
  assert.equal(written.json().code, "workspace_not_found");
  assert.equal((await invoke(handler, { url: "/api/qc/main/revision", headers: { host: "qc.example.com" } })).status, 200);
});

test("with the demo off, the demo database file is never created", async (t) => {
  const directory = await temporaryDirectory(t);
  const services = await createQCWorkspaceServices({ dataDirectory: directory, demoEnabled: false });
  t.after(() => services.close());
  await services.main.getRevision();
  assert.equal(services.demo, undefined);
  assert.deepEqual((await readdir(directory)).sort(), ["masterqc-main.sqlite"]);

  const server = await createStaticServer({ dataDirectory: directory, publicOrigin: PUBLIC_ORIGIN, demoEnabled: false, logger: silentLogger });
  t.after(() => server.qcServices.close());
  assert.equal(server.qcServices.demo, undefined);
  assert.deepEqual((await readdir(directory)).sort(), ["masterqc-main.sqlite"]);
});

test("the request handler refuses an invalid public origin before it serves any request", () => {
  assert.throws(() => createRequestHandler(async () => null, { publicOrigin: "http://qc.example.com" }), ConfigurationError);
});

test("over a real socket, hosted Host and Origin headers are judged as sent", async (t) => {
  const services = { main: fakeMainService() };
  const { port } = await listenWithHandler(t, (listenPort) => createRequestHandler(resolveStaticTarget, {
    services,
    host: "127.0.0.1",
    port: listenPort,
    publicOrigin: PUBLIC_ORIGIN,
    logger: silentLogger,
  }));

  const read = await sendRequest(port, { path: "/api/qc/main/revision", headers: { host: "qc.example.com" } });
  assert.equal(read.status, 200);
  assert.deepEqual(JSON.parse(read.body.toString()), { revision: 3 });

  const posted = await sendRequest(port, {
    method: "POST",
    path: "/api/qc/main/initialize",
    headers: { host: "qc.example.com", origin: PUBLIC_ORIGIN, "content-type": "application/json", "content-length": 2 },
    body: "{}",
  });
  assert.equal(posted.status, 200);

  const withoutOrigin = await sendRequest(port, {
    method: "POST",
    path: "/api/qc/main/initialize",
    headers: { host: "qc.example.com", "content-type": "application/json", "content-length": 2 },
    body: "{}",
  });
  assert.equal(withoutOrigin.status, 403);

  const health = await sendRequest(port, { path: "/healthz", headers: { host: "127.0.0.1:" + port } });
  assert.equal(health.status, 200, "loopback health checks work with the listening port");
});

test("a second database snapshot is refused with 429 while the first one is still running", async (t) => {
  const directory = await temporaryDirectory(t);
  const started = deferred();
  const release = deferred();
  const services = {
    main: fakeMainService({
      async createSnapshot(targetPath) {
        await writeFile(targetPath, "snapshot bytes");
        started.resolve();
        await release.promise;
      },
    }),
  };
  const { port } = await listenWithHandler(t, (listenPort) => createRequestHandler(resolveStaticTarget, {
    services,
    host: "127.0.0.1",
    port: listenPort,
    snapshotDirectory: directory,
    logger: silentLogger,
  }));

  const first = sendRequest(port, { path: "/api/qc/main/backup/snapshot" });
  await started.promise;
  const busy = await sendRequest(port, { path: "/api/qc/main/backup/snapshot" });
  assert.equal(busy.status, 429);
  assert.equal(JSON.parse(busy.body.toString()).code, "snapshot_busy");

  release.resolve();
  const completed = await first;
  assert.equal(completed.status, 200);
  assert.equal(completed.body.toString(), "snapshot bytes");

  // Once the first download has finished, the next request gets the slot. The slot is freed just after the body is
  // sent, so a client that retries at once may briefly still see 429; the test allows that short window.
  const deadline = Date.now() + 5000;
  let next = await sendRequest(port, { path: "/api/qc/main/backup/snapshot" });
  while (next.status === 429 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    next = await sendRequest(port, { path: "/api/qc/main/backup/snapshot" });
  }
  assert.equal(next.status, 200);
  await waitForNoSnapshotFiles(directory);
});

test("the shutdown handler waits for in-flight requests, then closes the databases once", async (t) => {
  const entered = deferred();
  const finish = deferred();
  const server = createHttpServer(async (request, response) => {
    entered.resolve();
    await finish.promise;
    response.end("finished");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const { port } = server.address();
  let closed = 0;
  const shutdown = createShutdownHandler({ server, closeServices: () => { closed += 1; }, graceMs: 2000, logger: silentLogger });

  const pending = sendRequest(port, { path: "/slow" });
  await entered.promise;
  setTimeout(() => finish.resolve(), 100);
  assert.deepEqual(await shutdown("SIGTERM"), { timedOut: false });
  assert.equal((await pending).body.toString(), "finished");
  assert.equal(server.listening, false);
  assert.equal(closed, 1);

  assert.deepEqual(await shutdown("SIGINT"), { timedOut: false }, "a second signal reuses the first shutdown");
  assert.equal(closed, 1);
});

test("the shutdown handler closes stuck connections after its grace period", async (t) => {
  const entered = deferred();
  const server = createHttpServer(async () => {
    entered.resolve();
    await new Promise(() => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const { port } = server.address();
  let closed = 0;
  const shutdown = createShutdownHandler({ server, closeServices: () => { closed += 1; }, graceMs: 150, logger: silentLogger });

  const pending = sendRequest(port, { path: "/stuck" }).catch((error) => error);
  await entered.promise;
  assert.deepEqual(await shutdown("SIGTERM"), { timedOut: true });
  assert.ok((await pending) instanceof Error, "the stuck client sees its connection close");
  assert.equal(closed, 1);
});

test("startup removes only the temporary snapshot files that the snapshot route creates", async (t) => {
  const directory = await temporaryDirectory(t);
  const leftoverFile = `.snapshot-main-${randomUUID()}.sqlite`;
  const leftoverJournal = `.snapshot-demo-${randomUUID()}.sqlite-journal`;
  const leftoverDirectory = `.snapshot-main-${randomUUID()}.sqlite`;
  const keep = [
    "masterqc-main.sqlite",
    "masterqc-main.sqlite-journal",
    ".snapshot-main-not-a-uuid.sqlite",
    `.snapshot-other-${randomUUID()}.sqlite`,
    `.snapshot-main-${randomUUID()}.sqlite.bak`,
    `snapshot-main-${randomUUID()}.sqlite`,
    ".snapshot-restore-abc123",
    "notes.txt",
  ];
  for (const name of [leftoverFile, leftoverJournal, ...keep]) {
    await writeFile(path.join(directory, name), "x");
  }
  await mkdir(path.join(directory, leftoverDirectory));

  assert.equal(await removeLeftoverSnapshotFiles(directory), 2);
  assert.deepEqual((await readdir(directory)).sort(), [...keep, leftoverDirectory].sort());
  assert.equal(await removeLeftoverSnapshotFiles(path.join(directory, "missing")), 0);
});

test("creating the server removes leftover snapshot files before it accepts requests", async (t) => {
  const directory = await temporaryDirectory(t);
  await writeFile(path.join(directory, `.snapshot-main-${randomUUID()}.sqlite`), "partial copy");

  const server = await createStaticServer({
    dataDirectory: directory,
    services: { main: fakeMainService() },
    logger: silentLogger,
  });
  assert.equal(server.listening, false);
  assert.deepEqual(await readdir(directory), []);
});

// The fake service records the options each mutation receives, so tests can see the operator the launcher passed.
function recordingService() {
  const received = [];
  const service = fakeMainService({
    async command(type, data, revision, options) {
      received.push({ route: "command", type, revision, options });
      return { revision: 4 };
    },
    async importBackup(backup, revision, options) {
      received.push({ route: "restore", revision, options });
      return { changed: false };
    },
    async importHistory(historyPackage, revision, options) {
      received.push({ route: "history", revision, options });
      return { changed: false };
    },
  });
  return { service, received };
}

function postCommand(handler, headers, remoteAddress) {
  return invoke(handler, {
    method: "POST",
    url: "/api/qc/main/command",
    headers: { host: "qc.example.com", origin: PUBLIC_ORIGIN, ...headers },
    body: JSON.stringify({ type: "createOrder", data: {}, expectedRevision: 3 }),
    remoteAddress,
  });
}

test("the trusted operator header reaches the service only in hosted mode and only from loopback", async () => {
  const { service, received } = recordingService();
  const handler = hostedHandler({ main: service }, { trustedUserHeader: "x-remote-user" });
  const lastOperator = () => received.at(-1).options;

  assert.equal((await postCommand(handler, { "x-remote-user": "alice" }, "127.0.0.1")).status, 200);
  assert.deepEqual(lastOperator(), { actor: "alice" });

  await postCommand(handler, { "x-remote-user": "alice" }, "::1");
  assert.deepEqual(lastOperator(), { actor: "alice" }, "IPv6 loopback counts");
  await postCommand(handler, { "x-remote-user": "alice" }, "::ffff:127.0.0.1");
  assert.deepEqual(lastOperator(), { actor: "alice" }, "IPv4-mapped loopback counts");

  await postCommand(handler, { "x-remote-user": "mallory" }, "203.0.113.9");
  assert.deepEqual(lastOperator(), { actor: null }, "a non-loopback client cannot name the operator");
  await postCommand(handler, {}, "127.0.0.1");
  assert.deepEqual(lastOperator(), { actor: null }, "no header means no operator");
  await postCommand(handler, { "x-remote-user": "" }, "127.0.0.1");
  assert.deepEqual(lastOperator(), { actor: null }, "an empty header is absent");
  await postCommand(handler, { "x-remote-user": "x".repeat(81) }, "127.0.0.1");
  assert.deepEqual(lastOperator(), { actor: null }, "a header over 80 characters is absent");
  await postCommand(handler, { "x-remote-user": "bad\u0001name" }, "127.0.0.1");
  assert.deepEqual(lastOperator(), { actor: null }, "a header with a control character is absent");
});

test("the trusted operator header is ignored in local mode, where the launcher serves no proxy", async () => {
  const { service, received } = recordingService();
  const handler = createRequestHandler(async () => null, {
    services: { main: service },
    logger: silentLogger,
    trustedUserHeader: "x-remote-user",
  });
  const response = await postCommand(handler, { host: "127.0.0.1:4173", origin: "http://127.0.0.1:4173", "x-remote-user": "alice" }, "127.0.0.1");
  assert.equal(response.status, 200);
  assert.deepEqual(received.at(-1).options, { actor: null });
  const session = await invoke(handler, { url: "/api/session", headers: { "x-remote-user": "alice" } });
  assert.equal(session.json().actor, null, "the session route ignores the header in local mode");
  assert.equal(typeof session.json().release, "string");
});

test("a browser cannot choose the operator through the request body", async (t) => {
  const service = createQCService(createMemoryQCAdapter(), {
    idFactory: () => randomUUID(),
    now: () => "2026-10-17T09:00:00.000Z",
  });
  const initial = await service.initialize();
  const variant = initial.variants.find((item) => item.model === "S15" && item.color === "Red");
  const handler = hostedHandler({ main: service }, { trustedUserHeader: "x-remote-user" });
  const body = {
    type: "createOrder",
    expectedRevision: initial.revision,
    actor: "mallory",
    data: {
      number: "PO-BODY-ACTOR",
      date: "2026-10-17",
      supplier: "Body supplier",
      notes: "",
      actor: "mallory",
      lines: [{ variantId: variant.id, orderedQty: 5 }],
    },
  };
  const response = await invoke(handler, {
    method: "POST",
    url: "/api/qc/main/command",
    headers: { host: "qc.example.com", origin: PUBLIC_ORIGIN },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  const state = await service.getState();
  const entry = state.audit.find((candidate) => candidate.action === "createOrder");
  assert.equal(Object.hasOwn(entry, "actor"), false, "without a trusted header, no operator is recorded");
  t.after(() => service.close());
});

test("a command from the trusted proxy is recorded as its operator in the audit trail", async (t) => {
  const service = createQCService(createMemoryQCAdapter(), {
    idFactory: () => randomUUID(),
    now: () => "2026-10-17T09:00:00.000Z",
  });
  t.after(() => service.close());
  const initial = await service.initialize();
  const variant = initial.variants.find((item) => item.model === "S15" && item.color === "Red");
  const handler = hostedHandler({ main: service }, { trustedUserHeader: "x-remote-user" });
  const response = await invoke(handler, {
    method: "POST",
    url: "/api/qc/main/command",
    headers: { host: "qc.example.com", origin: PUBLIC_ORIGIN, "x-remote-user": "frank" },
    body: JSON.stringify({
      type: "createOrder",
      expectedRevision: initial.revision,
      data: {
        number: "PO-PROXY-ACTOR",
        date: "2026-10-17",
        supplier: "Proxy supplier",
        notes: "",
        lines: [{ variantId: variant.id, orderedQty: 5 }],
      },
    }),
  });
  assert.equal(response.status, 200);
  const state = await service.getState();
  assert.equal(state.audit.find((entry) => entry.action === "createOrder").actor, "frank");
});

test("the restore and history routes pass the trusted operator to the service", async () => {
  const { service, received } = recordingService();
  const handler = hostedHandler({ main: service }, { trustedUserHeader: "x-remote-user" });
  const headers = { host: "qc.example.com", origin: PUBLIC_ORIGIN, "x-remote-user": "erin" };

  const restored = await invoke(handler, {
    method: "POST",
    url: "/api/qc/main/restore",
    headers,
    body: JSON.stringify({ backup: { format: "placeholder" }, expectedRevision: 3 }),
  });
  assert.equal(restored.status, 200);
  assert.deepEqual(received.at(-1), { route: "restore", revision: 3, options: { actor: "erin" } });

  const imported = await invoke(handler, {
    method: "POST",
    url: "/api/qc/main/history",
    headers,
    body: JSON.stringify({ historyPackage: { format: "placeholder" }, expectedRevision: 3 }),
  });
  assert.equal(imported.status, 200);
  assert.deepEqual(received.at(-1), { route: "history", revision: 3, options: { actor: "erin" } });
});

test("GET /api/session reports the release and the trusted operator, and is never cached", async () => {
  const handler = createRequestHandler(resolveStaticTarget, {
    services: null,
    publicOrigin: PUBLIC_ORIGIN,
    logger: silentLogger,
    release: "20261017T010203Z-abc1234",
    trustedUserHeader: "x-remote-user",
  });

  const fromProxy = await invoke(handler, { url: "/api/session", headers: { host: "qc.example.com", "x-remote-user": "gina" } });
  assert.equal(fromProxy.status, 200, "the session route answers even before the database is ready");
  assert.deepEqual(fromProxy.json(), { release: "20261017T010203Z-abc1234", actor: "gina" });
  assert.equal(fromProxy.headers["Cache-Control"], "no-store");
  assert.equal(fromProxy.headers["Content-Type"], "application/json; charset=utf-8");

  const anonymous = await invoke(handler, { url: "/api/session", headers: { host: "qc.example.com" } });
  assert.deepEqual(anonymous.json(), { release: "20261017T010203Z-abc1234", actor: null });

  const foreignHost = await invoke(handler, { url: "/api/session", headers: { host: "evil.example" } });
  assert.equal(foreignHost.status, 400, "the Host rules apply to the session route");
  const foreignOrigin = await invoke(handler, { url: "/api/session", headers: { host: "qc.example.com", origin: "https://evil.example" } });
  assert.equal(foreignOrigin.status, 403);
  assert.equal(foreignOrigin.json().code, "origin_not_allowed");

  const posted = await invoke(handler, {
    method: "POST",
    url: "/api/session",
    headers: { host: "qc.example.com", origin: PUBLIC_ORIGIN },
    body: "{}",
  });
  assert.equal(posted.status, 405);
  assert.equal(posted.json().code, "method_not_allowed");
});

test("errors name the MasterQC application and the QC service, not a local one", async () => {
  const handler = hostedHandler({ main: fakeMainService() });
  const foreign = await invoke(handler, { url: "/api/qc/main/revision", headers: { host: "qc.example.com", origin: "https://evil.example" } });
  assert.equal(foreign.json().error, "Requests must come from the MasterQC application.");

  const unsigned = await invoke(handler, { method: "POST", url: "/api/qc/main/initialize", headers: { host: "qc.example.com" }, body: "{}" });
  assert.equal(unsigned.json().error, "POST requests require the MasterQC application origin.");

  const snapshot = await invoke(handler, {
    url: "/api/qc/main/backup/snapshot",
    headers: { host: "qc.example.com", "sec-fetch-site": "cross-site" },
  });
  assert.equal(snapshot.status, 403);
  assert.equal(snapshot.json().error, "Database snapshots can only be downloaded from the MasterQC application.");

  const notReady = createRequestHandler(async () => null, { services: null, publicOrigin: PUBLIC_ORIGIN, logger: silentLogger });
  const waiting = await invoke(notReady, { url: "/api/qc/main/revision", headers: { host: "qc.example.com" } });
  assert.equal(waiting.status, 503);
  assert.deepEqual(waiting.json(), { error: "The QC service is not ready.", code: "service_unavailable" });
});
