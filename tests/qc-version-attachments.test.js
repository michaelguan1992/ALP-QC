import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createQCService } from "../core/qc-service.js";
import { removeVersionAttachment } from "../core/qc-assets.js";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";

const LARK_PACKAGE = JSON.parse(readFileSync(new URL("../data/lark-import/version-history.v1.json", import.meta.url), "utf8"));
const DATE = "2026-09-29";
const TEXT_DATA_URL = "data:text/plain;base64,dGVzdCBhdHRhY2htZW50";

function makeService(initialState = null) {
  let idNumber = 0;
  let timeNumber = 0;
  return createQCService(createMemoryQCAdapter({ initialState }), {
    idFactory: () => `version-attachment-test-${String(++idNumber).padStart(4, "0")}`,
    now: () => new Date(Date.UTC(2026, 8, 29, 12, 0, timeNumber++)).toISOString(),
  });
}

async function run(service, type, data = {}) {
  const state = await service.getState();
  return service.command(type, data, state.revision);
}

async function installVersions(service) {
  await run(service, "installAPReferences");
  return service.getState();
}

test("attachments can be removed from draft, published, and archived versions without editing versions", async () => {
  const service = makeService();
  await service.initialize();
  await installVersions(service);

  let state = await service.getState();
  const published = state.versions.find((version) => version.familyId === "s11-s14");
  await run(service, "publishVersion", { id: published.id });
  await run(service, "importLarkVersionHistory", { package: LARK_PACKAGE });
  state = await service.getState();

  const targets = [
    state.versions.find((version) => version.status === "draft"),
    state.versions.find((version) => version.status === "published"),
    state.versions.find((version) => version.status === "recorded"),
  ];
  assert.deepEqual(targets.map((version) => version?.status), ["draft", "published", "recorded"]);

  for (const [index, version] of targets.entries()) {
    const fileName = `version-${index}.txt`;
    const upload = await run(service, "addDocument", {
      name: fileName,
      mimeType: "text/plain",
      dataUrl: TEXT_DATA_URL,
      versionId: version.id,
    });
    const beforeRemoval = await service.getState();
    const versionBefore = structuredClone(beforeRemoval.versions.find((candidate) => candidate.id === version.id));

    await run(service, "removeVersionAttachment", { versionId: version.id, assetId: upload.entityId });

    const afterRemoval = await service.getState();
    assert.deepEqual(afterRemoval.versions.find((candidate) => candidate.id === version.id), versionBefore);
    assert.equal(afterRemoval.assets.some((asset) => asset.id === upload.entityId), false);
  }
});

test("removing an attachment through the wrong version fails atomically", async () => {
  const service = makeService();
  await service.initialize();
  const state = await installVersions(service);
  const [owner, other] = state.versions;
  const upload = await run(service, "addDocument", {
    name: "owned-by-first.txt",
    mimeType: "text/plain",
    dataUrl: TEXT_DATA_URL,
    versionId: owner.id,
  });
  const before = await service.getState();

  await assert.rejects(
    run(service, "removeVersionAttachment", { versionId: other.id, assetId: upload.entityId }),
    /not attached to this version/i,
  );
  assert.deepEqual(await service.getState(), before);
});

test("batch-referenced version assets are unlinked, retained, and restorable", async () => {
  const sourceService = makeService();
  await sourceService.initialize();
  let state = await installVersions(sourceService);
  const version = state.versions.find((candidate) => candidate.familyId === "s15");
  await run(sourceService, "publishVersion", { id: version.id });

  state = await sourceService.getState();
  const variant = state.variants.find((candidate) => candidate.model === "S15" && candidate.color === "Red");
  const orderResult = await run(sourceService, "createOrder", {
    number: "PO-VERSION-ATTACHMENT",
    date: DATE,
    supplier: "Supplier",
    notes: "",
    lines: [{ variantId: variant.id, orderedQty: 100 }],
  });
  state = await sourceService.getState();
  const order = state.orders.find((candidate) => candidate.id === orderResult.entityId);
  const batchResult = await run(sourceService, "createBatch", {
    number: "BATCH-VERSION-ATTACHMENT",
    orderId: order.id,
    lineId: order.lines[0].id,
    quantity: 100,
    factory: "奥途莱 AP",
    stage: "OQC",
    lotNumber: "LOT-VERSION-ATTACHMENT",
    versionId: version.id,
    date: DATE,
    recorder: "Inspector",
    notes: "",
  });
  const upload = await run(sourceService, "addDocument", {
    name: "shared-version-batch.txt",
    mimeType: "text/plain",
    dataUrl: TEXT_DATA_URL,
    versionId: version.id,
  });

  state = await sourceService.getState();
  state.batches.find((batch) => batch.id === batchResult.entityId).attachmentIds.push(upload.entityId);
  const service = makeService(state);
  await service.initialize();
  const versionBefore = structuredClone((await service.getState()).versions.find((candidate) => candidate.id === version.id));

  await run(service, "removeVersionAttachment", { versionId: version.id, assetId: upload.entityId });

  state = await service.getState();
  const retained = state.assets.find((asset) => asset.id === upload.entityId);
  assert.ok(retained);
  assert.equal(retained.versionId, null);
  assert.deepEqual(state.versions.find((candidate) => candidate.id === version.id), versionBefore);
  assert.deepEqual(state.batches.find((batch) => batch.id === batchResult.entityId).attachmentIds, [upload.entityId]);

  const restoredService = makeService();
  await restoredService.initialize();
  await restoredService.importBackup(await service.exportBackup(), 0);
  const restored = await restoredService.getState();
  assert.deepEqual(restored.assets.find((asset) => asset.id === upload.entityId), retained);
  assert.deepEqual(restored.batches.find((batch) => batch.id === batchResult.entityId).attachmentIds, [upload.entityId]);
});

test("history-referenced version assets retain source evidence when unlinked", () => {
  const version = { id: "archived-version", label: "25.10.29" };
  const asset = { id: "source-pdf", name: "original.pdf", kind: "document", versionId: version.id };
  const source = { id: "source-record", assetId: asset.id };
  const state = { versions: [version], assets: [asset], batches: [], history: { sources: [source] } };
  const historyBefore = structuredClone(state.history);

  removeVersionAttachment(state, { versionId: version.id, assetId: asset.id });

  assert.equal(state.assets.length, 1);
  assert.equal(state.assets[0].versionId, null);
  assert.deepEqual(state.history, historyBefore);
});
