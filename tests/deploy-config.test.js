import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readServerConfig } from "../launcher/server.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

// Parses the KEY=value lines of an EnvironmentFile, the way systemd reads /etc/masterqc/env.
function parseEnvironmentFile(text) {
  const values = {};
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    assert.ok(match, `not a KEY=value line: ${line}`);
    values[match[1]] = match[2];
  }
  return values;
}

test("the example environment file configures a hosted server with the trusted operator header", async () => {
  const values = parseEnvironmentFile(await readFile(path.join(PROJECT_ROOT, "deploy", "env.example"), "utf8"));
  assert.equal(values.MASTERQC_TRUSTED_USER_HEADER, "x-remote-user");
  const config = readServerConfig(values, { projectRoot: PROJECT_ROOT });
  assert.equal(config.hosted, true);
  assert.equal(config.publicOrigin, "https://qc.example.com");
  assert.equal(config.trustedUserHeader, "x-remote-user");
  assert.equal(config.listenHost, "127.0.0.1");
  assert.equal(config.listenPort, 4173);
  assert.equal(config.demoEnabled, false);
  assert.equal(config.dataDirectory, "/var/lib/masterqc", "the production data directory is absolute");
});

test("the Caddy example replaces any client-supplied X-Remote-User with the Basic Auth user name", async () => {
  const caddyfile = await readFile(path.join(PROJECT_ROOT, "deploy", "Caddyfile.example"), "utf8");
  const proxyBlock = /reverse_proxy 127\.0\.0\.1:4173 \{([\s\S]*?)\n\t\}/.exec(caddyfile);
  assert.ok(proxyBlock, "the reverse_proxy block exists");
  assert.match(proxyBlock[1], /^\t\theader_up X-Remote-User \{http\.auth\.user\.id\}$/m);
  assert.match(proxyBlock[1], /header_up replaces any/, "the block explains why header_up is used");
  assert.equal(/request_header\s+-X-Remote-User/.test(caddyfile), false, "a bare delete is not the mechanism");
});

test("the release script is executable and passes bash's syntax check", { skip: process.platform === "win32" ? "POSIX file modes do not apply on Windows." : false }, async () => {
  const script = path.join(PROJECT_ROOT, "deploy", "release.sh");
  const details = await stat(script);
  assert.notEqual(details.mode & 0o111, 0, "release.sh is executable");
  const result = await execFileAsync("bash", ["-n", script]);
  assert.equal(result.stderr, "");
});

test("the release script names every setting it reads, so the operator can find them", async () => {
  const script = await readFile(path.join(PROJECT_ROOT, "deploy", "release.sh"), "utf8");
  for (const setting of [
    "MASTERQC_ROOT",
    "MASTERQC_DATA_DIR",
    "MASTERQC_BACKUPS_DIR",
    "MASTERQC_ENV_FILE",
    "MASTERQC_VERIFY_PORT",
    "MASTERQC_SERVICE_UNIT",
    "MASTERQC_SERVICE_USER",
    "MASTERQC_NODE",
    "MASTERQC_HEALTH_TIMEOUT",
    "MASTERQC_VERIFY_TIMEOUT",
    "SYSTEMCTL",
  ]) {
    assert.ok(script.includes(setting), setting);
  }
  assert.match(script, /^set -euo pipefail$/m);
});
