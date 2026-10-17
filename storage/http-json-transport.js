// Browser transport for the QC HTTP API. Every request has a deadline. The default is 60 seconds;
// core/qc-http-service.js passes the longer budget for large transfers. An expired or unreachable
// request rejects with a stable `code`, so callers can tell a failed request from one whose outcome
// is unknown. The stored-data contract of the server is unchanged.

export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const LONG_REQUEST_TIMEOUT_MS = 15 * 60_000;

export const REQUEST_TIMEOUT_MESSAGE = "The server did not respond in time. The change may or may not have been saved. Reload the latest data to check before trying again.";
export const NETWORK_ERROR_MESSAGE = "Could not reach the QC server. Check your connection; unsaved edits are still on this page.";
const UNREADABLE_RESPONSE_MESSAGE = "The QC server returned an unreadable response.";

function failure(message, { code, status } = {}) {
  const error = new Error(message);
  if (code) error.code = code;
  if (status !== undefined) error.status = status;
  return error;
}

/** The message for an error response whose body does not carry an `error` string. */
export function statusMessage(status) {
  if (status === 401 || status === 403) return "Your sign-in was rejected or expired. Reload the page to sign in again.";
  if (status === 413) return "This upload is larger than the server accepts.";
  if (status === 502 || status === 503 || status === 504) return "The QC server is temporarily unreachable. Try again in a moment.";
  return `The QC server could not complete the request (HTTP ${status}).`;
}

export function createHttpJsonTransport({ fetchImpl = globalThis.fetch, baseUrl = "", timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("HTTP JSON transport requires fetch.");
  const origin = baseUrl.replace(/\/$/, "");

  // Reads one response. `isTimedOut` tells a deadline abort apart from a failure of the connection.
  async function exchange(url, init, isTimedOut) {
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch {
      throw isTimedOut()
        ? failure(REQUEST_TIMEOUT_MESSAGE, { code: "request_timeout" })
        : failure(NETWORK_ERROR_MESSAGE, { code: "network_error" });
    }

    let payload;
    let unreadable = false;
    try {
      payload = await response.json();
    } catch (error) {
      if (isTimedOut()) throw failure(REQUEST_TIMEOUT_MESSAGE, { code: "request_timeout" });
      // Invalid JSON is classified by status below. Any other failure means the body never fully arrived.
      if (!(error instanceof SyntaxError)) throw failure(NETWORK_ERROR_MESSAGE, { code: "network_error" });
      unreadable = true;
    }

    const ok = typeof response.ok === "boolean" ? response.ok : response.status >= 200 && response.status < 300;
    if (!ok) {
      const message = typeof payload?.error === "string" && payload.error.trim() ? payload.error : statusMessage(response.status);
      throw failure(message, {
        status: response.status,
        code: typeof payload?.code === "string" ? payload.code : undefined,
      });
    }
    if (unreadable) throw failure(UNREADABLE_RESPONSE_MESSAGE, { status: response.status });
    return payload;
  }

  return Object.freeze({
    async request(path, { method = "GET", body, timeoutMs: requestTimeoutMs = timeoutMs } = {}) {
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      let timedOut = false;
      let timer = null;
      // The race keeps the deadline even when fetchImpl ignores the abort signal.
      const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller?.abort();
          reject(failure(REQUEST_TIMEOUT_MESSAGE, { code: "request_timeout" }));
        }, requestTimeoutMs);
      });
      const init = {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        signal: controller?.signal,
      };
      try {
        return await Promise.race([exchange(`${origin}${path}`, init, () => timedOut), deadline]);
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
