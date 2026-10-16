import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  createReadStream,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
} from "node:fs";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { createQCService } from "../core/qc-service.js";
import { createSQLiteQCAdapter } from "../storage/sqlite-qc-adapter.mjs";
import { HOST, PORT, WORKSPACE_DATABASE_FILES, getDefaultDataDirectory } from "./server.mjs";

const USAGE = "Usage: node launcher/restore-snapshot.mjs <snapshot-file> [--workspace main|demo]";
const JOURNAL_SUFFIXES = ["-journal", "-wal", "-shm"];
const REQUIRED_TABLES = ["qc_state", "qc_adapter_meta", "qc_asset_payloads"];

function fileTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

// Resolves true when something accepts a TCP connection on host:port, and false when the port refuses it.
function isPortListening(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(2000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("the port did not answer in time"));
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
  });
}

async function assertServiceStopped({ host, port }) {
  let listening;
  try {
    listening = await isPortListening(host, port);
  } catch (error) {
    throw new Error(`Could not confirm that ${host}:${port} is free (${error.message}). Stop MasterQC Web, then run this command again.`);
  }
  if (listening) {
    throw new Error(`MasterQC Web is running on ${host}:${port}. Stop it first (press Ctrl+C in its terminal), then run this command again.`);
  }
}

function assertNoJournalFiles(databasePath) {
  const leftovers = JOURNAL_SUFFIXES.map((suffix) => `${databasePath}${suffix}`).filter((file) => existsSync(file));
  if (leftovers.length > 0) {
    throw new Error(`SQLite journal files exist next to the live database (${leftovers.map((file) => path.basename(file)).join(", ")}). Resolve them before restoring.`);
  }
}

function isSameFile(left, right) {
  if (!existsSync(left) || !existsSync(right)) return false;
  const leftDetails = statSync(left, { bigint: true });
  const rightDetails = statSync(right, { bigint: true });
  return leftDetails.dev === rightDetails.dev && leftDetails.ino === rightDetails.ino;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function flushFile(filePath) {
  const descriptor = openSync(filePath, "r+");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

// SQLite's own checks run before any MasterQC adapter opens the file. The adapter creates missing tables,
// so an unrelated database would otherwise be initialized as an empty workspace.
function checkSqliteFile(filePath) {
  let database;
  let integrity;
  try {
    database = new DatabaseSync(filePath);
    integrity = database.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check);
  } catch (error) {
    database?.close();
    throw new Error(`The snapshot is not a readable SQLite database (${error.message}).`);
  }
  try {
    if (integrity.length !== 1 || integrity[0] !== "ok") {
      throw new Error(`The snapshot failed SQLite integrity_check: ${integrity.join("; ")}`);
    }
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    if (REQUIRED_TABLES.some((table) => !tables.has(table))) throw new Error("The snapshot is not a MasterQC database.");
    if (!database.prepare("SELECT 1 AS saved FROM qc_state WHERE state_key = 'main'").get()) {
      throw new Error("The snapshot contains no saved QC state.");
    }
  } finally {
    database.close();
  }
}

// Each historical source record stores the SHA-256 of its original PDF. Each PDF is read on its own.
async function verifyHistorySourceDigests(adapter, state) {
  for (const source of state.history?.sources ?? []) {
    const asset = await adapter.readAsset(source.assetId);
    if (!asset) throw new Error(`The snapshot is missing the original historical PDF ${source.fileName}.`);
    const bytes = Buffer.from(asset.dataUrl.slice(asset.dataUrl.indexOf(",") + 1), "base64");
    if (createHash("sha256").update(bytes).digest("hex") !== String(source.sha256).toLowerCase()) {
      throw new Error(`The snapshot's SHA-256 does not match historical PDF ${source.fileName}.`);
    }
  }
}

// Opens the validated copy with the current adapter and service. Initialization may upgrade an older format
// on this copy. Each attachment payload is verified one row at a time (MIME, size and SHA-256), and the
// business graph is validated against that trusted metadata, so attachment bodies are never loaded together.
async function validateWithCurrentService(filePath) {
  const adapter = createSQLiteQCAdapter({ databasePath: filePath });
  const service = createQCService(adapter);
  try {
    const state = await service.initialize({ mode: "lightweight" });
    await verifyHistorySourceDigests(adapter, state);
    return {
      revision: state.revision,
      batches: state.batches.length,
      issues: state.issues.length,
      orders: state.orders.length,
      versions: state.versions.length,
      attachments: state.assets.length,
      attachmentBytes: state.assets.reduce((sum, asset) => sum + (Number(asset.decodedBytes) || 0), 0),
    };
  } finally {
    await service.close();
  }
}

/**
 * Replaces one workspace database with a validated SQLite snapshot. The service must be stopped.
 * The previous database is kept beside it under a timestamped name and is never deleted.
 */
export async function restoreSnapshot({
  snapshotPath,
  workspace = "main",
  dataDirectory = getDefaultDataDirectory(),
  host = HOST,
  port = PORT,
} = {}) {
  if (typeof snapshotPath !== "string" || !snapshotPath.trim()) throw new Error("A snapshot file is required.");
  if (!Object.hasOwn(WORKSPACE_DATABASE_FILES, workspace)) throw new Error("The workspace must be main or demo.");

  const resolvedSnapshot = path.resolve(snapshotPath);
  const snapshotDetails = await stat(resolvedSnapshot).catch(() => null);
  if (!snapshotDetails?.isFile() || snapshotDetails.size === 0) {
    throw new Error(`The snapshot file was not found or is empty: ${resolvedSnapshot}`);
  }

  const directory = path.resolve(dataDirectory);
  const databasePath = path.join(directory, WORKSPACE_DATABASE_FILES[workspace]);
  if (isSameFile(resolvedSnapshot, databasePath)) throw new Error("Choose a snapshot file, not the live database.");
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  await assertServiceStopped({ host, port });
  assertNoJournalFiles(databasePath);

  let stagedPath = null;
  let keptPath = null;
  const workDirectory = await mkdtemp(path.join(directory, ".snapshot-restore-"));
  try {
    const checkPath = path.join(workDirectory, "snapshot-check.sqlite");
    await copyFile(resolvedSnapshot, checkPath, fsConstants.COPYFILE_EXCL);
    chmodSync(checkPath, 0o600);
    checkSqliteFile(checkPath);
    const summary = await validateWithCurrentService(checkPath);

    // Stage a same-directory copy of the validated file, so the final rename replaces the live file in one step.
    stagedPath = path.join(directory, `${WORKSPACE_DATABASE_FILES[workspace]}.restore-${randomUUID()}.sqlite`);
    await copyFile(checkPath, stagedPath, fsConstants.COPYFILE_EXCL);
    chmodSync(stagedPath, 0o600);
    flushFile(stagedPath);
    const stagedHash = await sha256File(stagedPath);
    const validatedHash = await sha256File(checkPath);
    if (stagedHash !== validatedHash) throw new Error("The staged copy did not match the validated snapshot.");

    // Recheck just before swapping: the service must still be stopped and no journal may have appeared.
    await assertServiceStopped({ host, port });
    assertNoJournalFiles(databasePath);
    if (existsSync(databasePath)) {
      const candidate = `${databasePath}.before-snapshot-restore-${fileTimestamp()}.sqlite`;
      // A hard link keeps the previous database's bytes under the new name without a second full copy.
      linkSync(databasePath, candidate);
      keptPath = candidate;
    }
    renameSync(stagedPath, databasePath);
    stagedPath = null;
    return { databasePath, keptPath, summary };
  } catch (error) {
    // The live file is still the previous database here, so the extra name is only removed if this run created it.
    if (keptPath) await rm(keptPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    // Cleanup must never replace the outcome: after a successful swap, a leftover temporary name is only a warning.
    if (stagedPath) await removeLeftover(stagedPath);
    await removeLeftover(workDirectory, { recursive: true });
  }
}

async function removeLeftover(target, options = {}) {
  try {
    await rm(target, { force: true, ...options });
  } catch (error) {
    console.warn(`Could not remove the temporary file ${target}: ${error.message}`);
  }
}

function parseArguments(argv) {
  const options = { workspace: "main", snapshotPath: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--workspace") {
      index += 1;
      options.workspace = argv[index] ?? "";
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (options.snapshotPath === null) {
      options.snapshotPath = argument;
    } else {
      throw new Error("Only one snapshot file can be restored at a time.");
    }
  }
  return options;
}

async function runCommand(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (!options.snapshotPath) {
    console.error(`A snapshot file is required.\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (!Object.hasOwn(WORKSPACE_DATABASE_FILES, options.workspace)) {
    console.error(`The workspace must be main or demo.\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  const started = Date.now();
  try {
    const { databasePath, keptPath, summary } = await restoreSnapshot({
      snapshotPath: options.snapshotPath,
      workspace: options.workspace,
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const attachmentMiB = (summary.attachmentBytes / (1024 * 1024)).toFixed(2);
    console.log(`Snapshot checked: revision ${summary.revision}; batches ${summary.batches}; issues ${summary.issues}; orders ${summary.orders}; versions ${summary.versions}; attachments ${summary.attachments} (${attachmentMiB} MiB). Every payload was verified for MIME type, size and SHA-256.`);
    console.log(`Restored the ${options.workspace} workspace into ${databasePath} in ${seconds} s.`);
    console.log(keptPath
      ? `Previous database kept at: ${keptPath}`
      : "No previous database existed at that path, so nothing was kept.");
    console.log("Start MasterQC Web again to use the restored data.");
  } catch (error) {
    console.error(`Restore failed: ${error.message}`);
    console.error("The live database was not changed.");
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  await runCommand(process.argv.slice(2));
}
