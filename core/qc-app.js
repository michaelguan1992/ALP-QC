import { createQCHttpService } from "./qc-http-service.js";

export const qcService = createQCHttpService({ workspace: "main" });

export function createDemoQCService() {
  return createQCHttpService({ workspace: "demo" });
}
