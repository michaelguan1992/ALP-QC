import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInitialQCState } from "../core/qc-domain.js";
import {
  API_UPLOAD_BODY_MAX_BYTES,
  ASSET_TOTAL_MAX_BYTES,
  BACKUP_MAX_BYTES,
  DOCUMENT_MAX_BYTES,
  PHOTO_MAX_BYTES,
  UPLOAD_REQUEST_MAX_BYTES,
  createQCService,
} from "../core/qc-service.js";
import { MAX_ASSET_VALIDATION_CACHE_CHARS, createAssetValidationCache } from "../core/qc-validation.js";
import { createRequestHandler, resolveStaticTarget } from "../launcher/server.mjs";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";
import { createSQLiteQCAdapter } from "../storage/sqlite-qc-adapter.mjs";

const MiB = 1024 * 1024;
const ORIGIN = "http://127.0.0.1:4173";

function dataUrl(mimeType, bytes, fill = 65) {
  return `data:${mimeType};base64,${Buffer.alloc(bytes, fill).toString("base64")}`;
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "masterqc-attachment-limits-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// A stored document whose bytes exist only as trusted metadata, so totals can be exercised without writing them.
function storedDocuments(count, decodedBytes) {
  const state = createInitialQCState();
  const trusted = new Map();
  for (let index = 0; index < count; index += 1) {
    const id = `stored-document-${String(index).padStart(3, "0")}`;
    const contentRef = `masterqc-asset:v1:${id}`;
    state.assets.push({
      id,
      name: `stored-${index}.pdf`,
      mimeType: "application/pdf",
      kind: "document",
      batchId: null,
      rowId: null,
      versionId: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      contentRef,
    });
    trusted.set(id, {
      contentRef,
      contentSha256: "a".repeat(64),
      decodedBytes,
      mimeType: "application/pdf",
      contentRevision: 1,
    });
  }
  return { state, trusted };
}

// Serves trusted sizes from the test fixture, the same way the SQLite adapter serves stored metadata.
function adapterWithTrustedSizes({ state, trusted }) {
  return { ...createMemoryQCAdapter({ initialState: state }), getTrustedAssetValidation: () => trusted };
}

test("attachment, upload, backup, and cache limits follow the 2026-10-16 decision", () => {
  assert.equal(PHOTO_MAX_BYTES, 20 * MiB);
  assert.equal(DOCUMENT_MAX_BYTES, 20 * MiB);
  assert.equal(ASSET_TOTAL_MAX_BYTES, 500 * MiB);
  assert.equal(BACKUP_MAX_BYTES, 50 * MiB);
  assert.equal(UPLOAD_REQUEST_MAX_BYTES, 64 * MiB);
  // Base64 text is one third larger than the decoded bytes; the extra mebibyte covers JSON envelopes.
  assert.equal(API_UPLOAD_BODY_MAX_BYTES, Math.ceil(64 * MiB * 4 / 3) + MiB);
  assert.equal(MAX_ASSET_VALIDATION_CACHE_CHARS, 64 * MiB);
  assert.ok(MAX_ASSET_VALIDATION_CACHE_CHARS < Math.ceil(ASSET_TOTAL_MAX_BYTES * 4 / 3),
    "the cache bound must not grow with the attachment total");
});

test("the validation cache keeps two largest payloads and never more than its fixed bound", () => {
  const cache = createAssetValidationCache();
  const context = { revision: 1 };
  const payloads = [1, 2, 3].map((fill) => dataUrl("application/pdf", DOCUMENT_MAX_BYTES, fill));
  const parsed = payloads.map((payload) => cache.parse(payload, "Attachment", context));

  // Two maximal payloads fit under the bound, so both stay cached; the third evicts the least recently used one.
  assert.equal(cache.parse(payloads[1], "Attachment", context), parsed[1]);
  assert.equal(cache.parse(payloads[2], "Attachment", context), parsed[2]);
  assert.notEqual(cache.parse(payloads[0], "Attachment", context), parsed[0]);

  // A payload larger than the whole bound is parsed each time and never retained.
  const oversized = dataUrl("application/pdf", 49 * MiB, 7);
  assert.notEqual(cache.parse(oversized, "Attachment", context), cache.parse(oversized, "Attachment", context));
});

test("the 500 MiB total is enforced from stored sizes, including the exact boundary", async () => {
  const fixture = storedDocuments(24, DOCUMENT_MAX_BYTES);
  fixture.state.assets.push({
    id: "stored-document-remainder",
    name: "remainder.pdf",
    mimeType: "application/pdf",
    kind: "document",
    batchId: null,
    rowId: null,
    versionId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    contentRef: "masterqc-asset:v1:stored-document-remainder",
  });
  fixture.trusted.set("stored-document-remainder", {
    contentRef: "masterqc-asset:v1:stored-document-remainder",
    contentSha256: "b".repeat(64),
    decodedBytes: 19 * MiB,
    mimeType: "application/pdf",
    contentRevision: 1,
  });
  // 24 x 20 MiB plus 19 MiB is 499 MiB. The sizes come from trusted metadata, so no payload bodies are stored.
  const service = createQCService(adapterWithTrustedSizes(fixture));
  await service.initialize({ mode: "lightweight" });

  await assert.rejects(service.command("addDocument", {
    name: "over-limit.pdf", mimeType: "application/pdf", dataUrl: dataUrl("application/pdf", MiB + 1), versionId: null,
  }), /500 MiB total storage limit/);

  await service.command("addDocument", {
    name: "exact-fit.pdf", mimeType: "application/pdf", dataUrl: dataUrl("application/pdf", MiB), versionId: null,
  });
  const full = await service.getState({ mode: "lightweight" });
  assert.equal(full.assets.reduce((sum, asset) => sum + asset.decodedBytes, 0), ASSET_TOTAL_MAX_BYTES);

  await assert.rejects(service.command("addDocument", {
    name: "one-byte-over.pdf", mimeType: "application/pdf", dataUrl: dataUrl("application/pdf", 1), versionId: null,
  }), /500 MiB total storage limit/);
});

test("full-content reads and JSON exports refuse a 60 MiB workspace and point to the snapshot", async () => {
  const service = createQCService(adapterWithTrustedSizes(storedDocuments(3, DOCUMENT_MAX_BYTES)));
  await service.initialize({ mode: "lightweight" });

  const snapshotHint = /database snapshot/i;
  await assert.rejects(service.getState(), (error) => error.statusCode === 413 && error.code === "content_too_large" && snapshotHint.test(error.message));
  await assert.rejects(service.initialize(), (error) => error.statusCode === 413 && error.code === "content_too_large");
  // The size check runs before the batch lookup, so a missing batch still reports the size limit.
  await assert.rejects(service.getBatchWorkspace("missing-batch"), (error) => error.statusCode === 413);
  await assert.rejects(service.exportBackup(), (error) => error.statusCode === 413 && error.code === "backup_too_large" && snapshotHint.test(error.message));

  // The lightweight read still returns every record and each attachment's decoded size without payloads.
  const light = await service.getState({ mode: "lightweight" });
  assert.equal(light.assets.length, 3);
  assert.ok(light.assets.every((asset) => asset.decodedBytes === DOCUMENT_MAX_BYTES && asset.dataUrl === undefined));
});

test("full reads and JSON exports work below the limits and the JSON backup restores", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = createQCService(createSQLiteQCAdapter({ databasePath: path.join(directory, "source.sqlite") }));
  t.after(() => source.close());
  await source.initialize();
  await source.command("addDocument", {
    name: "first.pdf", mimeType: "application/pdf", dataUrl: dataUrl("application/pdf", DOCUMENT_MAX_BYTES, 1), versionId: null,
  });
  await source.command("addDocument", {
    name: "second.txt", mimeType: "text/plain", dataUrl: "data:text/plain;base64,c2Vjb25k", versionId: null,
  });

  // About 20 MiB of decoded content: well under both limits, so the full read and the export both work.
  const expected = await source.getState();
  assert.equal(expected.assets.length, 2);
  assert.ok(expected.assets.every((asset) => typeof asset.dataUrl === "string"));
  const backup = await source.exportBackup();

  const target = createQCService(createSQLiteQCAdapter({ databasePath: path.join(directory, "target.sqlite") }));
  t.after(() => target.close());
  await target.initialize();
  const imported = await target.importBackup(backup, 0);
  assert.equal(imported.changed, true);
  // The restore adds its own audit event and revision, so the attachments are compared rather than the whole state.
  assert.deepEqual((await target.getState()).assets, expected.assets);
});

test("a single-attachment read still works when the full workspace is too large to read", async (t) => {
  const directory = await temporaryDirectory(t);
  const service = createQCService(createSQLiteQCAdapter({ databasePath: path.join(directory, "workspace.sqlite") }));
  t.after(() => service.close());
  await service.initialize();
  await service.command("addDocument", {
    name: "first.pdf", mimeType: "application/pdf", dataUrl: dataUrl("application/pdf", DOCUMENT_MAX_BYTES, 1), versionId: null,
  });
  await service.command("addDocument", {
    name: "second.pdf", mimeType: "application/pdf", dataUrl: dataUrl("application/pdf", DOCUMENT_MAX_BYTES, 2), versionId: null,
  });
  // Two 20 MiB documents are 40 MiB: a full read still works, and a JSON backup would exceed the restore limit.
  const state = await service.getState();
  await assert.rejects(service.exportBackup(), (error) => error.statusCode === 413);
  const asset = await service.getAsset(state.assets[1].id);
  assert.equal(asset.name, "second.pdf");
  assert.equal(asset.dataUrl.startsWith("data:application/pdf;base64,"), true);
});

test("restore loads stored payloads only for attachment IDs that the backup repeats", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = createQCService(createSQLiteQCAdapter({ databasePath: path.join(directory, "source.sqlite") }));
  t.after(() => source.close());
  await source.initialize();
  await source.command("addDocument", {
    name: "shared.txt", mimeType: "text/plain", dataUrl: "data:text/plain;base64,c2hhcmVk", versionId: null,
  });
  await source.command("addDocument", {
    name: "other.txt", mimeType: "text/plain", dataUrl: "data:text/plain;base64,b3RoZXI=", versionId: null,
  });
  const backup = await source.exportBackup();
  const sharedId = backup.state.assets.find((asset) => asset.name === "shared.txt").id;
  // The incoming backup repeats one stored attachment and adds one new attachment.
  const extended = structuredClone(backup);
  extended.state.assets = extended.state.assets.filter((asset) => asset.id === sharedId);
  const newAsset = structuredClone(backup.state.assets.find((asset) => asset.name === "other.txt"));
  newAsset.id = "restored-only-document";
  newAsset.name = "restored-only.txt";
  newAsset.dataUrl = "data:text/plain;base64,bmV3";
  extended.state.assets.push(newAsset);

  const target = createQCService(createSQLiteQCAdapter({ databasePath: path.join(directory, "target.sqlite") }));
  t.after(() => target.close());
  await target.initialize();
  await target.importBackup(backup, 0);

  // Record which assets the restore transaction received with content; only the repeated one should carry it.
  const adapter = createSQLiteQCAdapter({ databasePath: path.join(directory, "target.sqlite") });
  const observed = [];
  const spied = {
    ...adapter,
    transact(mutator, options) {
      return adapter.transact((current) => {
        observed.push({ options, loaded: current.assets.filter((asset) => typeof asset.dataUrl === "string").map((asset) => asset.id) });
        return mutator(current);
      }, options);
    },
  };
  const restoring = createQCService(spied);
  t.after(() => restoring.close());
  await restoring.initialize({ mode: "lightweight" });
  const before = await restoring.getState({ mode: "lightweight" });
  const result = await restoring.importBackup(extended, before.revision);

  assert.equal(result.changed, true);
  assert.equal(result.counts.added.assets, 1);
  assert.equal(result.counts.skipped.assets, 1);
  const restoreTransaction = observed.at(-1);
  assert.equal(restoreTransaction.options.includeAssetContent, false);
  assert.deepEqual(restoreTransaction.loaded, [sharedId]);
  const restored = await restoring.getState({ mode: "lightweight" });
  assert.ok(restored.assets.some((asset) => asset.id === "restored-only-document"));
});

function requestFor({ method = "POST", url, body = "{}", contentLength, contentType = "application/json" }) {
  const payload = Buffer.from(body);
  return {
    method,
    url,
    headers: {
      host: "127.0.0.1:4173",
      origin: ORIGIN,
      "content-type": contentType,
      ...(contentLength === undefined ? {} : { "content-length": String(contentLength) }),
    },
    async *[Symbol.asyncIterator]() {
      if (payload.length) yield payload;
    },
  };
}

async function dispatch(handler, request) {
  const response = { status: 0, body: "" };
  response.writeHead = (status) => { response.status = status; };
  response.end = (value) => { response.body = value === undefined ? "" : String(value); };
  await handler(request, response);
  return { status: response.status, body: response.body ? JSON.parse(response.body) : null };
}

function limitedHandler(options = {}) {
  const calls = [];
  const services = {
    main: {
      command: async (type) => { calls.push(type); return { entityId: "accepted", revision: 1 }; },
      importBackup: async () => { calls.push("importBackup"); return { changed: false }; },
      importHistory: async () => { calls.push("importHistory"); return { changed: false }; },
      initialize: async () => ({ initialized: true }),
    },
    demo: {},
  };
  return { calls, handler: createRequestHandler(resolveStaticTarget, { services, host: "127.0.0.1", port: 4173, ...options }) };
}

const COMMAND_URL = "/api/qc/main/command";
const RESTORE_URL = "/api/qc/main/restore";
const HISTORY_URL = "/api/qc/main/history";
const SMALL_COMMAND = JSON.stringify({ type: "saveBatchChanges", data: {}, expectedRevision: 0 });

test("the upload route accepts a body at its limit and rejects one byte more with 413", async () => {
  const { calls, handler } = limitedHandler();
  const atLimit = await dispatch(handler, requestFor({ url: COMMAND_URL, body: SMALL_COMMAND, contentLength: API_UPLOAD_BODY_MAX_BYTES }));
  assert.equal(atLimit.status, 200);
  const overLimit = await dispatch(handler, requestFor({ url: COMMAND_URL, body: SMALL_COMMAND, contentLength: API_UPLOAD_BODY_MAX_BYTES + 1 }));
  assert.equal(overLimit.status, 413);
  assert.equal(overLimit.body.code, "body_too_large");
  assert.match(overLimit.body.error, /Add fewer files at a time/);
  assert.deepEqual(calls, ["saveBatchChanges"]);
});

test("the upload route carries a maximal multi-file request of 64 MiB decoded content", async () => {
  // Four files (20, 20, 20, and 4 MiB) are 64 MiB decoded; their base64 text is the largest request the browser may send.
  const sizes = [20, 20, 20, 4].map((mebibytes) => mebibytes * MiB);
  const files = sizes.map((bytes, index) => JSON.stringify({
    name: `maximal-${index}.jpg`,
    mimeType: "image/jpeg",
    category: "photo",
    dataUrl: `data:image/jpeg;base64,${"A".repeat(Math.ceil(bytes / 3) * 4)}`,
  }));
  const body = `{"type":"createIssue","data":{"reportedBy":"Inspector","title":"Maximal upload","files":[${files.join(",")}]},"expectedRevision":0}`;
  assert.ok(Buffer.byteLength(body) <= API_UPLOAD_BODY_MAX_BYTES, "a maximal request must fit the upload route");
  const { calls, handler } = limitedHandler();
  const response = await dispatch(handler, requestFor({ url: COMMAND_URL, body }));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["createIssue"]);
});

test("restore and history keep the 50 MiB limit while the upload route does not", async () => {
  const backupLimit = BACKUP_MAX_BYTES + 4096;
  const { calls, handler } = limitedHandler();
  const restoreBody = JSON.stringify({ backup: {}, expectedRevision: 0 });
  const historyBody = JSON.stringify({ historyPackage: {}, expectedRevision: 0 });

  assert.equal((await dispatch(handler, requestFor({ url: RESTORE_URL, body: restoreBody, contentLength: backupLimit }))).status, 200);
  const restoreTooLarge = await dispatch(handler, requestFor({ url: RESTORE_URL, body: restoreBody, contentLength: backupLimit + 1 }));
  assert.equal(restoreTooLarge.status, 413);
  assert.match(restoreTooLarge.body.error, /50 MiB/);

  assert.equal((await dispatch(handler, requestFor({ url: HISTORY_URL, body: historyBody, contentLength: backupLimit }))).status, 200);
  assert.equal((await dispatch(handler, requestFor({ url: HISTORY_URL, body: historyBody, contentLength: backupLimit + 1 }))).status, 413);

  // The same 60 MiB declared length is refused for restore but accepted by the upload route's length check.
  assert.equal((await dispatch(handler, requestFor({ url: RESTORE_URL, body: restoreBody, contentLength: 60 * MiB }))).status, 413);
  assert.equal((await dispatch(handler, requestFor({ url: COMMAND_URL, body: SMALL_COMMAND, contentLength: 60 * MiB }))).status, 200);
  assert.deepEqual(calls, ["importBackup", "importHistory", "saveBatchChanges"]);
});

test("a body that streams past the limit without a declared length is rejected with 413", async () => {
  const { handler } = limitedHandler({ maxBodyBytes: 1024 });
  const oversized = JSON.stringify({ type: "saveBatchChanges", data: { padding: "x".repeat(2048) }, expectedRevision: 0 });
  const response = await dispatch(handler, requestFor({ url: COMMAND_URL, body: oversized }));
  assert.equal(response.status, 413);
  assert.equal(response.body.code, "body_too_large");
});
