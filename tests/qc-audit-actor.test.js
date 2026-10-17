import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createQCService } from "../core/qc-service.js";
import { addAudit, createInitialQCState, isValidAuditActor } from "../core/qc-domain.js";
import { validateBackup, validateQCState } from "../core/qc-validation.js";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";

const DATE = "2026-10-17";
const PDF_BYTES = Buffer.from("%PDF-1.4\n", "utf8");
const PDF_URL = `data:application/pdf;base64,${PDF_BYTES.toString("base64")}`;

function makeService(prefix = "actor") {
  let idNumber = 0;
  let timeNumber = 0;
  return createQCService(createMemoryQCAdapter(), {
    idFactory: () => `${prefix}-${String(++idNumber).padStart(5, "0")}`,
    now: () => new Date(Date.UTC(2026, 9, 17, 9, 0, timeNumber++)).toISOString(),
  });
}

function orderData(number, variantId) {
  return {
    number,
    date: DATE,
    supplier: "Actor supplier",
    notes: "",
    lines: [{ variantId, orderedQty: 10 }],
  };
}

function redVariantId(initial) {
  return initial.variants.find((variant) => variant.model === "S15" && variant.color === "Red").id;
}

function auditEntryFor(state, entityId, action) {
  return state.audit.find((entry) => entry.entityId === entityId && entry.action === action);
}

function historicalPackage() {
  const sourceId = "actor-history-source";
  const assetId = "actor-history-pdf";
  const inspectionId = "actor-history-inspection";
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
      id: inspectionId,
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

test("isValidAuditActor accepts 1 to 80 characters without control characters", () => {
  assert.equal(isValidAuditActor("a"), true);
  assert.equal(isValidAuditActor("Michael Guan"), true);
  assert.equal(isValidAuditActor("x".repeat(80)), true);
  assert.equal(isValidAuditActor("x".repeat(81)), false);
  assert.equal(isValidAuditActor(""), false);
  assert.equal(isValidAuditActor("   "), false, "blank names are not names");
  assert.equal(isValidAuditActor("bad\u0007name"), false);
  assert.equal(isValidAuditActor("line\nbreak"), false);
  assert.equal(isValidAuditActor("del\u007f"), false);
  assert.equal(isValidAuditActor(null), false);
  assert.equal(isValidAuditActor(42), false);
});

test("addAudit stores an actor only when a valid one is supplied", () => {
  const state = createInitialQCState();
  let idNumber = 0;
  const options = {
    idFactory: () => `audit-${++idNumber}`,
    now: () => "2026-10-17T09:00:00.000Z",
    action: "testAction",
    entityId: "entity-1",
    summary: "A test entry.",
  };
  addAudit(state, options);
  addAudit(state, { ...options, actor: null });
  addAudit(state, { ...options, actor: undefined });
  addAudit(state, { ...options, actor: "alice" });
  addAudit(state, { ...options, actor: "x".repeat(80) });

  assert.equal(Object.hasOwn(state.audit[0], "actor"), false, "an omitted actor leaves no field");
  assert.equal(Object.hasOwn(state.audit[1], "actor"), false, "a null actor leaves no field");
  assert.equal(Object.hasOwn(state.audit[2], "actor"), false, "an undefined actor leaves no field");
  assert.equal(state.audit[3].actor, "alice");
  assert.equal(state.audit[4].actor, "x".repeat(80));

  for (const invalid of ["", "   ", "x".repeat(81), "bad\u0001name", 7]) {
    assert.throws(() => addAudit(state, { ...options, actor: invalid }), /Audit actor must be 1 to 80 characters/);
  }
  assert.equal(state.audit.length, 5, "a rejected actor adds no entry");
});

test("a command with an actor records it on its audit entry, and a command without one records nothing", async () => {
  const service = makeService();
  const initial = await service.initialize();
  const variantId = redVariantId(initial);

  const withActor = await service.command("createOrder", orderData("PO-ACTOR-1", variantId), initial.revision, { actor: "alice" });
  const withoutActor = await service.command("createOrder", orderData("PO-ACTOR-2", variantId), withActor.revision);
  const withNullActor = await service.command("createOrder", orderData("PO-ACTOR-3", variantId), withoutActor.revision, { actor: null });

  const state = await service.getState();
  const attributed = auditEntryFor(state, withActor.entityId, "createOrder");
  const unattributed = auditEntryFor(state, withoutActor.entityId, "createOrder");
  const nullAttributed = auditEntryFor(state, withNullActor.entityId, "createOrder");
  assert.equal(attributed.actor, "alice");
  assert.equal(Object.hasOwn(unattributed, "actor"), false);
  assert.equal(Object.hasOwn(nullAttributed, "actor"), false);
  assert.deepEqual(Object.keys(unattributed), ["id", "at", "action", "entityId", "summary"]);
});

test("a command refuses an invalid actor before it writes anything", async () => {
  const service = makeService();
  const initial = await service.initialize();
  const variantId = redVariantId(initial);

  await assert.rejects(
    service.command("createOrder", orderData("PO-BAD-ACTOR", variantId), initial.revision, { actor: "x".repeat(81) }),
    /Audit actor must be 1 to 80 characters without control characters/,
  );
  const state = await service.getState();
  assert.equal(state.revision, initial.revision);
  assert.equal(state.orders.length, 0);
});

test("the aggregate validator accepts entries without an actor and rejects invalid actors", () => {
  const state = createInitialQCState();
  state.audit.push({ id: "old-entry", at: "2026-10-01T00:00:00.000Z", action: "createOrder", entityId: "order-1", summary: "Older entry." });
  assert.doesNotThrow(() => validateQCState(state));

  state.audit.push({ id: "named-entry", at: "2026-10-02T00:00:00.000Z", action: "createOrder", entityId: "order-2", summary: "Named.", actor: "bob" });
  assert.doesNotThrow(() => validateQCState(state));

  for (const actor of ["x".repeat(81), "", "tab\tname", null, 12]) {
    const candidate = structuredClone(state);
    candidate.audit[1].actor = actor;
    assert.throws(() => validateQCState(candidate), /Audit actor must be 1 to 80 characters/, JSON.stringify(actor));
  }
});

test("backups keep each entry's actor, and an import marks only the entries it creates", async () => {
  const source = makeService("source");
  const initial = await source.initialize();
  const variantId = redVariantId(initial);
  const alice = await source.command("createOrder", orderData("PO-SOURCE-A", variantId), initial.revision, { actor: "alice" });
  const anonymous = await source.command("createOrder", orderData("PO-SOURCE-B", variantId), alice.revision);
  const backup = await source.exportBackup();
  validateBackup(backup);
  assert.ok(backup.state.audit.some((entry) => entry.actor === "alice"), "the export keeps the actor");
  assert.equal(Object.hasOwn(backup.state.audit.find((entry) => entry.entityId === anonymous.entityId), "actor"), false);

  const target = makeService("target");
  const targetInitial = await target.initialize();
  const restored = await target.importBackup(backup, targetInitial.revision, { actor: "bob" });
  assert.equal(restored.changed, true);
  const state = await target.getState();

  for (const entry of backup.state.audit) {
    const copied = state.audit.find((candidate) => candidate.id === entry.id);
    assert.ok(copied, `copied entry ${entry.id}`);
    assert.equal(copied.actor, entry.actor, `entry ${entry.id} keeps its original actor data`);
  }
  const importEntry = state.audit.find((entry) => entry.action === "importBackup");
  assert.equal(importEntry.actor, "bob", "the import entry records the operator");
});

test("an import without an operator adds no actor to its own audit entry", async () => {
  const source = makeService("plain-source");
  const initial = await source.initialize();
  await source.command("createOrder", orderData("PO-PLAIN", redVariantId(initial)), initial.revision);
  const backup = await source.exportBackup();

  const target = makeService("plain-target");
  const targetInitial = await target.initialize();
  await target.importBackup(backup, targetInitial.revision);
  const state = await target.getState();
  const importEntry = state.audit.find((entry) => entry.action === "importBackup");
  assert.ok(importEntry);
  assert.equal(Object.hasOwn(importEntry, "actor"), false);
});

test("an earlier-format backup without actor fields restores, and an operator names only the new import entry", async () => {
  const source = makeService("legacy-source");
  const initial = await source.initialize();
  await source.command("createOrder", orderData("PO-LEGACY", redVariantId(initial)), initial.revision);
  const legacy = await source.exportBackup();
  for (const entry of legacy.state.audit) delete entry.actor;

  const target = makeService("legacy-target");
  const targetInitial = await target.initialize();
  await target.importBackup(legacy, targetInitial.revision, { actor: "carol" });
  const state = await target.getState();
  const copiedEntries = state.audit.filter((entry) => legacy.state.audit.some((copy) => copy.id === entry.id));
  assert.ok(copiedEntries.length > 0);
  for (const entry of copiedEntries) assert.equal(Object.hasOwn(entry, "actor"), false);
  assert.equal(state.audit.find((entry) => entry.action === "importBackup").actor, "carol");
});

test("a history import records the operator on the audit entries it creates", async () => {
  const service = makeService("history");
  const initial = await service.initialize();
  const outcome = await service.importHistory(historicalPackage(), initial.revision, { actor: "dana" });
  assert.equal(outcome.changed, true);
  const state = await service.getState();
  const importEntry = state.audit.find((entry) => entry.action === "importHistory");
  assert.ok(importEntry, "the import writes its audit entry");
  assert.equal(importEntry.actor, "dana");
});

test("a history import without an operator leaves its audit entry unattributed", async () => {
  const service = makeService("history-plain");
  const initial = await service.initialize();
  await service.importHistory(historicalPackage(), initial.revision);
  const state = await service.getState();
  const importEntry = state.audit.find((entry) => entry.action === "importHistory");
  assert.equal(Object.hasOwn(importEntry, "actor"), false);
});
