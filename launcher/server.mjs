import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BACKUP_MAX_BYTES, QC_COMMAND_TYPES, createQCService } from "../core/qc-service.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const HOST = "127.0.0.1";
export const PORT = 4173;
export const CANONICAL_URL = `http://${HOST}:${PORT}`;

const STATIC_ROOTS = ["frontend", "core", "storage"].map((directory) => ({
  urlPrefix: `/${directory}`,
  directory: path.join(PROJECT_ROOT, directory),
}));
const DEXIE_PACKAGE_ROOT = path.join(PROJECT_ROOT, "node_modules", "dexie");
const DEXIE_ENTRY = path.join(DEXIE_PACKAGE_ROOT, "dist", "dexie.mjs");
const DEXIE_URL = "/vendor/dexie.mjs";
const LARK_IMPORT_ROOT = path.join(PROJECT_ROOT, "data", "lark-import");
const LARK_IMPORT_PACKAGE_URL = "/data/lark-import/version-history.v1.json";
const BROWSER_STORAGE_FILES = new Set(["qc-adapter.js", "dexie-adapter.js", "prototype-memory.js", "http-json-transport.js"]);
const API_BODY_MAX_BYTES = BACKUP_MAX_BYTES + 4096;
const ALLOWED_WORKSPACES = new Set(["main", "demo"]);
const ALLOWED_COMMANDS = new Set(QC_COMMAND_TYPES);

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
  dexiePackageRoot = DEXIE_PACKAGE_ROOT,
  larkImportRoot = LARK_IMPORT_ROOT,
  projectRoot = PROJECT_ROOT,
} = {}) {
  const requestPath = parseSafeRequestPath(requestTarget);
  if (requestPath === null) return null;
  if (requestPath === "/data/workspace" || requestPath.startsWith("/data/workspace/")) return null;

  if (requestPath === DEXIE_URL) {
    return resolveFileWithinRoot(dexiePackageRoot, "dist/dexie.mjs", projectRoot);
  }

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

export async function checkStartupRequirements({
  projectRoot = PROJECT_ROOT,
  dexiePackageRoot = path.join(projectRoot, "node_modules", "dexie"),
} = {}) {
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

  const entry = path.join(dexiePackageRoot, "dist", "dexie.mjs");
  try {
    const packageLinkDetails = await lstat(dexiePackageRoot);
    if (packageLinkDetails.isSymbolicLink()) throw new Error("symbolic package");
    const resolvedPackage = await realpath(dexiePackageRoot);
    const resolvedEntry = await realpath(entry);
    const details = await stat(resolvedEntry);
    if (!isInside(resolvedProjectRoot, resolvedPackage) || !isInside(resolvedPackage, resolvedEntry) || !details.isFile()) {
      throw new Error("invalid Dexie entry");
    }
    await access(resolvedEntry);
  } catch {
    return "未找到本地 Dexie 依赖。请在项目目录执行 npm ci 后重试。";
  }
  return null;
}

function send(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-src 'self' blob:; media-src 'self' blob:",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...headers,
  });
  response.end(body);
}

function sendJson(response, statusCode, value) {
  send(response, statusCode, JSON.stringify(value), { "Content-Type": "application/json; charset=utf-8" });
}

function errorStatus(error) {
  if (error?.statusCode) return error.statusCode;
  if (/revision|changed since your last view|reload the latest state/i.test(error?.message ?? "")) return 409;
  if (error?.code?.startsWith?.("ERR_SQLITE") || error?.code?.startsWith?.("SQLITE_")) return 500;
  return error instanceof Error ? 400 : 500;
}

function requestError(statusCode, message, code = undefined) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

async function readJsonBody(request, maxBodyBytes = API_BODY_MAX_BYTES) {
  const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw requestError(415, "Content-Type must be application/json.", "unsupported_media_type");
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    throw requestError(413, `Request body exceeds the ${BACKUP_MAX_BYTES / (1024 * 1024)} MiB backup limit.`, "body_too_large");
  }
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.byteLength;
    if (totalBytes > maxBodyBytes) {
      throw requestError(413, `Request body exceeds the ${BACKUP_MAX_BYTES / (1024 * 1024)} MiB backup limit.`, "body_too_large");
    }
    chunks.push(bytes);
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

function getService(services, workspace) {
  if (!ALLOWED_WORKSPACES.has(workspace) || !services?.[workspace]) {
    throw requestError(404, "QC workspace was not found.", "workspace_not_found");
  }
  return services[workspace];
}

async function handleApiRequest(request, response, path, services, maxBodyBytes) {
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 4 || segments[0] !== "api" || segments[1] !== "qc") {
    sendJson(response, 404, { error: "API route was not found.", code: "route_not_found" });
    return;
  }

  let service;
  try {
    service = getService(services, segments[2]);
  } catch (error) {
    sendJson(response, error.statusCode ?? 404, { error: error.message, code: error.code });
    return;
  }

  const method = request.method ?? "GET";
  const action = segments.slice(3);
  const allowedMethod = (expected) => {
    if (method !== expected) throw requestError(405, "Method is not allowed for this API route.", "method_not_allowed");
  };

  try {
    if (action.length === 1 && action[0] === "initialize") {
      allowedMethod("POST");
      await readJsonBody(request, maxBodyBytes);
      sendJson(response, 200, await service.initialize());
      return;
    }
    if (action.length === 1 && action[0] === "state") {
      allowedMethod("GET");
      sendJson(response, 200, await service.getState());
      return;
    }
    if (action.length === 1 && action[0] === "revision") {
      allowedMethod("GET");
      sendJson(response, 200, { revision: await service.getRevision() });
      return;
    }
    if (action.length === 1 && action[0] === "command") {
      allowedMethod("POST");
      const body = await readJsonBody(request, maxBodyBytes);
      if (typeof body.type !== "string" || !ALLOWED_COMMANDS.has(body.type)) {
        throw requestError(400, "QC command is not allowed.", "command_not_allowed");
      }
      if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
        throw requestError(400, "Command data must be an object.", "invalid_command_data");
      }
      requireRevision(body.expectedRevision);
      sendJson(response, 200, await service.command(body.type, body.data, body.expectedRevision));
      return;
    }
    if (action.length === 1 && action[0] === "backup") {
      allowedMethod("GET");
      sendJson(response, 200, await service.exportBackup());
      return;
    }
    if (action.length === 1 && action[0] === "restore") {
      allowedMethod("POST");
      const body = await readJsonBody(request, maxBodyBytes);
      requireRevision(body.expectedRevision);
      if (!body.backup || typeof body.backup !== "object" || Array.isArray(body.backup)) {
        throw requestError(400, "A backup object is required.", "invalid_backup");
      }
      sendJson(response, 200, await service.importBackup(body.backup, body.expectedRevision));
      return;
    }
    if (action.length === 1 && action[0] === "history") {
      allowedMethod("POST");
      const body = await readJsonBody(request, maxBodyBytes);
      requireRevision(body.expectedRevision);
      if (!body.historyPackage || typeof body.historyPackage !== "object" || Array.isArray(body.historyPackage)) {
        throw requestError(400, "A history package object is required.", "invalid_history_package");
      }
      sendJson(response, 200, await service.importHistory(body.historyPackage, body.expectedRevision));
      return;
    }
    if (action.length === 2 && action[0] === "batches") {
      allowedMethod("GET");
      sendJson(response, 200, await service.getBatchWorkspace(action[1]));
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
    sendJson(response, statusCode, {
      error: statusCode >= 500 ? "The local QC service could not complete the request." : error.message,
      ...(statusCode === 409 ? { code: "stale_revision" } : error.code ? { code: error.code } : {}),
    });
  }
}

export function createRequestHandler(resolveTarget = resolveStaticTarget, {
  services = null,
  host = HOST,
  port = PORT,
  maxBodyBytes = API_BODY_MAX_BYTES,
} = {}) {
  return async (request, response) => {
    if (request.headers.host !== `${host}:${port}`) {
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
    const expectedOrigin = `http://${host}:${port}`;
    if (origin !== undefined && origin !== expectedOrigin) {
      if (isApi) sendJson(response, 403, { error: "Requests must come from this local application origin.", code: "origin_not_allowed" });
      else send(response, 403, "Forbidden\n", { "Content-Type": "text/plain; charset=utf-8" });
      return;
    }
    if (isApi) {
      if (request.method !== "GET" && request.method !== "POST") {
        sendJson(response, 405, { error: "Method is not allowed.", code: "method_not_allowed" });
        return;
      }
      if (request.method === "POST" && origin !== expectedOrigin) {
        sendJson(response, 403, { error: "POST requests require the local application origin.", code: "origin_required" });
        return;
      }
      if (!services) {
        sendJson(response, 503, { error: "The local QC service is not ready.", code: "service_unavailable" });
        return;
      }
      await handleApiRequest(request, response, requestPath, services, maxBodyBytes);
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
  };
}

export function getDefaultDataDirectory({ platform = process.platform, env = process.env, projectRoot = PROJECT_ROOT } = {}) {
  const pathApi = platform === "win32" ? path.win32 : path;
  if (env.MASTERQC_DATA_DIR) return pathApi.resolve(env.MASTERQC_DATA_DIR);
  return pathApi.resolve(projectRoot, "data", "workspace");
}

export async function createQCWorkspaceServices({ dataDirectory, projectRoot = PROJECT_ROOT } = {}) {
  const [{ createSQLiteQCAdapter }] = await Promise.all([import("../storage/sqlite-qc-adapter.mjs")]);
  const directory = path.resolve(dataDirectory ?? getDefaultDataDirectory({ projectRoot }));
  const services = {
    main: createQCService(createSQLiteQCAdapter({ databasePath: path.join(directory, "masterqc-main.sqlite") })),
    demo: createQCService(createSQLiteQCAdapter({ databasePath: path.join(directory, "masterqc-demo.sqlite") })),
  };
  return Object.freeze({
    ...services,
    close() {
      services.main.close();
      services.demo.close();
    },
  });
}

export async function createStaticServer({ dataDirectory = getDefaultDataDirectory(), services: suppliedServices, host = HOST, port = PORT } = {}) {
  const services = suppliedServices ?? await createQCWorkspaceServices({ dataDirectory });
  const server = createHttpServer(createRequestHandler(resolveStaticTarget, { services, host, port }));
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
      console.warn("已启动本地页面，但系统未能自动打开浏览器；请手动访问 http://127.0.0.1:4173");
    });
    child.unref();
  } catch {
    console.warn("已启动本地页面，但系统未能自动打开浏览器；请手动访问 http://127.0.0.1:4173");
  }
}

export async function startServer({ open = true } = {}) {
  const startupIssue = await checkStartupRequirements();
  if (startupIssue) {
    console.error(startupIssue);
    return null;
  }

  let server;
  try {
    server = await createStaticServer();
  } catch (error) {
    console.error(`Local QC database could not be opened: ${error instanceof Error ? error.message : "unknown error"}`);
    return null;
  }
  return new Promise((resolve) => {
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        console.error("Local port 4173 is already in use. Close the other program using it, then restart MasterQC Web.");
      } else {
        console.error(`Local server could not start: ${error.message}`);
      }
      server.qcServices?.close?.();
      resolve(null);
    });
    server.listen(PORT, HOST, () => {
      console.log(`MasterQC Web 已启动：${CANONICAL_URL}`);
      if (open) openBrowser(CANONICAL_URL);
      resolve(server);
    });
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--no-open");
  if (unknownArguments.length > 0) {
    console.error("参数不受支持。可选参数：--no-open");
    process.exitCode = 2;
  } else {
    const server = await startServer({ open: !process.argv.includes("--no-open") });
    if (!server) process.exitCode = 1;
  }
}
