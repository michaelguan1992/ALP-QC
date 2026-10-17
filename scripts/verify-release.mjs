// Verifies a new release against a running server, which the release script starts on an internal port with a
// fresh copy of production. The check runs the startup upgrades, reads the state back, compares record counts with
// the counts taken from the live release before the snapshot, and downloads every attachment.
//
// Usage: node scripts/verify-release.mjs --base-url <url> --host-header <host:port> --origin <origin> --expect <counts.json>
// Exit status: 0 when every check passes, 1 when a check fails, 2 for invalid arguments.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { isEntryPoint } from "../launcher/entry-point.mjs";
import { EXACT_COLLECTIONS, countRecords, decodeDataUrlBytes, parseExpectedCounts, requestJson } from "./release-lib.mjs";

const USAGE = "Usage: node scripts/verify-release.mjs --base-url <url> --host-header <host:port> --origin <origin> --expect <counts.json> [--timeout-ms <ms>]";

export class VerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "VerificationError";
  }
}

// Sends one request. A connection failure is reported as a verification failure with its cause.
async function send(label, options) {
  try {
    return await requestJson(options);
  } catch (error) {
    throw new VerificationError(`${label} could not reach the server: ${error.message}`);
  }
}

function describeFailure(response) {
  const message = response.json?.error;
  return typeof message === "string" && message ? ` (${message})` : "";
}

// Compares counts from the new release with the expected counts. Exact collections must match; the others may grow.
export function compareCounts(actual, expected) {
  if (expected.revision !== undefined && actual.revision < expected.revision) {
    throw new VerificationError(`The revision is ${actual.revision}; expected at least ${expected.revision}.`);
  }
  for (const [name, expectedCount] of Object.entries(expected)) {
    if (name === "revision") continue;
    const actualCount = actual[name];
    if (actualCount === undefined) throw new VerificationError(`${name} is missing from the upgraded state.`);
    if (EXACT_COLLECTIONS.includes(name)) {
      if (actualCount !== expectedCount) {
        throw new VerificationError(`${name} has ${actualCount} records; expected exactly ${expectedCount}.`);
      }
    } else if (actualCount < expectedCount) {
      throw new VerificationError(`${name} has ${actualCount} records; expected at least ${expectedCount}.`);
    }
  }
}

/**
 * Runs every release check against the server at baseUrl. Resolves with the revision, counts, and attachment totals,
 * and rejects with a VerificationError that names the first failed check.
 */
export async function verifyRelease({ baseUrl, hostHeader, origin, expected, timeoutMs = 30000 }) {
  const health = await send("The health check", { baseUrl, path: "/healthz", hostHeader, timeoutMs });
  if (health.status !== 200 || health.json?.ok !== true) {
    throw new VerificationError(`The health check returned HTTP ${health.status}.`);
  }

  // Initialization runs the startup upgrades. The lightweight mode keeps attachment bodies out of this step.
  const initialized = await send("Startup", {
    baseUrl,
    path: "/api/qc/main/initialize",
    method: "POST",
    hostHeader,
    origin,
    body: { mode: "lightweight" },
    timeoutMs,
  });
  if (initialized.status !== 200) {
    throw new VerificationError(`Startup upgrades failed: initialize returned HTTP ${initialized.status}${describeFailure(initialized)}.`);
  }

  const stateResponse = await send("The state read", { baseUrl, path: "/api/qc/main/state/lightweight", hostHeader, timeoutMs });
  if (stateResponse.status !== 200 || !stateResponse.json) {
    throw new VerificationError(`The state read returned HTTP ${stateResponse.status}${describeFailure(stateResponse)}.`);
  }
  const state = stateResponse.json;
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) {
    throw new VerificationError("The upgraded state does not have a whole-number revision.");
  }
  const counts = countRecords(state);
  compareCounts(counts, expected);

  let attachmentBytes = 0;
  for (const asset of state.assets) {
    const response = await send(`Attachment ${asset.id}`, {
      baseUrl,
      path: `/api/qc/main/assets/${encodeURIComponent(asset.id)}`,
      hostHeader,
      timeoutMs,
    });
    if (response.status !== 200 || response.json?.id !== asset.id) {
      throw new VerificationError(`Attachment ${asset.id} could not be read (HTTP ${response.status}${describeFailure(response)}).`);
    }
    const decodedBytes = decodeDataUrlBytes(response.json.dataUrl);
    if (decodedBytes === null) throw new VerificationError(`Attachment ${asset.id} is not a valid base64 data URL.`);
    if (Number.isSafeInteger(asset.decodedBytes) && decodedBytes !== asset.decodedBytes) {
      throw new VerificationError(`Attachment ${asset.id} decodes to ${decodedBytes} bytes, but its metadata records ${asset.decodedBytes}.`);
    }
    attachmentBytes += decodedBytes;
  }

  return { revision: state.revision, counts, attachments: state.assets.length, attachmentBytes };
}

export function summarizeVerification(result) {
  const records = Object.entries(result.counts)
    .filter(([name]) => name !== "revision")
    .map(([name, count]) => `${name} ${count}`)
    .join(", ");
  const attachmentMiB = (result.attachmentBytes / (1024 * 1024)).toFixed(2);
  const attachmentWord = result.attachments === 1 ? "attachment" : "attachments";
  return `Release verification passed: revision ${result.revision}; records: ${records}; checked ${result.attachments} ${attachmentWord} (${attachmentMiB} MiB).`;
}

export function parseCommandLine(argv) {
  return parseArgs({
    args: argv,
    options: {
      "base-url": { type: "string" },
      "host-header": { type: "string" },
      origin: { type: "string" },
      expect: { type: "string" },
      "timeout-ms": { type: "string", default: "30000" },
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
  for (const name of ["base-url", "host-header", "origin", "expect"]) {
    if (!options[name]) {
      console.error(`--${name} is required.\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
  }
  const timeoutMs = Number(options["timeout-ms"]);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    console.error(`--timeout-ms must be a positive whole number.\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  let expected;
  try {
    const text = await readFile(path.resolve(options.expect), "utf8");
    expected = parseExpectedCounts(JSON.parse(text));
  } catch (error) {
    console.error(`The counts file is not usable: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  try {
    const result = await verifyRelease({
      baseUrl: options["base-url"],
      hostHeader: options["host-header"],
      origin: options.origin,
      expected,
      timeoutMs,
    });
    console.log(summarizeVerification(result));
  } catch (error) {
    const reason = error instanceof VerificationError ? error.message : `Unexpected error: ${error.message}`;
    console.error(`Release verification failed: ${reason}`);
    process.exitCode = 1;
  }
}

if (isEntryPoint(import.meta.url)) {
  await runCommand(process.argv.slice(2));
}
