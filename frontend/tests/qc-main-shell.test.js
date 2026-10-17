import test from "node:test";
import assert from "node:assert/strict";
import { installDomStub, findButton, flush } from "./dom-stub.js";

// Loads the page shell against a fake server, so its start-up, notice wiring, and reload path run.
const dom = installDomStub();
const app = dom.document.createElement("div");
app.id = "app";
dom.body.append(app);
dom.document.visibilityState = "visible";
dom.window.setInterval = () => 0;
globalThis.location = new URL("http://127.0.0.1:4173/");
globalThis.history = { replaceState() {}, pushState() {} };

const channels = [];
globalThis.BroadcastChannel = class FakeBroadcastChannel {
  constructor(name) {
    this.name = name;
    this.listeners = [];
    channels.push(this);
  }

  addEventListener(type, handler) {
    if (type === "message") this.listeners.push(handler);
  }

  postMessage() {}
};

const { createInitialQCState } = await import("../../core/qc-domain.js");
const requests = [];
let serverRevision = 4;
let stateDown = false;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

globalThis.fetch = async (url, init = {}) => {
  // The browser transport requests same-origin paths, so the fake resolves them against the page origin.
  const path = new URL(url, "http://127.0.0.1:4173").pathname;
  requests.push(`${init.method ?? "GET"} ${path}`);
  const state = { ...createInitialQCState(), revision: serverRevision };
  if (path.endsWith("/initialize")) return json(state);
  if (path.endsWith("/state/lightweight")) return stateDown ? json({ error: "The server is down for this test." }, 500) : json(state);
  if (path.endsWith("/revision")) return json({ revision: serverRevision });
  return new Response(JSON.stringify({ error: "Not part of this test.", code: "route_not_found" }), { status: 404 });
};

await import("../qc-main.js");
await flush(10);

function noticeElement() {
  return dom.document.querySelector("#shared-change-notice");
}

test("the page shell starts, shows the batch list, and keeps both warnings hidden", () => {
  assert.ok(app.querySelector(".app-sidebar"), "the sidebar rendered");
  assert.equal(dom.document.querySelector("#stale-warning").hidden, true);
  assert.equal(noticeElement().hidden, true);
  assert.ok(app.textContent.includes("Shared workspace"), "storage label uses the neutral wording");
  assert.equal(requests[0], "POST /api/qc/main/initialize");
});

test("a newer revision from another tab shows a notice without reloading, and Reload clears it", async () => {
  serverRevision = 9;
  const before = requests.length;
  channels[0].listeners.forEach((listener) => listener({ data: { revision: 9 } }));
  await flush();

  assert.equal(noticeElement().hidden, false);
  assert.ok(noticeElement().textContent.includes("Newer changes from other users are available."));
  assert.equal(dom.document.querySelector("#stale-warning").hidden, true, "the notice is not a blocking warning");
  assert.equal(requests.slice(before).some((entry) => entry.includes("/state")), false, "nothing reloaded by itself");

  dom.click(findButton(noticeElement(), "Reload"));
  await flush();

  assert.equal(requests.slice(before).includes("GET /api/qc/main/state/lightweight"), true);
  assert.equal(noticeElement().hidden, true);
});

test("while the blocking banner explains a failed reload, the informational notice stays hidden", async () => {
  serverRevision = 10;
  channels[0].listeners.forEach((listener) => listener({ data: { revision: 10 } }));
  await flush();
  assert.equal(noticeElement().hidden, false);

  stateDown = true;
  dom.click(findButton(noticeElement(), "Reload"));
  await flush();
  stateDown = false;

  const banner = dom.document.querySelector("#stale-warning");
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /could not be loaded/);
  assert.equal(noticeElement().hidden, true, "only one reload action is offered while the banner stands");
});
