import { createQCAdapter } from "../storage/qc-adapter.js";
import { makeBackup } from "./qc-backup.js";
import { createQCHttpService } from "./qc-http-service.js";

export const qcService = createQCHttpService({ workspace: "main" });

export function createDemoQCService() {
  return createQCHttpService({ workspace: "demo" });
}

/** Read an older browser QC aggregate without running startup migrations or changing it. */
export async function exportLegacyBrowserBackup() {
  const adapter = createQCAdapter();
  try {
    await adapter.initialize();
    const state = await adapter.readState();
    if (!state) throw new Error("No existing QC records were found in this browser profile.");
    return makeBackup(state, () => new Date().toISOString());
  } finally {
    adapter.close();
  }
}
