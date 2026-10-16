import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF_CHECK = fileURLToPath(new URL("../scripts/pdf-import/test_pdf_parsers.py", import.meta.url));
const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
const pythonAvailable = python.status === 0;

test("the PDF parser self-check runs with python3 -I and no third-party packages", { skip: !pythonAvailable && "python3 is not installed" }, () => {
  const result = spawnSync("python3", ["-I", "-B", SELF_CHECK], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /OK/u);
});
