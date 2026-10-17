// Prints the record counts of a running MasterQC server as JSON. The release script saves this output as the
// "before" counts that the new release must keep. It reads over HTTP only and never opens the database file.
//
// Usage: node scripts/count-records.mjs --base-url <url> --host-header <host:port> [--timeout-ms <ms>]
// Exit status: 0 on success, 1 when the server cannot be read, 2 for invalid arguments.
import { parseArgs } from "node:util";
import { isEntryPoint } from "../launcher/entry-point.mjs";
import { countRecords, requestJson } from "./release-lib.mjs";

const USAGE = "Usage: node scripts/count-records.mjs --base-url <url> --host-header <host:port> [--timeout-ms <ms>]";

export function parseCommandLine(argv) {
  return parseArgs({
    args: argv,
    options: {
      "base-url": { type: "string" },
      "host-header": { type: "string" },
      "timeout-ms": { type: "string", default: "30000" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  }).values;
}

// Reads the lightweight state through the same route the browser uses for its revision and record checks.
export async function readRecordCounts({ baseUrl, hostHeader, timeoutMs = 30000 }) {
  const response = await requestJson({
    baseUrl,
    path: "/api/qc/main/state/lightweight",
    hostHeader,
    timeoutMs,
  });
  if (response.status !== 200 || !response.json || typeof response.json !== "object") {
    throw new Error(`The state request returned HTTP ${response.status}.`);
  }
  if (!Number.isSafeInteger(response.json.revision) || response.json.revision < 0) {
    throw new Error("The state response does not contain a whole-number revision.");
  }
  return countRecords(response.json);
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
  if (!options["base-url"] || !options["host-header"]) {
    console.error(`--base-url and --host-header are required.\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const timeoutMs = Number(options["timeout-ms"]);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    console.error(`--timeout-ms must be a positive whole number.\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  try {
    const counts = await readRecordCounts({
      baseUrl: options["base-url"],
      hostHeader: options["host-header"],
      timeoutMs,
    });
    process.stdout.write(`${JSON.stringify(counts, null, 2)}\n`);
  } catch (error) {
    console.error(`Could not count the records: ${error.message}`);
    process.exitCode = 1;
  }
}

if (isEntryPoint(import.meta.url)) {
  await runCommand(process.argv.slice(2));
}
