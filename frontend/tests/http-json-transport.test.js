import test from "node:test";
import assert from "node:assert/strict";
import { createHttpJsonTransport } from "../../storage/http-json-transport.js";

const BASE_URL = "http://127.0.0.1:4173/api/qc/main";
const TIMEOUT_MESSAGE = "The server did not respond in time. The change may or may not have been saved. Reload the latest data to check before trying again.";
const NETWORK_MESSAGE = "Could not reach the QC server. Check your connection; unsaved edits are still on this page.";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function textResponse(status, body = "") {
  return new Response(body, { status, headers: { "Content-Type": "text/html" } });
}

function outcome(promise) {
  return promise.then((value) => ({ value }), (error) => ({ error }));
}

test("a request that never answers rejects with request_timeout and aborts the fetch", async () => {
  let signal = null;
  // The fake ignores the abort signal, so the transport's own deadline has to end the request.
  const transport = createHttpJsonTransport({
    baseUrl: BASE_URL,
    timeoutMs: 20,
    fetchImpl: (_url, init) => {
      signal = init.signal;
      return new Promise(() => {});
    },
  });

  const { error } = await outcome(transport.request("/state"));

  assert.equal(error.code, "request_timeout");
  assert.equal(error.message, TIMEOUT_MESSAGE);
  assert.equal(signal.aborted, true);
});

test("a response body that stalls after the headers also reaches the deadline", async () => {
  const stalledBody = new ReadableStream({ start() {} });
  const transport = createHttpJsonTransport({
    baseUrl: BASE_URL,
    timeoutMs: 20,
    fetchImpl: async () => new Response(stalledBody, { status: 200 }),
  });

  const { error } = await outcome(transport.request("/state"));

  assert.equal(error.code, "request_timeout");
  assert.equal(error.message, TIMEOUT_MESSAGE);
});

test("a per-request timeout overrides the default for that request only", async () => {
  const transport = createHttpJsonTransport({
    baseUrl: BASE_URL,
    timeoutMs: 5,
    fetchImpl: () => new Promise((resolve) => setTimeout(() => resolve(jsonResponse(200, { ok: true })), 40)),
  });

  assert.deepEqual(await transport.request("/state", { timeoutMs: 1_000 }), { ok: true });
  const { error } = await outcome(transport.request("/state"));
  assert.equal(error.code, "request_timeout");
});

test("a fetch that rejects is reported as network_error with the connection guidance", async () => {
  const transport = createHttpJsonTransport({
    baseUrl: BASE_URL,
    fetchImpl: async () => { throw new TypeError("fetch failed"); },
  });

  const { error } = await outcome(transport.request("/command", { method: "POST", body: { type: "saveIssue" } }));

  assert.equal(error.code, "network_error");
  assert.equal(error.message, NETWORK_MESSAGE);
  assert.equal(error.status, undefined);
});

test("a body cut off by the connection is a network failure, not an unreadable response", async () => {
  const cutOff = new ReadableStream({
    start(controller) {
      controller.error(new TypeError("terminated"));
    },
  });
  const transport = createHttpJsonTransport({
    baseUrl: BASE_URL,
    fetchImpl: async () => new Response(cutOff, { status: 200 }),
  });

  const { error } = await outcome(transport.request("/state"));

  assert.equal(error.code, "network_error");
  assert.equal(error.message, NETWORK_MESSAGE);
});

test("JSON error responses keep the server's message, code, and status", async () => {
  const transport = createHttpJsonTransport({
    baseUrl: BASE_URL,
    fetchImpl: async () => jsonResponse(409, { error: "Someone else changed this record.", code: "stale_revision" }),
  });

  const { error } = await outcome(transport.request("/command", { method: "POST", body: {} }));

  assert.equal(error.message, "Someone else changed this record.");
  assert.equal(error.code, "stale_revision");
  assert.equal(error.status, 409);
});

test("non-JSON error responses are described by status", async () => {
  const cases = [
    [401, "Your sign-in was rejected or expired. Reload the page to sign in again."],
    [403, "Your sign-in was rejected or expired. Reload the page to sign in again."],
    [413, "This upload is larger than the server accepts."],
    [502, "The QC server is temporarily unreachable. Try again in a moment."],
    [503, "The QC server is temporarily unreachable. Try again in a moment."],
    [504, "The QC server is temporarily unreachable. Try again in a moment."],
    [500, "The QC server could not complete the request (HTTP 500)."],
    [418, "The QC server could not complete the request (HTTP 418)."],
  ];
  for (const [status, message] of cases) {
    const transport = createHttpJsonTransport({
      baseUrl: BASE_URL,
      fetchImpl: async () => textResponse(status, "<html>proxy page</html>"),
    });

    const { error } = await outcome(transport.request("/state"));

    assert.equal(error.message, message, `HTTP ${status}`);
    assert.equal(error.status, status, `HTTP ${status} keeps its status`);
  }
});

test("a JSON error body without an error string falls back to the status message", async () => {
  const transport = createHttpJsonTransport({
    baseUrl: BASE_URL,
    fetchImpl: async () => jsonResponse(400, { code: "invalid_command_data" }),
  });

  const { error } = await outcome(transport.request("/command", { method: "POST", body: {} }));

  assert.equal(error.message, "The QC server could not complete the request (HTTP 400).");
  assert.equal(error.code, "invalid_command_data");
  assert.equal(error.status, 400);
});

test("a successful response with an unreadable body is reported without a stale or timeout code", async () => {
  const transport = createHttpJsonTransport({
    baseUrl: BASE_URL,
    fetchImpl: async () => textResponse(200, "not json"),
  });

  const { error } = await outcome(transport.request("/state"));

  assert.equal(error.message, "The QC server returned an unreadable response.");
  assert.equal(error.status, 200);
  assert.equal(error.code, undefined);
});

test("successful JSON responses are returned unchanged", async () => {
  const transport = createHttpJsonTransport({
    baseUrl: BASE_URL,
    fetchImpl: async () => jsonResponse(200, { revision: 7 }),
  });

  assert.deepEqual(await transport.request("/revision"), { revision: 7 });
});
