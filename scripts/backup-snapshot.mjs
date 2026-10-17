// Writes a verified, consistent copy of one workspace database and a JSON manifest that describes it.
// The live database is opened read-only, so this command never writes to it.
//
// Usage: node scripts/backup-snapshot.mjs --data-dir <directory> --out-dir <directory> [--workspace main]
// On success it prints the manifest path on stdout and exits 0. On failure it removes its partial output and exits 1.
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, createReadStream, existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { isEntryPoint } from "../launcher/entry-point.mjs";
import { WORKSPACE_DATABASE_FILES } from "../launcher/server.mjs";

const USAGE = "Usage: node scripts/backup-snapshot.mjs --data-dir <directory> --out-dir <directory> [--workspace main|demo]";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUSY_TIMEOUT_MS = 10000;
// Matches STATE_KEY in storage/sqlite-qc-adapter.mjs. The revision is read with the same query the adapter uses.
const STATE_KEY = "main";

function readAppVersion() {
  return JSON.parse(readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")).version;
}

// Compact UTC timestamp for file names, for example 20261017T010203Z.
function utcStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function sqlStringLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// readOnly means a missing file raises an error instead of creating an empty database.
function openReadOnly(filePath) {
  const database = new DatabaseSync(filePath, { readOnly: true });
  try {
    database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}

function checkIntegrity(database) {
  const results = database.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check);
  if (results.length !== 1 || results[0] !== "ok") {
    throw new Error(`The copy failed SQLite integrity_check: ${results.join("; ")}`);
  }
}

function readRevision(database) {
  const notWorkspace = "The database has no saved QC state, so it is not a MasterQC workspace.";
  const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'qc_state'").get();
  if (!table) throw new Error(notWorkspace);
  const row = database.prepare("SELECT revision FROM qc_state WHERE state_key = ?").get(STATE_KEY);
  if (!row) throw new Error(notWorkspace);
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("The saved QC revision is not a valid whole number.");
  return revision;
}

/**
 * Copies one workspace database into outDirectory and writes its manifest.
 * File names use the copy's own revision, so the manifest always matches the bytes it describes.
 */
export async function createBackupSnapshot({
  dataDirectory,
  outDirectory,
  workspace = "main",
  now = new Date(),
  appVersion = readAppVersion(),
} = {}) {
  if (typeof dataDirectory !== "string" || !dataDirectory.trim()) throw new Error("A data directory is required.");
  if (typeof outDirectory !== "string" || !outDirectory.trim()) throw new Error("An output directory is required.");
  if (!Object.hasOwn(WORKSPACE_DATABASE_FILES, workspace)) throw new Error("The workspace must be main or demo.");

  const sourcePath = path.join(path.resolve(dataDirectory), WORKSPACE_DATABASE_FILES[workspace]);
  if (!existsSync(sourcePath)) throw new Error(`The ${workspace} database was not found in the data directory.`);
  const targetDirectory = path.resolve(outDirectory);
  mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });

  const partialPath = path.join(targetDirectory, `.masterqc-${workspace}-${randomUUID()}.partial.sqlite`);
  let snapshotPath = null;
  let manifestPath = null;
  try {
    // VACUUM INTO reads one consistent snapshot through the read-only connection and writes it to a new file.
    const source = openReadOnly(sourcePath);
    try {
      source.exec(`VACUUM INTO ${sqlStringLiteral(partialPath)}`);
    } finally {
      source.close();
    }

    const copy = openReadOnly(partialPath);
    let revision;
    try {
      checkIntegrity(copy);
      revision = readRevision(copy);
    } finally {
      copy.close();
    }

    const baseName = `masterqc-${workspace}-${utcStamp(now)}-r${revision}`;
    // linkSync and writeFileSync with the wx flag refuse to replace an existing file, so earlier backups survive.
    const candidateSnapshotPath = path.join(targetDirectory, `${baseName}.sqlite`);
    linkSync(partialPath, candidateSnapshotPath);
    snapshotPath = candidateSnapshotPath;
    // Like the live database, the copy is readable only by its owner.
    chmodSync(snapshotPath, 0o600);

    const manifest = {
      file: `${baseName}.sqlite`,
      bytes: statSync(snapshotPath).size,
      sha256: await sha256OfFile(snapshotPath),
      revision,
      createdAt: now.toISOString(),
      appVersion,
    };
    const candidateManifestPath = path.join(targetDirectory, `${baseName}.json`);
    writeFileSync(candidateManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    manifestPath = candidateManifestPath;
    return { manifestPath, snapshotPath, manifest };
  } catch (error) {
    // Only files this call created are removed. A file that already existed was refused above and is not touched.
    for (const created of [manifestPath, snapshotPath]) {
      if (created) rmSync(created, { force: true });
    }
    throw error;
  } finally {
    rmSync(partialPath, { force: true });
    rmSync(`${partialPath}-journal`, { force: true });
  }
}

export function parseCommandLine(argv) {
  return parseArgs({
    args: argv,
    options: {
      "data-dir": { type: "string" },
      "out-dir": { type: "string" },
      workspace: { type: "string", default: "main" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  }).values;
}

async function runCommand(argv) {
  let options;
  try {
    options = parseCommandLine(argv);
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (!options["data-dir"] || !options["out-dir"]) {
    console.error(`--data-dir and --out-dir are required.\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  try {
    const { manifestPath } = await createBackupSnapshot({
      dataDirectory: options["data-dir"],
      outDirectory: options["out-dir"],
      workspace: options.workspace,
    });
    process.stdout.write(`${manifestPath}\n`);
  } catch (error) {
    console.error(`Backup failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (isEntryPoint(import.meta.url)) {
  await runCommand(process.argv.slice(2));
}
