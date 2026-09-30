import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";
import { createQCService } from "../core/qc-service.js";
import { importLarkVersionHistory } from "../core/qc-lark-versions.js";
import { supersedeOutdatedAPVersions } from "../core/qc-standards.js";
import { mergeSupersededAPVersionDuplicates } from "../core/qc-version-merge.js";
import { validateBackup, validateQCState } from "../core/qc-validation.js";

const LARK_PACKAGE = JSON.parse(readFileSync(new URL("../data/lark-import/version-history.v1.json", import.meta.url), "utf8"));
const PDF_PACKAGE = JSON.parse(readFileSync(new URL("../data/pdf-import/masterqc-history.json", import.meta.url), "utf8"));
const TARGETS = [
  { id: "history-version-28472835a7113e44c0de60c15607f7cdf7fc82bc", familyId: "s11-s14", targetVersionId: "lark:recvscXCuZAHXR:s11-s14" },
  { id: "history-version-cac6c73b7872b4fdf9493ec4c66d4509e12b9e0c", familyId: "s15", targetVersionId: "lark:recvscXCuZAHXR:s15" },
];
const PDF_DATA_URL = "data:application/pdf;base64,JVBERi0xLjQK";
const NOW = "2026-09-29T12:00:00.000Z";

function makeService() {
  let id = 0;
  return createQCService(createMemoryQCAdapter(), {
    idFactory: () => `merge-test-${String(++id).padStart(5, "0")}`,
    now: () => NOW,
  });
}

async function run(service, type, data = {}) {
  const state = await service.getState();
  return service.command(type, data, state.revision);
}

function makePDFPackageWithVersions() {
  return {
    format: PDF_PACKAGE.format,
    formatVersion: PDF_PACKAGE.formatVersion,
    sources: [],
    inspections: [],
    assets: [],
    versions: TARGETS.map(({ id }) => structuredClone(PDF_PACKAGE.versions.find((version) => version.id === id))),
    anomalies: [],
  };
}

async function makePreMergeServiceState() {
  const service = makeService();
  await service.initialize();
  await service.importHistory(makePDFPackageWithVersions(), 0);
  for (const target of TARGETS) {
    await run(service, "addDocument", {
      name: `${target.familyId}-reference.pdf`,
      mimeType: "application/pdf",
      dataUrl: PDF_DATA_URL,
      versionId: target.id,
    });
  }
  return { service, state: await service.getState() };
}

function makeBackup(state) {
  const backup = {
    format: "masterqc-web-backup",
    formatVersion: 1,
    exportedAt: NOW,
    state: structuredClone(state),
  };
  validateBackup(backup);
  return backup;
}

test("initialization merge keeps one recorded entry, relinks original PDFs, and preserves source facts", async () => {
  const { service, state: before } = await makePreMergeServiceState();
  const expectedCanonicalState = structuredClone(before);
  importLarkVersionHistory(expectedCanonicalState, LARK_PACKAGE);
  const duplicateBeforeCorrection = structuredClone(before.versions);
  const sourceHistory = structuredClone({ batches: before.batches, issues: before.issues, history: before.history });
  const assetsBefore = structuredClone(before.assets);

  const imported = await run(service, "importLarkVersionHistory", { package: LARK_PACKAGE });
  const after = await service.getState();

  assert.equal(imported.counts.mergedVersions, 2);
  assert.equal(after.versions.length, before.versions.length + imported.counts.addedVersions - TARGETS.length);
  assert.equal(after.versionMergeEvidence.length, 2);
  for (const target of TARGETS) {
    assert.equal(after.versions.filter((version) => version.id === target.id).length, 0);
    const canonical = after.versions.find((version) => version.id === target.targetVersionId);
    assert.deepEqual(canonical, expectedCanonicalState.versions.find((version) => version.id === target.targetVersionId));
    const original = duplicateBeforeCorrection.find((version) => version.id === target.id);
    const correctedOriginal = structuredClone(original);
    supersedeOutdatedAPVersions({ versions: [correctedOriginal] });
    assert.deepEqual(after.versionMergeEvidence.find((entry) => entry.id === target.id), {
      id: target.id,
      targetVersionId: target.targetVersionId,
      version: correctedOriginal,
    });
    const movedAsset = after.assets.find((asset) => asset.name === `${target.familyId}-reference.pdf`);
    assert.equal(movedAsset.versionId, target.targetVersionId);
  }
  assert.deepEqual({ batches: after.batches, issues: after.issues, history: after.history }, sourceHistory);
  for (const previous of assetsBefore) {
    const current = after.assets.find((asset) => asset.id === previous.id);
    const expected = structuredClone(previous);
    const target = TARGETS.find((candidate) => candidate.id === expected.versionId);
    if (target) expected.versionId = target.targetVersionId;
    assert.deepEqual(current, expected);
  }
  validateQCState(after);

  const revision = after.revision;
  const repeatedHistory = await service.importHistory(makePDFPackageWithVersions(), revision);
  assert.equal(repeatedHistory.changed, false);
  assert.equal(repeatedHistory.revision, revision);
  assert.deepEqual(await service.getState(), after);
  assert.deepEqual(await service.initialize(), after, "a second initialization must not add an audit entry or revision");
});

test("legacy backups with both exact records merge additively and repeat restore is a no-op", async () => {
  const { service, state: beforeLarkImport } = await makePreMergeServiceState();
  const legacyCombined = structuredClone(beforeLarkImport);
  const legacyImport = importLarkVersionHistory(legacyCombined, LARK_PACKAGE);
  const oldBackup = makeBackup(legacyCombined);

  const restoredService = makeService();
  await restoredService.initialize();
  await restoredService.importBackup(oldBackup, 0);
  const restored = await restoredService.getState();
  assert.equal(restored.versions.length, beforeLarkImport.versions.length + legacyImport.counts.addedVersions - TARGETS.length);
  assert.equal(restored.versionMergeEvidence.length, 2);
  for (const target of TARGETS) {
    assert.equal(restored.versions.some((version) => version.id === target.id), false);
    assert.equal(restored.assets.find((asset) => asset.name === `${target.familyId}-reference.pdf`).versionId, target.targetVersionId);
  }
  validateQCState(restored);

  const repeat = await restoredService.importBackup(oldBackup, restored.revision);
  assert.equal(repeat.changed, false);
  assert.equal(repeat.revision, restored.revision);
  assert.deepEqual(await restoredService.getState(), restored);

  const exported = await restoredService.exportBackup();
  validateBackup(exported);
  const roundTripService = makeService();
  await roundTripService.initialize();
  await roundTripService.importBackup(exported, 0);
  const roundTrip = await roundTripService.getState();
  assert.deepEqual(roundTrip.versionMergeEvidence, restored.versionMergeEvidence);
  for (const target of TARGETS) {
    assert.deepEqual(
      roundTrip.versions.find((version) => version.id === target.targetVersionId),
      restored.versions.find((version) => version.id === target.targetVersionId),
    );
  }

  const oldPDFOnlyTarget = await makePreMergeServiceState();
  await oldPDFOnlyTarget.service.importBackup(exported, oldPDFOnlyTarget.state.revision);
  const oldPDFOnlyRestored = await oldPDFOnlyTarget.service.getState();
  assert.equal(oldPDFOnlyRestored.versionMergeEvidence.length, 2);
  for (const target of TARGETS) {
    assert.equal(oldPDFOnlyRestored.versions.some((version) => version.id === target.id), false);
    assert.equal(
      oldPDFOnlyRestored.assets.find((asset) => asset.name === `${target.familyId}-reference.pdf`).versionId,
      target.targetVersionId,
    );
  }
  validateQCState(oldPDFOnlyRestored);
});

test("PDF-only legacy backups remain valid while a matching canonical source is absent", async () => {
  const { state } = await makePreMergeServiceState();
  const oldBackup = makeBackup(state);
  const restoredService = makeService();
  await restoredService.initialize();
  await restoredService.importBackup(oldBackup, 0);
  const restored = await restoredService.getState();

  assert.equal(restored.versionMergeEvidence, undefined);
  assert.equal(restored.versions.filter((version) => version.status === "superseded").length, 2);
  assert.equal(restored.versions.length, 2);
  validateQCState(restored);
});

test("merge preflight skips missing canonicals and rejects malformed targets or locked references without partial mutation", async () => {
  const { state: before } = await makePreMergeServiceState();
  const pdfOnly = structuredClone(before);
  supersedeOutdatedAPVersions(pdfOnly);
  const missingCanonicalResult = mergeSupersededAPVersionDuplicates(pdfOnly);
  assert.equal(missingCanonicalResult.changed, false);
  assert.deepEqual(pdfOnly.versionMergeEvidence, undefined);
  assert.equal(pdfOnly.versions.length, 2);

  const malformed = structuredClone(before);
  importLarkVersionHistory(malformed, LARK_PACKAGE);
  supersedeOutdatedAPVersions(malformed);
  malformed.versions.find((version) => version.id === TARGETS[1].targetVersionId).status = "published";
  const malformedBeforeMerge = structuredClone(malformed);
  assert.throws(() => mergeSupersededAPVersionDuplicates(malformed), /does not match the verified/i);
  assert.deepEqual(malformed, malformedBeforeMerge, "a failed second-family preflight must not merge the first family");

  const locked = structuredClone(before);
  importLarkVersionHistory(locked, LARK_PACKAGE);
  supersedeOutdatedAPVersions(locked);
  locked.batches.push({ id: "locked-batch", versionId: TARGETS[0].id });
  const lockedBeforeMerge = structuredClone(locked);
  assert.throws(() => mergeSupersededAPVersionDuplicates(locked), /locked by a batch/i);
  assert.deepEqual(locked, lockedBeforeMerge);
});
