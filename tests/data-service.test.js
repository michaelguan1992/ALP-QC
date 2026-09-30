import test from "node:test";
import assert from "node:assert/strict";
import { createDataService } from "../core/data-service.js";

function createMemoryAdapter() {
  const settings = new Map();
  return {
    settings,
    async getSetting(key) {
      return settings.get(key);
    },
    async setSetting(key, value) {
      settings.set(key, value);
    },
  };
}

test("data service reads and writes the initialization draft through its adapter", async () => {
  const adapter = createMemoryAdapter();
  const service = createDataService(adapter);

  assert.equal(await service.loadInitializationDraft(), "");
  await service.saveInitializationDraft("第一条初始化草稿");
  assert.equal(await service.loadInitializationDraft(), "第一条初始化草稿");
  assert.deepEqual([...adapter.settings.keys()], ["initializationDraft"]);
});

test("data service rejects non-text drafts and propagates adapter failures", async () => {
  const adapter = createMemoryAdapter();
  const service = createDataService(adapter);

  await assert.rejects(service.saveInitializationDraft({ text: "wrong shape" }), /必须是文本/);
  adapter.setSetting = async () => { throw new Error("quota exceeded"); };
  await assert.rejects(service.saveInitializationDraft("草稿"), /quota exceeded/);
});
