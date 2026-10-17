// Shared helpers for the release checks. They call a running MasterQC server over HTTP with the Host and Origin
// headers that the server expects, and they never open the database file.
import http from "node:http";
import { URL } from "node:url";

// Collections whose record count must match exactly across a release. Every other collection may only grow.
export const EXACT_COLLECTIONS = Object.freeze(["batches", "issues", "orders", "assets"]);

const BASE64_DATA_URL = /^data:[^;,]+;base64,([A-Za-z0-9+/]*={0,2})$/;

export function requestBytes({ baseUrl, path: requestPath, method = "GET", hostHeader, origin, body, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const url = new URL(requestPath, baseUrl);
    // IPv6 literals keep their brackets in URL#hostname, which the request API does not accept.
    const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
    const headers = { host: hostHeader };
    if (origin !== undefined) headers.origin = origin;
    let payload;
    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body), "utf8");
      headers["content-type"] = "application/json";
      headers["content-length"] = String(payload.length);
    }
    const request = http.request({
      protocol: url.protocol,
      hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      // One connection per request, so the checks never wait on keep-alive sockets.
      agent: false,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`no response within ${timeoutMs} ms`));
    });
    request.on("error", reject);
    request.end(payload);
  });
}

// Returns { status, json, text }. `json` is null when the body is not JSON.
export async function requestJson(options) {
  const response = await requestBytes(options);
  const text = response.body.toString("utf8");
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

// Counts every top-level array of a lightweight state, which covers each record collection, plus the revision.
export function countRecords(state) {
  const counts = { revision: state.revision };
  for (const [key, value] of Object.entries(state)) {
    if (Array.isArray(value)) counts[key] = value.length;
  }
  return counts;
}

// Returns the decoded byte length of a base64 data URL, or null when the value is not one.
export function decodeDataUrlBytes(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const match = BASE64_DATA_URL.exec(dataUrl);
  if (!match || match[1].length % 4 !== 0) return null;
  return Buffer.from(match[1], "base64").length;
}

// Checks the shape of a counts file: the revision and each collection count are whole numbers, and the exact
// collections must be present so that their counts can be compared exactly.
export function parseExpectedCounts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("The counts file must contain a JSON object.");
  }
  for (const [key, count] of Object.entries(value)) {
    if (key === "revision") {
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new TypeError("The counts file revision must be a whole number of zero or more.");
      }
    } else if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError(`The counts file value for ${key} must be a whole number of zero or more.`);
    }
  }
  const missing = EXACT_COLLECTIONS.filter((key) => value[key] === undefined);
  if (missing.length > 0) {
    throw new TypeError(`The counts file must include ${EXACT_COLLECTIONS.join(", ")}; missing ${missing.join(", ")}.`);
  }
  return value;
}
