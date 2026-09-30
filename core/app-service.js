import { createDataService } from "./data-service.js";
import { createDexieAdapter } from "../storage/dexie-adapter.js";

// Compose the browser implementation here so frontend code imports core only.
export const dataService = createDataService(createDexieAdapter());
