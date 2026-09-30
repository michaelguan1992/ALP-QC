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

/** In-memory QC adapter for core tests; it follows the durable adapter contract. */
export function createMemoryQCAdapter({ initialState = null } = {}) {
  let state = initialState === null ? null : cloneState(initialState);
  let queue = Promise.resolve();

  return Object.freeze({
    async initialize() {},

    async readState() {
      await queue;
      return state === null ? null : clone(state);
    },

    transact(mutator) {
      if (typeof mutator !== "function") return Promise.reject(new TypeError("QC transaction mutator must be a function"));

      const transaction = queue.then(() => {
        const current = state === null ? null : clone(state);
        const outcome = requireSynchronousOutcome(mutator(current));
        const nextState = cloneState(outcome.state);
        const result = clone(outcome.result);
        state = nextState;
        return result;
      });
      queue = transaction.catch(() => undefined);
      return transaction;
    },

    async close() {
      await queue;
    },
  });
}
