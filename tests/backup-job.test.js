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
test("the backup job encrypts, verifies both uploads, prunes old copies, and sends its heartbeat last", { skip: process.platform !== "linux" ? "The backup job is written for Linux." : false }, async (t) => {
  const directory = await temporaryDirectory(t);
  const binDirectory = path.join(directory, "bin");
  const bucketDirectory = path.join(directory, "bucket");
  const dataDirectory = path.join(directory, "data");
  const stagingDirectory = path.join(directory, "staging");
  const callLog = path.join(directory, "calls.log");
  await mkdir(binDirectory);
  await mkdir(bucketDirectory);
  await mkdir(dataDirectory);
  await mkdir(stagingDirectory);

  if (!(await hasCommand("age")) || !(await hasCommand("age-keygen"))) {
    t.skip("age and age-keygen are required to test encryption");
    return;
  }
  const keyFile = path.join(directory, "recovery-key.txt");
  await runBash(["-c", `age-keygen -o "${keyFile}"`], process.env);
  const recipient = (await readFile(keyFile, "utf8")).match(/^# public key: (\S+)$/m)?.[1];
  assert.match(recipient ?? "", /^age1/);

  const service = await createWorkspace(path.join(dataDirectory, "masterqc-main.sqlite"));
  await service.close();

  // Stub AWS CLI: S3 is a directory, and head-object reports the stored size.
  // The stub reports a different size when FAKE_AWS_WRONG_SIZE is set.
  await writeFile(path.join(binDirectory, "aws"), `#!/usr/bin/env bash
set -euo pipefail
echo "aws $*" >> "$CALL_LOG"
if [[ "$1 $2" == "s3 cp" ]]; then
  src="\${@: -2:1}"; dst="\${@: -1}"; key="\${dst#s3://$BUCKET/}"
  mkdir -p "$BUCKET_DIR/$(dirname "$key")"
  cp "$src" "$BUCKET_DIR/$key"
  exit 0
fi
if [[ "$1 $2" == "s3api head-object" ]]; then
  key=""
  while [[ $# -gt 0 ]]; do case "$1" in --key) key="$2"; shift 2;; *) shift;; esac; done
  size="$(stat -c '%s' "$BUCKET_DIR/$key")"
  if [[ -n "\${FAKE_AWS_WRONG_SIZE:-}" ]]; then size=$((size + 1)); fi
  echo "$size"
  exit 0
fi
echo "unexpected aws call" >&2
exit 1
`);
  // Stub curl: records the heartbeat call without contacting any network address.
  await writeFile(path.join(binDirectory, "curl"), `#!/usr/bin/env bash
echo "curl heartbeat" >> "$CALL_LOG"
exit 0
`);
  await chmod(path.join(binDirectory, "aws"), 0o755);
  await chmod(path.join(binDirectory, "curl"), 0o755);

  // Old local copies are removed; recent copies, the lock file, and unrelated files are kept.
  const oldName = "masterqc-main-20261010T000000Z-r1";
  await writeFile(path.join(stagingDirectory, `${oldName}.sqlite.age`), "old encrypted");
  await writeFile(path.join(stagingDirectory, `${oldName}.json`), "{}");
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  await utimes(path.join(stagingDirectory, `${oldName}.sqlite.age`), threeDaysAgo, threeDaysAgo);
  await utimes(path.join(stagingDirectory, `${oldName}.json`), threeDaysAgo, threeDaysAgo);
  await writeFile(path.join(stagingDirectory, "notes.txt"), "keep me");

  const secretToken = "HEARTBEAT-SECRET-TOKEN-7731";
  const awsSecret = "AWS-SECRET-VALUE-4412";
  const env = {
    PATH: [binDirectory, path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    CALL_LOG: callLog,
    BUCKET_DIR: bucketDirectory,
    BUCKET: "test-bucket",
    MASTERQC_APP_DIR: PROJECT_ROOT,
    MASTERQC_DATA_DIR: dataDirectory,
    MASTERQC_BACKUP_STAGING_DIR: stagingDirectory,
    MASTERQC_BACKUP_S3_BUCKET: "test-bucket",
    MASTERQC_BACKUP_S3_PREFIX: "masterqc-test/",
    MASTERQC_BACKUP_AGE_RECIPIENT: recipient,
    MASTERQC_BACKUP_HEARTBEAT_URL: `https://heartbeat.invalid/${secretToken}`,
    AWS_ACCESS_KEY_ID: "AKIATESTONLY",
    AWS_SECRET_ACCESS_KEY: awsSecret,
    AWS_DEFAULT_REGION: "ap-southeast-1",
    HOME: directory,
  };

  const success = await runBash([BACKUP_SCRIPT], env);
  assert.equal(success.code, 0, `${success.stdout}\n${success.stderr}`);
  const output = `${success.stdout}\n${success.stderr}`;
  assert.equal(output.includes(secretToken), false, "the heartbeat URL must not be printed");
  assert.equal(output.includes(awsSecret), false, "AWS secrets must not be printed");

  const uploaded = (await readdir(path.join(bucketDirectory, "masterqc-test"))).sort();
  const encryptedName = uploaded.find((name) => name.endsWith(".sqlite.age"));
  const manifestName = uploaded.find((name) => name.endsWith(".json"));
  assert.ok(encryptedName && manifestName, `uploaded: ${uploaded.join(", ")}`);
  const manifest = JSON.parse(await readFile(path.join(bucketDirectory, "masterqc-test", manifestName), "utf8"));

  // The uploaded object decrypts to the snapshot described by its manifest.
  const decrypted = path.join(directory, "decrypted.sqlite");
  const decryptResult = await runBash(["-c", `age -d -i "${keyFile}" -o "${decrypted}" "${path.join(bucketDirectory, "masterqc-test", encryptedName)}"`], process.env);
  assert.equal(decryptResult.code, 0, decryptResult.stderr);
  assert.equal(sha256(await readFile(decrypted)), manifest.sha256);

  const localNames = (await readdir(stagingDirectory)).sort();
  assert.equal(localNames.some((name) => name.endsWith(".sqlite") && name.startsWith("masterqc-")), false, "plaintext copies must not remain");
  assert.ok(localNames.includes(encryptedName), "the encrypted copy stays as the local recovery cache");
  assert.equal(localNames.includes(`${oldName}.sqlite.age`), false, "copies older than two days are pruned");
  assert.equal(localNames.includes(`${oldName}.json`), false);
  assert.ok(localNames.includes("notes.txt"));

  const calls = (await readFile(callLog, "utf8")).trim().split("\n");
  assert.equal(calls.at(-1), "curl heartbeat", "the heartbeat must be the last action");
  assert.equal(calls.filter((line) => line === "curl heartbeat").length, 1);
  assert.equal(calls.filter((line) => line.startsWith("aws s3 cp")).length, 2);

  // A size mismatch after upload fails the run and suppresses the heartbeat.
  // Backup names carry the UTC second, so the second run waits to avoid the refused same-name case.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await rm(callLog, { force: true });
  const mismatch = await runBash([BACKUP_SCRIPT], { ...env, FAKE_AWS_WRONG_SIZE: "1" });
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.stderr, /different size/);
  const mismatchCalls = await readFile(callLog, "utf8");
  assert.equal(mismatchCalls.includes("curl heartbeat"), false, "no heartbeat after a failed verification");
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
