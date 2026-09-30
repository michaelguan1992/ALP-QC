import Dexie from "../vendor/dexie.mjs";

const DATABASE_NAME = "masterqc-web";
const STATE_KEY = "main";

function clone(value) {
  return structuredClone(value);
}

function cloneState(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("QC state must be an object");
  }
  return clone(value);
}

function requireSynchronousOutcome(value) {
  if (value !== null && (typeof value === "object" || typeof value === "function") && typeof value.then === "function") {
    throw new TypeError("QC transaction mutator must be synchronous");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("QC transaction mutator must return an object containing state and result");
  }
  return value;
}

/** Durable local QC state, isolated from core business rules. */
export function createQCAdapter({ databaseName = DATABASE_NAME } = {}) {
  const database = new Dexie(databaseName);
  database.version(2).stores({
    settings: "key",
    qcState: "key",
  });
  database.on("versionchange", () => database.close());

  const stateTable = database.table("qcState");

  return Object.freeze({
    async initialize() {
      await database.open();
    },

    async readState() {
      const row = await stateTable.get(STATE_KEY);
      return row?.value == null ? null : clone(row.value);
    },

    async transact(mutator) {
      if (typeof mutator !== "function") throw new TypeError("QC transaction mutator must be a function");

      let committedResult;
      await database.transaction("rw", stateTable, async () => {
        const row = await stateTable.get(STATE_KEY);
        const current = row?.value == null ? null : clone(row.value);
        const outcome = requireSynchronousOutcome(mutator(current));
        const nextState = cloneState(outcome.state);
        const result = clone(outcome.result);

        await stateTable.put({
          key: STATE_KEY,
          value: nextState,
          updatedAt: new Date().toISOString(),
        });
        committedResult = result;
      });

      return committedResult;
    },

    close() {
      database.close();
    },
  });
}
