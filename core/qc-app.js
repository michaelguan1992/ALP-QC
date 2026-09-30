import { createQCAdapter } from "../storage/qc-adapter.js";
import { createQCService } from "./qc-service.js";

export const qcService = createQCService(createQCAdapter());

export function createDemoQCService() {
  return createQCService(createQCAdapter({ databaseName: "masterqc-web-demo" }));
}
