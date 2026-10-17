import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createQCService } from "../core/qc-service.js";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";
import { createSQLiteQCAdapter } from "../storage/sqlite-qc-adapter.mjs";

const DATE = "2026-10-17";
const PNG_URL = "data:image/png;base64,iVBORw0KGgo=";
const PDF_BYTES = Buffer.from("%PDF-1.4\n", "utf8");
const PDF_URL = `data:application/pdf;base64,${PDF_BYTES.toString("base64")}`;
const STALE_MESSAGE = "Someone else changed this record since you opened it. Reload the latest data and try again.";

function isStaleRejection(error) {
  return error.statusCode === 409 && error.code === "stale_revision" && error.message === STALE_MESSAGE;
}

// The memory adapter cannot be reopened, so only the SQLite store offers a restart.
async function createStore(kind, t) {
  if (kind === "memory") {
    const adapter = createMemoryQCAdapter();
    return { open: () => createQCService(adapter) };
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "masterqc-concurrent-saves-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "workspace.sqlite");
  return { open: () => createQCService(createSQLiteQCAdapter({ databasePath })) };
}

// Two batches on one purchase order, with the S15 version published, as the real workflow creates them.
async function seedBatches(service) {
  let state = await service.initialize();
  await service.command("installAPReferences", {}, state.revision);
  state = await service.getState();
  const version = state.versions.find((candidate) => candidate.familyId === "s15");
  await service.command("publishVersion", { id: version.id }, state.revision);
  state = await service.getState();
  const variant = state.variants.find((candidate) => candidate.model === "S15" && candidate.color === "Red");
  const orderResult = await service.command("createOrder", {
    number: "PO-CONCURRENT",
    date: DATE,
    supplier: "Supplier",
    notes: "",
    lines: [{ variantId: variant.id, orderedQty: 200 }],
  }, state.revision);
  state = await service.getState();
  const order = state.orders.find((candidate) => candidate.id === orderResult.entityId);
  const batchIds = [];
  for (const number of ["B-CONCURRENT-A", "B-CONCURRENT-B"]) {
    const result = await service.command("createBatch", {
      number,
      orderId: order.id,
      lineId: order.lines[0].id,
      quantity: 50,
      versionId: version.id,
      factory: "AP",
      stage: "OQC",
      date: DATE,
      recorder: "Inspector",
      notes: "",
    }, (await service.getState()).revision);
    batchIds.push(result.entityId);
  }
  return batchIds;
}

async function firstRows(service, batchId, count = 1) {
  return (await service.getBatchWorkspace(batchId)).rows.slice(0, count);
}

function rowSave(batchId, row, remarks) {
  return { batchId, rows: [{ rowId: row.id, defectiveQty: 0, actualTimeSeconds: 1.5, remarks }] };
}

function savedRemarks(state, batchId, rowId) {
  return state.batches.find((batch) => batch.id === batchId).rows.find((row) => row.id === rowId).remarks;
}

// A backup-format history package with one archived PDF, the same shape the history importer accepts.
function historicalPackage() {
  const sourceId = "concurrent-history-source";
  const assetId = "concurrent-history-pdf";
  return {
    format: "masterqc-pdf-history",
    formatVersion: 1,
    sources: [{
      id: sourceId,
      fileName: "archived.pdf",
      sha256: createHash("sha256").update(PDF_BYTES).digest("hex"),
      pageCount: 1,
      family: "s15",
      assetId,
    }],
    inspections: [{
      id: "concurrent-history-inspection",
      sourceId,
      page: 1,
      printedVersion: "25.10.29",
      printedDate: "2026/09/20",
      date: "2026-09-20",
      productLabel: "S15",
      model: "S15",
      color: null,
      factory: "AP",
      stage: "OQC",
      batchQuantity: 10,
      recorder: null,
      notes: "Archived original.",
      rows: [{
        no: 1,
        title: "Visual inspection",
        specification: "Inspect the visible surface.",
        devices: "Visual inspection",
        samplingPercent: 100,
        recordingRule: "Record all defects.",
        timeSeconds: null,
        important: false,
        sourceInspectedQty: 10,
        defectiveQty: 0,
        sourceDefectiveRate: 0,
        remarks: "",
        raw: {},
      }],
      anomalies: [],
      raw: {},
    }],
    assets: [{
      id: assetId,
      name: "archived.pdf",
      mimeType: "application/pdf",
      dataUrl: PDF_URL,
      kind: "document",
      batchId: null,
      rowId: null,
      versionId: null,
      createdAt: "2026-09-20T12:00:00.000Z",
    }],
    versions: [],
    anomalies: [],
  };
}

for (const kind of ["memory", "sqlite"]) {
  test(`${kind}: edits to different batches from one base revision both commit, and the second is rebased`, async (t) => {
    const store = await createStore(kind, t);
    const service = store.open();
    t.after(() => service.close());
    const [batchA, batchB] = await seedBatches(service);
    const base = (await service.getState()).revision;
    const [rowA] = await firstRows(service, batchA);
    const [rowB] = await firstRows(service, batchB);

    const first = await service.saveBatchChanges(rowSave(batchA, rowA, "A from the base view"), base);
    assert.equal(first.revision, base + 1);
    assert.equal(first.baseRevision, base);
    assert.equal(first.rebased, undefined, "a save on the latest revision is not rebased");

    const second = await service.saveBatchChanges(rowSave(batchB, rowB, "B from the same base view"), base);
    assert.equal(second.revision, base + 2);
    assert.equal(second.baseRevision, base);
    assert.equal(second.rebased, true);

    const state = await service.getState();
    assert.equal(savedRemarks(state, batchA, rowA.id), "A from the base view");
    assert.equal(savedRemarks(state, batchB, rowB.id), "B from the same base view");
  });

  test(`${kind}: a second edit to the same batch from one base revision is rejected and changes nothing`, async (t) => {
    const store = await createStore(kind, t);
    const service = store.open();
    t.after(() => service.close());
    const [batchA] = await seedBatches(service);
    const base = (await service.getState()).revision;
    const [rowA] = await firstRows(service, batchA);

    await service.saveBatchChanges(rowSave(batchA, rowA, "winning edit"), base);
    const before = await service.getState();
    await assert.rejects(service.saveBatchChanges(rowSave(batchA, rowA, "losing edit"), base), (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "stale_revision");
      assert.equal(error.message, STALE_MESSAGE);
      return true;
    });

    assert.deepEqual(await service.getState(), before, "the rejected save rolls back completely");
    assert.equal(await service.getRevision(), before.revision);
    assert.equal(savedRemarks(before, batchA, rowA.id), "winning edit");
  });

  test(`${kind}: an Issue save and a different batch save from one base both commit, and a repeated Issue save conflicts`, async (t) => {
    const store = await createStore(kind, t);
    const service = store.open();
    t.after(() => service.close());
    const [, batchB] = await seedBatches(service);
    const [rowB] = await firstRows(service, batchB);
    const created = await service.command("createIssue", {
      reportedBy: "Inspector",
      title: "Seal concern",
      files: [{ name: "seal.png", mimeType: "image/png", dataUrl: PNG_URL, category: "photo" }],
    }, (await service.getState()).revision);
    const base = created.revision;
    const issueSave = { id: created.entityId, owner: "Owner A", disposition: "Accept", confirmations: ["Ann", "Ben", "Cara"], description: "" };

    const issueResult = await service.command("saveIssue", issueSave, base);
    assert.equal(issueResult.revision, base + 1);

    const batchResult = await service.saveBatchChanges(rowSave(batchB, rowB, "Concurrent batch edit"), base);
    assert.equal(batchResult.rebased, true);

    await assert.rejects(service.command("saveIssue", { ...issueSave, owner: "Owner B" }, base), isStaleRejection);
    const state = await service.getState();
    assert.equal(state.issues.find((issue) => issue.id === created.entityId).owner, "Owner A");
    assert.equal(savedRemarks(state, batchB, rowB.id), "Concurrent batch edit");
  });

  test(`${kind}: audit entries from earlier saves never make a stale save conflict`, async (t) => {
    const store = await createStore(kind, t);
    const service = store.open();
    t.after(() => service.close());
    const [batchA] = await seedBatches(service);
    const base = (await service.getState()).revision;
    const [rowA] = await firstRows(service, batchA);

    await service.saveBatchChanges(rowSave(batchA, rowA, "first audited save"), base);
    const auditBefore = (await service.getState()).audit.length;
    const stale = await service.command("createIssue", {
      reportedBy: "Inspector",
      title: "Stale but unrelated",
      files: [{ name: "unrelated.png", mimeType: "image/png", dataUrl: PNG_URL, category: "photo" }],
    }, base);

    assert.equal(stale.rebased, true);
    const state = await service.getState();
    assert.equal(state.audit.length, auditBefore + 1, "the stale command appended its own audit entry");
    assert.equal(state.issues.length, 1);
  });

  test(`${kind}: a base newer than the stored revision is rejected, and a malformed base is a validation error`, async (t) => {
    const store = await createStore(kind, t);
    const service = store.open();
    t.after(() => service.close());
    const [batchA] = await seedBatches(service);
    const before = await service.getState();
    const [rowA] = await firstRows(service, batchA);

    await assert.rejects(service.saveBatchChanges(rowSave(batchA, rowA, "from the future"), before.revision + 5), isStaleRejection);
    await assert.rejects(service.saveBatchChanges(rowSave(batchA, rowA, "negative"), -1), (error) => {
      assert.equal(error.statusCode, undefined, "a malformed base is not reported as a stale revision");
      return /Expected revision must be a non-negative whole number/.test(error.message);
    });
    await assert.rejects(service.saveBatchChanges(rowSave(batchA, rowA, "fractional"), 1.5), /Expected revision must be a non-negative whole number/);
    assert.deepEqual(await service.getState(), before);
  });

  test(`${kind}: a save that changes nothing records nothing and leaves other stale saves accepted`, async (t) => {
    const store = await createStore(kind, t);
    const service = store.open();
    t.after(() => service.close());
    const [batchA, batchB] = await seedBatches(service);
    const base = (await service.getState()).revision;
    const [rowA] = await firstRows(service, batchA);
    const [rowB] = await firstRows(service, batchB);

    const saved = await service.saveBatchChanges(rowSave(batchA, rowA, "unchanged text"), base);
    const unchanged = await service.saveBatchChanges(rowSave(batchA, rowA, "unchanged text"), saved.revision);
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.revision, saved.revision);

    const other = await service.saveBatchChanges(rowSave(batchB, rowB, "edit from the base view"), base);
    assert.equal(other.rebased, true);
    assert.equal(other.revision, saved.revision + 1);
  });

  test(`${kind}: a backup restore makes older views reject until they reload`, async (t) => {
    const store = await createStore(kind, t);
    const service = store.open();
    t.after(() => service.close());
    const [batchA, batchB] = await seedBatches(service);
    const base = (await service.getState()).revision;
    const [rowA] = await firstRows(service, batchA);
    const [rowB] = await firstRows(service, batchB);
    await service.saveBatchChanges(rowSave(batchA, rowA, "before restore"), base);

    const donor = createQCService(createMemoryQCAdapter());
    const donorState = await donor.initialize();
    const variant = donorState.variants.find((candidate) => candidate.model === "S15" && candidate.color === "Red");
    await donor.command("createOrder", {
      number: "PO-FROM-BACKUP",
      date: DATE,
      supplier: "Restore source",
      notes: "",
      lines: [{ variantId: variant.id, orderedQty: 10 }],
    }, donorState.revision);
    const backup = await donor.exportBackup();

    const restored = await service.importBackup(backup, (await service.getState()).revision);
    assert.equal(restored.changed, true);
    await assert.rejects(service.saveBatchChanges(rowSave(batchB, rowB, "older view after restore"), base), isStaleRejection);

    const current = await service.saveBatchChanges(rowSave(batchB, rowB, "reloaded view"), restored.revision);
    assert.equal(current.revision, restored.revision + 1);
    assert.equal(current.rebased, undefined);
  });

  test(`${kind}: opening an already-loaded workspace keeps older views usable`, async (t) => {
    const store = await createStore(kind, t);
    const service = store.open();
    t.after(() => service.close());
    await service.initialize();
    await service.importHistory(historicalPackage(), (await service.getState()).revision);
    const [batchA, batchB] = await seedBatches(service);
    const base = (await service.getState()).revision;
    const [rowA] = await firstRows(service, batchA);
    const [rowB] = await firstRows(service, batchB);
    await service.saveBatchChanges(rowSave(batchA, rowA, "before page load"), base);

    // A page load runs the startup check again. It changes nothing, so the change log must survive it.
    await service.initialize();
    const older = await service.saveBatchChanges(rowSave(batchB, rowB, "after page load"), base);
    assert.equal(older.rebased, true);
  });
}

test("sqlite: a fresh service over the same file rejects an older base even for an unrelated record", async (t) => {
  const store = await createStore("sqlite", t);
  let service = store.open();
  t.after(() => service.close());
  const [batchA, batchB] = await seedBatches(service);
  const base = (await service.getState()).revision;
  const [rowA] = await firstRows(service, batchA);
  const [rowB] = await firstRows(service, batchB);
  await service.saveBatchChanges(rowSave(batchA, rowA, "saved before restart"), base);
  await service.close();

  // A restarted process starts with an empty change log, so the gap forces the strict answer.
  service = store.open();
  const beforeStale = await service.getState();
  await assert.rejects(service.saveBatchChanges(rowSave(batchB, rowB, "unrelated but unknown"), base), isStaleRejection);
  assert.deepEqual(await service.getState(), beforeStale);

  const current = await service.saveBatchChanges(rowSave(batchB, rowB, "current view"), beforeStale.revision);
  assert.equal(current.revision, beforeStale.revision + 1);
  assert.equal(current.rebased, undefined);
});

test("sqlite: a rejected stale save leaves the durable file exactly as the last commit left it", async (t) => {
  const store = await createStore("sqlite", t);
  let service = store.open();
  t.after(() => service.close());
  const [batchA] = await seedBatches(service);
  const base = (await service.getState()).revision;
  const [rowA] = await firstRows(service, batchA);
  await service.saveBatchChanges(rowSave(batchA, rowA, "committed"), base);
  const committed = await service.getState();
  await assert.rejects(service.command("saveBatchChanges", rowSave(batchA, rowA, "stale"), base), isStaleRejection);
  await service.close();

  service = store.open();
  assert.deepEqual(await service.getState(), committed);
  assert.equal(savedRemarks(committed, batchA, rowA.id), "committed");
});
