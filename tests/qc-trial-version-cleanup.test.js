import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createInitialQCState } from "../core/qc-domain.js";
import {
  isAuthorizedS15TrialPackageEntry,
  isAuthorizedS15TrialVersion,
  removeAuthorizedS15TrialVersion,
  S15_TRIAL_VERSION_ID,
} from "../core/qc-version-cleanup.js";
import { importLarkVersionHistory } from "../core/qc-lark-versions.js";
import { getBatchVersions } from "../core/qc-batch-versions.js";
import { createQCService } from "../core/qc-service.js";
import { validateQCState } from "../core/qc-validation.js";
import { createMemoryQCAdapter } from "../storage/memory-qc-adapter.js";

const LARK_PACKAGE = JSON.parse(readFileSync(new URL("../data/lark-import/version-history.v1.json", import.meta.url), "utf8"));

function importedState() {
  const state = createInitialQCState();
  importLarkVersionHistory(state, LARK_PACKAGE);
  return state;
}

function makeTrialVersion(state) {
  const entry = LARK_PACKAGE.records.find((record) => record.id === S15_TRIAL_VERSION_ID);
  const template = state.versions.find((version) => version.familyId === "s15" && version.label === "26.09.04");
  const version = structuredClone(template);
  version.id = entry.id;
  version.label = entry.revision;
  version.items = [];
  version.sourceRows = [];
  version.source.recordId = entry.source.recordId;
  version.source.applicableProductIds = structuredClone(entry.applicableProductIds);
  version.source.effectiveAtRaw = structuredClone(entry.effectiveAt);
  version.source.statusRaw = structuredClone(entry.rawStatus);
  version.source.changeDescriptionRaw = structuredClone(entry.changeDescription);
  version.source.attachmentsRaw = structuredClone(entry.attachments);
  version.source.rawRecord = structuredClone(entry.rawRecord);
  version.source.anomalies = structuredClone(entry.anomalies);
  return version;
}

function withTrialVersion() {
  const state = importedState();
  state.versions.push(makeTrialVersion(state));
  validateQCState(state);
  return state;
}

function makeService(initialState = null) {
  const adapter = createMemoryQCAdapter({ initialState });
  let idNumber = 0;
  let timeNumber = 0;
  return {
    adapter,
    service: createQCService(adapter, {
      idFactory: () => `trial-cleanup-${String(++idNumber).padStart(4, "0")}`,
      now: () => new Date(Date.UTC(2026, 8, 29, 12, 0, timeNumber++)).toISOString(),
    }),
  };
}

test("the package and active-record guards match only the exact empty S15 trial", () => {
  const entry = LARK_PACKAGE.records.find((record) => record.id === S15_TRIAL_VERSION_ID);
  assert.equal(isAuthorizedS15TrialPackageEntry(entry), true);
  assert.equal(isAuthorizedS15TrialVersion(makeTrialVersion(importedState())), true);

  const changedEntries = [
    { ...structuredClone(entry), id: "another-id" },
    { ...structuredClone(entry), familyId: "s11-s14" },
    { ...structuredClone(entry), revision: "26.09.04" },
    { ...structuredClone(entry), changeDescription: "not the trial" },
    { ...structuredClone(entry), specs: [{ sourceRecordId: "spec-1" }] },
    { ...structuredClone(entry), attachments: [{ name: "drawing.pdf" }] },
  ];
  changedEntries.at(-2).rawRecord["③QC规范 Spec Items"] = [{ id: "spec-1" }];
  changedEntries.at(-1).rawRecord["图纸/附件 Engineering Drawing"] = [{ name: "drawing.pdf" }];
  for (const changed of changedEntries) assert.equal(isAuthorizedS15TrialPackageEntry(changed), false);

  const state = withTrialVersion();
  const original = structuredClone(state);
  for (const mutate of [
    (version) => { version.items.push({ key: "H001" }); },
    (version) => { version.sourceRows.push({ sourceRecordId: "spec-1", rawRecord: {} }); },
    (version) => { version.source.changeDescriptionRaw = "not the trial"; },
    (version) => { version.source.rawRecord["③QC规范 Spec Items"] = [{ id: "spec-1" }]; },
  ]) {
    const altered = structuredClone(state.versions.find((version) => version.id === S15_TRIAL_VERSION_ID));
    mutate(altered);
    assert.equal(isAuthorizedS15TrialVersion(altered), false);
    const guardState = structuredClone(state);
    guardState.versions[guardState.versions.findIndex((version) => version.id === S15_TRIAL_VERSION_ID)] = altered;
    assert.deepEqual(removeAuthorizedS15TrialVersion(guardState), { versionIds: [] });
    assert.deepEqual(guardState.versions.find((version) => version.id === S15_TRIAL_VERSION_ID), altered);
  }
  assert.deepEqual(state, original);
});

test("cleanup rejects batch, issue, asset, history, and merge references without mutating state", () => {
  const referenceCases = [
    (state) => state.batches.push({ id: "batch-ref", number: "B-REF", versionId: S15_TRIAL_VERSION_ID }),
    (state) => state.issues.push({ id: "issue-ref", number: "I-REF", sourceSnapshot: { versionId: S15_TRIAL_VERSION_ID } }),
    (state) => state.assets.push({ id: "asset-ref", name: "trial.pdf", versionId: S15_TRIAL_VERSION_ID }),
    (state) => state.history.sources.push({ id: "history-ref", source: { versionId: S15_TRIAL_VERSION_ID } }),
    (state) => { state.versionMergeEvidence = [{ id: "merge-ref", sourceVersionId: S15_TRIAL_VERSION_ID }]; },
  ];
  for (const addReference of referenceCases) {
    const state = withTrialVersion();
    addReference(state);
    const original = structuredClone(state);
    assert.throws(() => removeAuthorizedS15TrialVersion(state), /cannot remove.*referenced by/i);
    assert.deepEqual(state, original);
  }
});

test("initialize removes the active trial once, audits it, and leaves every other record intact", async () => {
  const { service } = makeService(withTrialVersion());
  const before = await service.getState();
  const initialized = await service.initialize();

  assert.ok(!initialized.versions.some((version) => version.id === S15_TRIAL_VERSION_ID));
  assert.deepEqual(initialized.versions, before.versions.filter((version) => version.id !== S15_TRIAL_VERSION_ID));
  assert.deepEqual(
    { ...initialized, versions: [], audit: [], revision: 0 },
    { ...before, versions: [], audit: [], revision: 0 },
  );
  assert.equal(initialized.revision, before.revision + 1);
  const cleanupAudits = initialized.audit.filter((event) => event.action === "removeS15TrialVersion");
  assert.equal(cleanupAudits.length, 1);
  assert.equal(cleanupAudits[0].entityId, S15_TRIAL_VERSION_ID);
  assert.equal(getBatchVersions(initialized, "s15")[0].label, "26.09.04");

  const afterFirstInitialization = structuredClone(initialized);
  assert.deepEqual(await service.initialize(), afterFirstInitialization);
});

test("legacy backups omit the trial before merge and repeated restore does not resurrect it", async () => {
  const source = makeService(withTrialVersion()).service;
  const legacyBackup = await source.exportBackup();
  const expectedVersions = legacyBackup.state.versions.filter((version) => version.id !== S15_TRIAL_VERSION_ID);

  const restored = makeService();
  await restored.service.initialize();
  const first = await restored.service.importBackup(legacyBackup, 0);
  let state = await restored.service.getState();
  assert.equal(first.counts.omittedTrialVersions, 1);
  assert.equal(first.counts.removedTrialVersions, 0);
  assert.ok(!state.versions.some((version) => version.id === S15_TRIAL_VERSION_ID));
  assert.deepEqual(state.versions, expectedVersions);
  assert.equal(state.audit.filter((event) => event.action === "removeS15TrialVersion").length, 1);
  assert.equal(getBatchVersions(state, "s15")[0].label, "26.09.04");

  const snapshot = structuredClone(state);
  const repeated = await restored.service.importBackup(legacyBackup, state.revision);
  state = await restored.service.getState();
  assert.equal(repeated.changed, false);
  assert.equal(repeated.counts.omittedTrialVersions, 1);
  assert.deepEqual(state, snapshot);
});

test("a legacy backup with a dependency on the trial is rejected atomically", async () => {
  const source = makeService(withTrialVersion()).service;
  const backup = await source.exportBackup();
  backup.state.assets.push({
    id: "trial-attachment",
    kind: "document",
    name: "trial.txt",
    mimeType: "text/plain",
    dataUrl: "data:text/plain;base64,YQ==",
    batchId: null,
    rowId: null,
    versionId: S15_TRIAL_VERSION_ID,
    createdAt: "2026-09-29T12:00:00.000Z",
  });
  const restored = makeService();
  await restored.service.initialize();
  const before = await restored.service.getState();
  await assert.rejects(restored.service.importBackup(backup, before.revision), /cannot remove.*referenced by/i);
  assert.deepEqual(await restored.service.getState(), before);
});
