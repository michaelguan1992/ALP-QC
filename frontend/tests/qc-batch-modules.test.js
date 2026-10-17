import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installDomStub } from "./dom-stub.js";

// Record the window listeners added while the batch modules load, so import-time registration can be counted.
const dom = installDomStub();
const windowListeners = [];
const addWindowListener = dom.window.addEventListener.bind(dom.window);
dom.window.addEventListener = (type, handler, options) => {
  windowListeners.push({ type, handler });
  addWindowListener(type, handler, options);
};

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BATCH_MODULES = [
  "qc-batch-model.js",
  "qc-batch-attachments.js",
  "qc-batch-rows.js",
  "qc-batch-historical.js",
  "qc-batch-detail.js",
  "qc-batch-new.js",
  "qc-ops-batches.js",
];

// Public exports of qc-ops-batches.js recorded before the split, with their arity. Existing importers rely on them.
const RECORDED_PUBLIC_EXPORTS = { clearBatchDrafts: 0, inspectionControlName: 2, renderBatchesPage: 2 };

const batchModules = {};
for (const file of BATCH_MODULES) batchModules[file] = await import(`../${file}`);
const drafts = await import("../qc-batch-drafts.js");

function sourceOf(file) {
  return readFileSync(path.join(frontendDir, file), "utf8");
}

// Relative module specifiers named by import and re-export statements, without the leading "./".
function relativeImports(file) {
  return [...sourceOf(file).matchAll(/^(?:import|export)\s[^;]*?\bfrom\s*"(\.\/[^"]+)";/gm)].map((match) => match[1].slice(2));
}

// Named bindings that a file imports from a sibling module.
function namedImports(file) {
  return [...sourceOf(file).matchAll(/^import\s*\{([^}]*)\}\s*from\s*"\.\/([^"]+)";/gm)].map((match) => ({
    target: match[2],
    names: match[1].split(",").map((name) => name.trim()).filter(Boolean),
  }));
}

test("the split batch modules load and the names they import from each other are exported", () => {
  for (const file of BATCH_MODULES) {
    for (const { target, names } of namedImports(file)) {
      if (!BATCH_MODULES.includes(target)) continue;
      for (const name of names) {
        assert.equal(typeof batchModules[target][name], "function", `${file} imports ${name} from ${target}`);
      }
    }
  }
});

test("the batch page modules form no import cycle", () => {
  const finished = new Set();
  const onPath = [];
  const visit = (file) => {
    if (finished.has(file)) return;
    if (onPath.includes(file)) assert.fail(`import cycle: ${[...onPath, file].join(" -> ")}`);
    onPath.push(file);
    for (const target of relativeImports(file)) visit(target);
    onPath.pop();
    finished.add(file);
  };
  for (const file of BATCH_MODULES) visit(file);
});

test("qc-ops-batches.js keeps the public exports recorded before the split", () => {
  const entry = batchModules["qc-ops-batches.js"];
  assert.deepEqual(Object.keys(entry), Object.keys(RECORDED_PUBLIC_EXPORTS));
  for (const [name, arity] of Object.entries(RECORDED_PUBLIC_EXPORTS)) {
    assert.equal(typeof entry[name], "function", name);
    assert.equal(entry[name].length, arity, `${name} arity`);
  }
});

test("import-time window listeners are registered once and not again on re-import", async () => {
  const countListeners = (type, matches) => windowListeners.filter((entry) => entry.type === type && matches(entry.handler)).length;
  assert.equal(countListeners("beforeunload", (handler) => String(handler).includes("hasAnyBatchDrafts")), 1);
  assert.equal(countListeners("masterqc:discard-operation-drafts", (handler) => handler === drafts.clearBatchDrafts), 1);
  const before = windowListeners.length;
  await import("../qc-ops-batches.js");
  assert.equal(windowListeners.length, before, "re-importing a loaded module must not add listeners");
});
