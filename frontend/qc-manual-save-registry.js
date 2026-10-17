import { REPLACED_PAGE_MESSAGE } from "./qc-manual-save.js";
import { isStaleRevisionError } from "./qc-command-rules.js";
import { button, captureDialogState, closeDialog, el, notify, restoreDialogState, showDialog } from "./qc-ui.js";

/**
 * Tracks the manual-save controllers of the rendered page and guards in-app departure.
 *
 * When a page render starts, the controllers it replaces are retired rather than disposed.
 * A retired controller keeps guarding departure until its replacement registers, or until the
 * replacing render finishes without registering one. Stale renders never register or release
 * anything (the caller checks that before calling in), so departure during a re-render still
 * saves pending edits or explains why it cannot.
 */
export function createManualSaveRegistry() {
  let rendered = [];
  let retired = [];
  let exitVersion = 0;
  let promptOpen = false;

  function active() {
    return rendered.at(-1)?.controller ?? retired.at(-1)?.controller ?? null;
  }

  function hasPending() {
    return Boolean(active()?.hasPending?.());
  }

  function disposeRetired() {
    for (const registration of retired.splice(0)) registration.controller.dispose?.();
  }

  function register(controller) {
    const registration = { controller };
    disposeRetired();
    rendered.push(registration);
    return () => unregister(registration);
  }

  function unregister(registration) {
    rendered = rendered.filter((entry) => entry !== registration);
    retired = retired.filter((entry) => entry !== registration);
    registration.controller.dispose?.();
  }

  function retireRendered() {
    retired.push(...rendered.splice(0));
  }

  function releaseRetired() {
    disposeRetired();
  }

  /**
   * Runs `action` once the active controller (or `controller`) has no pending changes.
   * Navigation-style actions close the Issue dialog first; `keepDialog` keeps it on screen
   * so that a non-navigation action (closing or deleting an Issue) can report errors in it.
   */
  async function resolve(actionLabel, action, { keepDialog = false, controller = active() } = {}) {
    if (!controller?.hasPending?.()) return action();
    if (controller.saveOnExit && typeof controller.saveBeforeExit === "function") {
      const version = ++exitVersion;
      const saved = await controller.saveBeforeExit();
      if (version !== exitVersion) return false;
      if (!saved) {
        // A stale save is explained by the banner and the page header, so it raises no toast.
        const lastError = controller.getLastError?.();
        if (!isStaleRevisionError(lastError)) {
          const reason = lastError?.message || "Check the highlighted changes and try again.";
          notify(`This page remains open because the changes could not be saved: ${reason}`, true);
        }
        return false;
      }
      if (active() !== controller) {
        notify("Your changes were saved, but this page was refreshed before you could leave. Review the batch before leaving.", true);
        return false;
      }
      return action();
    }
    return promptForUnsavedChanges(actionLabel, action, { keepDialog, controller });
  }

  function promptForUnsavedChanges(actionLabel, action, { keepDialog, controller }) {
    if (promptOpen) return false;
    const previous = captureDialogState();
    let settled = false;
    const settle = () => {
      settled = true;
      promptOpen = false;
    };
    const restore = () => {
      if (!restoreDialogState(previous)) closeDialog(true);
    };
    // Escape and the Close button cancel the prompt, which returns to the content the user was editing.
    const dismiss = () => {
      if (settled) return;
      settle();
      restore();
    };
    const finish = () => {
      settle();
      if (keepDialog) restore();
      else closeDialog(true);
    };

    const message = el("p", { className: "qc-ops-manual-exit-message", role: "status" },
      `Save your changes before you ${actionLabel}, discard them, or cancel.`);
    const save = button("Save changes", async () => {
      if (settled || controller.isSaving?.()) return;
      save.disabled = true;
      discard.disabled = true;
      message.textContent = "Saving changes…";
      const saved = await controller.saveAll();
      // Cancelled while saving: keep the form exactly as the user left it.
      if (settled) return;
      if (!saved) {
        message.textContent = "The changes could not be saved. Your edits are still here.";
        save.disabled = false;
        discard.disabled = false;
        return;
      }
      if (controller.hasPending?.()) {
        message.textContent = "New changes were made while saving. Save or discard them before continuing.";
        save.disabled = false;
        discard.disabled = false;
        return;
      }
      finish();
      await action();
    }, "button-primary qc-ops-unsaved-save");
    const discard = button("Discard changes", async () => {
      if (settled) return;
      if (!controller.discardAll?.() || controller.hasPending?.()) {
        message.textContent = "Wait for the current save to finish before discarding changes.";
        return;
      }
      finish();
      await action();
    }, "button-danger qc-ops-unsaved-discard");
    const cancel = button("Cancel", dismiss, "button-secondary qc-ops-unsaved-cancel");

    promptOpen = true;
    const dialog = showDialog("Unsaved changes", el("div", { className: "discard-prompt qc-ops-manual-exit" },
      message,
      el("div", { className: "button-row" }, save, discard, cancel),
    ), { onCloseRequest: dismiss });
    dialog.addEventListener("close", settle, { once: true });
    return true;
  }

  return {
    register,
    retireRendered,
    releaseRetired,
    active,
    hasPending,
    resolve,
  };
}
