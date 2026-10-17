import test from "node:test";
import assert from "node:assert/strict";
import { installDomStub, findButton, flush } from "./dom-stub.js";

// Loads the page shell against a fake server whose release can change, so the new-version notice runs end to end.
const dom = installDomStub();
const app = dom.document.createElement("div");
app.id = "app";
dom.body.append(app);
dom.document.visibilityState = "visible";
dom.window.setInterval = () => 0;
globalThis.history = { replaceState() {}, pushState() {} };
const reloads = [];
globalThis.location = new URL("http://127.0.0.1:4173/");
globalThis.location.reload = () => {
  reloads.push(true);
};
globalThis.BroadcastChannel = class FakeBroadcastChannel {
  addEventListener() {}
  postMessage() {}
};

const { createInitialQCState } = await import("../../core/qc-domain.js");
let serverRelease = "2026.10.17-a";
let sessionStatus = 200;
const requests = [];

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url, "http://127.0.0.1:4173").pathname;
  requests.push(`${init.method ?? "GET"} ${path}`);
  const state = { ...createInitialQCState(), revision: 4 };
  if (path.endsWith("/initialize") || path.endsWith("/state/lightweight")) return json(state);
  if (path.endsWith("/revision")) return json({ revision: 4 });
  if (path === "/api/session") {
    if (sessionStatus !== 200) return json({ error: "Not part of this test." }, sessionStatus);
    return json({ release: serverRelease, actor: "ann" });
  }
  return json({ error: "Not part of this test.", code: "route_not_found" }, 404);
};

await import("../qc-main.js");
await flush(10);

function releaseNotice() {
  return dom.document.querySelector("#release-notice");
}

test("the new-version notice stays hidden while the release is unchanged, and the session is read once at start-up", () => {
  assert.equal(requests.filter((entry) => entry === "GET /api/session").length, 1);
  assert.equal(releaseNotice().hidden, true);
});

test("a changed release shows a persistent notice on the next focus, and Reload now reloads when nothing is pending", async () => {
  serverRelease = "2026.10.17-b";
  dom.fire(dom.window, "focus");
  await flush();

  assert.equal(releaseNotice().hidden, false);
  assert.ok(releaseNotice().textContent.includes("A new version of MasterQC is available. Your edits are kept — reload when convenient."));
  assert.equal(dom.document.querySelector("#stale-warning").hidden, true, "the notice is not a blocking banner");

  // The notice is rebuilt with every render, and it stays until the user reloads.
  dom.fire(dom.window, "focus");
  await flush();
  assert.equal(releaseNotice().hidden, false);

  dom.click(findButton(releaseNotice(), "Reload now"));
  await flush();
  assert.equal(reloads.length, 1);
});

test("a server that stops answering the session route keeps the page and its notice state unchanged", async () => {
  sessionStatus = 503;
  const before = releaseNotice().hidden;
  dom.fire(dom.window, "focus");
  await flush();

  assert.equal(releaseNotice().hidden, before);
  assert.equal(dom.document.querySelector("#stale-warning").hidden, true);
  sessionStatus = 200;
});
