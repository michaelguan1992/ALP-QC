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
    initialize: () => request("/initialize", { method: "POST", body: {} }),
    getState: () => request("/state"),
    getRevision: async () => (await request("/revision")).revision,
    command: (type, data = {}, expectedRevision) => request("/command", {
      method: "POST",
      body: { type, data, expectedRevision },
    }),
    getBatchWorkspace: (batchId) => request(`/batches/${encodeURIComponent(batchId)}`),
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
