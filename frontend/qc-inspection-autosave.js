function clone(value) {
  return structuredClone(value);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function staleError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /revision|stale|another tab changed|changed since your last view/i.test(message);
}

export function createInspectionAutosaveController({ delayMs = 425 } = {}) {
  const entries = new Map();
  let writeTail = Promise.resolve();
  let disposed = false;

  function enqueueWrite(work) {
    const next = writeTail.then(work, work);
    writeTail = next.then(() => undefined, () => undefined);
    return next;
  }

  function notifyStatus(entry, status) {
    entry.status = status;
    try {
      entry.config.onStatus?.(status, {
        pending: entry.inFlight !== null || entry.committed !== null || !sameValue(entry.value, entry.acceptedInput),
        version: entry.version,
        value: clone(entry.value),
      });
    } catch {
      // A display callback must not change persistence state.
    }
  }

  function idleStatus(entry) {
    if (entry.acknowledged || entry.config.initiallySaved) return entry.config.isComplete(entry.value) ? "Saved" : "Saved · Incomplete";
    return entry.config.initiallySaved ? "Saved" : "Incomplete";
  }

  function hasPending(entry) {
    return !sameValue(entry.value, entry.acceptedInput);
  }

  function validate(entry) {
    try {
      return entry.config.isValid(entry.value) === true;
    } catch {
      return false;
    }
  }

  function cancelTimer(entry) {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  function schedule(entry, immediate = false) {
    cancelTimer(entry);
    if (disposed || entry.blockedStale || !hasPending(entry) || !validate(entry)) return;
    notifyStatus(entry, "Saving…");
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void flushEntry(entry);
    }, immediate ? 0 : delayMs);
  }

  function acknowledge(entry, sentValue, sentVersion, response) {
    entry.acceptedInput = clone(sentValue);
    entry.acknowledged = true;
    entry.lastAckVersion = sentVersion;
    entry.committed = null;
    entry.failed = false;
    try {
      entry.config.onSaved?.(clone(sentValue), response, {
        sentVersion,
        currentVersion: entry.version,
        currentValue: clone(entry.value),
        isCurrent: entry.version === sentVersion || sameValue(entry.value, sentValue),
      });
    } catch (error) {
      entry.config.onSyncError?.(error);
    }
    if (!hasPending(entry)) notifyStatus(entry, idleStatus(entry));
    else if (validate(entry)) schedule(entry, true);
    else notifyStatus(entry, "Incomplete");
  }

  async function resolveCommitted(entry) {
    const committed = entry.committed;
    if (!committed) return true;
    if (typeof entry.config.refreshCommitted !== "function") {
      entry.failed = true;
      notifyStatus(entry, "Save failed");
      return false;
    }
    let refreshed;
    try {
      refreshed = await entry.config.refreshCommitted(committed.response);
    } catch (error) {
      entry.failed = true;
      entry.config.onSyncError?.(error);
      notifyStatus(entry, "Save failed");
      return false;
    }
    if (!refreshed?.ok) {
      entry.failed = true;
      if (staleError(refreshed?.error)) entry.blockedStale = true;
      entry.config.onSyncError?.(refreshed?.error);
      notifyStatus(entry, "Save failed");
      return false;
    }
    if (entry.config.verifyCommitted && !entry.config.verifyCommitted(refreshed.state, committed.value)) {
      entry.blockedStale = true;
      entry.config.onSyncError?.(new Error("The saved values changed before they could be reloaded."));
      notifyStatus(entry, "Save failed");
      return false;
    }
    acknowledge(entry, committed.value, committed.version, { ...committed.response, state: refreshed.state, refreshed: true });
    return true;
  }

  async function flushEntry(entry) {
    cancelTimer(entry);
    if (entry.inFlight) {
      const completed = await entry.inFlight;
      if (!completed) return false;
      return flushEntry(entry);
    }
    if (entry.committed && !(await resolveCommitted(entry))) return false;
    if (!hasPending(entry)) {
      notifyStatus(entry, idleStatus(entry));
      return true;
    }
    if (entry.blockedStale || !validate(entry)) {
      notifyStatus(entry, entry.blockedStale ? "Save failed" : "Incomplete");
      return false;
    }

    const sentValue = clone(entry.value);
    const sentVersion = entry.version;
    cancelTimer(entry);
    notifyStatus(entry, "Saving…");
    let operation;
    operation = enqueueWrite(async () => entry.config.save(clone(sentValue)))
      .catch((error) => ({ ok: false, error }))
      .then(async (response) => {
        if (response?.ok) {
          if (response.refreshed === false && response.committed) {
            entry.committed = { value: sentValue, version: sentVersion, response };
            return resolveCommitted(entry);
          }
          if (entry.config.verifyCommitted && !entry.config.verifyCommitted(response.state, sentValue)) {
            entry.blockedStale = true;
            entry.config.onSyncError?.(new Error("The saved values changed before they could be reloaded."));
            notifyStatus(entry, "Save failed");
            return false;
          }
          acknowledge(entry, sentValue, sentVersion, response);
          return !entry.blockedStale;
        }

        if (response?.committed) {
          entry.committed = { value: sentValue, version: sentVersion, response };
          entry.failed = true;
          notifyStatus(entry, "Save failed");
          return false;
        }
        entry.failed = true;
        if (staleError(response?.error)) entry.blockedStale = true;
        entry.config.onSaveError?.(response?.error);
        notifyStatus(entry, "Save failed");
        return false;
      })
      .finally(() => {
        if (entry.inFlight !== operation) return;
        entry.inFlight = null;
        if (entry.failed || entry.blockedStale) notifyStatus(entry, "Save failed");
        else if (entry.committed) notifyStatus(entry, "Save failed");
        else if (hasPending(entry)) notifyStatus(entry, validate(entry) ? "Saving…" : "Incomplete");
        else notifyStatus(entry, idleStatus(entry));
      });
    entry.inFlight = operation;
    return operation;
  }

  function register(key, config) {
    if (disposed) throw new Error("This autosave controller has been disposed.");
    const normalizedKey = String(key);
    const existing = entries.get(normalizedKey);
    if (existing) throw new Error(`Autosave key is already registered: ${normalizedKey}`);
    if (typeof config?.save !== "function" || typeof config?.isValid !== "function" || typeof config?.isComplete !== "function") {
      throw new TypeError("Autosave entries require save, isValid, and isComplete functions.");
    }
    const initial = clone(config.initial);
    const entry = {
      key: normalizedKey,
      config,
      value: initial,
      acceptedInput: clone(initial),
      version: 0,
      lastAckVersion: -1,
      timer: null,
      inFlight: null,
      committed: null,
      acknowledged: false,
      failed: false,
      blockedStale: false,
      status: config.initiallySaved ? "Saved" : "Incomplete",
    };
    entries.set(normalizedKey, entry);

    return {
      update(value, { immediate = false } = {}) {
        entry.value = clone(value);
        entry.version += 1;
        entry.failed = false;
        if (!hasPending(entry) && !entry.inFlight && !entry.committed) {
          cancelTimer(entry);
          notifyStatus(entry, idleStatus(entry));
          return;
        }
        if (!validate(entry)) {
          cancelTimer(entry);
          notifyStatus(entry, "Incomplete");
          return;
        }
        if (entry.blockedStale) {
          notifyStatus(entry, "Save failed");
          return;
        }
        schedule(entry, immediate);
      },
      flush: () => flushEntry(entry),
      getValue: () => clone(entry.value),
      getStatus: () => entry.status,
    };
  }

  async function flushAll() {
    if (disposed) return true;
    const results = await Promise.all([...entries.values()].map((entry) => flushEntry(entry)));
    return results.every(Boolean);
  }

  function hasPendingWork() {
    return [...entries.values()].some((entry) => entry.timer !== null || entry.inFlight !== null || entry.committed !== null || hasPending(entry));
  }

  function dispose() {
    disposed = true;
    for (const entry of entries.values()) cancelTimer(entry);
    entries.clear();
  }

  return { register, flushAll, hasPending: hasPendingWork, dispose };
}
