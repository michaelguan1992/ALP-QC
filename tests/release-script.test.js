import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createQCService } from "../core/qc-service.js";
import { createSQLiteQCAdapter } from "../storage/sqlite-qc-adapter.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_SCRIPT = path.join(PROJECT_ROOT, "deploy", "release.sh");
// The parts of the project that a release needs to start and verify. The data directory is never copied.
const FIXTURE_DIRECTORIES = ["launcher", "core", "storage", "frontend", "scripts"];
const DATE = "2026-10-17";
const GIT_IDENTITY = ["-c", "user.name=Release Test", "-c", "user.email=release-test@example.invalid"];
const RELEASE_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{7,40}$/;

// The stub systemctl. It records each call and runs a real server child from the current release, the way systemd
// would. A marker file makes the next start fail, which lets a test simulate a release that never becomes healthy.
const STUB_SYSTEMCTL = `#!${process.execPath}
import { appendFileSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const [command] = process.argv.slice(2);
const stubDirectory = process.env.STUB_DIR;
const root = process.env.MASTERQC_ROOT;
const pidFile = path.join(stubDirectory, "child.pid");
appendFileSync(path.join(stubDirectory, "calls.log"), command + " masterqc.service\\n");

function isAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    // A child that has exited but was not reaped is a zombie; it no longer holds its port.
    return !/\\) Z /.test(readFileSync("/proc/" + pid + "/stat", "utf8"));
  } catch {
    return false;
  }
}

async function stopChild() {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8"));
  if (isAlive(pid)) {
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + 10000;
    while (isAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  rmSync(pidFile, { force: true });
}

function readEnvironmentFile(file) {
  const values = {};
  for (const line of readFileSync(file, "utf8").split("\\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

if (command === "stop") {
  await stopChild();
} else if (command === "restart") {
  await stopChild();
  const failMarker = path.join(stubDirectory, "fail-next-start");
  let args;
  if (existsSync(failMarker)) {
    rmSync(failMarker);
    args = ["-e", "process.exit(1)"];
  } else {
    args = [path.join(root, "current", "launcher", "server.mjs"), "--no-open"];
  }
  const environment = { ...readEnvironmentFile(process.env.MASTERQC_ENV_FILE), PATH: process.env.PATH, HOME: process.env.HOME };
  const log = openSync(path.join(stubDirectory, "server.log"), "a");
  appendFileSync(path.join(stubDirectory, "server.log"), "stub spawning " + JSON.stringify(args) + "\\n");
  const child = spawn(process.execPath, args, { cwd: path.join(root, "current"), env: environment, detached: true, stdio: ["ignore", log, log] });
  child.on("error", (error) => appendFileSync(path.join(stubDirectory, "server.log"), "spawn error: " + error.message + "\\n"));
  child.unref();
  writeFileSync(pidFile, String(child.pid));
} else {
  console.error("unsupported command " + command);
  process.exit(2);
}
`;

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "masterqc-release-script-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", ...options }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

async function git(args, cwd) {
  const result = await run("git", [...GIT_IDENTITY, ...args], { cwd });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function getJson(port, requestPath) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: requestPath,
      headers: { host: `127.0.0.1:${port}` },
      agent: false,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    request.on("error", reject);
    request.end();
  });
}

async function waitUntil(predicate, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

// Creates the project repository that releases are fetched from. Its tracked files include a database placeholder
// and PDF sources, which a release must not ship.
async function createOrigin(base) {
  const origin = path.join(base, "origin");
  mkdirSync(origin);
  for (const directory of FIXTURE_DIRECTORIES) cpSync(path.join(PROJECT_ROOT, directory), path.join(origin, directory), { recursive: true });
  cpSync(path.join(PROJECT_ROOT, "package.json"), path.join(origin, "package.json"));
  mkdirSync(path.join(origin, "data", "workspace"), { recursive: true });
  writeFileSync(path.join(origin, "data", "workspace", "masterqc-main.sqlite"), "tracked placeholder, not a database\n");
  mkdirSync(path.join(origin, "data", "pdf-import"), { recursive: true });
  writeFileSync(path.join(origin, "data", "pdf-import", "summary.json"), "{}\n");
  await git(["init", "-q"], origin);
  await git(["symbolic-ref", "HEAD", "refs/heads/main"], origin);
  await git(["add", "-A"], origin);
  await git(["commit", "-q", "-m", "Initial release fixture"], origin);
  return origin;
}

async function commitChange(origin, relativeFile, text, message) {
  appendFileSync(path.join(origin, relativeFile), text);
  await git(["add", "-A"], origin);
  await git(["commit", "-q", "-m", message], origin);
  return git(["rev-parse", "HEAD"], origin);
}

// Builds a production-like installation: a clone, one installed release, a seeded data directory, an environment file,
// and a stub systemctl with its server running on a free port. The first release is installed by hand, as in the docs.
async function createProduction(t) {
  // Registered before the directory cleanup, so it runs first and can still find the server's pid file.
  let stopServer = async () => {};
  t.after(() => stopServer());
  const base = await temporaryDirectory(t);
  const origin = await createOrigin(base);
  const root = path.join(base, "opt", "masterqc");
  const releases = path.join(root, "releases");
  const dataDirectory = path.join(base, "data");
  const backups = path.join(base, "backups");
  const etc = path.join(base, "etc");
  const stubDirectory = path.join(base, "stub");
  mkdirSync(releases, { recursive: true });
  mkdirSync(dataDirectory);
  mkdirSync(backups);
  mkdirSync(etc);
  mkdirSync(stubDirectory);
  mkdirSync(path.join(base, "bin"));
  await git(["clone", "-q", origin, path.join(root, "repo")], base);

  // Synthetic production data: one purchase order, enough to make the counts and the snapshot meaningful.
  const seed = createQCService(createSQLiteQCAdapter({ databasePath: path.join(dataDirectory, "masterqc-main.sqlite") }));
  const initial = await seed.initialize();
  const variant = initial.variants.find((item) => item.model === "S15" && item.color === "Red");
  await seed.command("createOrder", {
    number: "PO-SEED",
    date: DATE,
    supplier: "Synthetic supplier",
    notes: "release test data",
    lines: [{ variantId: variant.id, orderedQty: 10 }],
  }, initial.revision);
  await seed.close();

  const shortSha = (sha) => git(["rev-parse", "--short=7", sha], path.join(root, "repo"));
  const firstSha = await git(["rev-parse", "HEAD"], path.join(root, "repo"));
  const firstId = `20200101T000000Z-${await shortSha(firstSha)}`;
  const firstDirectory = path.join(releases, firstId);
  mkdirSync(firstDirectory);
  const archived = await run("bash", ["-c", `git -C "${path.join(root, "repo")}" archive --format=tar ${firstSha} | tar -x -C "${firstDirectory}"`]);
  assert.equal(archived.code, 0, archived.stderr);
  rmSync(path.join(firstDirectory, "data", "workspace"), { recursive: true, force: true });
  writeFileSync(path.join(firstDirectory, "RELEASE"), `${firstId}\n`);
  await run("ln", ["-s", firstDirectory, path.join(root, "current")]);

  const [servicePort, verifyPort] = [await freePort(), await freePort()];
  const envFile = path.join(etc, "env");
  writeFileSync(envFile, [
    `MASTERQC_DATA_DIR=${dataDirectory}`,
    "MASTERQC_PUBLIC_ORIGIN=https://qc.example.test",
    "MASTERQC_LISTEN_HOST=127.0.0.1",
    `MASTERQC_LISTEN_PORT=${servicePort}`,
    "MASTERQC_DEMO=off",
    "",
  ].join("\n"));
  const stubPath = path.join(base, "bin", "systemctl");
  writeFileSync(stubPath, STUB_SYSTEMCTL);
  chmodSync(stubPath, 0o755);

  const env = {
    PATH: process.env.PATH,
    HOME: base,
    MASTERQC_ROOT: root,
    MASTERQC_ENV_FILE: envFile,
    MASTERQC_BACKUPS_DIR: backups,
    MASTERQC_VERIFY_PORT: String(verifyPort),
    // Tests run as the developer, so the verification server does not switch to a service account.
    MASTERQC_SERVICE_USER: "",
    MASTERQC_NODE: process.execPath,
    MASTERQC_HEALTH_TIMEOUT: "10",
    MASTERQC_VERIFY_TIMEOUT: "30",
    SYSTEMCTL: stubPath,
    STUB_DIR: stubDirectory,
  };
  const production = {
    base, origin, root, releases, backups, dataDirectory, stubDirectory, stubPath, env, servicePort, verifyPort, firstId, firstSha,
    calls: () => readFileSync(path.join(stubDirectory, "calls.log"), "utf8").trim().split("\n").filter(Boolean),
    releaseScript: (args) => run("bash", [RELEASE_SCRIPT, ...args], { env, cwd: base }),
    currentId: () => readFileSync(path.join(readlinkSync(path.join(root, "current")), "RELEASE"), "utf8").trim(),
    previousId: () => readFileSync(path.join(readlinkSync(path.join(root, "previous")), "RELEASE"), "utf8").trim(),
    servedRelease: async () => (await getJson(servicePort, "/api/session")).json.release,
    stub: (command) => run(stubPath, [command, "masterqc.service"], { env }),
    shortSha,
  };

  stopServer = async () => {
    await production.stub("stop");
  };
  const started = await production.stub("restart");
  const healthy = await waitUntil(async () => {
    try {
      return (await getJson(servicePort, "/healthz")).status === 200;
    } catch {
      return false;
    }
  }, 20);
  const serverLog = path.join(stubDirectory, "server.log");
  const diagnostics = `stub exit ${started.code}: ${started.stderr}${started.stdout}; calls: ${production.calls().join(", ")}; log: ${existsSync(serverLog) ? readFileSync(serverLog, "utf8") : "(none)"}`;
  assert.ok(healthy, `the stub started the production server (${diagnostics})`);
  return production;
}

test("a release verifies the candidate, switches production, and keeps only the newest five releases", { skip: process.platform !== "linux" ? "The release script targets Linux." : false }, async (t) => {
  const production = await createProduction(t);
  const candidate = await commitChange(production.origin, "launcher/server.mjs", "// release fixture B\n", "Release B");
  // Older releases stand in for history, so the retention rule has something to prune.
  for (let index = 1; index <= 6; index += 1) {
    mkdirSync(path.join(production.releases, `20190101T00000${index}Z-aaaaaaa`));
  }

  const result = await production.releaseScript(["main"]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Verification passed on port/);
  assert.match(result.stdout, /Release .* is live and healthy\./);

  const newId = production.currentId();
  assert.match(newId, RELEASE_ID_PATTERN);
  const candidateShort = await git(["rev-parse", "--short=7", candidate], production.origin);
  assert.equal(newId.endsWith(`-${candidateShort}`), true, "the release is named for the fetched commit");
  assert.equal(production.previousId(), production.firstId, "the previous link points at the release that was live");
  assert.equal(await production.servedRelease(), newId, "production reports the new release");
  assert.equal(existsSync(path.join(production.root, "current", "data", "workspace", "masterqc-main.sqlite")), false, "the tracked database is removed from the release");
  assert.equal(existsSync(path.join(production.root, "current", "data", "pdf-import")), false, "the PDF sources are not shipped");

  const snapshots = readdirSync(path.join(production.backups, "pre-release")).filter((name) => name.endsWith(".sqlite"));
  assert.equal(snapshots.length, 1, "one pre-release snapshot is kept");
  const snapshotService = createQCService(createSQLiteQCAdapter({ databasePath: path.join(production.backups, "pre-release", snapshots[0]) }));
  try {
    assert.equal((await snapshotService.getState()).orders.length, 1, "the snapshot holds the live records");
  } finally {
    await snapshotService.close();
  }
  assert.deepEqual(readdirSync(path.join(production.backups, "verify")), [], "the verification copy is removed");
  assert.deepEqual(readdirSync(production.releases).sort(), [
    newId,
    production.firstId,
    "20190101T000006Z-aaaaaaa",
    "20190101T000005Z-aaaaaaa",
    "20190101T000004Z-aaaaaaa",
  ].sort(), "the five newest releases remain");
  assert.equal(production.calls().length, 2, "production was restarted once, after the initial start");
});

test("a candidate that fails verification leaves production on the current release", { skip: process.platform !== "linux" ? "The release script targets Linux." : false }, async (t) => {
  const production = await createProduction(t);
  await commitChange(production.origin, "launcher/server.mjs", "}\n", "Release with a syntax error");

  const result = await production.releaseScript(["main"]);
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /The new release failed verification\. Production was not changed\./);
  assert.match(result.stdout, /did not start on port/, "the candidate's log is shown");
  assert.equal(production.currentId(), production.firstId);
  assert.equal(existsSync(path.join(production.root, "previous")), false, "no previous link is written before the candidate passes");
  assert.equal(await production.servedRelease(), production.firstId);
  assert.equal(production.calls().length, 1, "production was not restarted");
  assert.deepEqual(readdirSync(path.join(production.backups, "verify")), [], "the verification copy is removed");
});

test("a release that does not become healthy after the switch is replaced by the previous release", { skip: process.platform !== "linux" ? "The release script targets Linux." : false }, async (t) => {
  const production = await createProduction(t);
  await commitChange(production.origin, "launcher/server.mjs", "// release fixture D\n", "Release D");
  // The next start (the post-switch restart) fails, while the verification server still starts.
  writeFileSync(path.join(production.stubDirectory, "fail-next-start"), "");

  const result = await production.releaseScript(["main"]);
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /did not become healthy within 10 seconds\. Switching back to the previous release\./);
  assert.match(result.stdout, /The previous release is live and healthy again\./);
  assert.equal(production.currentId(), production.firstId, "current is switched back");
  assert.equal(production.previousId(), production.firstId);
  assert.equal(await production.servedRelease(), production.firstId, "production serves the previous release again");
  assert.match(result.stdout, /Database data was not restored automatically\./);
  // The restore command names the live release by its resolved path, which is the code that is actually installed.
  assert.match(result.stdout, new RegExp(`node \\S*${production.firstId}/launcher/restore-snapshot\\.mjs \\S*pre-release/\\S*\\.sqlite`));
  assert.equal(production.calls().length, 3, "initial start, failed post-switch start, and switch-back start");
});

test("--rollback switches back to the previous release, and a second rollback returns to the one it left", { skip: process.platform !== "linux" ? "The release script targets Linux." : false }, async (t) => {
  const production = await createProduction(t);
  await commitChange(production.origin, "launcher/server.mjs", "// release fixture B\n", "Release B");
  const released = await production.releaseScript(["main"]);
  assert.equal(released.code, 0, `${released.stdout}\n${released.stderr}`);
  const releasedId = production.currentId();

  const rolledBack = await production.releaseScript(["--rollback"]);
  assert.equal(rolledBack.code, 0, `${rolledBack.stdout}\n${rolledBack.stderr}`);
  assert.match(rolledBack.stdout, /Rolled back to /);
  assert.match(rolledBack.stdout, /restore-snapshot\.mjs/, "the restore guidance is printed, not applied");
  assert.equal(production.currentId(), production.firstId);
  assert.equal(production.previousId(), releasedId, "the two links swap");
  assert.equal(await production.servedRelease(), production.firstId);

  const again = await production.releaseScript(["--rollback"]);
  assert.equal(again.code, 0, `${again.stdout}\n${again.stderr}`);
  assert.equal(production.currentId(), releasedId);
  assert.equal(await production.servedRelease(), releasedId);
});

test("a release is refused when production is not answering or the ref does not exist", { skip: process.platform !== "linux" ? "The release script targets Linux." : false }, async (t) => {
  const production = await createProduction(t);
  await production.stub("stop");
  const down = await production.releaseScript(["main"]);
  assert.equal(down.code, 1);
  assert.match(down.stderr, new RegExp(`not answering on 127\\.0\\.0\\.1:${production.servicePort}`));
  assert.equal(production.currentId(), production.firstId, "nothing changed");

  await production.stub("restart");
  await waitUntil(async () => {
    try {
      return (await getJson(production.servicePort, "/healthz")).status === 200;
    } catch {
      return false;
    }
  }, 20);
  const unknown = await production.releaseScript(["no-such-ref"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Git ref not found: no-such-ref/);
  assert.equal(production.currentId(), production.firstId);
});

test("the release script prints usage with status 2, and a rollback without a previous release explains why", { skip: process.platform !== "linux" ? "The release script targets Linux." : false }, async (t) => {
  const production = await createProduction(t);
  const noArguments = await production.releaseScript([]);
  assert.equal(noArguments.code, 2);
  assert.match(noArguments.stderr, /Usage: release\.sh <git-ref> \| --rollback/);
  const extra = await production.releaseScript(["--rollback", "extra"]);
  assert.equal(extra.code, 2);

  const rollback = await production.releaseScript(["--rollback"]);
  assert.equal(rollback.code, 1);
  assert.match(rollback.stderr, /No previous release is recorded/);
  assert.equal(lstatSync(path.join(production.root, "current")).isSymbolicLink(), true, "a refused rollback leaves current alone");
});
