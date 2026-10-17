import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { lstat, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { API_UPLOAD_BODY_MAX_BYTES, BACKUP_MAX_BYTES, QC_COMMAND_TYPES, createQCService } from "../core/qc-service.js";
import { isValidAuditActor } from "../core/qc-domain.js";
import { isEntryPoint } from "./entry-point.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const HOST = "127.0.0.1";
export const PORT = 4173;
export const CANONICAL_URL = `http://${HOST}:${PORT}`;
export const WORKSPACE_DATABASE_FILES = Object.freeze({ main: "masterqc-main.sqlite", demo: "masterqc-demo.sqlite" });

const STATIC_ROOTS = ["frontend", "core", "storage"].map((directory) => ({
  urlPrefix: `/${directory}`,
  directory: path.join(PROJECT_ROOT, directory),
}));
const LARK_IMPORT_ROOT = path.join(PROJECT_ROOT, "data", "lark-import");
const LARK_IMPORT_PACKAGE_URL = "/data/lark-import/version-history.v1.json";
const BROWSER_STORAGE_FILES = new Set(["http-json-transport.js"]);
// Commands and initialization carry attachment uploads, so they use the upload budget from the core.
const API_BODY_MAX_BYTES = API_UPLOAD_BODY_MAX_BYTES;
// JSON restore and historical package imports keep the 50 MiB backup limit plus a small envelope.
const BACKUP_BODY_MAX_BYTES = BACKUP_MAX_BYTES + 4096;
const ALLOWED_WORKSPACES = new Set(["main", "demo"]);
const ALLOWED_COMMANDS = new Set(QC_COMMAND_TYPES);
// Addresses that mean this computer. Only these may listen, because hosted mode relies on the reverse proxy for public access.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
// Socket addresses that mean the request came from this computer, such as the reverse proxy on the same server.
const LOOPBACK_CLIENT_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
// Header names are HTTP tokens; Node delivers them in lower case.
const TRUSTED_HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
// Release identifiers are printable ASCII, up to 100 characters.
const RELEASE_ID_PATTERN = /^[\x20-\x7e]{1,100}$/;
// Time that in-flight requests get after SIGINT or SIGTERM before their connections are closed.
const SHUTDOWN_GRACE_MS = 10_000;
// Node's default five-minute request timeout is too short for a 64 MiB upload over a slow link.
const REQUEST_TIMEOUT_MS = 60 * 60 * 1000;
const GENERIC_SERVICE_ERROR = "The QC server could not complete the request.";
// Core raises this message for a stale expected revision; other revision messages are ordinary validation errors.
const STALE_REVISION_MESSAGE = "This data changed since your last view";
// Temporary files written by the snapshot route: .snapshot-<workspace>-<uuid>.sqlite, optionally with a journal.
const SNAPSHOT_TEMPORARY_FILE = /^\.snapshot-(?:main|demo)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sqlite(?:-journal)?$/;
const SILENT_LOGGER = Object.freeze({ info() {}, error() {} });
const CONSOLE_LOGGER = Object.freeze({
  info: (line) => console.log(line),
  error: (text) => console.error(text),
});

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
]);

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function parseSafeRequestPath(requestTarget) {
  if (typeof requestTarget !== "string" || requestTarget.includes("#") || requestTarget.includes("\\")) {
    return null;
  }

  const queryIndex = requestTarget.indexOf("?");
  const rawPath = queryIndex === -1 ? requestTarget : requestTarget.slice(0, queryIndex);
  if (!rawPath.startsWith("/") || rawPath.startsWith("//")) return null;

  const decodedSegments = [];
  for (const segment of rawPath.split("/")) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("\0")
    ) {
      return null;
    }
    decodedSegments.push(decoded);
  }
  return decodedSegments.join("/") || "/";
}

async function resolveFileWithinRoot(rootDirectory, relativePath, boundaryDirectory = PROJECT_ROOT) {
  const boundary = await realpath(boundaryDirectory);
  const linkDetails = await lstat(rootDirectory);
  if (linkDetails.isSymbolicLink()) return null;
  const root = await realpath(rootDirectory);
  if (!isInside(boundary, root)) return null;
  const candidate = path.resolve(root, relativePath);
  if (!isInside(root, candidate)) return null;

  let resolved;
  try {
    resolved = await realpath(candidate);
  } catch {
    return null;
  }
  if (!isInside(root, resolved)) return null;

  try {
    const details = await stat(resolved);
    return details.isFile() ? resolved : null;
  } catch {
    return null;
  }
}

export async function resolveStaticTarget(requestTarget, {
  roots = STATIC_ROOTS,
  larkImportRoot = LARK_IMPORT_ROOT,
  projectRoot = PROJECT_ROOT,
} = {}) {
  const requestPath = parseSafeRequestPath(requestTarget);
  if (requestPath === null) return null;
  if (requestPath === "/data/workspace" || requestPath.startsWith("/data/workspace/")) return null;

  if (requestPath === LARK_IMPORT_PACKAGE_URL) {
    return resolveFileWithinRoot(larkImportRoot, "version-history.v1.json", projectRoot);
  }

  if (requestPath === "/") {
    return resolveFileWithinRoot(roots[0].directory, "index.html", projectRoot);
  }

  for (const root of roots) {
    if (requestPath === root.urlPrefix) {
      return root.urlPrefix === "/frontend"
        ? resolveFileWithinRoot(root.directory, "index.html", projectRoot)
        : null;
    }
    if (requestPath.startsWith(`${root.urlPrefix}/`)) {
      const relativePath = requestPath.slice(root.urlPrefix.length + 1);
      if (root.urlPrefix === "/storage" && !BROWSER_STORAGE_FILES.has(relativePath)) return null;
      return resolveFileWithinRoot(root.directory, relativePath, projectRoot);
    }
  }
  return null;
}

export async function checkStartupRequirements({ projectRoot = PROJECT_ROOT } = {}) {
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  const supportsBuiltInSQLite = (nodeMajor === 22 && nodeMinor >= 13) ||
    (nodeMajor === 23 && nodeMinor >= 4) || nodeMajor >= 24;
  if (!supportsBuiltInSQLite) {
    return "Built-in SQLite requires Node.js 22.13+ on the 22.x line, 23.4+ on the 23.x line, or 24+. Install a supported Node.js release, then restart MasterQC Web.";
  }

  let resolvedProjectRoot;
  try {
    resolvedProjectRoot = await realpath(projectRoot);
  } catch {
    return "启动文件不完整：找不到项目目录。请重新解压或恢复项目文件后重试。";
  }

  for (const directory of ["frontend", "core", "storage"]) {
    try {
      const directoryPath = path.join(projectRoot, directory);
      const linkDetails = await lstat(directoryPath);
      if (linkDetails.isSymbolicLink()) throw new Error("symbolic directory");
      const resolvedDirectory = await realpath(directoryPath);
      const details = await stat(resolvedDirectory);
      if (!isInside(resolvedProjectRoot, resolvedDirectory) || !details.isDirectory()) throw new Error("invalid directory");
    } catch {
      return `启动文件不完整：找不到 ${directory}/ 目录。请重新解压或恢复项目文件后重试。`;
    }
  }

  return null;
}

export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function environmentValue(env, name) {
  const value = env[name];
  if (value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

function formatHostPort(host, port) {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

// Accepts a bare origin such as https://qc.example.com. Plain HTTP is allowed only for a loopback address.
export function parsePublicOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError("MASTERQC_PUBLIC_ORIGIN must be a full URL such as https://qc.example.com.");
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname.replace(/^\[(.*)\]$/, "$1"));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ConfigurationError("MASTERQC_PUBLIC_ORIGIN must start with https:// (http:// is accepted only for localhost).");
  }
  if (url.username || url.password) {
    throw new ConfigurationError("MASTERQC_PUBLIC_ORIGIN must not contain a username or password.");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new ConfigurationError("MASTERQC_PUBLIC_ORIGIN must contain only the scheme, host, and optional port, without a path, query, or fragment.");
  }
  return url.origin;
}

function parseListenPort(text) {
  const port = /^\d{1,5}$/.test(text) ? Number(text) : NaN;
  if (!(port >= 1 && port <= 65535)) {
    throw new ConfigurationError("MASTERQC_LISTEN_PORT must be a whole number from 1 to 65535.");
  }
  return port;
}

function checkedReleaseId(value, label) {
  if (!RELEASE_ID_PATTERN.test(value)) throw new ConfigurationError(`${label} must be 1 to 100 printable characters.`);
  return value;
}

// The release shown to browsers and checked by the release script. MASTERQC_RELEASE_ID wins, then the RELEASE file
// that the release script writes, then the package version. Read once at startup.
export function readReleaseIdentifier({ env = process.env, projectRoot = PROJECT_ROOT } = {}) {
  const fromEnvironment = environmentValue(env, "MASTERQC_RELEASE_ID");
  if (fromEnvironment !== null) return checkedReleaseId(fromEnvironment, "MASTERQC_RELEASE_ID");
  const releaseFile = path.join(projectRoot, "RELEASE");
  if (existsSync(releaseFile)) return checkedReleaseId(readFileSync(releaseFile, "utf8").trim(), "The RELEASE file");
  const { version } = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  return checkedReleaseId(String(version), "The package version");
}

// Reads the launcher settings once. Empty values count as unset. Invalid values throw a ConfigurationError.
export function readServerConfig(env = process.env, { projectRoot = PROJECT_ROOT } = {}) {
  const listenHost = environmentValue(env, "MASTERQC_LISTEN_HOST") ?? HOST;
  if (!LOOPBACK_HOSTS.has(listenHost)) {
    throw new ConfigurationError("MASTERQC_LISTEN_HOST must be 127.0.0.1, localhost, or ::1. Expose the app to other computers only through the HTTPS reverse proxy.");
  }
  const portText = environmentValue(env, "MASTERQC_LISTEN_PORT");
  const listenPort = portText === null ? PORT : parseListenPort(portText);

  const originText = environmentValue(env, "MASTERQC_PUBLIC_ORIGIN");
  const publicOrigin = originText === null ? null : parsePublicOrigin(originText);

  // The demo workspace is on for this computer and off for a hosted server unless set explicitly.
  const demoText = environmentValue(env, "MASTERQC_DEMO");
  let demoEnabled = publicOrigin === null;
  if (demoText !== null) {
    const normalized = demoText.toLowerCase();
    if (normalized !== "on" && normalized !== "off") throw new ConfigurationError("MASTERQC_DEMO must be on or off.");
    demoEnabled = normalized === "on";
  }

  const dataText = environmentValue(env, "MASTERQC_DATA_DIR");
  if (dataText !== null && publicOrigin !== null && !path.isAbsolute(dataText)) {
    throw new ConfigurationError("MASTERQC_DATA_DIR must be an absolute path when MASTERQC_PUBLIC_ORIGIN is set.");
  }
  const dataDirectory = dataText === null
    ? path.resolve(projectRoot, "data", "workspace")
    : path.resolve(dataText);

  // Header names are case-insensitive. The header counts only in hosted mode (see trustedOperator).
  const trustedHeaderText = environmentValue(env, "MASTERQC_TRUSTED_USER_HEADER");
  if (trustedHeaderText !== null && !TRUSTED_HEADER_NAME.test(trustedHeaderText)) {
    throw new ConfigurationError("MASTERQC_TRUSTED_USER_HEADER must be an HTTP header name such as x-remote-user.");
  }

  return Object.freeze({
    hosted: publicOrigin !== null,
    listenHost,
    listenPort,
    publicOrigin,
    demoEnabled,
    dataDirectory,
    trustedUserHeader: trustedHeaderText === null ? null : trustedHeaderText.toLowerCase(),
    release: readReleaseIdentifier({ env, projectRoot }),
  });
}

// The Host and Origin values one server accepts. Hosted mode adds the public origin and keeps loopback for local tools.
function createOriginPolicy({ host, port, publicOrigin }) {
  const loopbackHost = formatHostPort(host, port);
  const loopbackOrigin = `http://${loopbackHost}`;
  if (publicOrigin === null || publicOrigin === undefined) {
    return Object.freeze({
      hosted: false,
      allowedHosts: Object.freeze([loopbackHost]),
      allowedOrigins: Object.freeze([loopbackOrigin]),
    });
  }
  const origin = parsePublicOrigin(publicOrigin);
  return Object.freeze({
    hosted: true,
    allowedHosts: Object.freeze([new URL(origin).host, loopbackHost]),
    allowedOrigins: Object.freeze([origin, loopbackOrigin]),
  });
}

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-src 'self' blob:; media-src 'self' blob:",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function send(response, statusCode, body, headers = {}) {
  // The status is also kept on the response object so the access log can read it.
  response.statusCode = statusCode;
  response.writeHead(statusCode, { ...SECURITY_HEADERS, ...headers });
  response.end(body);
}

function sendJson(response, statusCode, value) {
  send(response, statusCode, JSON.stringify(value), { "Content-Type": "application/json; charset=utf-8" });
}

// The operator name from the trusted proxy header. It counts only in hosted mode and only for loopback clients,
// so a browser cannot set it directly. Caddy overwrites the header with the Basic Auth user name.
function trustedOperator(request, context) {
  if (context.trustedUserHeader === null || !context.hosted) return null;
  if (!LOOPBACK_CLIENT_ADDRESSES.has(request.socket?.remoteAddress)) return null;
  const value = request.headers[context.trustedUserHeader];
  return isValidAuditActor(value) ? value : null;
}

function rawRequestPath(url) {
  return String(url ?? "").split("?", 1)[0];
}

// Only /api and /healthz requests get access-log lines; static files stay quiet.
function isLoggedRoute(rawPath) {
  return rawPath === "/healthz" || rawPath === "/api" || rawPath.startsWith("/api/");
}

function truncateForLog(value) {
  return value.length > 200 ? `${value.slice(0, 200)}...` : value;
}

// Logs the method, path without query string, status, and duration. Headers and bodies are never included.
function accessLogLine(request, response, startedAt) {
  const duration = Math.round(performance.now() - startedAt);
  return `${new Date().toISOString()} ${request.method ?? "GET"} ${truncateForLog(rawRequestPath(request.url))} ${response.statusCode ?? 0} ${duration}ms`;
}

function errorLogText(request, statusCode, error) {
  const detail = error?.stack ?? String(error);
  return `${new Date().toISOString()} ${request.method ?? "GET"} ${truncateForLog(rawRequestPath(request.url))} ${statusCode}\n${detail}`;
}

const PROGRAMMING_ERROR_TYPES = [TypeError, ReferenceError, RangeError, SyntaxError];
const SQLITE_ERROR_CODE = /^(?:ERR_SQLITE|SQLITE_)/;
// Node system errors carry an errno code such as ENOSPC or EACCES and a syscall name. Their messages reveal paths.
const SYSTEM_ERROR_CODE = /^E[A-Z0-9]+$/;

function explicitStatusCode(error) {
  const statusCode = error?.statusCode;
  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : null;
}

function isInternalError(error) {
  if (PROGRAMMING_ERROR_TYPES.some((type) => error instanceof type)) return true;
  const code = typeof error?.code === "string" ? error.code : "";
  return SQLITE_ERROR_CODE.test(code) || SYSTEM_ERROR_CODE.test(code) || typeof error?.syscall === "string";
}

// Errors that carry a statusCode keep it. Internal faults become a generic 500. Other plain errors are business
// validation from the core, so they return 400 with their message.
function errorStatus(error) {
  const explicit = explicitStatusCode(error);
  if (explicit !== null) return explicit;
  if (typeof error?.message === "string" && error.message.startsWith(STALE_REVISION_MESSAGE)) return 409;
  if (isInternalError(error)) return 500;
  return error instanceof Error ? 400 : 500;
}

function errorBody(error, statusCode) {
  const body = { error: statusCode >= 500 ? GENERIC_SERVICE_ERROR : error.message };
  if (explicitStatusCode(error) !== null && typeof error.code === "string" && error.code) {
    body.code = error.code;
  } else if (statusCode === 409) {
    body.code = "stale_revision";
  }
  return body;
}

function requestError(statusCode, message, code = undefined) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function formatLimit(bytes) {
  return bytes >= 1024 * 1024 ? `${Number((bytes / (1024 * 1024)).toFixed(1))} MiB` : `${bytes} bytes`;
}

function uploadTooLargeMessage(maxBodyBytes) {
  return `This request is larger than the ${formatLimit(maxBodyBytes)} limit. Add fewer files at a time.`;
}

function backupTooLargeMessage() {
  return `This JSON file is larger than the ${formatLimit(BACKUP_MAX_BYTES)} limit for backups and historical packages. Move larger workspaces with a database snapshot.`;
}

async function readJsonBody(request, maxBodyBytes, tooLargeMessage) {
  const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw requestError(415, "Content-Type must be application/json.", "unsupported_media_type");
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    throw requestError(413, tooLargeMessage, "body_too_large");
  }
  const chunks = [];
  let totalBytes = 0;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBodyBytes) {
        throw requestError(413, tooLargeMessage, "body_too_large");
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error?.statusCode) throw error;
    // A client that disconnects mid-upload fails the stream. That is not a server fault, so it is not logged as one.
    throw requestError(400, "The request body was interrupted before it finished.", "body_interrupted");
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON body must be an object.");
    return value;
  } catch (error) {
    if (error?.statusCode) throw error;
    throw requestError(400, "Request body must be a valid JSON object.", "invalid_json");
  }
}

function requireRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw requestError(400, "A non-negative expectedRevision is required.", "invalid_revision");
  }
}

function getService(services, workspace, demoEnabled) {
  if (!ALLOWED_WORKSPACES.has(workspace) || !services?.[workspace] || (workspace === "demo" && !demoEnabled)) {
    throw requestError(404, "QC workspace was not found.", "workspace_not_found");
  }
  return services[workspace];
}

function closeReadStream(stream) {
  if (!stream || stream.closed) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once("close", resolve);
    stream.destroy();
  });
}

// Only one snapshot runs at a time. Each slot is released by its own token, so a late release cannot free a newer holder.
function acquireSnapshotSlot(gate) {
  if (gate.holder !== null) return null;
  const token = {};
  gate.holder = token;
  return () => {
    if (gate.holder === token) gate.holder = null;
  };
}

// Streams one consistent SQLite snapshot as a download. The temporary file stays in the data directory,
// which is never statically served, and is removed after success, a client disconnect, or an error.
async function streamDatabaseSnapshot(request, response, service, workspace, context, releaseSlot) {
  const snapshotPath = path.join(context.snapshotDirectory, `.snapshot-${workspace}-${randomUUID()}.sqlite`);
  let stream = null;
  try {
    await service.createSnapshot(snapshotPath);
    const { size } = await stat(snapshotPath);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    stream = createReadStream(snapshotPath);
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": "application/vnd.sqlite3",
      "Content-Disposition": `attachment; filename="masterqc-${workspace}-${stamp}.sqlite"`,
      "Content-Length": size,
    });
    await pipeline(stream, response);
    // The client can start another download as soon as the body is sent, so free the slot before cleanup.
    releaseSlot();
  } catch (error) {
    releaseSlot();
    // Before headers are sent, the caller reports the failure. Afterwards only the socket can be closed.
    if (!response.headersSent) throw error;
    if (error?.code !== "ERR_STREAM_PREMATURE_CLOSE") {
      context.logger.error(errorLogText(request, 200, error));
    }
    response.destroy();
  } finally {
    await closeReadStream(stream);
    await rm(snapshotPath, { force: true }).catch((error) => {
      context.logger.error(`Could not delete the temporary snapshot ${snapshotPath}: ${error.message}`);
    });
  }
}

async function sendDatabaseSnapshot(request, response, service, workspace, context) {
  // Same-origin downloads send no Origin header; a page on another site must not be able to fetch the database.
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw requestError(403, "Database snapshots can only be downloaded from the MasterQC application.", "origin_not_allowed");
  }
  if (!context.snapshotDirectory) throw requestError(503, "Database snapshots are not available for this server.", "snapshot_unavailable");
  // One snapshot at a time keeps the extra copy and the database read from piling up; other callers retry later.
  const releaseSlot = acquireSnapshotSlot(context.snapshotGate);
  if (releaseSlot === null) {
    throw requestError(429, "Another database snapshot is already in progress. Try again when it finishes.", "snapshot_busy");
  }
  try {
    await streamDatabaseSnapshot(request, response, service, workspace, context, releaseSlot);
  } finally {
    releaseSlot();
  }
}

async function handleApiRequest(request, response, path, context) {
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 4 || segments[0] !== "api" || segments[1] !== "qc") {
    sendJson(response, 404, { error: "API route was not found.", code: "route_not_found" });
    return;
  }

  let service;
  try {
    service = getService(context.services, segments[2], context.demoEnabled);
  } catch (error) {
    sendJson(response, error.statusCode ?? 404, { error: error.message, code: error.code });
    return;
  }

  const method = request.method ?? "GET";
  const action = segments.slice(3);
  const allowedMethod = (expected) => {
    if (method !== expected) throw requestError(405, "Method is not allowed for this API route.", "method_not_allowed");
  };
  const { limits } = context;

  try {
    if (action.length === 1 && action[0] === "initialize") {
      allowedMethod("POST");
      const body = await readJsonBody(request, limits.maxBodyBytes, uploadTooLargeMessage(limits.maxBodyBytes));
      if (body.mode !== undefined && !["full", "lightweight"].includes(body.mode)) {
        throw requestError(400, "Initialization mode must be full or lightweight.", "invalid_read_mode");
      }
      sendJson(response, 200, await service.initialize(body.mode ? { mode: body.mode } : {}));
      return;
    }
    if (action.length === 1 && action[0] === "state") {
      allowedMethod("GET");
      sendJson(response, 200, await service.getState());
      return;
    }
    if (action.length === 2 && action[0] === "state" && action[1] === "lightweight") {
      allowedMethod("GET");
      sendJson(response, 200, await service.getState({ mode: "lightweight" }));
      return;
    }
    if (action.length === 1 && action[0] === "revision") {
      allowedMethod("GET");
      sendJson(response, 200, { revision: await service.getRevision() });
      return;
    }
    if (action.length === 1 && action[0] === "command") {
      allowedMethod("POST");
      const body = await readJsonBody(request, limits.maxBodyBytes, uploadTooLargeMessage(limits.maxBodyBytes));
      if (typeof body.type !== "string" || !ALLOWED_COMMANDS.has(body.type)) {
        throw requestError(400, "QC command is not allowed.", "command_not_allowed");
      }
      if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
        throw requestError(400, "Command data must be an object.", "invalid_command_data");
      }
      requireRevision(body.expectedRevision);
      sendJson(response, 200, await service.command(body.type, body.data, body.expectedRevision, { actor: trustedOperator(request, context) }));
      return;
    }
    if (action.length === 1 && action[0] === "backup") {
      allowedMethod("GET");
      sendJson(response, 200, await service.exportBackup());
      return;
    }
    if (action.length === 2 && action[0] === "backup" && action[1] === "snapshot") {
      allowedMethod("GET");
      await sendDatabaseSnapshot(request, response, service, segments[2], context);
      return;
    }
    if (action.length === 1 && action[0] === "restore") {
      allowedMethod("POST");
      const body = await readJsonBody(request, limits.maxBackupBodyBytes, backupTooLargeMessage());
      requireRevision(body.expectedRevision);
      if (!body.backup || typeof body.backup !== "object" || Array.isArray(body.backup)) {
        throw requestError(400, "A backup object is required.", "invalid_backup");
      }
      sendJson(response, 200, await service.importBackup(body.backup, body.expectedRevision, { actor: trustedOperator(request, context) }));
      return;
    }
    if (action.length === 1 && action[0] === "history") {
      allowedMethod("POST");
      const body = await readJsonBody(request, limits.maxBackupBodyBytes, backupTooLargeMessage());
      requireRevision(body.expectedRevision);
      if (!body.historyPackage || typeof body.historyPackage !== "object" || Array.isArray(body.historyPackage)) {
        throw requestError(400, "A history package object is required.", "invalid_history_package");
      }
      sendJson(response, 200, await service.importHistory(body.historyPackage, body.expectedRevision, { actor: trustedOperator(request, context) }));
      return;
    }
    if (action.length === 2 && action[0] === "assets") {
      allowedMethod("GET");
      const asset = await service.getAsset(action[1]);
      if (!asset) {
        sendJson(response, 404, { error: "That attachment is no longer available.", code: "asset_not_found" });
        return;
      }
      sendJson(response, 200, asset);
      return;
    }
    if (action.length === 2 && action[0] === "batches") {
      allowedMethod("GET");
      sendJson(response, 200, await service.getBatchWorkspace(action[1]));
      return;
    }
    if (action.length === 3 && action[0] === "batches" && action[2] === "lightweight") {
      allowedMethod("GET");
      sendJson(response, 200, await service.getBatchWorkspace(action[1], { mode: "lightweight" }));
      return;
    }
    if (action.length === 3 && action[0] === "orders" && action[2] === "progress") {
      allowedMethod("GET");
      sendJson(response, 200, await service.getPurchaseOrderProgress(action[1]));
      return;
    }
    sendJson(response, 404, { error: "API route was not found.", code: "route_not_found" });
  } catch (error) {
    const statusCode = errorStatus(error);
    if (statusCode >= 500) context.logger.error(errorLogText(request, statusCode, error));
    sendJson(response, statusCode, errorBody(error, statusCode));
  }
}

// GET /healthz reports the main workspace revision through the cheap revision read. It never exposes records.
async function handleHealthRequest(request, response, context) {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method is not allowed.", code: "method_not_allowed" });
    return;
  }
  let revision;
  try {
    if (!context.services?.main) throw new Error("The main QC workspace is not available.");
    revision = await context.services.main.getRevision();
  } catch (error) {
    context.logger.error(errorLogText(request, 503, error));
    sendJson(response, 503, { ok: false });
    return;
  }
  sendJson(response, 200, { ok: true, revision });
}

async function routeRequest(request, response, resolveTarget, origins, context) {
  // Host decides which address the client used. X-Forwarded-* headers are deliberately ignored.
  const host = String(request.headers.host ?? "").toLowerCase();
  if (!origins.allowedHosts.includes(host)) {
    send(response, 400, "Bad Request\n", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }
  let requestPath;
  try {
    requestPath = parseSafeRequestPath(request.url);
  } catch {
    requestPath = null;
  }
  if (!requestPath) {
    send(response, 400, "Bad Request\n", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  const isApi = requestPath.startsWith("/api/");
  const origin = request.headers.origin;
  if (origin !== undefined && !origins.allowedOrigins.includes(origin)) {
    if (isApi) sendJson(response, 403, { error: "Requests must come from the MasterQC application.", code: "origin_not_allowed" });
    else send(response, 403, "Forbidden\n", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  if (requestPath === "/healthz") {
    await handleHealthRequest(request, response, context);
    return;
  }

  if (isApi) {
    if (request.method !== "GET" && request.method !== "POST") {
      sendJson(response, 405, { error: "Method is not allowed.", code: "method_not_allowed" });
      return;
    }
    // The session route reads no records, so it answers even while the database is not ready.
    if (requestPath === "/api/session") {
      if (request.method !== "GET") {
        sendJson(response, 405, { error: "Method is not allowed for this API route.", code: "method_not_allowed" });
        return;
      }
      sendJson(response, 200, { release: context.release, actor: trustedOperator(request, context) });
      return;
    }
    if (request.method === "POST" && origin === undefined) {
      sendJson(response, 403, { error: "POST requests require the MasterQC application origin.", code: "origin_required" });
      return;
    }
    if (!context.services) {
      sendJson(response, 503, { error: "The QC service is not ready.", code: "service_unavailable" });
      return;
    }
    await handleApiRequest(request, response, requestPath, context);
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    send(response, 405, "Method Not Allowed\n", {
      Allow: "GET, HEAD",
      "Content-Type": "text/plain; charset=utf-8",
    });
    return;
  }

  let target;
  try {
    target = await resolveTarget(request.url);
  } catch {
    send(response, 404, "Not Found\n", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }
  if (!target) {
    send(response, 404, "Not Found\n", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  try {
    const content = await readFile(target);
    send(response, 200, request.method === "HEAD" ? undefined : content, {
      "Content-Type": CONTENT_TYPES.get(path.extname(target)) ?? "application/octet-stream",
    });
  } catch {
    send(response, 404, "Not Found\n", { "Content-Type": "text/plain; charset=utf-8" });
  }
}

export function createRequestHandler(resolveTarget = resolveStaticTarget, {
  services = null,
  host = HOST,
  port = PORT,
  publicOrigin = null,
  demoEnabled = true,
  maxBodyBytes = API_BODY_MAX_BYTES,
  maxBackupBodyBytes = BACKUP_BODY_MAX_BYTES,
  snapshotDirectory = null,
  logger = SILENT_LOGGER,
  trustedUserHeader = null,
  release = readReleaseIdentifier(),
} = {}) {
  const origins = createOriginPolicy({ host, port, publicOrigin });
  const context = {
    services,
    demoEnabled,
    logger,
    snapshotDirectory,
    limits: { maxBodyBytes, maxBackupBodyBytes },
    snapshotGate: { holder: null },
    release,
    hosted: origins.hosted,
    // Node delivers header names in lower case, so the configured name is compared in lower case too.
    trustedUserHeader: trustedUserHeader === null ? null : String(trustedUserHeader).toLowerCase(),
  };

  return async (request, response) => {
    const startedAt = performance.now();
    const logged = isLoggedRoute(rawRequestPath(request.url));
    try {
      await routeRequest(request, response, resolveTarget, origins, context);
    } catch (error) {
      // An unexpected failure must not escape the request listener. Report it, then close the response.
      logger.error(errorLogText(request, 500, error));
      if (!response.headersSent) sendJson(response, 500, { error: GENERIC_SERVICE_ERROR });
      else response.destroy?.();
    } finally {
      if (logged) logger.info(accessLogLine(request, response, startedAt));
    }
  };
}

export function getDefaultDataDirectory({ platform = process.platform, env = process.env, projectRoot = PROJECT_ROOT } = {}) {
  const pathApi = platform === "win32" ? path.win32 : path;
  if (env.MASTERQC_DATA_DIR) return pathApi.resolve(env.MASTERQC_DATA_DIR);
  return pathApi.resolve(projectRoot, "data", "workspace");
}

// Removes temporary snapshot files that an interrupted download left behind. Only names the snapshot route creates match.
export async function removeLeftoverSnapshotFiles(directory) {
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names) {
    if (!SNAPSHOT_TEMPORARY_FILE.test(name)) continue;
    const candidate = path.join(directory, name);
    const details = await lstat(candidate).catch(() => null);
    if (!details?.isFile()) continue;
    await rm(candidate, { force: true });
    removed += 1;
  }
  return removed;
}

export async function createQCWorkspaceServices({ dataDirectory, projectRoot = PROJECT_ROOT, demoEnabled = true } = {}) {
  const [{ createSQLiteQCAdapter }] = await Promise.all([import("../storage/sqlite-qc-adapter.mjs")]);
  const directory = path.resolve(dataDirectory ?? getDefaultDataDirectory({ projectRoot }));
  const services = {
    main: createQCService(createSQLiteQCAdapter({ databasePath: path.join(directory, WORKSPACE_DATABASE_FILES.main) })),
  };
  // A disabled demo workspace never opens its database file, so the file is not created.
  if (demoEnabled) {
    try {
      services.demo = createQCService(createSQLiteQCAdapter({ databasePath: path.join(directory, WORKSPACE_DATABASE_FILES.demo) }));
    } catch (error) {
      services.main.close();
      throw error;
    }
  }
  return Object.freeze({
    ...services,
    close() {
      services.main.close();
      services.demo?.close();
    },
  });
}

export async function createStaticServer({
  dataDirectory = getDefaultDataDirectory(),
  services: suppliedServices,
  host = HOST,
  port = PORT,
  publicOrigin = null,
  demoEnabled = true,
  logger = CONSOLE_LOGGER,
  trustedUserHeader = null,
  release = readReleaseIdentifier(),
} = {}) {
  const directory = path.resolve(dataDirectory);
  // Invalid origin settings fail here, before any database file is opened.
  createOriginPolicy({ host, port, publicOrigin });
  const services = suppliedServices ?? await createQCWorkspaceServices({ dataDirectory: directory, demoEnabled });
  try {
    const removed = await removeLeftoverSnapshotFiles(directory);
    if (removed > 0) logger.info(`Removed ${removed} temporary snapshot file(s) left by an earlier run.`);
  } catch (error) {
    if (!suppliedServices) services.close();
    throw error;
  }
  const server = createHttpServer(createRequestHandler(resolveStaticTarget, {
    services,
    host,
    port,
    publicOrigin,
    demoEnabled,
    snapshotDirectory: directory,
    logger,
    trustedUserHeader,
    release,
  }));
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.once("close", () => services.close?.());
  server.qcServices = services;
  return server;
}

function openBrowser(url) {
  let command;
  let args;
  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => {
      console.warn(`已启动本地页面，但系统未能自动打开浏览器；请手动访问 ${url}`);
    });
    child.unref();
  } catch {
    console.warn(`已启动本地页面，但系统未能自动打开浏览器；请手动访问 ${url}`);
  }
}

// Stops accepting connections, waits up to graceMs for in-flight requests, then closes what remains and the databases.
export function createShutdownHandler({ server, closeServices, graceMs = SHUTDOWN_GRACE_MS, logger = CONSOLE_LOGGER }) {
  let stopping = null;
  async function stop(signal) {
    logger.info(`Received ${signal}; finishing in-flight requests before stopping MasterQC Web.`);
    const closed = new Promise((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();
    let timer = null;
    const timedOut = await Promise.race([
      closed.then(() => false),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(true), graceMs);
      }),
    ]);
    clearTimeout(timer);
    if (timedOut) {
      logger.error(`In-flight requests did not finish within ${graceMs / 1000} seconds; closing their connections.`);
      server.closeAllConnections();
      await closed;
    }
    await closeServices();
    return { timedOut };
  }
  return (signal) => {
    if (!stopping) stopping = stop(signal);
    return stopping;
  };
}

function installShutdownHandlers(server) {
  const shutdown = createShutdownHandler({
    server,
    closeServices: () => server.qcServices?.close?.(),
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      shutdown(signal).then(
        () => process.exit(0),
        (error) => {
          console.error(`MasterQC Web could not stop cleanly: ${error.message}`);
          process.exit(1);
        },
      );
    });
  }
}

export async function startServer({ open = true, config = readServerConfig() } = {}) {
  const startupIssue = await checkStartupRequirements();
  if (startupIssue) {
    console.error(startupIssue);
    return null;
  }

  let server;
  try {
    server = await createStaticServer({
      dataDirectory: config.dataDirectory,
      host: config.listenHost,
      port: config.listenPort,
      publicOrigin: config.publicOrigin,
      demoEnabled: config.demoEnabled,
      logger: CONSOLE_LOGGER,
      trustedUserHeader: config.trustedUserHeader,
      release: config.release,
    });
  } catch (error) {
    console.error(`Local QC database could not be opened: ${error instanceof Error ? error.message : "unknown error"}`);
    return null;
  }

  const url = `http://${formatHostPort(config.listenHost, config.listenPort)}`;
  return new Promise((resolve) => {
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        console.error(`Local port ${config.listenPort} is already in use. Close the other program using it, then restart MasterQC Web.`);
      } else {
        console.error(`Local server could not start: ${error.message}`);
      }
      server.qcServices?.close?.();
      resolve(null);
    });
    server.listen(config.listenPort, config.listenHost, () => {
      if (config.hosted) {
        console.log(`MasterQC Web is listening on ${url} and serves ${config.publicOrigin} (release ${config.release}).`);
      } else {
        console.log(`MasterQC Web 已启动：${url}`);
      }
      // A hosted server runs headless; a browser can only be opened on the computer that runs the service.
      if (open && !config.hosted) openBrowser(url);
      installShutdownHandlers(server);
      resolve(server);
    });
  });
}

if (isEntryPoint(import.meta.url)) {
  const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--no-open");
  if (unknownArguments.length > 0) {
    console.error("参数不受支持。可选参数：--no-open");
    process.exitCode = 2;
  } else {
    let config = null;
    try {
      config = readServerConfig(process.env);
    } catch (error) {
      console.error(`Invalid MasterQC Web configuration: ${error.message}`);
      process.exitCode = 1;
    }
    if (config) {
      const server = await startServer({ open: !process.argv.includes("--no-open"), config });
      if (!server) process.exitCode = 1;
    }
  }
}
