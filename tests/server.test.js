import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CANONICAL_URL,
  HOST,
  PORT,
  checkStartupRequirements,
  createRequestHandler,
  resolveStaticTarget,
} from "../launcher/server.mjs";

async function createRoots() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "masterqc-web-test-"));
  const root = await realpath(temporaryRoot);
  const roots = [];
  for (const name of ["frontend", "core", "storage"]) {
    const directory = path.join(root, name);
    await mkdir(directory);
    roots.push({ urlPrefix: `/${name}`, directory });
  }
  await writeFile(path.join(roots[0].directory, "index.html"), "<main>test</main>");
  return { root, roots };
}

test("static routes expose only the allowlisted app roots and exact Dexie resource", async (t) => {
  const { root, roots } = await createRoots();
  t.after(() => rm(root, { recursive: true, force: true }));
  const dexieRoot = path.join(root, "dexie");
  await mkdir(path.join(dexieRoot, "dist"), { recursive: true });
  await writeFile(path.join(dexieRoot, "dist", "dexie.mjs"), "export default class Dexie {}");
  const options = { roots, dexiePackageRoot: dexieRoot, projectRoot: root };

  assert.equal(await resolveStaticTarget("/", options), path.join(roots[0].directory, "index.html"));
  assert.equal(await resolveStaticTarget("/frontend/index.html", options), path.join(roots[0].directory, "index.html"));
  assert.equal(await resolveStaticTarget("/vendor/dexie.mjs", options), path.join(dexieRoot, "dist", "dexie.mjs"));
  assert.equal(await resolveStaticTarget("/README.md", options), null);
  assert.equal(await resolveStaticTarget("/package.json", options), null);
  assert.equal(await resolveStaticTarget("/vendor/package.json", options), null);
});

test("static routes expose only the generated Lark import package", async (t) => {
  const { root, roots } = await createRoots();
  t.after(() => rm(root, { recursive: true, force: true }));
  const dexieRoot = path.join(root, "dexie");
  const larkImportRoot = path.join(root, "data", "lark-import");
  await mkdir(path.join(dexieRoot, "dist"), { recursive: true });
  await mkdir(larkImportRoot, { recursive: true });
  await writeFile(path.join(dexieRoot, "dist", "dexie.mjs"), "export default class Dexie {}");
  await writeFile(path.join(larkImportRoot, "version-history.v1.json"), "{\"format\":\"masterqc-lark-version-import\"}");
  await writeFile(path.join(larkImportRoot, "source-export.ndjson"), "private source export");
  const options = { roots, dexiePackageRoot: dexieRoot, larkImportRoot, projectRoot: root };

  assert.equal(await resolveStaticTarget("/data/lark-import/version-history.v1.json", options), path.join(larkImportRoot, "version-history.v1.json"));
  assert.equal(await resolveStaticTarget("/data/lark-import/package.json", options), null);
  assert.equal(await resolveStaticTarget("/data/lark-import/source-export.ndjson", options), null);
  assert.equal(await resolveStaticTarget("/data/lark-import/../package.json", options), null);
});

test("generated Lark package is served as JSON through its exact route", async (t) => {
  const { root, roots } = await createRoots();
  t.after(() => rm(root, { recursive: true, force: true }));
  const dexieRoot = path.join(root, "dexie");
  const larkImportRoot = path.join(root, "data", "lark-import");
  await mkdir(path.join(dexieRoot, "dist"), { recursive: true });
  await mkdir(larkImportRoot, { recursive: true });
  await writeFile(path.join(dexieRoot, "dist", "dexie.mjs"), "export default class Dexie {}");
  const expectedBody = "{\"format\":\"masterqc-lark-version-import\"}";
  await writeFile(path.join(larkImportRoot, "version-history.v1.json"), expectedBody);
  const options = { roots, dexiePackageRoot: dexieRoot, larkImportRoot, projectRoot: root };
  const response = {
    headers: null,
    statusCode: null,
    body: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
  const handler = createRequestHandler((requestPath) => resolveStaticTarget(requestPath, options));

  await handler({ headers: { host: `${HOST}:${PORT}` }, method: "GET", url: "/data/lark-import/version-history.v1.json" }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Content-Type"], "application/json; charset=utf-8");
  assert.equal(response.body.toString(), expectedBody);
});

test("CSP permits local blob document frames while keeping other sources restricted", async (t) => {
  const { root, roots } = await createRoots();
  t.after(() => rm(root, { recursive: true, force: true }));
  const response = {
    headers: null,
    statusCode: null,
    body: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
  const handler = createRequestHandler(async () => path.join(roots[0].directory, "index.html"));

  await handler({ headers: { host: `${HOST}:${PORT}` }, method: "GET", url: "/frontend/index.html" }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Content-Security-Policy"], "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-src 'self' blob:");
  assert.equal(response.headers["Content-Security-Policy"].includes("script-src 'self' blob:"), false);
  assert.equal(response.headers["Content-Security-Policy"].includes("connect-src 'self' blob:"), false);
  assert.equal(response.headers["Content-Security-Policy"].includes("object-src blob:"), false);
});

test("static routes reject encoded traversal, separators, malformed paths, and external roots", async (t) => {
  const { root, roots } = await createRoots();
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { roots, projectRoot: root };

  for (const requestPath of [
    "/frontend/%2e%2e/README.md",
    "/frontend/%2e%2e%2fREADME.md",
    "/frontend/%5c..%5cREADME.md",
    "/frontend/%E0%A4%A",
    "/frontend/./index.html",
    "//example.com/frontend/index.html",
  ]) {
    assert.equal(await resolveStaticTarget(requestPath, options), null, `should reject ${requestPath}`);
  }
});

test("static routes reject symlinks that escape the allowlisted directory", async (t) => {
  const { root, roots } = await createRoots();
  t.after(() => rm(root, { recursive: true, force: true }));
  const external = path.join(root, "outside.txt");
  await writeFile(external, "secret");

  try {
    await symlink(external, path.join(roots[0].directory, "escape.txt"));
  } catch (error) {
    if (error.code === "EPERM" || error.code === "ENOTSUP") {
      t.skip(`symlink creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  assert.equal(await resolveStaticTarget("/frontend/escape.txt", { roots, projectRoot: root }), null);
});

test("startup reports a missing local Dexie dependency and server uses the canonical loopback address", async (t) => {
  const { root } = await createRoots();
  t.after(() => rm(root, { recursive: true, force: true }));
  const issue = await checkStartupRequirements({ projectRoot: root });

  assert.match(issue, /Dexie/);
  assert.equal(HOST, "127.0.0.1");
  assert.equal(PORT, 4173);
  assert.equal(CANONICAL_URL, "http://127.0.0.1:4173");
});
