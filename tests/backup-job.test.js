import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createQCService } from "../core/qc-service.js";
import { createSQLiteQCAdapter } from "../storage/sqlite-qc-adapter.mjs";
import { createBackupSnapshot, parseCommandLine } from "../scripts/backup-snapshot.mjs";

const DATE = "2026-10-16";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_SCRIPT = path.join(PROJECT_ROOT, "scripts", "backup-snapshot.mjs");
const BACKUP_SCRIPT = path.join(PROJECT_ROOT, "deploy", "masterqc-backup.sh");
const FIXED_NOW = new Date("2026-10-17T01:02:03.456Z");

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "masterqc-backup-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Creates a real workspace database through the production adapter, with one saved order.
async function createWorkspace(databasePath) {
  const service = createQCService(createSQLiteQCAdapter({ databasePath }));
  const initial = await service.initialize();
  const variant = initial.variants.find((item) => item.model === "S15" && item.color === "Red");
  await service.command("createOrder", {
    number: "PO-BACKUP",
    date: DATE,
    supplier: "Backup supplier",
    notes: "backup test",
    lines: [{ variantId: variant.id, orderedQty: 25 }],
  }, initial.revision);
  return service;
}

function runNode(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

function runBash(args, env) {
  return new Promise((resolve) => {
    execFile("bash", args, { encoding: "utf8", env }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

function hasCommand(name) {
  return new Promise((resolve) => {
    execFile("sh", ["-c", `command -v ${name}`], (error) => resolve(!error));
  });
}

test("a backup copy is verified, matches its manifest, and never writes the live database", async (t) => {
  const directory = await temporaryDirectory(t);
  const dataDirectory = path.join(directory, "data");
  await mkdir(dataDirectory);
  const livePath = path.join(dataDirectory, "masterqc-main.sqlite");
  const service = await createWorkspace(livePath);
  const revision = await service.getRevision();
  const liveState = await service.getState();
  await service.close();

  const liveBefore = await readFile(livePath);
  const liveStatBefore = await stat(livePath);
  const listingBefore = await readdir(dataDirectory);
  const outDirectory = path.join(directory, "out");

  const { manifestPath, snapshotPath, manifest } = await createBackupSnapshot({
    dataDirectory,
    outDirectory,
    now: FIXED_NOW,
    appVersion: "9.9.9-test",
  });

  const expectedName = `masterqc-main-20261017T010203Z-r${revision}`;
  assert.equal(path.basename(snapshotPath), `${expectedName}.sqlite`);
  assert.equal(path.basename(manifestPath), `${expectedName}.json`);
  assert.deepEqual(Object.keys(manifest), ["file", "bytes", "sha256", "revision", "createdAt", "appVersion"]);
  assert.equal(manifest.file, `${expectedName}.sqlite`);
  assert.equal(manifest.revision, revision);
  assert.equal(manifest.createdAt, FIXED_NOW.toISOString());
  assert.equal(manifest.appVersion, "9.9.9-test");

  const copyBytes = await readFile(snapshotPath);
  assert.equal(manifest.bytes, copyBytes.length);
  assert.equal(manifest.sha256, sha256(copyBytes));
  // Windows does not store POSIX permission bits, so the owner-only mode is checked on POSIX systems only.
  if (process.platform !== "win32") assert.equal((await stat(snapshotPath)).mode & 0o777, 0o600);

  const manifestOnDisk = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.deepEqual(manifestOnDisk, manifest);

  const copyService = createQCService(createSQLiteQCAdapter({ databasePath: snapshotPath }));
  try {
    assert.deepEqual(await copyService.getState(), liveState);
    assert.equal(await copyService.getRevision(), revision);
  } finally {
    await copyService.close();
  }

  // The source is opened read-only, so its bytes, timestamp, and directory listing stay the same.
  assert.deepEqual(await readFile(livePath), liveBefore);
  assert.equal((await stat(livePath)).mtimeMs, liveStatBefore.mtimeMs);
  assert.deepEqual(await readdir(dataDirectory), listingBefore);
  assert.deepEqual((await readdir(outDirectory)).sort(), [`${expectedName}.json`, `${expectedName}.sqlite`].sort());
});

test("the snapshot command prints only the manifest path and exits zero", async (t) => {
  const directory = await temporaryDirectory(t);
  const dataDirectory = path.join(directory, "data");
  await mkdir(dataDirectory);
  const service = await createWorkspace(path.join(dataDirectory, "masterqc-main.sqlite"));
  await service.close();
  const outDirectory = path.join(directory, "out");

  const result = await runNode([SNAPSHOT_SCRIPT, "--data-dir", dataDirectory, "--out-dir", outDirectory, "--workspace", "main"]);

  assert.equal(result.code, 0, result.stderr);
  const printed = result.stdout.trim();
  assert.equal(path.dirname(printed), outDirectory);
  assert.equal(result.stdout.split("\n").filter(Boolean).length, 1, "stdout must hold only the manifest path");
  const manifest = JSON.parse(await readFile(printed, "utf8"));
  const copyBytes = await readFile(path.join(outDirectory, manifest.file));
  assert.equal(manifest.sha256, sha256(copyBytes));
  assert.equal(manifest.bytes, copyBytes.length);
});

test("failed backups leave no partial output and never overwrite an existing backup", async (t) => {
  const directory = await temporaryDirectory(t);
  const emptyData = path.join(directory, "empty-data");
  await mkdir(emptyData);
  const outDirectory = path.join(directory, "out");
  await mkdir(outDirectory);

  // A missing database is refused; the read-only open never creates an empty file.
  await assert.rejects(createBackupSnapshot({ dataDirectory: emptyData, outDirectory, now: FIXED_NOW }), /was not found/);
  assert.deepEqual(await readdir(emptyData), []);

  // A SQLite file without saved QC state is not a workspace, so no backup is produced.
  const foreignData = path.join(directory, "foreign-data");
  await mkdir(foreignData);
  const foreign = new DatabaseSync(path.join(foreignData, "masterqc-main.sqlite"));
  foreign.exec("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('not qc');");
  foreign.close();
  await assert.rejects(createBackupSnapshot({ dataDirectory: foreignData, outDirectory, now: FIXED_NOW }), /no saved QC state/);

  // Not a database at all.
  const garbageData = path.join(directory, "garbage-data");
  await mkdir(garbageData);
  await writeFile(path.join(garbageData, "masterqc-main.sqlite"), "this is not sqlite");
  await assert.rejects(createBackupSnapshot({ dataDirectory: garbageData, outDirectory, now: FIXED_NOW }));
  assert.equal(await readFile(path.join(garbageData, "masterqc-main.sqlite"), "utf8"), "this is not sqlite");

  assert.deepEqual(await readdir(outDirectory), []);

  // An existing backup with the same name is refused and kept unchanged.
  const liveData = path.join(directory, "live-data");
  await mkdir(liveData);
  const service = await createWorkspace(path.join(liveData, "masterqc-main.sqlite"));
  const revision = await service.getRevision();
  await service.close();
  const existingName = `masterqc-main-20261017T010203Z-r${revision}.sqlite`;
  await writeFile(path.join(outDirectory, existingName), "earlier backup");
  await assert.rejects(createBackupSnapshot({ dataDirectory: liveData, outDirectory, now: FIXED_NOW }));
  assert.equal(await readFile(path.join(outDirectory, existingName), "utf8"), "earlier backup");
  assert.deepEqual(await readdir(outDirectory), [existingName]);
});

test("the snapshot command validates its arguments and reports usage with status 2", async () => {
  const usage = await runNode([SNAPSHOT_SCRIPT]);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /--data-dir and --out-dir are required/);

  const unknown = await runNode([SNAPSHOT_SCRIPT, "--data-dir", "x", "--out-dir", "y", "--bogus"]);
  assert.equal(unknown.code, 2);

  assert.deepEqual({ ...parseCommandLine(["--data-dir", "a", "--out-dir", "b"]) }, {
    "data-dir": "a", "out-dir": "b", workspace: "main", help: false,
  });
  await assert.rejects(createBackupSnapshot({ dataDirectory: "a", outDirectory: "b", workspace: "archive" }), /main or demo/);
});

// The shell job is Linux-only. Its object store, heartbeat, and time-based pruning use Linux tools.
const LINUX_ONLY = process.platform !== "linux" ? "The backup job is written for Linux." : false;
const BACKUP_PREFIX = "masterqc-test";
const HEARTBEAT_SECRET = "HEARTBEAT-SECRET-TOKEN-7731";
const AWS_SECRET = "AWS-SECRET-VALUE-4412";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Fake AWS CLI. Its bucket is a directory, and every call is logged. put-object stores the bytes and the Object Lock
// settings it was given. head-object answers with the size, lock mode, and retention date that the real CLI returns
// for the query the job uses. The FAKE_AWS_* variables inject the failures that the tests need.
const FAKE_AWS = `#!${process.execPath}
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, ["aws", ...args].join(" ") + "\\n");
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const fail = (message, code) => {
  process.stderr.write(message + "\\n");
  process.exit(code);
};
const key = option("--key") ?? "";
const target = path.join(process.env.BUCKET_DIR, key);
const metaFile = path.join(process.env.BUCKET_DIR, ".meta", key.replaceAll("/", "__") + ".json");
if (args[0] !== "s3api") fail("unexpected aws call", 1);
if (args[1] === "put-object") {
  const failing = process.env.FAKE_AWS_FAIL_PREFIX;
  if (failing && key.includes(failing)) fail("simulated upload failure", 255);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(option("--body").replace(/^fileb:\\/\\//, ""), target);
  fs.mkdirSync(path.dirname(metaFile), { recursive: true });
  fs.writeFileSync(metaFile, JSON.stringify({
    mode: option("--object-lock-mode") ?? null,
    retainUntil: option("--object-lock-retain-until-date") ?? null,
  }));
  process.stdout.write('{"ETag": "\\"stub\\""}\\n');
  process.exit(0);
}
if (args[1] === "head-object") {
  if (!fs.existsSync(target)) fail("An error occurred (404) when calling the HeadObject operation: Not Found", 254);
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  let size = fs.statSync(target).size;
  if (process.env.FAKE_AWS_WRONG_SIZE) size += 1;
  let mode = meta.mode ?? "None";
  let retainUntil = meta.retainUntil ?? "None";
  if (process.env.FAKE_AWS_NO_LOCK) {
    mode = "None";
    retainUntil = "None";
  }
  if (process.env.FAKE_AWS_SHORT_RETAIN && retainUntil !== "None") {
    retainUntil = new Date(Date.parse(retainUntil) - 60 * 60 * 1000).toISOString().replace(/\\.\\d{3}Z$/, "+00:00");
  }
  process.stdout.write([size, mode, retainUntil].join("\\t") + "\\n");
  process.exit(0);
}
fail("unexpected aws call", 1);
`;

// Fake heartbeat: records the call without contacting any network address.
const FAKE_CURL = `#!/usr/bin/env bash
echo "curl heartbeat" >> "$CALL_LOG"
exit 0
`;

// Encryption needs age and age-keygen. Without them the job tests are skipped, as before.
async function requireAge(t) {
  if (!(await hasCommand("age")) || !(await hasCommand("age-keygen"))) {
    t.skip("age and age-keygen are required to test encryption");
    return false;
  }
  return true;
}

// A temporary bucket, data directory, and staging area, with the fake AWS CLI and curl first on PATH and a real age key.
async function createBackupFixture(t) {
  const directory = await temporaryDirectory(t);
  const fixture = {
    directory,
    binDirectory: path.join(directory, "bin"),
    bucketDirectory: path.join(directory, "bucket"),
    dataDirectory: path.join(directory, "data"),
    stagingDirectory: path.join(directory, "staging"),
    stateDirectory: path.join(directory, "state"),
    callLog: path.join(directory, "calls.log"),
    keyFile: path.join(directory, "recovery-key.txt"),
    databasePath: path.join(directory, "data", "masterqc-main.sqlite"),
  };
  for (const name of ["binDirectory", "bucketDirectory", "dataDirectory", "stagingDirectory"]) {
    await mkdir(fixture[name]);
  }
  await runBash(["-c", `age-keygen -o "${fixture.keyFile}"`], process.env);
  fixture.recipient = (await readFile(fixture.keyFile, "utf8")).match(/^# public key: (\S+)$/m)?.[1];
  assert.match(fixture.recipient ?? "", /^age1/);
  await writeFile(path.join(fixture.binDirectory, "aws"), FAKE_AWS);
  await writeFile(path.join(fixture.binDirectory, "curl"), FAKE_CURL);
  await chmod(path.join(fixture.binDirectory, "aws"), 0o755);
  await chmod(path.join(fixture.binDirectory, "curl"), 0o755);
  return fixture;
}

// The environment the systemd unit would give the job, pointed at the fixture's directories and fake services.
function backupEnvironment(fixture, overrides = {}) {
  return {
    PATH: [fixture.binDirectory, path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    CALL_LOG: fixture.callLog,
    BUCKET_DIR: fixture.bucketDirectory,
    MASTERQC_APP_DIR: PROJECT_ROOT,
    MASTERQC_DATA_DIR: fixture.dataDirectory,
    MASTERQC_BACKUP_STAGING_DIR: fixture.stagingDirectory,
    MASTERQC_BACKUP_STATE_DIR: fixture.stateDirectory,
    MASTERQC_BACKUP_S3_BUCKET: "test-bucket",
    MASTERQC_BACKUP_S3_PREFIX: `${BACKUP_PREFIX}/`,
    MASTERQC_BACKUP_AGE_RECIPIENT: fixture.recipient,
    MASTERQC_BACKUP_HEARTBEAT_URL: `https://heartbeat.invalid/${HEARTBEAT_SECRET}`,
    AWS_ACCESS_KEY_ID: "AKIATESTONLY",
    AWS_SECRET_ACCESS_KEY: AWS_SECRET,
    AWS_DEFAULT_REGION: "ap-southeast-1",
    HOME: fixture.directory,
    ...overrides,
  };
}

async function runBackup(fixture, overrides) {
  return runBash([BACKUP_SCRIPT], backupEnvironment(fixture, overrides));
}

function outputOf(result) {
  return `${result.stdout}\n${result.stderr}`;
}

async function callLines(fixture) {
  const text = await readFile(fixture.callLog, "utf8").catch(() => "");
  return text.trim() === "" ? [] : text.trim().split("\n");
}

async function clearCalls(fixture) {
  await rm(fixture.callLog, { force: true });
}

// The uploads in call order. Each put-object line gives its S3 key, lock mode, and retain-until date.
function uploadsOf(calls) {
  return calls.filter((line) => line.startsWith("aws s3api put-object ")).map((line) => {
    const key = line.match(/--key (\S+)/)[1];
    return {
      key,
      tier: key.split("/")[1],
      mode: line.match(/--object-lock-mode (\S+)/)?.[1],
      retainUntil: line.match(/--object-lock-retain-until-date (\S+)/)?.[1],
    };
  });
}

// State files are read back as trimmed text, or null when absent.
async function readState(fixture, name) {
  return readFile(path.join(fixture.stateDirectory, name), "utf8").then((text) => text.trim(), () => null);
}

async function writeState(fixture, name, value) {
  await mkdir(fixture.stateDirectory, { recursive: true });
  await writeFile(path.join(fixture.stateDirectory, name), `${value}\n`);
}

// The job works in UTC, so the expected day and month are UTC too.
const utcDay = () => new Date().toISOString().slice(0, 10);
const utcMonth = () => new Date().toISOString().slice(0, 7);
const epochSeconds = () => Math.floor(Date.now() / 1000);

// Creates the fixture's workspace database with one saved order and returns its revision.
async function seedWorkspace(fixture) {
  const service = await createWorkspace(fixture.databasePath);
  const revision = await service.getRevision();
  await service.close();
  return revision;
}

async function currentRevision(fixture) {
  const service = createQCService(createSQLiteQCAdapter({ databasePath: fixture.databasePath }));
  try {
    return await service.getRevision();
  } finally {
    await service.close();
  }
}

// Saves one more order through the production adapter, which moves the workspace revision on.
async function addOrder(fixture, number) {
  const service = createQCService(createSQLiteQCAdapter({ databasePath: fixture.databasePath }));
  try {
    const state = await service.getState();
    const variant = state.variants.find((item) => item.model === "S15" && item.color === "Red");
    await service.command("createOrder", {
      number,
      date: DATE,
      supplier: "Backup supplier",
      notes: "backup test",
      lines: [{ variantId: variant.id, orderedQty: 5 }],
    }, state.revision);
  } finally {
    await service.close();
  }
}

// Each run names its copies to the second. A run that keeps the same revision waits out the current second first.
function pause() {
  return new Promise((resolve) => setTimeout(resolve, 1100));
}

test("the first run uploads every tier, each object under a COMPLIANCE lock with its retention", { skip: LINUX_ONLY }, async (t) => {
  if (!(await requireAge(t))) return;
  const fixture = await createBackupFixture(t);
  const revision = await seedWorkspace(fixture);

  // Old local copies are removed; recent copies, the lock file, and unrelated files are kept.
  const oldName = "masterqc-main-20261010T000000Z-r1";
  await writeFile(path.join(fixture.stagingDirectory, `${oldName}.sqlite.age`), "old encrypted");
  await writeFile(path.join(fixture.stagingDirectory, `${oldName}.json`), "{}");
  const threeDaysAgo = new Date(Date.now() - 3 * DAY_MS);
  await utimes(path.join(fixture.stagingDirectory, `${oldName}.sqlite.age`), threeDaysAgo, threeDaysAgo);
  await utimes(path.join(fixture.stagingDirectory, `${oldName}.json`), threeDaysAgo, threeDaysAgo);
  await writeFile(path.join(fixture.stagingDirectory, "notes.txt"), "keep me");

  const before = Date.now();
  const run = await runBackup(fixture);
  const after = Date.now();
  assert.equal(run.code, 0, outputOf(run));
  assert.equal(outputOf(run).includes(HEARTBEAT_SECRET), false, "the heartbeat URL must not be printed");
  assert.equal(outputOf(run).includes(AWS_SECRET), false, "AWS secrets must not be printed");

  const calls = await callLines(fixture);
  // Each tier gets the encrypted copy and then its manifest: half-hourly, then daily, then monthly.
  const uploads = uploadsOf(calls);
  assert.deepEqual(uploads.map((upload) => upload.tier), ["half-hourly", "half-hourly", "daily", "daily", "monthly", "monthly"]);
  const lockDays = { "half-hourly": 7, daily: 30, monthly: 366 };
  for (const upload of uploads) {
    assert.equal(upload.mode, "COMPLIANCE", upload.key);
    const retainMs = Date.parse(upload.retainUntil);
    const days = lockDays[upload.tier];
    assert.ok(
      retainMs >= before + days * DAY_MS - 1000 && retainMs <= after + days * DAY_MS + 1000,
      `${upload.key} is locked until ${upload.retainUntil}, expected about ${days} days from now`,
    );
  }
  // Every upload is read back under its own key before the next upload starts.
  for (const [index, line] of calls.entries()) {
    if (!line.startsWith("aws s3api put-object ")) continue;
    const { key } = uploadsOf([line])[0];
    assert.ok(calls[index + 1]?.startsWith("aws s3api head-object "), `${key} is not read back`);
    assert.ok(calls[index + 1].includes(`--key ${key} `), `${key} is read back under its own key`);
  }

  assert.match(String(await readState(fixture, "last-half-hourly")), new RegExp(`^${revision} \\d+$`));
  assert.equal(await readState(fixture, "last-daily"), utcDay());
  assert.equal(await readState(fixture, "last-monthly"), utcMonth());

  // The half-hourly copy decrypts to the snapshot that its manifest describes.
  const folder = path.join(fixture.bucketDirectory, BACKUP_PREFIX, "half-hourly");
  const names = (await readdir(folder)).sort();
  const encryptedName = names.find((name) => name.endsWith(".sqlite.age"));
  const manifestName = names.find((name) => name.endsWith(".json"));
  assert.ok(encryptedName && manifestName, `uploaded: ${names.join(", ")}`);
  const manifest = JSON.parse(await readFile(path.join(folder, manifestName), "utf8"));
  assert.equal(manifest.revision, revision);
  const decrypted = path.join(fixture.directory, "decrypted.sqlite");
  const decryptResult = await runBash(["-c", `age -d -i "${fixture.keyFile}" -o "${decrypted}" "${path.join(folder, encryptedName)}"`], process.env);
  assert.equal(decryptResult.code, 0, decryptResult.stderr);
  assert.equal(sha256(await readFile(decrypted)), manifest.sha256);

  const localNames = (await readdir(fixture.stagingDirectory)).sort();
  assert.equal(localNames.some((name) => name.endsWith(".sqlite") && name.startsWith("masterqc-")), false, "plaintext copies must not remain");
  assert.ok(localNames.includes(encryptedName), "the encrypted copy stays as the local recovery cache");
  assert.equal(localNames.includes(`${oldName}.sqlite.age`), false, "copies older than two days are pruned");
  assert.equal(localNames.includes(`${oldName}.json`), false);
  assert.ok(localNames.includes("notes.txt"));

  assert.equal(calls.at(-1), "curl heartbeat", "the heartbeat must be the last action");
  assert.equal(calls.filter((line) => line === "curl heartbeat").length, 1);
});

test("a later run on the same day uploads only the half-hourly copy when the revision changed", { skip: LINUX_ONLY }, async (t) => {
  if (!(await requireAge(t))) return;
  const fixture = await createBackupFixture(t);
  await seedWorkspace(fixture);
  assert.equal((await runBackup(fixture)).code, 0);

  await addOrder(fixture, "PO-SECOND");
  const revision = await currentRevision(fixture);
  await clearCalls(fixture);
  const run = await runBackup(fixture);
  assert.equal(run.code, 0, outputOf(run));

  const calls = await callLines(fixture);
  assert.deepEqual(uploadsOf(calls).map((upload) => upload.tier), ["half-hourly", "half-hourly"]);
  assert.match(String(await readState(fixture, "last-half-hourly")), new RegExp(`^${revision} \\d+$`));
  assert.equal(calls.at(-1), "curl heartbeat");
});

test("an unchanged revision within six hours uploads nothing, logs unchanged, and still sends the heartbeat", { skip: LINUX_ONLY }, async (t) => {
  if (!(await requireAge(t))) return;
  const fixture = await createBackupFixture(t);
  await seedWorkspace(fixture);
  assert.equal((await runBackup(fixture)).code, 0);

  await pause();
  await clearCalls(fixture);
  const run = await runBackup(fixture);
  assert.equal(run.code, 0, outputOf(run));
  assert.match(run.stdout, /unchanged/);

  const calls = await callLines(fixture);
  assert.deepEqual(uploadsOf(calls), [], "no copy is uploaded for an unchanged revision");
  assert.equal(calls.at(-1), "curl heartbeat", "coverage is current, so the heartbeat is still sent");
});

test("an unchanged revision is copied again once its last half-hourly copy is six hours old", { skip: LINUX_ONLY }, async (t) => {
  if (!(await requireAge(t))) return;
  const fixture = await createBackupFixture(t);
  const revision = await seedWorkspace(fixture);
  assert.equal((await runBackup(fixture)).code, 0);

  await writeState(fixture, "last-half-hourly", `${revision} ${epochSeconds() - 7 * 3600}`);
  await pause();
  await clearCalls(fixture);
  const run = await runBackup(fixture);
  assert.equal(run.code, 0, outputOf(run));

  const calls = await callLines(fixture);
  assert.deepEqual(uploadsOf(calls).map((upload) => upload.tier), ["half-hourly", "half-hourly"]);
  assert.equal(calls.at(-1), "curl heartbeat");
  const [storedRevision, storedEpoch] = String(await readState(fixture, "last-half-hourly")).split(" ");
  assert.equal(storedRevision, String(revision));
  assert.ok(Number(storedEpoch) >= epochSeconds() - 60, "the state records the new upload time");
});

test("a due daily or monthly copy uploads even when the revision is unchanged", { skip: LINUX_ONLY }, async (t) => {
  if (!(await requireAge(t))) return;
  const fixture = await createBackupFixture(t);
  await seedWorkspace(fixture);
  assert.equal((await runBackup(fixture)).code, 0);

  await writeState(fixture, "last-daily", "2000-01-01");
  await writeState(fixture, "last-monthly", "2000-01");
  await pause();
  await clearCalls(fixture);
  const run = await runBackup(fixture);
  assert.equal(run.code, 0, outputOf(run));
  assert.match(run.stdout, /unchanged/);

  const calls = await callLines(fixture);
  assert.deepEqual(uploadsOf(calls).map((upload) => upload.tier), ["daily", "daily", "monthly", "monthly"]);
  assert.equal(await readState(fixture, "last-daily"), utcDay());
  assert.equal(await readState(fixture, "last-monthly"), utcMonth());
  assert.equal(calls.at(-1), "curl heartbeat");
});

test("a failed upload stops the run: no heartbeat, and each tier advances only after its own copies verify", { skip: LINUX_ONLY }, async (t) => {
  if (!(await requireAge(t))) return;
  const fixture = await createBackupFixture(t);
  const revision = await seedWorkspace(fixture);

  // 1. The half-hourly upload fails, so nothing is recorded.
  let run = await runBackup(fixture, { FAKE_AWS_FAIL_PREFIX: "/half-hourly/" });
  assert.equal(run.code, 1, outputOf(run));
  assert.match(run.stderr, /Upload failed for masterqc-test\/half-hourly\//);
  let calls = await callLines(fixture);
  assert.equal(calls.includes("curl heartbeat"), false, "no heartbeat after a failed upload");
  for (const name of ["last-half-hourly", "last-daily", "last-monthly"]) {
    assert.equal(await readState(fixture, name), null, `${name} must not be recorded`);
  }

  // 2. The half-hourly copy verifies, then the daily copy fails. Only the half-hourly state advances.
  await pause();
  await clearCalls(fixture);
  run = await runBackup(fixture, { FAKE_AWS_FAIL_PREFIX: "/daily/" });
  assert.equal(run.code, 1, outputOf(run));
  assert.match(run.stderr, /Upload failed for masterqc-test\/daily\//);
  calls = await callLines(fixture);
  assert.equal(calls.includes("curl heartbeat"), false, "no heartbeat after a failed daily upload");
  assert.match(String(await readState(fixture, "last-half-hourly")), new RegExp(`^${revision} \\d+$`));
  assert.equal(await readState(fixture, "last-daily"), null);
  assert.equal(await readState(fixture, "last-monthly"), null);

  // 3. The half-hourly copy is unchanged and the daily copy succeeds now. The monthly copy fails.
  await pause();
  await clearCalls(fixture);
  run = await runBackup(fixture, { FAKE_AWS_FAIL_PREFIX: "/monthly/" });
  assert.equal(run.code, 1, outputOf(run));
  assert.match(run.stderr, /Upload failed for masterqc-test\/monthly\//);
  calls = await callLines(fixture);
  assert.deepEqual(uploadsOf(calls).map((upload) => upload.tier), ["daily", "daily", "monthly"]);
  assert.equal(calls.some((line) => line.includes("/half-hourly/")), false, "the verified half-hourly copy is not uploaded again");
  assert.equal(calls.includes("curl heartbeat"), false, "no heartbeat after a failed monthly upload");
  assert.equal(await readState(fixture, "last-daily"), utcDay());
  assert.equal(await readState(fixture, "last-monthly"), null);

  // 4. With no failure, the next run uploads only the monthly copy and sends the heartbeat.
  await pause();
  await clearCalls(fixture);
  run = await runBackup(fixture);
  assert.equal(run.code, 0, outputOf(run));
  calls = await callLines(fixture);
  assert.deepEqual(uploadsOf(calls).map((upload) => upload.tier), ["monthly", "monthly"]);
  assert.equal(calls.at(-1), "curl heartbeat");
  assert.equal(await readState(fixture, "last-monthly"), utcMonth());
});

test("a copy whose head-object shows no COMPLIANCE lock, or a shorter one, fails the run", { skip: LINUX_ONLY }, async (t) => {
  if (!(await requireAge(t))) return;
  const fixture = await createBackupFixture(t);
  await seedWorkspace(fixture);

  let run = await runBackup(fixture, { FAKE_AWS_NO_LOCK: "1" });
  assert.equal(run.code, 1, outputOf(run));
  assert.match(run.stderr, /not under a COMPLIANCE Object Lock/);
  assert.equal((await callLines(fixture)).includes("curl heartbeat"), false, "no heartbeat without a verified lock");
  assert.equal(await readState(fixture, "last-half-hourly"), null);

  await pause();
  await clearCalls(fixture);
  run = await runBackup(fixture, { FAKE_AWS_SHORT_RETAIN: "1" });
  assert.equal(run.code, 1, outputOf(run));
  assert.match(run.stderr, /locked for less time than required/);
  assert.equal((await callLines(fixture)).includes("curl heartbeat"), false, "no heartbeat for a shorter lock");
  assert.equal(await readState(fixture, "last-half-hourly"), null);
});

test("a size mismatch after upload fails the run and suppresses the heartbeat", { skip: LINUX_ONLY }, async (t) => {
  if (!(await requireAge(t))) return;
  const fixture = await createBackupFixture(t);
  await seedWorkspace(fixture);

  const mismatch = await runBackup(fixture, { FAKE_AWS_WRONG_SIZE: "1" });
  assert.equal(mismatch.code, 1, outputOf(mismatch));
  assert.match(mismatch.stderr, /different size/);
  assert.equal((await callLines(fixture)).includes("curl heartbeat"), false, "no heartbeat after a failed verification");
});

test("the backup job passes bash's syntax check", { skip: process.platform === "win32" ? "POSIX shell syntax is checked on POSIX systems." : false }, async () => {
  const result = await runBash(["-n", BACKUP_SCRIPT], process.env);
  assert.equal(result.code, 0, result.stderr);
});

test("the backup job refuses to run without its encryption recipient and reports nothing secret", { skip: process.platform !== "linux" ? "The backup job is written for Linux." : false }, async () => {
  const result = await runBash([BACKUP_SCRIPT], {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    MASTERQC_BACKUP_S3_BUCKET: "test-bucket",
    AWS_SECRET_ACCESS_KEY: "AWS-SECRET-VALUE-9001",
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /MASTERQC_BACKUP_AGE_RECIPIENT is not set/);
  assert.equal(`${result.stdout}${result.stderr}`.includes("AWS-SECRET-VALUE-9001"), false);
});
