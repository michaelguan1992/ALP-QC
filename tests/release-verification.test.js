import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createQCWorkspaceServices, createRequestHandler, resolveStaticTarget } from "../launcher/server.mjs";
import { countRecords, parseExpectedCounts } from "../scripts/release-lib.mjs";
import { VerificationError, compareCounts, summarizeVerification, verifyRelease } from "../scripts/verify-release.mjs";
import { readRecordCounts } from "../scripts/count-records.mjs";

const DATE = "2026-10-17";
const EVIDENCE_TEXT = "release evidence";
const EVIDENCE_BYTES = Buffer.byteLength(EVIDENCE_TEXT);
const TEXT_URL = `data:text/plain;base64,${Buffer.from(EVIDENCE_TEXT).toString("base64")}`;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERIFY_SCRIPT = path.join(PROJECT_ROOT, "scripts", "verify-release.mjs");
const COUNT_SCRIPT = path.join(PROJECT_ROOT, "scripts", "count-records.mjs");
const execFileAsync = promisify(execFile);
const silentLogger = { info() {}, error() {} };

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "masterqc-release-check-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// Seeds a real SQLite workspace with a published version, an order, a batch, and one library document.
async function seedWorkspace(service) {
  let state = await service.initialize();
  await service.command("installAPReferences", {}, state.revision);
  state = await service.getState();
  const version = state.versions.find((candidate) => candidate.familyId === "s15");
  await service.command("publishVersion", { id: version.id }, state.revision);
  state = await service.getState();
  const variant = state.variants.find((candidate) => candidate.model === "S15" && candidate.color === "Red");
  const orderResult = await service.command("createOrder", {
    number: "PO-RELEASE-CHECK",
    date: DATE,
    supplier: "Release supplier",
    notes: "",
    lines: [{ variantId: variant.id, orderedQty: 100 }],
  }, state.revision);
  state = await service.getState();
  const order = state.orders.find((candidate) => candidate.id === orderResult.entityId);
  await service.command("createBatch", {
    number: "B-RELEASE-CHECK",
    orderId: order.id,
    lineId: order.lines[0].id,
    quantity: 100,
    versionId: version.id,
    factory: "AP",
    stage: "OQC",
    date: DATE,
    recorder: "Inspector",
  }, state.revision);
  state = await service.getState();
  const documentResult = await service.command("addDocument", {
    name: "release-evidence.txt",
    mimeType: "text/plain",
    dataUrl: TEXT_URL,
    versionId: null,
  }, state.revision);
  return { state: await service.getState(), documentId: documentResult.entityId };
}

// Serves the real request handler on a loopback port, under the hosted origin rules that the release check uses.
async function startServer(t, services) {
  let handler = null;
  const server = createHttpServer((request, response) => handler(request, response));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  handler = createRequestHandler(resolveStaticTarget, {
    services,
    host: "127.0.0.1",
    port,
    publicOrigin: `http://127.0.0.1:${port}`,
    demoEnabled: false,
    logger: silentLogger,
  });
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return { port, baseUrl: `http://127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, hostHeader: `127.0.0.1:${port}` };
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// A real SQLite workspace in a temporary directory, seeded with the records the checks need.
async function seededWorkspace(t) {
  const directory = await temporaryDirectory(t);
  const services = await createQCWorkspaceServices({ dataDirectory: directory, demoEnabled: false });
  t.after(() => services.close());
  const seeded = await seedWorkspace(services.main);
  return { directory, services, ...seeded };
}

function runNode(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

test("the release check passes on a real server when the counts match and every attachment reads back", async (t) => {
  const { services, state } = await seededWorkspace(t);
  assert.ok(state.batches.length >= 1 && state.assets.length >= 1, "the seeded workspace has a batch and an attachment");
  const server = await startServer(t, { main: services.main });

  const expected = countRecords(state);
  const result = await verifyRelease({ ...server, expected });
  assert.equal(result.revision, state.revision);
  assert.equal(result.attachments, state.assets.length);
  assert.ok(result.attachmentBytes >= EVIDENCE_BYTES, "the attachment bytes are summed");
  assert.match(summarizeVerification(result), /^Release verification passed: revision \d+; records: families 2, variants \d+, .*batches 1, .*assets \d+/);

  // A new release may hold more records than the baseline, so counts above the expected numbers still pass.
  await verifyRelease({ ...server, expected: { ...expected, versions: expected.versions - 1, audit: expected.audit - 1 } });
});

test("the release check fails with the missing batch named when the new release has fewer batches", async (t) => {
  const { services, state } = await seededWorkspace(t);
  const server = await startServer(t, { main: services.main });
  const expected = { ...countRecords(state), batches: state.batches.length + 1 };
  await assert.rejects(verifyRelease({ ...server, expected }), (error) => {
    assert.ok(error instanceof VerificationError);
    assert.equal(error.message, `batches has ${state.batches.length} records; expected exactly ${state.batches.length + 1}.`);
    return true;
  });
});

test("the release check fails when a stored attachment size differs from its metadata", async (t) => {
  const { services, state, documentId } = await seededWorkspace(t);
  const realMain = services.main;
  // The lightweight state reports one byte more than the document's real decoded size. Attachment reads are unchanged.
  const tamperedMain = {
    ...realMain,
    async getState(options) {
      const current = await realMain.getState(options);
      if (options?.mode !== "lightweight") return current;
      return {
        ...current,
        assets: current.assets.map((asset) => (asset.id === documentId ? { ...asset, decodedBytes: EVIDENCE_BYTES + 1 } : asset)),
      };
    },
  };
  const server = await startServer(t, { main: tamperedMain });
  await assert.rejects(verifyRelease({ ...server, expected: countRecords(state) }), (error) => {
    assert.ok(error instanceof VerificationError);
    assert.equal(
      error.message,
      `Attachment ${documentId} decodes to ${EVIDENCE_BYTES} bytes, but its metadata records ${EVIDENCE_BYTES + 1}.`,
    );
    return true;
  });
});

test("the release check reports a server that cannot be reached, without a stack trace", async () => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  await assert.rejects(
    verifyRelease({ baseUrl, hostHeader: `127.0.0.1:${port}`, origin: baseUrl, expected: { revision: 0, batches: 0, issues: 0, orders: 0, assets: 0 } }),
    (error) => {
      assert.ok(error instanceof VerificationError);
      assert.match(error.message, /^The health check could not reach the server: /);
      return true;
    },
  );
});

test("compareCounts allows growth in ordinary collections and requires exact batches, issues, orders and assets", () => {
  const actual = { revision: 9, batches: 2, issues: 1, orders: 1, assets: 3, versions: 4 };
  assert.doesNotThrow(() => compareCounts(actual, { revision: 8, batches: 2, issues: 1, orders: 1, assets: 3, versions: 2 }));
  assert.throws(() => compareCounts(actual, { batches: 3, issues: 1, orders: 1, assets: 3 }), /batches has 2 records; expected exactly 3\./);
  assert.throws(() => compareCounts(actual, { batches: 2, issues: 1, orders: 1, assets: 2 }), /assets has 3 records; expected exactly 2\./);
  assert.throws(() => compareCounts(actual, { revision: 10, batches: 2, issues: 1, orders: 1, assets: 3 }), /The revision is 9; expected at least 10\./);
  assert.throws(() => compareCounts(actual, { batches: 2, issues: 1, orders: 1, assets: 3, audit: 1 }), /audit is missing from the upgraded state\./);
  assert.throws(() => compareCounts({ ...actual, versions: 1 }, { batches: 2, issues: 1, orders: 1, assets: 3, versions: 2 }), /versions has 1 records; expected at least 2\./);
});

test("the counts file must be an object that includes the exact collections", () => {
  assert.throws(() => parseExpectedCounts([]), /must contain a JSON object/);
  assert.throws(() => parseExpectedCounts({ batches: 1, issues: 0, orders: 0 }), /missing assets/);
  assert.throws(() => parseExpectedCounts({ batches: -1, issues: 0, orders: 0, assets: 0 }), /value for batches must be a whole number/);
  assert.throws(() => parseExpectedCounts({ revision: 1.5, batches: 0, issues: 0, orders: 0, assets: 0 }), /revision must be a whole number/);
  assert.equal(parseExpectedCounts({ revision: 1, batches: 0, issues: 0, orders: 0, assets: 0, versions: 2 }).versions, 2);
});

test("the verification command exits 0 with a summary when the release passes, and 1 with the reason when it fails", async (t) => {
  const { directory, services, state } = await seededWorkspace(t);
  const server = await startServer(t, { main: services.main });
  const countsPath = path.join(directory, "expected.json");
  const baseArguments = ["--base-url", server.baseUrl, "--host-header", server.hostHeader, "--origin", server.origin];

  await writeFile(countsPath, JSON.stringify(countRecords(state)));
  const passed = await runNode([VERIFY_SCRIPT, ...baseArguments, "--expect", countsPath]);
  assert.equal(passed.code, 0, passed.stderr);
  assert.match(passed.stdout, /Release verification passed: revision/);

  await writeFile(countsPath, JSON.stringify({ ...countRecords(state), batches: state.batches.length + 2 }));
  const failed = await runNode([VERIFY_SCRIPT, ...baseArguments, "--expect", countsPath]);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /^Release verification failed: batches has 1 records; expected exactly 3\./);

  const invalid = await runNode([VERIFY_SCRIPT, ...baseArguments]);
  assert.equal(invalid.code, 2, "a missing --expect is a usage error");
  assert.match(invalid.stderr, /--expect is required/);
});

test("the count command prints the record counts of a running server as JSON", async (t) => {
  const { services, state } = await seededWorkspace(t);
  const server = await startServer(t, { main: services.main });

  const counts = await readRecordCounts({ baseUrl: server.baseUrl, hostHeader: server.hostHeader });
  assert.equal(counts.revision, state.revision);
  assert.equal(counts.batches, state.batches.length);
  assert.equal(counts.assets, state.assets.length);
  assert.equal(counts.families, 2);
  assert.equal(Object.hasOwn(counts, "history"), false, "only top-level arrays of records are counted");

  const printed = await runNode([COUNT_SCRIPT, "--base-url", server.baseUrl, "--host-header", server.hostHeader]);
  assert.equal(printed.code, 0, printed.stderr);
  assert.deepEqual(JSON.parse(printed.stdout), counts);

  const unreachable = await runNode([COUNT_SCRIPT, "--base-url", `http://127.0.0.1:${await freePort()}`, "--host-header", "127.0.0.1:1"]);
  assert.equal(unreachable.code, 1);
  assert.match(unreachable.stderr, /^Could not count the records:/);

  const usage = await execFileAsync(process.execPath, [COUNT_SCRIPT]).catch((error) => error);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /--base-url and --host-header are required/);
});
