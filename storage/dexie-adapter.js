import Dexie from "../vendor/dexie.mjs";

const DATABASE_NAME = "masterqc-web";

/** Local browser storage for the initial draft. Keep Dexie inside storage/. */
export function createDexieAdapter() {
  const database = new Dexie(DATABASE_NAME);
  database.version(2).stores({
    settings: "key",
    qcState: "key",
  });
  database.on("versionchange", () => database.close());

  return Object.freeze({
    async initialize() {
      await database.open();
    },

    async getSetting(key) {
      const row = await database.table("settings").get(key);
      return row?.value;
    },

    async setSetting(key, value) {
      await database.table("settings").put({
        key,
        value,
        updatedAt: new Date().toISOString(),
      });
    },
  });
}
