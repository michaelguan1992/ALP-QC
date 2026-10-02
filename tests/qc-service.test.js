import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";
import { createQCService } from "../core/qc-service.js";
import { validateQCState } from "../core/qc-validation.js";
import {
  ASSET_TOTAL_MAX_BYTES,
  BACKUP_MAX_BYTES,
  DOCUMENT_MAX_BYTES,
  PHOTO_MAX_BYTES,
} from "../core/qc-service.js";

const DATE = "2026-09-28";
const PNG_URL = "data:image/png;base64,iVBORw0KGgo=";
const PDF_URL = "data:application/pdf;base64,JVBERi0xLjQK";

function makeHarness() {
  const base = createMemoryQCAdapter();
  let writes = 0;
  let idNumber = 0;
  let timeNumber = 0;
  const adapter = {
    initialize: () => base.initialize(),
    readState: () => base.readState(),
    transact(mutator) {
      return base.transact((state) => {
        const outcome = mutator(state);
        writes += 1;
        return outcome;
      });
    },
    close: () => base.close(),
  };
  const service = createQCService(adapter, {
    idFactory: () => `test-id-${String(++idNumber).padStart(5, "0")}`,
    now: () => new Date(Date.UTC(2026, 8, 28, 12, 0, timeNumber++)).toISOString(),
  });
  return {
    service,
    get writes() { return writes; },
    async state() { return service.getState(); },
    async command(type, data = {}, revision) {
      const current = await service.getState();
      return service.command(type, data, revision ?? current.revision);
    },
    async mutateStoredState(mutator) {
      return base.transact((state) => {
        mutator(state);
        return { state, result: {} };
      });
    },
  };
}

async function publishAPReferences(harness) {
  await harness.command("installAPReferences", {});
  let state = await harness.state();
  for (const version of state.versions) await harness.command("publishVersion", { id: version.id });
  state = await harness.state();
  return state.versions;
}

async function createOrder(harness, variant, { number = "PO-001", orderedQty = 5000 } = {}) {
  const result = await harness.command("createOrder", {
    number,
    date: DATE,
    supplier: "Supplier One",
    notes: "",
    lines: [{ variantId: variant.id, orderedQty }],
  });
  const state = await harness.state();
  return { order: state.orders.find((order) => order.id === result.entityId), line: state.orders.find((order) => order.id === result.entityId).lines[0] };
}

async function createBatch(harness, options = {}) {
  const state = await harness.state();
  const variant = options.variant || state.variants.find((item) => item.model === "S15" && item.color === "Red");
  const versions = state.versions.filter((item) => item.familyId === variant.familyId && item.status === "published");
  const version = options.version || versions.at(-1);
  let order = options.order;
  let line = options.line;
  if (!order || !line) ({ order, line } = await createOrder(harness, variant, { number: options.orderNumber || `PO-${state.revision + 1}` }));
  const command = {
    number: options.number || `B-${state.batches.length + 1}`,
    orderId: order.id,
    lineId: line.id,
    quantity: options.quantity ?? 423,
    factory: options.factory ?? "奥途莱 AP",
    stage: options.stage ?? "OQC",
    versionId: options.useDefaultVersion ? undefined : version.id,
    date: options.date || DATE,
    recorder: options.recorder ?? "Inspector",
    notes: options.notes ?? "",
  };
  if (options.lotNumber) command.lotNumber = options.lotNumber;
  if (Object.hasOwn(options, "countForPO")) command.countForPO = options.countForPO;
  const result = await harness.command("createBatch", command);
  return { id: result.entityId, order, line, variant, version };
}

async function saveAllRows(harness, batchId) {
  const workspace = await harness.service.getBatchWorkspace(batchId);
  for (const row of workspace.rows) {
    await harness.command("saveInspection", {
      batchId,
      rowId: row.id,
      actualTimeSeconds: 1.25,
      defectiveQty: 0,
      remarks: "Checked.",
    });
  }
}

test("initialization creates only the two families and ten predefined variants", async () => {
  const harness = makeHarness();
  const state = await harness.service.initialize();

  assert.equal(state.schemaVersion, 1);
  assert.equal(state.revision, 0);
  assert.deepEqual(state.families.map((family) => family.id), ["s11-s14", "s15"]);
  assert.equal(state.variants.length, 10);
  assert.equal(state.variants.find((variant) => variant.model === "S15" && variant.color === "Red").label, "S15");
  assert.equal(state.variants.find((variant) => variant.model === "S15" && variant.color === "Yellow").label, "S15 Yellow");
  for (const collection of ["versions", "orders", "batches", "issues", "assets", "audit"]) assert.deepEqual(state[collection], []);
  assert.deepEqual(await harness.service.getState(), state);
});

test("AP references install idempotent drafts with model-specific source standards", async () => {
  const harness = makeHarness();
  await harness.service.initialize();
  const first = await harness.command("installAPReferences");
  const state = await harness.state();
  assert.equal(state.versions.length, 2);
  assert.ok(state.versions.every((version) => version.status === "draft" && version.notes.includes("AP OQC reference PDF")));
  assert.deepEqual(state.versions.map((version) => version.items.length).sort(), [4, 5]);
  assert.deepEqual(state.orders, []);
  const revision = state.revision;
  await harness.command("installAPReferences");
  assert.equal((await harness.state()).revision, revision);
  assert.equal(first.entityId, state.versions[0].id);

  const version14 = state.versions.find((version) => version.familyId === "s11-s14");
  const s11 = version14.items.find((item) => item.key === "power-test" && item.models.includes("S11"));
  const s12 = version14.items.find((item) => item.key === "power-test" && item.models.includes("S12"));
  assert.notEqual(s11.id, s12.id);
  assert.equal(s11.key, s12.key);
  assert.match(s11.specification, /32\.3–34\.0W/);
  assert.match(s12.specification, /30\.1–31\.8W/);
  assert.equal(version14.items.find((item) => item.key === "final-packaging").samplingPercent, 10);
  const version15 = state.versions.find((version) => version.familyId === "s15");
  assert.equal(version15.items.find((item) => item.key === "leak-test").samplingPercent, 10);
  assert.equal(version15.items.find((item) => item.key === "final-packaging").samplingPercent, 100);

  await harness.command("publishVersion", { id: version14.id });
  const published = (await harness.state()).versions.find((version) => version.id === version14.id);
  const beforeWrites = harness.writes;
  await assert.rejects(harness.command("saveVersion", { ...published, items: published.items }), /immutable/i);
  assert.equal(harness.writes, beforeWrites);

  const baseItem = structuredClone(version15.items[0]);
  await assert.rejects(harness.command("createVersion", {
    familyId: "s15", label: "Invalid AP incoming", sequence: 2, effectiveDate: DATE, notes: "",
    items: [{ ...baseItem, id: "invalid-item", factory: "AP", stage: "IQC" }],
  }), /AP inspections are OQC only/i);
});

test("batch creation locks the selected family/model rows and calculated sampling quantities", async () => {
  const harness = makeHarness();
  await harness.service.initialize();
  const versions = await publishAPReferences(harness);
  const version15 = versions.find((version) => version.familyId === "s15");
  const s15 = (await harness.state()).variants.find((variant) => variant.model === "S15" && variant.color === "Red");
  const batch = await createBatch(harness, { variant: s15, version: version15, quantity: 423 });
  let workspace = await harness.service.getBatchWorkspace(batch.id);
  assert.equal(workspace.rows.length, 4);
  assert.deepEqual(workspace.rows.map((row) => row.inspectedQty), [43, 43, 43, 423]);
  assert.equal(workspace.rows[0].defectiveRate, null);
  assert.equal(workspace.releaseBlockers.length, 1);

  const s11 = (await harness.state()).variants.find((variant) => variant.model === "S11" && variant.color === "Red");
  const s12 = (await harness.state()).variants.find((variant) => variant.model === "S12" && variant.color === "Red");
  const order11 = await createOrder(harness, s11, { number: "PO-S11" });
  const order12 = await createOrder(harness, s12, { number: "PO-S12" });
  const b11 = await createBatch(harness, { variant: s11, order: order11.order, line: order11.line, version: versions.find((version) => version.familyId === "s11-s14"), number: "B-S11", quantity: 100 });
  const b12 = await createBatch(harness, { variant: s12, order: order12.order, line: order12.line, version: versions.find((version) => version.familyId === "s11-s14"), number: "B-S12", quantity: 100 });
  const s11Rows = (await harness.service.getBatchWorkspace(b11.id)).rows;
  const s12Rows = (await harness.service.getBatchWorkspace(b12.id)).rows;
  assert.equal(s11Rows.length, 4);
  assert.equal(s12Rows.length, 4);
  assert.match(s11Rows[1].specification, /32\.3–34\.0W/);
  assert.match(s12Rows[1].specification, /30\.1–31\.8W/);

  await assert.rejects(harness.command("saveInspection", {
    batchId: batch.id, rowId: workspace.rows[0].id, inspectedQty: 99, defectiveQty: 0, remarks: "",
  }), /calculated .* cannot be entered/i);
  await harness.command("saveInspection", { batchId: batch.id, rowId: workspace.rows[0].id, actualTimeSeconds: 1.25, defectiveQty: 1, remarks: "One defect." });
  workspace = await harness.service.getBatchWorkspace(batch.id);
  assert.equal(workspace.rows[0].defectiveRate, 2.33);
  assert.equal(workspace.rows[0].inspectedQty, 43);
});

test("draft cloning keeps item identities and published source changes do not alter locked batches", async () => {
  const harness = makeHarness();
  await harness.service.initialize();
  const versions = await publishAPReferences(harness);
  const version15 = versions.find((version) => version.familyId === "s15");
  const variant = (await harness.state()).variants.find((item) => item.model === "S15" && item.color === "Red");
  const firstBatch = await createBatch(harness, { variant, version: version15, number: "B-OLD", quantity: 50 });
  const cloneResult = await harness.command("cloneVersion", {
    id: version15.id, label: "Reviewed S15 v2", sequence: 2, effectiveDate: DATE,
  });
  let state = await harness.state();
  let draft = state.versions.find((item) => item.id === cloneResult.entityId);
  assert.deepEqual(draft.items.map((item) => item.id), version15.items.map((item) => item.id));
  const modifiedItems = structuredClone(draft.items);
  modifiedItems[0].specification = "Updated review wording.";
  await harness.command("saveVersion", {
    id: draft.id, label: draft.label, sequence: draft.sequence, effectiveDate: draft.effectiveDate, notes: draft.notes, items: modifiedItems,
  });
  await harness.command("publishVersion", { id: draft.id });

  const oldWorkspace = await harness.service.getBatchWorkspace(firstBatch.id);
  assert.match(oldWorkspace.rows[0].specification, /Power on to check/);
  const secondBatch = await createBatch(harness, { variant, number: "B-NEW", quantity: 50, useDefaultVersion: true });
  const newWorkspace = await harness.service.getBatchWorkspace(secondBatch.id);
  assert.equal(newWorkspace.batch.versionId, draft.id);
  assert.equal(newWorkspace.rows[0].specification, "Updated review wording.");
});

test("saved row photos remain in an issue snapshot, open issues block release, and release counts once", async () => {
  const harness = makeHarness();
  await harness.service.initialize();
  await publishAPReferences(harness);
  const state = await harness.state();
  const variant = state.variants.find((item) => item.model === "S15" && item.color === "Red");
  const created = await createBatch(harness, { variant, number: "B-ISSUE", quantity: 100, lotNumber: "LOT-ISSUE" });
  await saveAllRows(harness, created.id);
  let workspace = await harness.service.getBatchWorkspace(created.id);
  const row = workspace.rows[0];
  await harness.command("addPhotos", {
    batchId: created.id, rowId: row.id, files: [{ name: "evidence.png", mimeType: "image/png", dataUrl: PNG_URL }],
  });
  const issue = await harness.command("createIssue", {
    reportedBy: "Inspector",
    title: "Abnormal pressure",
    batchId: created.id,
    rowId: row.id,
    files: [{ name: "issue-evidence.png", mimeType: "image/png", dataUrl: PNG_URL, category: "photo" }],
  });
  const duplicateIssue = await harness.command("createIssue", { reportedBy: "Inspector", title: "Should be ignored", batchId: created.id, rowId: row.id });
  assert.equal(duplicateIssue.entityId, issue.entityId);
  await harness.command("removePhoto", { batchId: created.id, rowId: row.id, assetId: (await harness.state()).batches.find((batch) => batch.id === created.id).rows[0].photoIds[0] });
  let afterRemoval = await harness.state();
  assert.equal(afterRemoval.batches.find((batch) => batch.id === created.id).rows[0].photoIds.length, 0);
  assert.equal(afterRemoval.assets.filter((asset) => asset.kind === "photo").length, 1);
  assert.equal(afterRemoval.assets.filter((asset) => asset.kind === "issueAttachment").length, 1);
  const savedIssue = afterRemoval.issues.find((item) => item.id === issue.entityId);
  assert.equal(savedIssue.sourceSnapshot.row.photoIds.length, 1);
  workspace = await harness.service.getBatchWorkspace(created.id);
  assert.equal(workspace.rows[0].photos.length, 0);
  assert.equal(workspace.rows[0].issues[0].sourceSnapshot.row.photoIds.length, 1);

  await harness.command("saveIssue", { id: issue.entityId, owner: "Lead", disposition: "Replace the seal", confirmations: ["One", "Two", "Three"] });
  await harness.command("saveIssue", { id: issue.entityId, owner: "", disposition: "", confirmations: ["", "", ""] });
  const clearedIssue = (await harness.state()).issues.find((item) => item.id === issue.entityId);
  assert.equal(clearedIssue.owner, "");
  assert.equal(clearedIssue.disposition, "");
  assert.deepEqual(clearedIssue.confirmations, ["", "", ""]);
  assert.equal(clearedIssue.status, "open", "clearing the disposition does not close the issue");

  await assert.rejects(harness.command("releaseBatch", { id: created.id }), /Close all linked issues/i);
  await harness.command("saveIssue", { id: issue.entityId, owner: "Lead", disposition: "Replace the seal", confirmations: ["One", "", "Three"] });
  await assert.rejects(harness.command("closeIssue", { id: issue.entityId }), /all three confirmation names/i);
  await harness.command("saveIssue", { id: issue.entityId, owner: "Lead", disposition: "Replace the seal", confirmations: ["One", "Two", "Three"] });
  await harness.command("addDiscussion", { id: issue.entityId, text: "Replacement verified.", authorName: "Inspector" });
  await harness.command("closeIssue", { id: issue.entityId });
  await assert.rejects(harness.command("addDiscussion", { id: issue.entityId, text: "Late note.", authorName: "Inspector" }), /read-only/i);
  const progressBefore = await harness.service.getPurchaseOrderProgress(created.order.id);
  assert.equal(progressBefore.lines[0].releasedQty, 0);
  await harness.command("releaseBatch", { id: created.id });
  const revisionAfterRelease = (await harness.state()).revision;
  await harness.command("releaseBatch", { id: created.id });
  assert.equal((await harness.state()).revision, revisionAfterRelease);
  const progressAfter = await harness.service.getPurchaseOrderProgress(created.order.id);
  assert.equal(progressAfter.lines[0].releasedQty, 100);
  assert.equal(progressAfter.lines[0].remainingQty, 4900);
  assert.equal(progressAfter.lines[0].batches.length, 1);
});

test("released operational batch attachments are immutable", async () => {
  const harness = makeHarness();
  await harness.service.initialize();
  await publishAPReferences(harness);
  const state = await harness.state();
  const variant = state.variants.find((item) => item.model === "S15" && item.color === "Red");
  const created = await createBatch(harness, { variant, number: "B-ATTACH-LOCK", quantity: 20, lotNumber: "LOT-ATTACH-LOCK" });
  await saveAllRows(harness, created.id);
  await harness.command("addBatchAttachment", { batchId: created.id, name: "release-note.pdf", mimeType: "application/pdf", dataUrl: PDF_URL });
  const beforeRelease = await harness.state();
  const batch = beforeRelease.batches.find((item) => item.id === created.id);
  await harness.command("releaseBatch", { id: created.id });
  await assert.rejects(harness.command("addBatchAttachment", { batchId: created.id, name: "late-note.pdf", dataUrl: PDF_URL }), /released.*attachments are read-only/i);
  await assert.rejects(harness.command("removeBatchAttachment", { batchId: created.id, assetId: batch.attachmentIds[0] }), /released.*attachments are read-only/i);
  const afterRejectedChanges = await harness.state();
  assert.deepEqual(afterRejectedChanges.batches.find((item) => item.id === created.id).attachmentIds, batch.attachmentIds);
  assert.equal(afterRejectedChanges.assets.length, beforeRelease.assets.length);
});

test("release validates every row, deduplicates physical lots, and counts OQC batches regardless of legacy input flags", async () => {
  const harness = makeHarness();
  await harness.service.initialize();
  await publishAPReferences(harness);
  const state = await harness.state();
  const variant = state.variants.find((item) => item.model === "S15" && item.color === "Red");
  const first = await createBatch(harness, { variant, number: "B-LOT-1", quantity: 25, lotNumber: "PHYS-1" });
  assert.equal((await harness.state()).batches.find((batch) => batch.id === first.id).countForPO, true);
  await assert.rejects(harness.command("releaseBatch", { id: first.id }), /Complete all .* inspection rows.*remain incomplete/i);
  await saveAllRows(harness, first.id);
  await harness.command("releaseBatch", { id: first.id });

  const duplicateLot = await createBatch(harness, { variant, order: first.order, line: first.line, number: "B-LOT-2", quantity: 10, lotNumber: "phys-1" });
  await saveAllRows(harness, duplicateLot.id);
  await assert.rejects(harness.command("releaseBatch", { id: duplicateLot.id }), /already counted/i);
  const secondOrder = await createOrder(harness, variant, { number: "PO-NONCOUNT" });
  const legacyOptOut = await createBatch(harness, {
    variant, order: secondOrder.order, line: secondOrder.line, number: "B-LEGACY-OPTOUT", quantity: 5, countForPO: false,
  });
  assert.equal((await harness.state()).batches.find((batch) => batch.id === legacyOptOut.id).countForPO, true);
  await saveAllRows(harness, legacyOptOut.id);
  await harness.command("releaseBatch", { id: legacyOptOut.id });
  const progress = await harness.service.getPurchaseOrderProgress(secondOrder.order.id);
  assert.equal(progress.lines[0].releasedQty, 5);
  assert.deepEqual(progress.lines[0].batches.map((batch) => batch.id), [legacyOptOut.id]);
});

test("IQC remains excluded while saved legacy OQC false flags stay unchanged and readable", async () => {
  const harness = makeHarness();
  await harness.service.initialize();
  const versions = await publishAPReferences(harness);
  const s15Version = versions.find((version) => version.familyId === "s15");
  const iqcVersionResult = await harness.command("createVersion", {
    familyId: "s15",
    label: "Factory B incoming check",
    sequence: 2,
    effectiveDate: DATE,
    notes: "",
    items: [{
      ...s15Version.items[0],
      id: "factory-b-iqc-s15",
      key: "factory-b-incoming-check",
      no: 1,
      factory: "Factory B",
      stage: "IQC",
      models: ["S15"],
    }],
  });
  await harness.command("publishVersion", { id: iqcVersionResult.entityId });
  const state = await harness.state();
  const variant = state.variants.find((item) => item.model === "S15" && item.color === "Red");
  const iqcOrder = await createOrder(harness, variant, { number: "PO-IQC-NO-COUNT" });
  const iqcVersion = state.versions.find((version) => version.id === iqcVersionResult.entityId);
  const iqcBatch = await createBatch(harness, {
    variant,
    order: iqcOrder.order,
    line: iqcOrder.line,
    version: iqcVersion,
    number: "B-IQC-NO-COUNT",
    quantity: 12,
    factory: "Factory B",
    stage: "IQC",
    countForPO: true,
  });
  assert.equal((await harness.state()).batches.find((batch) => batch.id === iqcBatch.id).countForPO, false);
  await saveAllRows(harness, iqcBatch.id);
  await harness.command("releaseBatch", { id: iqcBatch.id });
  assert.equal((await harness.service.getPurchaseOrderProgress(iqcOrder.order.id)).lines[0].releasedQty, 0);

  const legacyOrder = await createOrder(harness, variant, { number: "PO-LEGACY-FALSE" });
  const legacyBatch = await createBatch(harness, {
    variant,
    order: legacyOrder.order,
    line: legacyOrder.line,
    version: s15Version,
    number: "B-LEGACY-FALSE",
    quantity: 19,
  });
  await harness.mutateStoredState((stored) => {
    stored.batches.find((batch) => batch.id === legacyBatch.id).countForPO = false;
  });
  const savedState = await harness.state();
  assert.equal(savedState.batches.find((batch) => batch.id === legacyBatch.id).countForPO, false);
  validateQCState(savedState);
  const backup = await harness.service.exportBackup();
  assert.equal(backup.state.batches.find((batch) => batch.id === legacyBatch.id).countForPO, false);
  await saveAllRows(harness, legacyBatch.id);
  await harness.command("releaseBatch", { id: legacyBatch.id });
  assert.equal((await harness.state()).batches.find((batch) => batch.id === legacyBatch.id).countForPO, false);
  assert.equal((await harness.service.getPurchaseOrderProgress(legacyOrder.order.id)).lines[0].releasedQty, 0);
});

test("purchase order progress keeps variants separate and reports shortage and overdelivery", async () => {
  const harness = makeHarness();
  await harness.service.initialize();
  await publishAPReferences(harness);
  const state = await harness.state();
  const red = state.variants.find((item) => item.model === "S15" && item.color === "Red");
  const yellow = state.variants.find((item) => item.model === "S15" && item.color === "Yellow");
  const orderResult = await harness.command("createOrder", {
    number: "PO-COLOR-SPLIT", date: DATE, supplier: "Supplier One", notes: "",
    lines: [{ variantId: red.id, orderedQty: 20 }, { variantId: yellow.id, orderedQty: 10 }],
  });
  const order = (await harness.state()).orders.find((item) => item.id === orderResult.entityId);
  const redBatch = await createBatch(harness, {
    variant: red, order, line: order.lines.find((line) => line.variantId === red.id),
    number: "B-RED-25", quantity: 25, lotNumber: "LOT-RED",
  });
  const yellowBatch = await createBatch(harness, {
    variant: yellow, order, line: order.lines.find((line) => line.variantId === yellow.id),
    number: "B-YELLOW-5", quantity: 5, lotNumber: "LOT-YELLOW",
  });
  await saveAllRows(harness, redBatch.id);
  await saveAllRows(harness, yellowBatch.id);
  await harness.command("releaseBatch", { id: redBatch.id });
  await harness.command("releaseBatch", { id: yellowBatch.id });

  const progress = await harness.service.getPurchaseOrderProgress(order.id);
  const redLine = progress.lines.find((line) => line.variantId === red.id);
  const yellowLine = progress.lines.find((line) => line.variantId === yellow.id);
  assert.equal(redLine.releasedQty, 25);
  assert.equal(redLine.remainingQty, 0);
  assert.equal(redLine.excessQty, 5);
  assert.equal(yellowLine.releasedQty, 5);
  assert.equal(yellowLine.remainingQty, 5);
  assert.equal(yellowLine.excessQty, 0);
});

test("row photos stay isolated by row and batch, and history uses only saved earlier matching results", async () => {
  const harness = makeHarness();
  await harness.service.initialize();
  await publishAPReferences(harness);
  const state = await harness.state();
  const red = state.variants.find((item) => item.model === "S15" && item.color === "Red");
  const older = await createBatch(harness, { variant: red, number: "B-HISTORY-OLD", quantity: 100, lotNumber: "LOT-OLD", date: "2026-09-20" });
  let workspace = await harness.service.getBatchWorkspace(older.id);
  const oldRow = workspace.rows[0];
  await harness.command("saveInspection", { batchId: older.id, rowId: oldRow.id, actualTimeSeconds: 1.25, defectiveQty: 1, remarks: "Old saved result." });
  const unsaved = await createBatch(harness, { variant: red, number: "B-HISTORY-UNSAVED", quantity: 100, lotNumber: "LOT-UNSAVED", date: "2026-09-22" });
  const yellow = (await harness.state()).variants.find((item) => item.model === "S15" && item.color === "Yellow");
  const otherVariant = await createBatch(harness, { variant: yellow, number: "B-HISTORY-YELLOW", quantity: 100, lotNumber: "LOT-YELLOW-HISTORY", date: "2026-09-23" });
  await harness.command("saveInspection", {
    batchId: otherVariant.id,
    rowId: (await harness.service.getBatchWorkspace(otherVariant.id)).rows[0].id,
    actualTimeSeconds: 1.25,
    defectiveQty: 1,
    remarks: "Different variant.",
  });
  const current = await createBatch(harness, { variant: red, number: "B-HISTORY-CURRENT", quantity: 100, lotNumber: "LOT-CURRENT", date: "2026-09-28" });
  workspace = await harness.service.getBatchWorkspace(current.id);
  const matchingHistory = workspace.rows[0].history;
  assert.equal(matchingHistory.length, 1);
  assert.equal(matchingHistory[0].batchId, older.id);
  assert.equal(matchingHistory[0].rate, 10);
  assert.notEqual(matchingHistory[0].batchId, unsaved.id);

  const rowA = workspace.rows[0];
  const rowB = workspace.rows[1];
  await harness.command("addPhotos", { batchId: current.id, rowId: rowA.id, files: [{ name: "row-a.png", mimeType: "image/png", dataUrl: PNG_URL }] });
  await harness.command("addPhotos", { batchId: current.id, rowId: rowB.id, files: [{ name: "row-b.png", mimeType: "image/png", dataUrl: PNG_URL }] });
  const nextBatch = await createBatch(harness, { variant: red, number: "B-PHOTO-NEXT", quantity: 100, lotNumber: "LOT-NEXT", date: "2026-09-29" });
  const nextWorkspace = await harness.service.getBatchWorkspace(nextBatch.id);
  assert.equal((await harness.service.getBatchWorkspace(current.id)).rows[0].photos.length, 1);
  assert.equal((await harness.service.getBatchWorkspace(current.id)).rows[1].photos.length, 1);
  assert.equal(nextWorkspace.rows[0].photos.length, 0);
});

test("backup import validates, merges additively, restores a fresh inactive variant, and rejects conflicts atomically", async () => {
  const source = makeHarness();
  await source.service.initialize();
  await publishAPReferences(source);
  let sourceState = await source.state();
  const variant = sourceState.variants.find((item) => item.model === "S15" && item.color === "Red");
  const created = await createBatch(source, { variant, number: "B-BACKUP", quantity: 25, lotNumber: "BACKUP-LOT" });
  await source.command("addDocument", { name: "source.pdf", mimeType: "application/pdf", dataUrl: PDF_URL, versionId: created.version.id });
  await source.command("setVariantActive", { id: variant.id, active: false });
  const backup = await source.service.exportBackup();

  const target = makeHarness();
  await target.service.initialize();
  const result = await target.service.importBackup(backup, 0);
  assert.equal(result.counts.adoptedSeedVariants, 1);
  assert.ok(result.counts.added.versions > 0);
  let restored = await target.state();
  assert.equal(restored.variants.find((item) => item.id === variant.id).active, false);
  assert.equal(restored.batches.length, 1);
  assert.equal(restored.assets[0].name, "source.pdf");

  const revision = restored.revision;
  const identical = await target.service.importBackup(backup, revision);
  assert.equal(identical.changed, false);
  assert.equal(identical.revision, revision);

  const conflicting = structuredClone(backup);
  conflicting.state.orders[0].supplier = "Conflicting supplier";
  const beforeConflict = await target.state();
  const beforeWrites = target.writes;
  await assert.rejects(target.service.importBackup(conflicting, beforeConflict.revision), /conflicts with existing orders/i);
  assert.equal(target.writes, beforeWrites);
  assert.deepEqual(await target.state(), beforeConflict);

  const dangling = structuredClone(backup);
  dangling.state.batches[0].lineId = "missing-line";
  await assert.rejects(target.service.importBackup(dangling, beforeConflict.revision), /refers to a line outside/i);
  assert.deepEqual(await target.state(), beforeConflict);
});

test("backup validation rejects malformed issue evidence and unsafe library assets", async () => {
  const harness = makeHarness();
  await harness.service.initialize();
  await publishAPReferences(harness);
  const variant = (await harness.state()).variants.find((item) => item.model === "S15" && item.color === "Red");
  const batch = await createBatch(harness, { variant, number: "B-INVALID-BACKUP", quantity: 20 });
  await saveAllRows(harness, batch.id);
  const row = (await harness.service.getBatchWorkspace(batch.id)).rows[0];
  const issue = await harness.command("createIssue", {
    reportedBy: "Inspector",
    title: "Source issue",
    batchId: batch.id,
    rowId: row.id,
    files: [{ name: "source-issue.png", mimeType: "image/png", dataUrl: PNG_URL, category: "photo" }],
  });
  const backup = await harness.service.exportBackup();

  const badRate = structuredClone(backup);
  badRate.state.issues.find((item) => item.id === issue.entityId).sourceSnapshot.row.defectiveRate = 99;
  await assert.rejects(harness.service.importBackup(badRate, (await harness.state()).revision), /invalid defective rate/i);

  const badSnapshotRef = structuredClone(backup);
  badSnapshotRef.state.issues.find((item) => item.id === issue.entityId).sourceSnapshot.versionId = "foreign-version";
  await assert.rejects(harness.service.importBackup(badSnapshotRef, (await harness.state()).revision), /invalid design version/i);

  const beforeWrites = harness.writes;
  await assert.rejects(harness.command("addDocument", {
    name: "payload.html", mimeType: "text/html", dataUrl: "data:text/html;base64,PGI+",
  }), /supported file types/i);
  assert.equal(harness.writes, beforeWrites);
  assert.equal(PHOTO_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(DOCUMENT_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(ASSET_TOTAL_MAX_BYTES, 30 * 1024 * 1024);
  assert.equal(BACKUP_MAX_BYTES, 50 * 1024 * 1024);
});

test("failed commands and stale revisions do not commit any state changes", async () => {
  const harness = makeHarness();
  await harness.service.initialize();
  const state = await harness.state();
  const writesBefore = harness.writes;
  await assert.rejects(harness.command("createOrder", {
    number: "PO-EMPTY", date: DATE, supplier: "", notes: "", lines: [],
  }), /at least one product variant line/i);
  assert.equal(harness.writes, writesBefore);
  const variant = state.variants[0];
  await harness.command("createOrder", {
    number: "PO-REV", date: DATE, supplier: "", notes: "", lines: [{ variantId: variant.id, orderedQty: 1 }],
  }, state.revision);
  const afterWrite = await harness.state();
  const beforeStale = harness.writes;
  await assert.rejects(harness.command("setVariantActive", { id: variant.id, active: false }, state.revision), /changed since your last view/i);
  assert.equal(harness.writes, beforeStale);
  assert.equal((await harness.state()).revision, afterWrite.revision);
});

test("an explicit 0% standard remains a zero-sample row with a null rate", async () => {
  const harness = makeHarness();
  await harness.service.initialize();
  const s15Source = await harness.command("installAPReferences");
  const version = (await harness.state()).versions.find((item) => item.familyId === "s15");
  const items = structuredClone(version.items);
  items[0].samplingPercent = 0;
  await harness.command("saveVersion", {
    id: version.id, label: version.label, sequence: version.sequence, effectiveDate: version.effectiveDate, notes: version.notes, items,
  });
  await harness.command("publishVersion", { id: version.id });
  const variant = (await harness.state()).variants.find((item) => item.model === "S15" && item.color === "Red");
  const batch = await createBatch(harness, { variant, version: (await harness.state()).versions.find((item) => item.id === version.id), number: "B-ZERO", quantity: 100 });
  const row = (await harness.service.getBatchWorkspace(batch.id)).rows[0];
  assert.equal(row.inspectedQty, 0);
  await harness.command("saveInspection", { batchId: batch.id, rowId: row.id, actualTimeSeconds: 0, defectiveQty: 0, remarks: "Not sampled." });
  assert.equal((await harness.service.getBatchWorkspace(batch.id)).rows[0].defectiveRate, null);
  assert.ok(s15Source.entityId);
});
