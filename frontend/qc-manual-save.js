function clone(value) {
  return structuredClone(value);
}

export function createManualSaveController({
  hasChanges,
  readSnapshot,
  validate = () => true,
  save,
  onStatus = () => {},
  onSaved = () => {},
  onError = () => {},
  onDiscard = () => {},
} = {}) {
  if (typeof hasChanges !== "function" || typeof readSnapshot !== "function" || typeof save !== "function") {
    throw new TypeError("Manual save controllers require hasChanges, readSnapshot, and save functions.");
  }

  let disposed = false;
  let inFlight = null;
  let status = hasChanges() ? "Unsaved changes" : "Saved";

  function publish(nextStatus) {
    status = nextStatus;
    try {
      onStatus(status, { dirty: hasChanges(), saving: inFlight !== null });
    } catch {
      // Status display must not change persistence behavior.
    }
  }

  function noteChanges() {
    if (disposed) return;
    if (inFlight) {
      publish("Saving…");
      return;
    }
    publish(hasChanges() ? "Unsaved changes" : "Saved");
  }

  async function saveAll() {
    if (disposed) return true;
    if (inFlight) return inFlight;
    if (!hasChanges()) {
      publish("Saved");
      return true;
    }

    const snapshot = clone(readSnapshot());
    let validation;
    try {
      validation = validate(snapshot);
    } catch (error) {
      validation = error instanceof Error ? error.message : "The changes are invalid.";
    }
    if (validation !== true) {
      const error = new Error(typeof validation === "string" ? validation : "Correct the highlighted changes before saving.");
      try { onError(error, { validation: true, snapshot }); } catch {}
      publish("Save failed");
      return false;
    }

    let failed = false;
    const pending = Promise.resolve()
      .then(() => save(clone(snapshot)))
      .then((response) => {
        if (!response?.ok) throw response?.error || new Error("The changes could not be saved.");
        try {
          onSaved(clone(snapshot), response);
        } catch (error) {
          failed = true;
          try { onError(error, { acknowledged: true, snapshot, response }); } catch {}
          publish("Save failed");
          return false;
        }
        publish(hasChanges() ? "Unsaved changes" : "Saved");
        return true;
      })
      .catch((error) => {
        failed = true;
        try { onError(error, { snapshot }); } catch {}
        publish("Save failed");
        return false;
      })
      .finally(() => {
        inFlight = null;
        publish(failed ? "Save failed" : hasChanges() ? "Unsaved changes" : "Saved");
      });
    inFlight = pending;
    publish("Saving…");
    return inFlight;
  }

  function discardAll() {
    if (disposed || inFlight) return false;
    try { onDiscard(); } catch {}
    publish(hasChanges() ? "Unsaved changes" : "Saved");
    return !hasChanges();
  }

  publish(status);
  return {
    saveAll,
    noteChanges,
    hasPending: () => !disposed && (inFlight !== null || hasChanges()),
    isSaving: () => inFlight !== null,
    getStatus: () => status,
    discardAll,
    dispose() { disposed = true; },
  };
}
