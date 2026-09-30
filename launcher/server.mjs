import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
      return resolveFileWithinRoot(root.directory, relativePath, projectRoot);
    }
  }
  return null;
}

export async function checkStartupRequirements({
  projectRoot = PROJECT_ROOT,
  dexiePackageRoot = path.join(projectRoot, "node_modules", "dexie"),
} = {}) {
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
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-src 'self' blob:",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...headers,
  });
  response.end(body);
}

export function createRequestHandler(resolveTarget = resolveStaticTarget) {
  return async (request, response) => {
    if (request.headers.host !== `${HOST}:${PORT}`) {
      send(response, 400, "Bad Request\n", { "Content-Type": "text/plain; charset=utf-8" });
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

export function createStaticServer() {
  return createHttpServer(createRequestHandler());
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

  const server = createStaticServer();
  return new Promise((resolve) => {
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        console.error("本地端口 4173 已被占用。请先关闭占用该端口的程序，再重新启动 MasterQC Web。");
      } else {
        console.error(`本地服务器启动失败：${error.message}`);
      }
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
