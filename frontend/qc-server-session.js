// Reads GET /api/session to learn the server's release and the signed-in user, and tells the page when the
// release changes after it started. The read is tolerant by design: a server without the route (404), a
// failed or slow request, or an unexpected body means "unknown", and the page carries on silently.

export const SESSION_PATH = "/api/session";
export const SESSION_REQUEST_TIMEOUT_MS = 5_000;
export const RELEASE_CHECK_INTERVAL_MS = 5 * 60_000;
export const RELEASE_NOTICE_MESSAGE = "A new version of MasterQC is available. Your edits are kept — reload when convenient.";

function nonEmptyText(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** `{ release, actor }` from the server, or null when the server could not say. Never rejects. */
export async function readServerSession({ fetchImpl = globalThis.fetch, timeoutMs = SESSION_REQUEST_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== "function") return null;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer = null;
  // The race keeps the deadline even when fetchImpl ignores the abort signal.
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller?.abort();
      resolve(null);
    }, timeoutMs);
  });
  const request = (async () => {
    try {
      const response = await fetchImpl(SESSION_PATH, {
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller?.signal,
      });
      if (!response?.ok) return null;
      const body = await response.json();
      if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
      return { release: nonEmptyText(body.release), actor: nonEmptyText(body.actor) };
    } catch {
      return null;
    }
  })();
  try {
    return await Promise.race([request, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compares the server's release with the release this page started with. `check` asks the server now
 * (calls made while a request is in flight share it). `tick` asks only once the check interval has passed,
 * so it can ride on a timer the page already runs. When no release was known at start-up, the first one
 * the server reports becomes the baseline silently, so a later change can still be noticed.
 */
export function createReleaseWatch({
  startRelease = null,
  readSession = readServerSession,
  onNewRelease = () => {},
  now = () => Date.now(),
  intervalMs = RELEASE_CHECK_INTERVAL_MS,
} = {}) {
  let baseline = nonEmptyText(startRelease);
  let lastCheckedAt = now();
  let inFlight = null;
  let announced = false;

  function check() {
    if (inFlight) return inFlight;
    lastCheckedAt = now();
    inFlight = (async () => {
      let session = null;
      try {
        session = await readSession();
      } catch {
        // An unreadable session is "unknown", never a notice.
      }
      const release = nonEmptyText(session?.release);
      if (release !== null) {
        if (baseline === null) baseline = release;
        else if (release !== baseline && !announced) {
          announced = true;
          onNewRelease(release);
        }
      }
      return { release, announced };
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return Object.freeze({
    check,
    tick() {
      return now() - lastCheckedAt >= intervalMs ? check() : null;
    },
    isAnnounced: () => announced,
  });
}
