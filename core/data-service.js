const INITIALIZATION_DRAFT_KEY = "initializationDraft";

function requireAdapterMethod(adapter, methodName) {
  if (!adapter || typeof adapter[methodName] !== "function") {
    throw new TypeError(`数据适配器必须提供 ${methodName} 方法`);
  }
}

/**
 * The UI depends on this service only. Swap the adapter here to add a future
 * backend, keeping a tiny API layer and SQLite behind the same settings seam.
 */
export function createDataService(adapter) {
  requireAdapterMethod(adapter, "getSetting");
  requireAdapterMethod(adapter, "setSetting");

  return Object.freeze({
    async initialize() {
      if (typeof adapter.initialize === "function") await adapter.initialize();
    },

    async loadInitializationDraft() {
      const value = await adapter.getSetting(INITIALIZATION_DRAFT_KEY);
      if (value === undefined || value === null) return "";
      if (typeof value !== "string") throw new TypeError("本地草稿格式无效");
      return value;
    },

    async saveInitializationDraft(note) {
      if (typeof note !== "string") throw new TypeError("草稿必须是文本");
      await adapter.setSetting(INITIALIZATION_DRAFT_KEY, note);
    },
  });
}
