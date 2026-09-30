export function createHttpJsonTransport({ fetchImpl = globalThis.fetch, baseUrl = "" } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("HTTP JSON transport requires fetch.");
  const origin = baseUrl.replace(/\/$/, "");

  return Object.freeze({
    async request(path, { method = "GET", body } = {}) {
      const response = await fetchImpl(`${origin}${path}`, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error(response.ok ? "The local QC service returned an unreadable response." : "The local QC service could not complete the request.");
      }
      if (!response.ok) {
        const error = new Error(typeof payload?.error === "string" ? payload.error : "The local QC service could not complete the request.");
        error.status = response.status;
        error.code = payload?.code;
        throw error;
      }
      return payload;
    },
  });
}
