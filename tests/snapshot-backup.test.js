import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createQCService } from "../core/qc-service.js";
import { createQCHttpService } from "../core/qc-http-service.js";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";
import { createSQLiteQCAdapter } from "../storage/sqlite-qc-adapter.mjs";
import { createQCWorkspaceServices, createRequestHandler, resolveStaticTarget } from "../launcher/server.mjs";
import { restoreSnapshot } from "../launcher/restore-snapshot.mjs";

const DATE = "2026-10-16";
const LIVE_FILE = "masterqc-main.sqlite";
const RESTORE_SCRIPT = fileURLToPath(new URL("../launcher/restore-snapshot.mjs", import.meta.url));
const execFileAsync = promisify(execFile);

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "masterqc-snapshot-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256OfFile(filePath) {
  return sha256(await readFile(filePath));
}

function openService(databasePath) {
  return createQCService(createSQLiteQCAdapter({ databasePath }));
}

// Adds an order and one library document, so the workspace has business records and an attachment payload.
async function seedWorkspace(service, label, { documentBytes = null } = {}) {
  const initial = await service.initialize();
  const variant = initial.variants.find((item) => item.model === "S15" && item.color === "Red");
  const order = await service.command("createOrder", {
    number: `PO-${label}`,
    date: DATE,
    supplier: `Supplier ${label}`,
    notes: label,
    lines: [{ variantId: variant.id, orderedQty: 25 }],
  }, initial.revision);
  const isText = documentBytes === null;
  await service.command("addDocument", {
    name: isText ? `${label}.txt` : `${label}.pdf`,
    mimeType: isText ? "text/plain" : "application/pdf",
    dataUrl: isText
      ? `data:text/plain;base64,${Buffer.from(`evidence for ${label}`).toString("base64")}`
      : `data:application/pdf;base64,${documentBytes.toString("base64")}`,
    versionId: null,
  }, order.revision);
  return service.getState();
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// Uses a fresh connection per request, so closing the test server never waits on keep-alive sockets.
function httpGet(port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path: requestPath, method: "GET", headers, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

// Runs the real request handler behind an ephemeral loopback server, so the Host check sees the actual port.
async function startRouteServer(t, services, dataDirectory) {
  let handler = null;
  const server = createHttpServer((request, response) => handler(request, response));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  handler = createRequestHandler(resolveStaticTarget, { services, host: "127.0.0.1", port, snapshotDirectory: dataDirectory });
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return port;
}

async function listSnapshotLeftovers(directory) {
  return (await readdir(directory)).filter((name) => name.startsWith(".snapshot-"));
}

// The handler removes the temporary file after the response ends, so allow a short wait before checking.
async function waitForSnapshotCleanup(directory) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const leftovers = await listSnapshotLeftovers(directory);
    if (leftovers.length === 0) return;
    if (Date.now() > deadline) assert.fail(`Temporary snapshot files remained: ${leftovers.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function listRestoreLeftovers(directory) {
  return (await readdir(directory)).filter((name) => name.includes(".restore-") ||
    name.startsWith(".snapshot-restore-") || name.includes("before-snapshot-restore"));
}

test("a SQLite snapshot opens with the current code and matches the live state, revision and attachments", async (t) => {
  const directory = await temporaryDirectory(t);
  const livePath = path.join(directory, LIVE_FILE);
  const service = openService(livePath);
  t.after(() => service.close());
  await seedWorkspace(service, "live");
  const live = await service.getState();
  const liveRevision = await service.getRevision();

  const snapshotPath = path.join(directory, "snapshot.sqlite");
  assert.equal(await service.createSnapshot(snapshotPath), path.resolve(snapshotPath));

  const check = new DatabaseSync(snapshotPath);
  try {
    assert.deepEqual(check.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check), ["ok"]);
  } finally {
    check.close();
  }
  const snapshotService = openService(snapshotPath);
  try {
    assert.deepEqual(await snapshotService.getState(), live);
    assert.equal(await snapshotService.getRevision(), liveRevision);
  } finally {
    await snapshotService.close();
  }

  await assert.rejects(service.createSnapshot(snapshotPath), /already exists/);
  await assert.rejects(service.createSnapshot(livePath), /cannot replace the live database/);
});

test("the memory adapter reports snapshots as unsupported and writes nothing", async (t) => {
  const directory = await temporaryDirectory(t);
  const service = createQCService(createMemoryQCAdapter());
  await service.initialize();
  const target = path.join(directory, "memory-snapshot.sqlite");
  await assert.rejects(service.createSnapshot(target), /not supported by this storage adapter/);
  assert.deepEqual(await readdir(directory), []);
});

test("the snapshot route streams a valid SQLite download with headers and removes its temporary file", async (t) => {
  const directory = await temporaryDirectory(t);
  const services = await createQCWorkspaceServices({ dataDirectory: directory });
  t.after(() => services.close());
  const live = await seedWorkspace(services.main, "route");
  const port = await startRouteServer(t, services, directory);

  const response = await httpGet(port, "/api/qc/main/backup/snapshot");
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/vnd.sqlite3");
  assert.match(response.headers["content-disposition"], /^attachment; filename="masterqc-main-\d{8}T\d{6}Z\.sqlite"$/);
  assert.equal(Number(response.headers["content-length"]), response.body.length);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.body.subarray(0, 16).toString("latin1"), "SQLite format 3\u0000");
  await waitForSnapshotCleanup(directory);

  const downloaded = path.join(directory, "downloaded-copy.sqlite");
  await writeFile(downloaded, response.body);
  const copy = openService(downloaded);
  try {
    assert.deepEqual(await copy.getState(), live);
  } finally {
    await copy.close();
  }

  const sameOrigin = await httpGet(port, "/api/qc/main/backup/snapshot", { Origin: `http://127.0.0.1:${port}` });
  assert.equal(sameOrigin.status, 200);
  const fetchSameOrigin = await httpGet(port, "/api/qc/main/backup/snapshot", { "Sec-Fetch-Site": "same-origin" });
  assert.equal(fetchSameOrigin.status, 200);
  await waitForSnapshotCleanup(directory);
});

test("the snapshot route rejects foreign origins, cross-site requests and foreign hosts before creating a file", async (t) => {
  const directory = await temporaryDirectory(t);
  const services = await createQCWorkspaceServices({ dataDirectory: directory });
  t.after(() => services.close());
  await seedWorkspace(services.main, "origin");
  const port = await startRouteServer(t, services, directory);
  const url = "/api/qc/main/backup/snapshot";

  const foreignOrigin = await httpGet(port, url, { Origin: "http://evil.example" });
  assert.equal(foreignOrigin.status, 403);
  assert.equal(JSON.parse(foreignOrigin.body.toString()).code, "origin_not_allowed");

  const crossSite = await httpGet(port, url, { "Sec-Fetch-Site": "cross-site" });
  assert.equal(crossSite.status, 403);
  const sameSite = await httpGet(port, url, { "Sec-Fetch-Site": "same-site" });
  assert.equal(sameSite.status, 403);

  const foreignHost = await httpGet(port, url, { Host: "evil.example" });
  assert.equal(foreignHost.status, 400);

  assert.deepEqual(await listSnapshotLeftovers(directory), []);
});

test("a snapshot that fails before streaming reports the error and removes the partial file", async (t) => {
  const directory = await temporaryDirectory(t);
  const failingService = {
    async createSnapshot(targetPath) {
      await writeFile(targetPath, "partial snapshot bytes");
      throw new Error("Simulated disk failure.");
    },
    close() {},
  };
  const port = await startRouteServer(t, { main: failingService }, directory);

  const response = await httpGet(port, "/api/qc/main/backup/snapshot");
  assert.equal(response.status, 400);
  assert.equal(JSON.parse(response.body.toString()).error, "Simulated disk failure.");
  assert.deepEqual(await listSnapshotLeftovers(directory), []);
});

test("a snapshot download interrupted by the client removes its temporary file", async (t) => {
  const directory = await temporaryDirectory(t);
  const services = await createQCWorkspaceServices({ dataDirectory: directory });
  t.after(() => services.close());
  await seedWorkspace(services.main, "interrupt", { documentBytes: randomBytes(8 * 1024 * 1024) });
  const port = await startRouteServer(t, services, directory);

  await new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path: "/api/qc/main/backup/snapshot", agent: false }, (response) => {
      assert.equal(response.statusCode, 200);
      response.on("error", () => {});
      response.once("data", () => {
        request.destroy();
        resolve();
      });
    });
    request.on("error", () => {});
    request.setTimeout(10000, () => {
      request.destroy();
      reject(new Error("The snapshot response did not start."));
    });
    request.end();
  });
  await waitForSnapshotCleanup(directory);
});

test("the restore command refuses while the service port is in use and leaves the live database unchanged", async (t) => {
  const directory = await temporaryDirectory(t);
  const livePath = path.join(directory, LIVE_FILE);
  const service = openService(livePath);
  await seedWorkspace(service, "busy");
  await service.close();
  const snapshotPath = path.join(directory, "source.sqlite");
  await copyFile(livePath, snapshotPath);
  const liveHash = await sha256OfFile(livePath);
  const before = (await readdir(directory)).sort();

  const busy = net.createServer();
  await new Promise((resolve) => busy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => busy.close(resolve)));
  const { port } = busy.address();

  await assert.rejects(
    restoreSnapshot({ snapshotPath, dataDirectory: directory, port }),
    /MasterQC Web is running on 127\.0\.0\.1:\d+\. Stop it first/,
  );
  assert.equal(await sha256OfFile(livePath), liveHash);
  assert.deepEqual((await readdir(directory)).sort(), before);
});

test("the restore command rejects corrupt or invalid snapshots without touching the live database", async (t) => {
  const directory = await temporaryDirectory(t);
  const livePath = path.join(directory, LIVE_FILE);
  const service = openService(livePath);
  await seedWorkspace(service, "live-before-bad", { documentBytes: Buffer.from("good attachment bytes") });
  await service.close();
  const liveHash = await sha256OfFile(livePath);
  const port = await freePort();

  const goodSnapshot = path.join(directory, "good-source.sqlite");
  await copyFile(livePath, goodSnapshot);
  const payloadAssetId = (() => {
    const database = new DatabaseSync(goodSnapshot);
    try {
      return database.prepare("SELECT asset_id FROM qc_asset_payloads LIMIT 1").get().asset_id;
    } finally {
      database.close();
    }
  })();
  const editGoodCopy = async (target, sql, values) => {
    await copyFile(goodSnapshot, target);
    const database = new DatabaseSync(target);
    try {
      database.prepare(sql).run(...values);
    } finally {
      database.close();
    }
  };

  const cases = [
    ["a non-SQLite file", async (target) => writeFile(target, randomBytes(4096)), /not a readable SQLite database/],
    ["a truncated snapshot", async (target) => {
      await copyFile(goodSnapshot, target);
      await truncate(target, Math.floor((await stat(target)).size / 2));
    }, /not a readable SQLite database|failed SQLite integrity_check/],
    ["an unrelated SQLite database", async (target) => {
      const database = new DatabaseSync(target);
      database.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT);");
      database.close();
    }, /not a MasterQC database/],
    ["a MasterQC database without saved state", async (target) => {
      const adapter = createSQLiteQCAdapter({ databasePath: target });
      await adapter.close();
    }, /contains no saved QC state/],
    ["a payload whose digest does not match its content", (target) =>
      editGoodCopy(target, "UPDATE qc_asset_payloads SET content_sha256 = ? WHERE asset_id = ?", ["0".repeat(64), payloadAssetId]),
    /corrupt/],
    ["a payload whose MIME type does not match its content", (target) =>
      editGoodCopy(target, "UPDATE qc_asset_payloads SET mime_type = ? WHERE asset_id = ?", ["image/png", payloadAssetId]),
    /corrupt/],
    ["a payload whose size does not match its content", (target) =>
      editGoodCopy(target, "UPDATE qc_asset_payloads SET decoded_bytes = decoded_bytes + 1 WHERE asset_id = ?", [payloadAssetId]),
    /corrupt/],
  ];

  for (const [label, buildSnapshot, expected] of cases) {
    const snapshotPath = path.join(directory, `bad-${label.replace(/\W+/g, "-")}.sqlite`);
    await buildSnapshot(snapshotPath);
    await assert.rejects(restoreSnapshot({ snapshotPath, dataDirectory: directory, port }), expected, label);
    assert.equal(await sha256OfFile(livePath), liveHash, `${label} changed the live database`);
    assert.deepEqual(await listRestoreLeftovers(directory), [], label);
  }
});

const HISTORY_SOURCE_ID = "source-restore-check-1";
const HISTORY_ASSET_ID = "asset-restore-check-1";

// A minimal historical PDF package: one source, one inspection with one row, and the PDF itself.
function historyPackageFor(pdfBytes) {
  return {
    format: "masterqc-pdf-history",
    formatVersion: 1,
    sources: [{
      id: HISTORY_SOURCE_ID,
      fileName: "restore-check.pdf",
      sha256: sha256(pdfBytes),
      pageCount: 1,
      family: "s15",
      assetId: HISTORY_ASSET_ID,
      rawFileName: "restore-check.pdf",
    }],
    inspections: [{
      id: "inspection-restore-check-1",
      sourceId: HISTORY_SOURCE_ID,
      page: 1,
      printedVersion: "25.10.29",
      printedDate: "2026/09/14",
      date: "2026-09-14",
      productLabel: "S15",
      model: "S15",
      color: null,
      factory: "AP",
      stage: "IQC",
      batchQuantity: 384,
      recorder: null,
      notes: "",
      rows: [{
        no: 1,
        title: "Visual check",
        specification: "",
        devices: "Visual",
        samplingPercent: 10,
        recordingRule: "",
        timeSeconds: null,
        important: false,
        sourceInspectedQty: 39,
        defectiveQty: 0,
        sourceDefectiveRate: 0,
        remarks: "",
        raw: {},
      }],
      anomalies: [],
      raw: {},
    }],
    assets: [{
      id: HISTORY_ASSET_ID,
      name: "restore-check.pdf",
      mimeType: "application/pdf",
      dataUrl: `data:application/pdf;base64,${pdfBytes.toString("base64")}`,
      kind: "document",
      batchId: null,
      rowId: null,
      versionId: null,
      createdAt: "2026-09-29T12:00:00.000Z",
    }],
    anomalies: [],
  };
}

test("the restore command checks each historical PDF against its recorded SHA-256", async (t) => {
  const directory = await temporaryDirectory(t);
  const originalDirectory = await temporaryDirectory(t);
  const livePath = path.join(originalDirectory, LIVE_FILE);
  const originalPdf = Buffer.from("%PDF-1.4 original historical sheet\n");
  const seeded = openService(livePath);
  await seeded.initialize();
  await seeded.importHistory(historyPackageFor(originalPdf), 0);
  await seeded.close();

  const goodSnapshot = path.join(originalDirectory, "history-good.sqlite");
  await copyFile(livePath, goodSnapshot);
  const control = await restoreSnapshot({ snapshotPath: goodSnapshot, dataDirectory: directory, port: await freePort() });
  assert.equal(control.summary.attachments, 1);

  // Replace the PDF and keep its payload metadata consistent, so only the recorded source digest disagrees.
  const replacement = Buffer.from("%PDF-1.4 replaced historical sheet\n");
  const tamperedSnapshot = path.join(originalDirectory, "history-tampered.sqlite");
  await copyFile(livePath, tamperedSnapshot);
  const database = new DatabaseSync(tamperedSnapshot);
  database.prepare("UPDATE qc_asset_payloads SET data_url = ?, decoded_bytes = ?, content_sha256 = ? WHERE asset_id = ?")
    .run(`data:application/pdf;base64,${replacement.toString("base64")}`, replacement.length, sha256(replacement), HISTORY_ASSET_ID);
  database.close();

  const liveHash = await sha256OfFile(control.databasePath);
  await assert.rejects(
    restoreSnapshot({ snapshotPath: tamperedSnapshot, dataDirectory: directory, port: await freePort() }),
    /SHA-256 does not match historical PDF restore-check\.pdf/,
  );
  assert.equal(await sha256OfFile(control.databasePath), liveHash);
});

test("the restore command refuses leftover journal files and the live database itself", async (t) => {
  const directory = await temporaryDirectory(t);
  const livePath = path.join(directory, LIVE_FILE);
  const service = openService(livePath);
  await seedWorkspace(service, "journal");
  await service.close();
  const port = await freePort();
  const liveHash = await sha256OfFile(livePath);

  await assert.rejects(restoreSnapshot({ snapshotPath: livePath, dataDirectory: directory, port }), /Choose a snapshot file, not the live database/);

  const snapshotPath = path.join(directory, "journal-source.sqlite");
  await copyFile(livePath, snapshotPath);
  await writeFile(`${livePath}-journal`, "hot journal");
  await assert.rejects(restoreSnapshot({ snapshotPath, dataDirectory: directory, port }), /SQLite journal files exist/);
  assert.equal(await sha256OfFile(livePath), liveHash);
});

test("a valid snapshot replaces the live database, keeps the previous one and makes the restored data readable", async (t) => {
  const liveDirectory = await temporaryDirectory(t);
  const sourceDirectory = await temporaryDirectory(t);
  const livePath = path.join(liveDirectory, LIVE_FILE);

  const liveService = openService(livePath);
  const previousState = await seedWorkspace(liveService, "previous");
  await liveService.close();
  const previousHash = await sha256OfFile(livePath);

  const sourceService = openService(path.join(sourceDirectory, "source.sqlite"));
  const restoredState = await seedWorkspace(sourceService, "restored", { documentBytes: randomBytes(64 * 1024) });
  const snapshotPath = path.join(sourceDirectory, "source-snapshot.sqlite");
  await sourceService.createSnapshot(snapshotPath);
  await sourceService.close();

  const result = await restoreSnapshot({ snapshotPath, dataDirectory: liveDirectory, port: await freePort() });

  assert.equal(result.databasePath, livePath);
  assert.match(result.keptPath, /masterqc-main\.sqlite\.before-snapshot-restore-\d{8}T\d{6}Z\.sqlite$/);
  assert.equal(await sha256OfFile(result.keptPath), previousHash);
  assert.equal(result.summary.revision, restoredState.revision);
  assert.equal(result.summary.attachments, restoredState.assets.length);

  const restored = openService(livePath);
  try {
    assert.deepEqual(await restored.getState(), restoredState);
    assert.equal(await restored.getRevision(), restoredState.revision);
  } finally {
    await restored.close();
  }
  const kept = openService(result.keptPath);
  try {
    assert.deepEqual(await kept.getState(), previousState);
  } finally {
    await kept.close();
  }
  assert.deepEqual(await listRestoreLeftovers(liveDirectory), [path.basename(result.keptPath)]);
});

test("a restore into an empty data directory creates the workspace without keeping anything", async (t) => {
  const liveDirectory = await temporaryDirectory(t);
  const sourceDirectory = await temporaryDirectory(t);
  const sourceService = openService(path.join(sourceDirectory, "source.sqlite"));
  const sourceState = await seedWorkspace(sourceService, "fresh");
  const snapshotPath = path.join(sourceDirectory, "fresh-snapshot.sqlite");
  await sourceService.createSnapshot(snapshotPath);
  await sourceService.close();

  const result = await restoreSnapshot({ snapshotPath, dataDirectory: liveDirectory, port: await freePort() });
  assert.equal(result.keptPath, null);
  const restored = openService(path.join(liveDirectory, LIVE_FILE));
  try {
    assert.deepEqual(await restored.getState(), sourceState);
  } finally {
    await restored.close();
  }
});

test("attachment verification iterates payload rows instead of reading every payload at once", async (t) => {
  const directory = await temporaryDirectory(t);
  const livePath = path.join(directory, LIVE_FILE);
  const seeded = openService(livePath);
  await seedWorkspace(seeded, "iteration", { documentBytes: randomBytes(16 * 1024) });
  await seeded.close();

  const probe = new DatabaseSync(":memory:");
  const statementPrototype = Object.getPrototypeOf(probe.prepare("SELECT 1"));
  probe.close();
  const originalAll = statementPrototype.all;
  const originalIterate = statementPrototype.iterate;
  const iteratedPayloadQueries = [];
  const readsPayloadBodies = (sql) => /qc_asset_payloads/.test(sql) && /data_url/.test(sql);
  statementPrototype.all = function allWithoutPayloadBodies(...args) {
    if (readsPayloadBodies(this.sourceSQL)) {
      throw new Error("Payload verification must not read every attachment body at once.");
    }
    return originalAll.apply(this, args);
  };
  statementPrototype.iterate = function iterateStatement(...args) {
    if (readsPayloadBodies(this.sourceSQL)) iteratedPayloadQueries.push(this.sourceSQL);
    return originalIterate.apply(this, args);
  };
  t.after(() => {
    statementPrototype.all = originalAll;
    statementPrototype.iterate = originalIterate;
  });

  const service = openService(livePath);
  try {
    const state = await service.initialize({ mode: "lightweight" });
    assert.equal(state.assets.length, 1);
    assert.ok(iteratedPayloadQueries.length > 0, "payload verification should iterate the payload rows");
  } finally {
    await service.close();
  }
});

test("a corrupt payload found during iterated verification fails cleanly and leaves the database usable", async (t) => {
  const directory = await temporaryDirectory(t);
  const livePath = path.join(directory, LIVE_FILE);
  const seeded = openService(livePath);
  await seedWorkspace(seeded, "corrupt-iteration", { documentBytes: randomBytes(4096) });
  await seeded.close();
  const database = new DatabaseSync(livePath);
  database.prepare("UPDATE qc_asset_payloads SET content_sha256 = ?").run("f".repeat(64));
  database.close();

  const adapter = createSQLiteQCAdapter({ databasePath: livePath });
  const service = createQCService(adapter);
  try {
    await assert.rejects(service.initialize({ mode: "lightweight" }), /corrupt/);
    assert.equal(typeof await adapter.getRevision(), "number");
  } finally {
    await service.close();
  }
});

test("the restore command prints usage and exits with status 2 for invalid arguments", async () => {
  for (const args of [[], ["--workspace", "other", "snapshot.sqlite"], ["one.sqlite", "two.sqlite"], ["--unknown"]]) {
    await assert.rejects(execFileAsync(process.execPath, [RESTORE_SCRIPT, ...args]), (error) => {
      assert.equal(error.code, 2, `arguments ${JSON.stringify(args)}`);
      assert.match(error.stderr, /Usage: node launcher\/restore-snapshot\.mjs <snapshot-file> \[--workspace main\|demo\]/);
      return true;
    });
  }
});

test("the HTTP facade exposes the same-origin snapshot URL for each workspace", () => {
  assert.equal(createQCHttpService().backupSnapshotUrl(), "/api/qc/main/backup/snapshot");
  assert.equal(createQCHttpService({ workspace: "demo", baseUrl: "http://127.0.0.1:4173/" }).backupSnapshotUrl(),
    "http://127.0.0.1:4173/api/qc/demo/backup/snapshot");
});
