import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CANONICAL_URL,
  ConfigurationError,
  HOST,
  PORT,
  checkStartupRequirements,
  createRequestHandler,
  parsePublicOrigin,
  readServerConfig,
  resolveStaticTarget,
} from "../launcher/server.mjs";

// Calls the request handler in-process, the way the HTTP server would, without opening a socket.
async function invoke(handler, { method = "GET", url = "/", headers = {}, body = undefined } = {}) {
  const requestHeaders = { host: `${HOST}:${PORT}` };
  for (const [name, value] of Object.entries(headers)) requestHeaders[name.toLowerCase()] = value;
  if (body !== undefined) {
    requestHeaders["content-type"] ??= "application/json";
    requestHeaders["content-length"] = Buffer.byteLength(body);
  }
  const request = {
    method,
    url,
    headers: requestHeaders,
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
  return {
    status: response.statusCode,
    headers: response.headers,
    text: response.body,
    json: () => JSON.parse(response.body),
  };
}

function captureLogs() {
  const logs = { info: [], error: [] };
  return {
    logs,
    logger: {
      info: (line) => logs.info.push(line),
      error: (text) => logs.error.push(text),
    },
  };
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

async function createRoots() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "masterqc-web-test-"));
  const root = await realpath(temporaryRoot);
  const roots = [];
  for (const name of ["frontend", "core", "storage"]) {
    const directory = path.join(root, name);
    await mkdir(directory);
    roots.push({ urlPrefix: `/${name}`, directory });
  }
  await writeFile(path.join(roots[0].directory, "index.html"), "<main>test</main>");
  return { root, roots };
}

test("static routes expose only the allowlisted app roots and browser storage transport", async (t) => {
  const { root, roots } = await createRoots();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(roots[2].directory, "http-json-transport.js"), "export const transport = true;");
  await writeFile(path.join(roots[2].directory, "qc-adapter.js"), "private legacy adapter");
  const options = { roots, projectRoot: root };

  assert.equal(await resolveStaticTarget("/", options), path.join(roots[0].directory, "index.html"));
  assert.equal(await resolveStaticTarget("/frontend/index.html", options), path.join(roots[0].directory, "index.html"));
  assert.equal(await resolveStaticTarget("/storage/http-json-transport.js", options), path.join(roots[2].directory, "http-json-transport.js"));
  assert.equal(await resolveStaticTarget("/storage/qc-adapter.js", options), null);
  assert.equal(await resolveStaticTarget("/vendor/dexie.mjs", options), null);
  assert.equal(await resolveStaticTarget("/frontend/initialization.html", options), null);
  assert.equal(await resolveStaticTarget("/frontend/prototype.html", options), null);
  assert.equal(await resolveStaticTarget("/README.md", options), null);
  assert.equal(await resolveStaticTarget("/package.json", options), null);

  const handler = createRequestHandler((requestPath) => resolveStaticTarget(requestPath, options));
  for (const url of [
    "/frontend/initialization.html",
    "/frontend/prototype.html",
    "/vendor/dexie.mjs",
  ]) {
    const response = {
      statusCode: null,
      writeHead(statusCode) { this.statusCode = statusCode; },
      end() {},
    };
    await handler({ headers: { host: `${HOST}:${PORT}` }, method: "GET", url }, response);
    assert.equal(response.statusCode, 404, `${url} should return Not Found`);
  }
});

test("static routes expose only the generated Lark import package", async (t) => {
  const { root, roots } = await createRoots();
  t.after(() => rm(root, { recursive: true, force: true }));
  const larkImportRoot = path.join(root, "data", "lark-import");
  await mkdir(larkImportRoot, { recursive: true });
  await writeFile(path.join(larkImportRoot, "version-history.v1.json"), "{\"format\":\"masterqc-lark-version-import\"}");
  await writeFile(path.join(larkImportRoot, "source-export.ndjson"), "private source export");
  const options = { roots, larkImportRoot, projectRoot: root };

  assert.equal(await resolveStaticTarget("/data/lark-import/version-history.v1.json", options), path.join(larkImportRoot, "version-history.v1.json"));
  assert.equal(await resolveStaticTarget("/data/lark-import/package.json", options), null);
  assert.equal(await resolveStaticTarget("/data/lark-import/source-export.ndjson", options), null);
  assert.equal(await resolveStaticTarget("/data/lark-import/../package.json", options), null);
});

test("generated Lark package is served as JSON through its exact route", async (t) => {
  const { root, roots } = await createRoots();
  t.after(() => rm(root, { recursive: true, force: true }));
  const larkImportRoot = path.join(root, "data", "lark-import");
  await mkdir(larkImportRoot, { recursive: true });
  const expectedBody = "{\"format\":\"masterqc-lark-version-import\"}";
  await writeFile(path.join(larkImportRoot, "version-history.v1.json"), expectedBody);
  const options = { roots, larkImportRoot, projectRoot: root };
  const response = {
    headers: null,
    statusCode: null,
    body: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
  const handler = createRequestHandler((requestPath) => resolveStaticTarget(requestPath, options));

  await handler({ headers: { host: `${HOST}:${PORT}` }, method: "GET", url: "/data/lark-import/version-history.v1.json" }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Content-Type"], "application/json; charset=utf-8");
  assert.equal(response.body.toString(), expectedBody);
});

test("CSP permits local blob document frames while keeping other sources restricted", async (t) => {
  const { root, roots } = await createRoots();
  t.after(() => rm(root, { recursive: true, force: true }));
  const response = {
    headers: null,
    statusCode: null,
    body: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
  const handler = createRequestHandler(async () => path.join(roots[0].directory, "index.html"));

  await handler({ headers: { host: `${HOST}:${PORT}` }, method: "GET", url: "/frontend/index.html" }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Content-Security-Policy"], "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-src 'self' blob:; media-src 'self' blob:");
  assert.equal(response.headers["Content-Security-Policy"].includes("script-src 'self' blob:"), false);
  assert.equal(response.headers["Content-Security-Policy"].includes("connect-src 'self' blob:"), false);
  assert.equal(response.headers["Content-Security-Policy"].includes("object-src blob:"), false);
  assert.equal(response.headers["Content-Security-Policy"].includes("media-src 'self' blob:"), true);
});

test("static routes reject encoded traversal, separators, malformed paths, and external roots", async (t) => {
  const { root, roots } = await createRoots();
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { roots, projectRoot: root };

  for (const requestPath of [
    "/frontend/%2e%2e/README.md",
    "/frontend/%2e%2e%2fREADME.md",
    "/frontend/%5c..%5cREADME.md",
    "/frontend/%E0%A4%A",
    "/frontend/./index.html",
    "//example.com/frontend/index.html",
  ]) {
    assert.equal(await resolveStaticTarget(requestPath, options), null, `should reject ${requestPath}`);
  }
});

test("static routes reject symlinks that escape the allowlisted directory", async (t) => {
  const { root, roots } = await createRoots();
  t.after(() => rm(root, { recursive: true, force: true }));
  const external = path.join(root, "outside.txt");
  await writeFile(external, "secret");

  try {
    await symlink(external, path.join(roots[0].directory, "escape.txt"));
  } catch (error) {
    if (error.code === "EPERM" || error.code === "ENOTSUP") {
      t.skip(`symlink creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  assert.equal(await resolveStaticTarget("/frontend/escape.txt", { roots, projectRoot: root }), null);
});

test("startup does not require Dexie and server uses the canonical loopback address", async (t) => {
  const { root } = await createRoots();
  t.after(() => rm(root, { recursive: true, force: true }));
  const issue = await checkStartupRequirements({ projectRoot: root });

  assert.equal(issue, null);
  assert.equal(HOST, "127.0.0.1");
  assert.equal(PORT, 4173);
  assert.equal(CANONICAL_URL, "http://127.0.0.1:4173");
});

test("QC HTTP routes carry lightweight mode and expose on-demand asset reads", async () => {
  const calls = [];
  const services = {
    main: {
      async initialize(options) { calls.push(["initialize", options]); return { mode: options.mode }; },
      async getState(options) { calls.push(["getState", options]); return { mode: options?.mode ?? "full" }; },
      async getAsset(id) { calls.push(["getAsset", id]); return { id, dataUrl: "data:image/png;base64,iVBORw0KGgo=" }; },
      async getBatchWorkspace(id, options) { calls.push(["getBatchWorkspace", id, options]); return { batch: { id }, mode: options?.mode ?? "full" }; },
    },
  };
  const handler = createRequestHandler(async () => null, { services });
  const request = async (method, url, body = undefined) => {
    const response = {
      headers: null,
      statusCode: null,
      body: null,
      writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; },
      end(value) { this.body = value; },
    };
    const headers = { host: `${HOST}:${PORT}` };
    if (body !== undefined) {
      headers.origin = CANONICAL_URL;
      headers["content-type"] = "application/json";
    }
    const input = {
      headers,
      method,
      url,
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body));
      },
    };
    await handler(input, response);
    return { ...response, json: JSON.parse(response.body) };
  };

  const initialized = await request("POST", "/api/qc/main/initialize", { mode: "lightweight" });
  assert.equal(initialized.statusCode, 200);
  assert.deepEqual(initialized.json, { mode: "lightweight" });
  assert.deepEqual((await request("GET", "/api/qc/main/state/lightweight")).json, { mode: "lightweight" });
  assert.deepEqual((await request("GET", "/api/qc/main/assets/asset-1")).json, {
    id: "asset-1", dataUrl: "data:image/png;base64,iVBORw0KGgo=",
  });
  assert.deepEqual((await request("GET", "/api/qc/main/batches/batch-1/lightweight")).json, {
    batch: { id: "batch-1" }, mode: "lightweight",
  });
  assert.deepEqual(calls, [
    ["initialize", { mode: "lightweight" }],
    ["getState", { mode: "lightweight" }],
    ["getAsset", "asset-1"],
    ["getBatchWorkspace", "batch-1", { mode: "lightweight" }],
  ]);
});

test("readServerConfig keeps the local defaults when no hosted settings are present", () => {
  const config = readServerConfig({}, { projectRoot: path.resolve("/srv/masterqc") });
  assert.deepEqual({ ...config }, {
    hosted: false,
    listenHost: "127.0.0.1",
    listenPort: 4173,
    publicOrigin: null,
    demoEnabled: true,
    dataDirectory: path.resolve("/srv/masterqc", "data", "workspace"),
  });
  assert.equal(Object.isFrozen(config), true);
});

test("readServerConfig enables hosted mode from the public origin and keeps the demo off by default", () => {
  const hosted = readServerConfig({
    MASTERQC_PUBLIC_ORIGIN: "https://QC.example.com:443/",
    MASTERQC_LISTEN_PORT: "4300",
    MASTERQC_DATA_DIR: path.resolve("/var/lib/masterqc"),
  });
  assert.equal(hosted.hosted, true);
  assert.equal(hosted.publicOrigin, "https://qc.example.com");
  assert.equal(hosted.listenPort, 4300);
  assert.equal(hosted.demoEnabled, false);
  assert.equal(hosted.dataDirectory, path.resolve("/var/lib/masterqc"));
  assert.equal(readServerConfig({ MASTERQC_PUBLIC_ORIGIN: "https://qc.example.com", MASTERQC_DEMO: "ON" }).demoEnabled, true);
  assert.equal(readServerConfig({ MASTERQC_DEMO: "off" }).demoEnabled, false);
  assert.equal(readServerConfig({ MASTERQC_PUBLIC_ORIGIN: "  ", MASTERQC_LISTEN_PORT: "" }).hosted, false, "blank values count as unset");
});

test("readServerConfig rejects invalid settings and names the setting in the error", () => {
  const cases = [
    [{ MASTERQC_LISTEN_PORT: "0" }, "MASTERQC_LISTEN_PORT"],
    [{ MASTERQC_LISTEN_PORT: "65536" }, "MASTERQC_LISTEN_PORT"],
    [{ MASTERQC_LISTEN_PORT: "4173x" }, "MASTERQC_LISTEN_PORT"],
    [{ MASTERQC_LISTEN_HOST: "0.0.0.0" }, "MASTERQC_LISTEN_HOST"],
    [{ MASTERQC_LISTEN_HOST: "192.168.1.10" }, "MASTERQC_LISTEN_HOST"],
    [{ MASTERQC_DEMO: "maybe" }, "MASTERQC_DEMO"],
    [{ MASTERQC_PUBLIC_ORIGIN: "qc.example.com" }, "MASTERQC_PUBLIC_ORIGIN"],
    [{ MASTERQC_PUBLIC_ORIGIN: "http://qc.example.com" }, "MASTERQC_PUBLIC_ORIGIN"],
    [{ MASTERQC_PUBLIC_ORIGIN: "https://qc.example.com/app" }, "MASTERQC_PUBLIC_ORIGIN"],
    [{ MASTERQC_PUBLIC_ORIGIN: "https://user:secret@qc.example.com" }, "MASTERQC_PUBLIC_ORIGIN"],
    [{ MASTERQC_PUBLIC_ORIGIN: "https://qc.example.com?x=1" }, "MASTERQC_PUBLIC_ORIGIN"],
    [{ MASTERQC_PUBLIC_ORIGIN: "https://qc.example.com", MASTERQC_DATA_DIR: "relative/data" }, "MASTERQC_DATA_DIR"],
  ];
  for (const [env, setting] of cases) {
    assert.throws(() => readServerConfig(env), (error) => {
      assert.ok(error instanceof ConfigurationError, JSON.stringify(env));
      assert.ok(error.message.includes(setting), `${setting} missing from: ${error.message}`);
      assert.equal(error.message.includes("secret"), false, "credentials must not be echoed");
      return true;
    }, JSON.stringify(env));
  }
});

test("public origins accept only https, or http on a loopback address, without credentials or paths", () => {
  assert.equal(parsePublicOrigin("https://qc.example.com:8443"), "https://qc.example.com:8443");
  assert.equal(parsePublicOrigin("https://qc.example.com/"), "https://qc.example.com");
  assert.equal(parsePublicOrigin("http://127.0.0.1:4173"), "http://127.0.0.1:4173");
  assert.equal(parsePublicOrigin("http://[::1]:4173"), "http://[::1]:4173");
  for (const value of ["http://qc.example.com", "https://qc.example.com/app", "ftp://qc.example.com", "not a url", "https://a:b@qc.example.com", "https://qc.example.com/?q=1", "https://qc.example.com/#x"]) {
    assert.throws(() => parsePublicOrigin(value), ConfigurationError, value);
  }
});

test("local mode keeps the exact loopback Host and Origin rules and keeps the demo workspace", async () => {
  const { logger } = captureLogs();
  const services = {
    main: fakeMainService(),
    demo: fakeMainService({ async getRevision() { return 7; } }),
  };
  const handler = createRequestHandler(async () => null, { services, logger });

  assert.equal((await invoke(handler, { url: "/api/qc/main/revision" })).status, 200);
  assert.equal((await invoke(handler, { url: "/api/qc/demo/revision" })).json().revision, 7);

  const foreignHost = await invoke(handler, { url: "/api/qc/main/revision", headers: { host: "qc.example.com" } });
  assert.equal(foreignHost.status, 400);
  const localhostName = await invoke(handler, { url: "/api/qc/main/revision", headers: { host: "localhost:4173" } });
  assert.equal(localhostName.status, 400, "local mode accepts only the configured loopback address");

  const foreignOrigin = await invoke(handler, { url: "/api/qc/main/revision", headers: { origin: "https://qc.example.com" } });
  assert.equal(foreignOrigin.status, 403);
  assert.equal(foreignOrigin.json().code, "origin_not_allowed");
  const unsignedPost = await invoke(handler, { method: "POST", url: "/api/qc/main/initialize" });
  assert.equal(unsignedPost.status, 403);
  assert.equal(unsignedPost.json().code, "origin_required");
  const signedPost = await invoke(handler, { method: "POST", url: "/api/qc/main/initialize", headers: { origin: CANONICAL_URL }, body: "{}" });
  assert.equal(signedPost.status, 200);

  const ipv6 = createRequestHandler(async () => null, { host: "::1", port: 4173, services, logger });
  assert.equal((await invoke(ipv6, { url: "/api/qc/main/revision", headers: { host: "[::1]:4173" } })).status, 200);
  assert.equal((await invoke(ipv6, { url: "/api/qc/main/revision", headers: { host: "127.0.0.1:4173" } })).status, 400);
});

test("GET /healthz reports the main revision and 503 when the database cannot be read", async () => {
  const { logs, logger } = captureLogs();
  const healthy = createRequestHandler(async () => null, {
    services: { main: fakeMainService({ async getRevision() { return 12; } }) },
    logger,
  });
  const ok = await invoke(healthy, { url: "/healthz?probe=1" });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json(), { ok: true, revision: 12 });
  assert.match(logs.info[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z GET \/healthz 200 \d+ms$/);

  const broken = createRequestHandler(async () => null, {
    services: { main: fakeMainService({ async getRevision() { throw new Error("database is locked"); } }) },
    logger,
  });
  const down = await invoke(broken, { url: "/healthz" });
  assert.equal(down.status, 503);
  assert.deepEqual(down.json(), { ok: false });
  assert.match(logs.error.at(-1), /database is locked/);

  const wrongHost = await invoke(healthy, { url: "/healthz", headers: { host: "example.invalid" } });
  assert.equal(wrongHost.status, 400);
  const posted = await invoke(healthy, { method: "POST", url: "/healthz", headers: { origin: CANONICAL_URL }, body: "{}" });
  assert.equal(posted.status, 405);
  const notReady = await invoke(createRequestHandler(async () => null, { logger }), { url: "/healthz" });
  assert.equal(notReady.status, 503);
  assert.deepEqual(notReady.json(), { ok: false });
});

test("a request body that breaks mid-upload is a client error and is not logged as a server fault", async () => {
  const { logs, logger } = captureLogs();
  const handler = createRequestHandler(async () => null, { services: { main: fakeMainService() }, logger });
  const request = {
    method: "POST",
    url: "/api/qc/main/initialize",
    headers: { host: `${HOST}:${PORT}`, origin: CANONICAL_URL, "content-type": "application/json" },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from("{\"mode\":");
      const aborted = new Error("aborted");
      aborted.code = "ECONNRESET";
      throw aborted;
    },
  };
  const response = {
    statusCode: null,
    body: "",
    writeHead(statusCode) { this.statusCode = statusCode; },
    end(value) { this.body = String(value ?? ""); },
  };
  await handler(request, response);
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).code, "body_interrupted");
  assert.equal(logs.error.length, 0);
});

test("access logs record one line per API or health request, without query strings, headers, or bodies", async () => {
  const { logs, logger } = captureLogs();
  const handler = createRequestHandler(async () => null, { services: { main: fakeMainService() }, logger });

  await invoke(handler, {
    url: "/api/qc/main/revision?token=QUERY-SECRET",
    headers: { authorization: "Basic QVVUSC1TRUNSRVQ=" },
  });
  await invoke(handler, {
    method: "POST",
    url: "/api/qc/main/initialize",
    headers: { origin: CANONICAL_URL },
    body: JSON.stringify({ mode: "lightweight", note: "BODY-SECRET" }),
  });
  await invoke(handler, { url: "/frontend/index.html" });

  assert.equal(logs.info.length, 2, "static requests are not logged");
  assert.match(logs.info[0], /^\S+ GET \/api\/qc\/main\/revision 200 \d+ms$/);
  assert.match(logs.info[1], /^\S+ POST \/api\/qc\/main\/initialize 200 \d+ms$/);
  const everything = [...logs.info, ...logs.error].join("\n");
  for (const secret of ["QUERY-SECRET", "QVVUSC1TRUNSRVQ=", "BODY-SECRET", "Basic"]) {
    assert.equal(everything.includes(secret), false, `${secret} must not be logged`);
  }
});

test("error mapping hides internal faults, keeps business messages, and honors explicit status codes", async () => {
  const cases = [
    { name: "TypeError", error: new TypeError("Cannot read properties of undefined (reading 'orders')"), status: 500, generic: true, logged: true },
    { name: "ReferenceError", error: new ReferenceError("state is not defined"), status: 500, generic: true, logged: true },
    {
      name: "SQLite error",
      error: Object.assign(new Error("database disk image is malformed"), { code: "ERR_SQLITE_ERROR" }),
      status: 500, generic: true, logged: true,
    },
    {
      name: "system error",
      error: Object.assign(new Error("ENOSPC: no space left on device, write '/var/lib/masterqc/tmp'"), { code: "ENOSPC", syscall: "write" }),
      status: 500, generic: true, logged: true,
    },
    { name: "business validation", error: new Error("Order number is required."), status: 400, message: "Order number is required.", logged: false },
    {
      name: "legacy revision wording",
      error: new Error("Expected revision must be a non-negative whole number."),
      status: 400, message: "Expected revision must be a non-negative whole number.", logged: false,
    },
    {
      name: "stale revision",
      error: new Error("This data changed since your last view. Reload the latest state and retry."),
      status: 409, message: "This data changed since your last view. Reload the latest state and retry.", code: "stale_revision", logged: false,
    },
    {
      name: "explicit status with code",
      error: Object.assign(new Error("Too many rows."), { statusCode: 422, code: "row_limit" }),
      status: 422, message: "Too many rows.", code: "row_limit", logged: false,
    },
    {
      name: "explicit conflict without code",
      error: Object.assign(new Error("Conflict."), { statusCode: 409 }),
      status: 409, message: "Conflict.", code: "stale_revision", logged: false,
    },
    {
      name: "explicit server error",
      error: Object.assign(new Error("Index unavailable."), { statusCode: 503 }),
      status: 503, generic: true, logged: true,
    },
  ];

  for (const testCase of cases) {
    const { logs, logger } = captureLogs();
    const handler = createRequestHandler(async () => null, {
      services: { main: fakeMainService({ async getState() { throw testCase.error; } }) },
      logger,
    });
    const response = await invoke(handler, { url: "/api/qc/main/state" });
    assert.equal(response.status, testCase.status, testCase.name);
    const body = response.json();
    if (testCase.generic) {
      assert.equal(body.error, "The local QC service could not complete the request.", testCase.name);
      assert.equal(response.text.includes("ENOSPC"), false, `${testCase.name} leaked its message`);
      assert.equal(response.text.includes("/var/lib"), false, `${testCase.name} leaked a path`);
    } else {
      assert.equal(body.error, testCase.message, testCase.name);
    }
    assert.equal(body.code, testCase.code, testCase.name);
    if (testCase.logged) {
      assert.equal(logs.error.length, 1, testCase.name);
      assert.match(logs.error[0], /\n\s+at /, `${testCase.name} must log a stack trace`);
      assert.ok(logs.error[0].includes(testCase.error.message), testCase.name);
    } else {
      assert.equal(logs.error.length, 0, testCase.name);
    }
  }
});
