import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createQCService } from "../core/qc-service.js";
import { createQCHttpService } from "../core/qc-http-service.js";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";
import { createSQLiteQCAdapter } from "../storage/sqlite-qc-adapter.mjs";
import { createQCWorkspaceServices, createRequestHandler, getDefaultDataDirectory, resolveStaticTarget } from "../launcher/server.mjs";

const DATE = "2026-09-30";
const LARK_PACKAGE = JSON.parse(await readFile(new URL("../data/lark-import/version-history.v1.json", import.meta.url), "utf8"));

async function temporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "masterqc-web-sqlite-test-"));
}

function createInProcessFetch(handler, origin) {
  return async (input, options = {}) => {
    const url = new URL(input);
    const headers = Object.fromEntries(Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    const body = options.body === undefined ? undefined : String(options.body);
    const request = {
      headers: {
        host: url.host,
        ...(options.method && options.method !== "GET" ? { origin } : {}),
        ...headers,
        ...(body === undefined ? {} : {
          "content-type": headers["content-type"] ?? "application/json",
          "content-length": Buffer.byteLength(body),
        }),
      },
      method: options.method ?? "GET",
      url: `${url.pathname}${url.search}`,
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(body);
      },
    };
    let status = 0;
    let responseHeaders = {};
    let responseBody = "";
    await handler(request, {
      writeHead(code, values) { status = code; responseHeaders = values; },
      end(value) { responseBody = value === undefined ? "" : value; },
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: responseHeaders,
      async json() { return JSON.parse(Buffer.isBuffer(responseBody) ? responseBody.toString("utf8") : String(responseBody)); },
    };
  };
}

async function startTestServer(dataDirectory, options = {}) {
  const services = await createQCWorkspaceServices({ dataDirectory });
  const port = 4173;
  const baseUrl = `http://127.0.0.1:${port}`;
  const handler = createRequestHandler(resolveStaticTarget, { services, host: "127.0.0.1", port, ...options });
  const fetchImpl = createInProcessFetch(handler, baseUrl);
  return {
    services,
    baseUrl,
    fetchImpl,
    main: createQCHttpService({ baseUrl, fetchImpl }),
    demo: createQCHttpService({ workspace: "demo", baseUrl, fetchImpl }),
  };
}

async function closeTestServer(services) {
  services.close();
}

test("SQLite QC adapter commits atomically, rejects stale revisions, and survives close and reopen", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "workspace.sqlite");
  let adapter = createSQLiteQCAdapter({ databasePath });
  let service = createQCService(adapter);
  const initial = await service.initialize();
  const variant = initial.variants.find((item) => item.model === "S15" && item.color === "Red");
  const created = await service.command("createOrder", {
    number: "SQLITE-PO-1",
    date: DATE,
    supplier: "Supplier",
    notes: "Durable order",
    lines: [{ variantId: variant.id, orderedQty: 25 }],
  }, initial.revision);
  const committed = await service.getState();

  await assert.rejects(service.command("createOrder", {
    number: "SQLITE-PO-STALE",
    date: DATE,
    lines: [{ variantId: variant.id, orderedQty: 25 }],
  }, initial.revision), /changed since your last view/i);
  await assert.rejects(adapter.transact((current) => {
    current.revision += 1;
    current.orders.push({ id: "rolled-back" });
    throw new Error("rollback marker");
  }), /rollback marker/);
  assert.deepEqual(await service.getState(), committed);
  assert.equal(created.revision, 1);

  await service.close();
  adapter = createSQLiteQCAdapter({ databasePath });
  service = createQCService(adapter);
  await service.initialize();
  assert.deepEqual(await service.getState(), committed);
  await service.close();
});

test("a copied main database file retains committed attachments and accepts durable edits", async (t) => {
  const sourceDirectory = await temporaryDirectory();
  const destinationDirectory = await temporaryDirectory();
  t.after(() => rm(sourceDirectory, { recursive: true, force: true }));
  t.after(() => rm(destinationDirectory, { recursive: true, force: true }));
  const sourcePath = path.join(sourceDirectory, "masterqc-main.sqlite");
  const destinationPath = path.join(destinationDirectory, "masterqc-main.sqlite");

  let source = createQCService(createSQLiteQCAdapter({ databasePath: sourcePath }));
  await source.initialize();
  await source.command("importLarkVersionHistory", { package: LARK_PACKAGE }, 0);
  let sourceState = await source.getState();
  const recordedVersion = sourceState.versions.find((version) => version.status === "recorded");
  await source.command("addDocument", {
    name: "portable-evidence.txt",
    mimeType: "text/plain",
    dataUrl: "data:text/plain;base64,cG9ydGFibGUgYXR0YWNobWVudA==",
    versionId: recordedVersion.id,
  }, sourceState.revision);
  sourceState = await source.getState();
  const expected = structuredClone(sourceState);
  await source.close();

  assert.deepEqual(await readdir(sourceDirectory), ["masterqc-main.sqlite"]);
  await copyFile(sourcePath, destinationPath);
  assert.deepEqual(await readdir(destinationDirectory), ["masterqc-main.sqlite"]);

  let destination = createQCService(createSQLiteQCAdapter({ databasePath: destinationPath }));
  await destination.initialize();
  assert.deepEqual(await destination.getState(), expected);
  assert.equal((await destination.getState()).assets.find((asset) => asset.name === "portable-evidence.txt").dataUrl,
    "data:text/plain;base64,cG9ydGFibGUgYXR0YWNobWVudA==");

  const variant = expected.variants.find((item) => item.model === "S15" && item.color === "Red");
  await destination.command("createOrder", {
    number: "PORTABLE-PO-1",
    date: DATE,
    supplier: "Destination supplier",
    notes: "Saved after copying the database file",
    lines: [{ variantId: variant.id, orderedQty: 18 }],
  }, expected.revision);
  const destinationEditedState = await destination.getState();
  await destination.close();

  destination = createQCService(createSQLiteQCAdapter({ databasePath: destinationPath }));
  await destination.initialize();
  assert.deepEqual(await destination.getState(), destinationEditedState);
  await destination.close();

  source = createQCService(createSQLiteQCAdapter({ databasePath: sourcePath }));
  await source.initialize();
  assert.deepEqual(await source.getState(), expected);
  await source.close();
});

test("additive SQLite restore preserves recorded references and attached files on repeat", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = createQCService(createMemoryQCAdapter());
  await source.initialize();
  await source.command("importLarkVersionHistory", { package: LARK_PACKAGE }, 0);
  const sourceState = await source.getState();
  const recordedVersion = sourceState.versions.find((version) => version.status === "recorded");
  await source.command("addDocument", {
    name: "source-note.txt",
    mimeType: "text/plain",
    dataUrl: "data:text/plain;base64,bGVnYWN5IGF0dGFjaG1lbnQ=",
    versionId: recordedVersion.id,
  }, sourceState.revision);
  const backup = await source.exportBackup();

  const target = createQCService(createSQLiteQCAdapter({ databasePath: path.join(directory, "workspace.sqlite") }));
  await target.initialize();
  const imported = await target.importBackup(backup, 0);
  const migratedState = await target.getState();
  assert.equal(imported.changed, true);
  assert.deepEqual(migratedState.versions, backup.state.versions);
  assert.deepEqual(migratedState.assets, backup.state.assets);
  assert.deepEqual(migratedState.versions.find((version) => version.id === recordedVersion.id).sourceRows,
    backup.state.versions.find((version) => version.id === recordedVersion.id).sourceRows);
  const linkedAsset = migratedState.assets.find((asset) => asset.name === "source-note.txt");
  assert.equal(linkedAsset.versionId, recordedVersion.id);

  const conflictingBackup = structuredClone(backup);
  conflictingBackup.state.assets.find((asset) => asset.id === linkedAsset.id).name = "conflicting-source-note.txt";
  await assert.rejects(target.importBackup(conflictingBackup, migratedState.revision), /conflicts with existing assets record/i);
  assert.deepEqual(await target.getState(), migratedState);

  const repeated = await target.importBackup(backup, migratedState.revision);
  assert.equal(repeated.changed, false);
  assert.deepEqual(await target.getState(), migratedState);
  await target.close();
  await source.close();
});

test("two HTTP clients share main records across restart while demo stays isolated", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  let running = await startTestServer(directory);
  let initial = await running.main.initialize();
  await running.demo.initialize();
  const secondClientState = await running.main.getState();
  const variant = initial.variants.find((item) => item.model === "S15" && item.color === "Red");
  const created = await running.main.command("createOrder", {
    number: "HTTP-SHARED-PO",
    date: DATE,
    supplier: "Shared supplier",
    notes: "Visible to both clients",
    lines: [{ variantId: variant.id, orderedQty: 40 }],
  }, initial.revision);

  assert.equal((await running.main.getRevision()), created.revision);
  assert.equal((await running.main.getState()).orders.length, 1);
  assert.equal((await running.demo.getState()).orders.length, 0);
  await assert.rejects(running.main.command("createOrder", {
    number: "HTTP-STALE-PO",
    date: DATE,
    lines: [{ variantId: variant.id, orderedQty: 10 }],
  }, secondClientState.revision), (error) => error.status === 409);

  const committed = await running.main.getState();
  await closeTestServer(running.services);
  running = await startTestServer(directory);
  assert.deepEqual(await running.main.getState(), committed);
  assert.equal((await running.demo.getState()).orders.length, 0);
  await closeTestServer(running.services);
});

test("API rejects foreign origins, oversized JSON, unsupported operations, and Node-only storage paths", async (t) => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const running = await startTestServer(directory, { maxBodyBytes: 128 });
  t.after(() => closeTestServer(running.services));

  const foreignOrigin = await running.fetchImpl(`${running.baseUrl}/api/qc/main/initialize`, {
    method: "POST",
    headers: { Origin: "http://example.invalid", "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(foreignOrigin.status, 403);

  const oversized = await running.fetchImpl(`${running.baseUrl}/api/qc/main/initialize`, {
    method: "POST",
    headers: { Origin: running.baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ payload: "x".repeat(1000) }),
  });
  assert.equal(oversized.status, 413);

  const forbiddenOperation = await running.fetchImpl(`${running.baseUrl}/api/qc/main/command`, {
    method: "POST",
    headers: { Origin: running.baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "replaceState", data: {}, expectedRevision: 0 }),
  });
  assert.equal(forbiddenOperation.status, 400);

  const unknownRoute = await running.fetchImpl(`${running.baseUrl}/api/qc/main/raw-state`);
  assert.equal(unknownRoute.status, 404);
  const nodeOnlyModule = await running.fetchImpl(`${running.baseUrl}/storage/sqlite-qc-adapter.mjs`);
  assert.equal(nodeOnlyModule.status, 404);
  assert.equal(await resolveStaticTarget("/data/workspace/masterqc-main.sqlite"), null);
  assert.equal(await resolveStaticTarget("/data/workspace/masterqc-demo.sqlite"), null);
});

test("static serving blocks project-local workspace files even under a data root", async (t) => {
  const projectRoot = await temporaryDirectory();
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const workspaceDirectory = path.join(projectRoot, "data", "workspace");
  const databasePath = path.join(workspaceDirectory, "masterqc-main.sqlite");
  await mkdir(workspaceDirectory, { recursive: true });
  await writeFile(databasePath, "private database bytes");

  const target = await resolveStaticTarget("/data/workspace/masterqc-main.sqlite", {
    roots: [{ urlPrefix: "/data", directory: path.join(projectRoot, "data") }],
    projectRoot,
  });
  assert.equal(target, null);
});

test("HTTP batch routes preserve IDs that contain colons", async () => {
  const baseUrl = "http://127.0.0.1:4173";
  const handler = createRequestHandler(resolveStaticTarget, {
    services: { main: { getBatchWorkspace: async (id) => ({ batch: { id } }) } },
  });
  const service = createQCHttpService({ baseUrl, fetchImpl: createInProcessFetch(handler, baseUrl) });
  const workspace = await service.getBatchWorkspace("history:inspection:source-001");
  assert.equal(workspace.batch.id, "history:inspection:source-001");
});

test("default SQLite paths stay in project data/workspace on every platform, with an environment override", () => {
  assert.equal(getDefaultDataDirectory({ platform: "darwin", env: {}, projectRoot: "/Users/tester/Projects/MasterQC-Web" }),
    "/Users/tester/Projects/MasterQC-Web/data/workspace");
  assert.equal(getDefaultDataDirectory({ platform: "win32", env: {}, projectRoot: "C:\\Users\\tester\\Projects\\MasterQC-Web" }),
    "C:\\Users\\tester\\Projects\\MasterQC-Web\\data\\workspace");
  assert.equal(getDefaultDataDirectory({ platform: "linux", env: {}, projectRoot: "/home/tester/projects/MasterQC-Web" }),
    "/home/tester/projects/MasterQC-Web/data/workspace");
  assert.equal(getDefaultDataDirectory({ platform: "darwin", env: { MASTERQC_DATA_DIR: "./acceptance-data" } }),
    path.resolve("./acceptance-data"));
});
