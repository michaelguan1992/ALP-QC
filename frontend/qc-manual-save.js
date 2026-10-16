function clone(value) {
  return structuredClone(value);
}

/** Shown when the page that owns a save is replaced before its outcome can be applied to it. */
export const REPLACED_PAGE_MESSAGE = "This page was refreshed before your changes were confirmed. Reopen it to review your changes.";

function replacedPageError() {
  return new Error(REPLACED_PAGE_MESSAGE);
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
  saveOnExit = false,
} = {}) {
  if (typeof hasChanges !== "function" || typeof readSnapshot !== "function" || typeof save !== "function") {
    throw new TypeError("Manual save controllers require hasChanges, readSnapshot, and save functions.");
  }

  let disposed = false;
  let inFlight = null;
  let exitFlush = null;
  let lastError = null;
  let status = hasChanges() ? "Unsaved changes" : "Saved";

  function publish(nextStatus) {
    status = nextStatus;
    // A disposed controller belongs to a page that is gone, so it must not touch the display.
    if (disposed) return;
    try {
      onStatus(status, { dirty: hasChanges(), saving: inFlight !== null });
    } catch {
      // Status display must not change persistence behavior.
    }
  }

  function noteChanges() {
    if (disposed) return;
    lastError = null;
    if (inFlight) {
      publish("Saving…");
      return;
    }
    publish(hasChanges() ? "Unsaved changes" : "Saved");
  }

  async function saveAll() {
    if (disposed) {
      lastError = replacedPageError();
      return false;
    }
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
      lastError = error;
      try { onError(error, { validation: true, snapshot }); } catch {}
      publish("Save failed");
      return false;
    }

    let failed = false;
    const pending = Promise.resolve()
      .then(() => save(clone(snapshot)))
      .then((response) => {
        if (!response?.ok) throw response?.error || new Error("The changes could not be saved.");
        // The server accepted the change, but the page that owns these drafts was replaced meanwhile.
        if (disposed) throw replacedPageError();
        try {
          onSaved(clone(snapshot), response);
        } catch (error) {
          failed = true;
          lastError = error;
          try { onError(error, { acknowledged: true, snapshot, response }); } catch {}
          publish("Save failed");
          return false;
        }
        publish(hasChanges() ? "Unsaved changes" : "Saved");
        return true;
      })
      .catch((error) => {
        failed = true;
        lastError = error;
        if (!disposed) {
          try { onError(error, { snapshot }); } catch {}
        }
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

  function saveBeforeExit() {
    if (!saveOnExit) return Promise.resolve(false);
    if (disposed) {
      lastError = replacedPageError();
      return Promise.resolve(false);
    }
    if (exitFlush) return exitFlush;

    // Keep saving until nothing is pending. A page may only be left once every change is acknowledged.
    const flush = async () => {
      for (;;) {
        if (disposed) {
          lastError = replacedPageError();
          return false;
        }
        if (inFlight) {
          if (!await inFlight) return false;
          continue;
        }
        if (!hasChanges()) {
          publish("Saved");
          return true;
        }
        if (!await saveAll()) return false;
      }
    };

    exitFlush = flush().finally(() => {
      exitFlush = null;
    });
    return exitFlush;
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
    saveOnExit: Boolean(saveOnExit),
    ...(saveOnExit ? { saveBeforeExit } : {}),
    noteChanges,
    hasPending: () => !disposed && (inFlight !== null || hasChanges()),
    isSaving: () => inFlight !== null,
    getStatus: () => status,
    getLastError: () => lastError,
    discardAll,
    dispose() { disposed = true; },
    isDisposed: () => disposed,
  };
}
