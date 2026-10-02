import { createHttpJsonTransport } from "../storage/http-json-transport.js";

const WORKSPACES = new Set(["main", "demo"]);

function requireWorkspace(workspace) {
  if (!WORKSPACES.has(workspace)) throw new TypeError("QC workspace must be main or demo.");
  return workspace;
}

export function createQCHttpService({ workspace = "main", fetchImpl = globalThis.fetch, baseUrl = "" } = {}) {
  const selectedWorkspace = requireWorkspace(workspace);
  const root = `${baseUrl.replace(/\/$/, "")}/api/qc/${selectedWorkspace}`;
  const transport = createHttpJsonTransport({ fetchImpl, baseUrl: root });
  const request = transport.request;

  return Object.freeze({
    workspace: selectedWorkspace,
    initialize: (options = {}) => request("/initialize", {
      method: "POST",
      body: options?.mode ? { mode: options.mode } : {},
    }),
    getState: (options = {}) => request(options === "lightweight" || options?.mode === "lightweight" ? "/state/lightweight" : "/state"),
    getRevision: async () => (await request("/revision")).revision,
    command: (type, data = {}, expectedRevision) => request("/command", {
      method: "POST",
      body: { type, data, expectedRevision },
    }),
    saveBatchChanges: (data, expectedRevision) => request("/command", {
      method: "POST",
      body: { type: "saveBatchChanges", data, expectedRevision },
    }),
    getAsset: (assetId) => request(`/assets/${encodeURIComponent(assetId)}`),
    getBatchWorkspace: (batchId, options = { mode: "lightweight" }) => request(
      options === "lightweight" || options?.mode === "lightweight"
        ? `/batches/${encodeURIComponent(batchId)}/lightweight`
        : `/batches/${encodeURIComponent(batchId)}`,
    ),
    getPurchaseOrderProgress: (orderId) => request(`/orders/${encodeURIComponent(orderId)}/progress`),
    exportBackup: () => request("/backup"),
    importBackup: (backup, expectedRevision) => request("/restore", {
      method: "POST",
      body: { backup, expectedRevision },
    }),
    importHistory: (historyPackage, expectedRevision) => request("/history", {
      method: "POST",
      body: { historyPackage, expectedRevision },
    }),
  });
}
