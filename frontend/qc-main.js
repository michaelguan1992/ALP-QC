import { qcService, createDemoQCService } from "../core/qc-app.js";
import { renderAdminPage } from "./qc-admin.js";
import { renderOperationsPage } from "./qc-operations.js";
import { button, el, notify, showDialog, closeDialog } from "./qc-ui.js";

const app = document.querySelector("#app");
const routes = new Set(["batches", "batch-report", "issues", "catalog", "standards", "orders", "library", "settings", "backup"]);
const operationRoutes = new Set(["batches", "batch-report", "issues"]);
const demoMode = new URLSearchParams(location.search).get("workspace") === "demo";
const service = demoMode ? await createDemoQCService() : qcService;
let state = null;
let currentRoute = "batches";
let selectedId = null;
let staleMessage = "";
let renderNumber = 0;
let channel = null;
let activeManualSaveController = null;
const manualSaveControllers = [];
let automaticExitActionVersion = 0;
let commandQueue = Promise.resolve();
let needsAuthoritativeRefresh = false;
let commandInFlight = 0;

function readRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const legacyHistory = parts[0] === "history";
  const legacyReports = parts[0] === "reports";
  const batchReport = parts[0] === "batches" && parts.length >= 3 && parts.at(-1) === "report";
  let route = "batches";
  let id = null;
  try {
    if (!legacyHistory && legacyReports) {
      if (parts.length > 1) {
        route = "batch-report";
        id = decodeURIComponent(parts.slice(1).join("/"));
      }
    } else if (batchReport) {
      route = "batch-report";
      id = decodeURIComponent(parts.slice(1, -1).join("/"));
    } else if (!legacyHistory) {
      route = routes.has(parts[0]) ? parts[0] : "batches";
      id = parts[1] ? decodeURIComponent(parts.slice(1).join("/")) : null;
    }
  } catch {
    route = "batches";
    id = null;
  }
  return { route, id, legacyHistory, legacyReports };
}

function hasUnsavedForm() {
  return dirtyForms().length > 0;
}

function dirtyForms() {
  return [...app.querySelectorAll('.app-main form[data-dirty="true"]:not([data-autosave-form="true"]):not([data-issue-id])')];
}

function disposeManualSaveController() {
  for (const entry of manualSaveControllers) entry.controller.dispose?.();
  manualSaveControllers.length = 0;
  activeManualSaveController = null;
}

function saveDialogSnapshot() {
  const dialog = document.querySelector("#qc-dialog");
  if (!dialog?.open) return null;
  return {
    dialog,
    title: dialog.querySelector(".dialog-header h2")?.textContent || "",
    nodes: [...(dialog.querySelector(".dialog-content")?.childNodes || [])],
  };
}

function restoreDialogSnapshot(snapshot) {
  if (snapshot?.dialog?.open) showDialog(snapshot.title, snapshot.nodes);
}

async function resolveManualChanges(actionLabel, action) {
  const controller = activeManualSaveController;
  if (!controller?.hasPending?.()) return action();

  if (controller.saveOnExit && typeof controller.saveBeforeExit === "function") {
    const actionVersion = ++automaticExitActionVersion;
    const saved = await controller.saveBeforeExit();
    if (actionVersion !== automaticExitActionVersion || activeManualSaveController !== controller) return false;
    if (!saved) {
      const reason = controller.getLastError?.()?.message || "Check the highlighted changes and try again.";
      notify(`This page remains open because the changes could not be saved: ${reason}`, true);
      return false;
    }
    return action();
  }

  const snapshot = saveDialogSnapshot();
  const message = el("p", { className: "qc-ops-manual-exit-message", role: "status" },
    `Save your changes before you ${actionLabel}, discard them, or cancel.`);
  const save = button("Save changes", async () => {
    if (controller.isSaving?.()) return;
    save.disabled = true;
    discard.disabled = true;
    message.textContent = "Saving changes…";
    const saved = await controller.saveAll();
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
    resolved = true;
    closeDialog(true);
    await action();
  }, "button-primary qc-ops-unsaved-save");
  const discard = button("Discard changes", async () => {
    if (!controller.discardAll?.() || controller.hasPending?.()) {
      message.textContent = "Wait for the current save to finish before discarding changes.";
      return;
    }
    resolved = true;
    closeDialog(true);
    await action();
  }, "button-danger qc-ops-unsaved-discard");
  const cancel = button("Cancel", () => {
    resolved = true;
    if (snapshot) restoreDialogSnapshot(snapshot);
    else closeDialog(true);
  }, "button-secondary qc-ops-unsaved-cancel");
  let resolved = false;
  const dialog = showDialog("Unsaved changes", el("div", { className: "discard-prompt qc-ops-manual-exit" },
    message,
    el("div", { className: "button-row" }, save, discard, cancel),
  ));
  const restoreIfDismissed = () => {
    if (!resolved && snapshot) restoreDialogSnapshot(snapshot);
  };
  dialog.addEventListener("close", restoreIfDismissed, { once: true });
}

function enqueueCommand(work) {
  const pending = commandQueue.then(work, work);
  commandQueue = pending.then(() => undefined, () => undefined);
  return pending;
}

function routeHash(route, id) {
  if (route === "batch-report" && id) return `#/batches/${encodeURIComponent(id)}/report`;
  return `#/${route}${id ? `/${encodeURIComponent(id)}` : ""}`;
}

function promptToDiscard(actionLabel, action) {
  showDialog("Unsaved changes", el("div", { className: "discard-prompt" },
    el("p", {}, "This page has unsaved changes. Save them before leaving, or discard them and continue."),
    el("div", { className: "button-row" },
      button("Stay on this page", () => closeDialog(true), "button-secondary"),
      button(`Discard and ${actionLabel}`, () => {
        closeDialog(true);
        action();
      }, "button-danger"),
    ),
  ));
}

function updateStaleWarning() {
  const warning = document.querySelector("#stale-warning");
  if (!warning) return;
  warning.hidden = !staleMessage;
  const message = warning.querySelector(".stale-message");
  if (message) message.textContent = staleMessage;
}

function setStale(message) {
  staleMessage = message;
  updateStaleWarning();
}

async function readLatestState() {
  const next = await service.getState({ mode: "lightweight" });
  state = next;
  needsAuthoritativeRefresh = false;
  staleMessage = "";
  renderApp();
}

async function requestRefresh() {
  if (activeManualSaveController?.hasPending?.()) {
    if (activeManualSaveController.saveOnExit) {
      await refreshLatest();
      return;
    }
    await resolveManualChanges("reload the latest data", () => refreshLatest());
    return;
  }
  if (hasUnsavedForm()) {
    promptToDiscard("reload latest data", () => { void refreshLatest(); });
    return;
  }
  void refreshLatest();
}

async function refreshLatest() {
  try {
    await readLatestState();
    notify("Latest local data loaded.");
  } catch (error) {
    setStale("The latest data could not be loaded. Your current page is still open; try again.");
    notify(error instanceof Error ? error.message : "The latest data could not be loaded.", true);
  }
}

async function navigate(route, id = null, force = false) {
  if (!routes.has(route)) return false;
  const targetId = id ?? null;
  if (route === currentRoute && targetId === selectedId) return false;
  if (!force && activeManualSaveController?.hasPending?.()) {
    await resolveManualChanges(`leave for ${route === "batch-report" ? "the report" : route}`, () => navigate(route, targetId, true));
    return false;
  }
  if (!closeDialog()) return false;
  if (!force && hasUnsavedForm()) {
    promptToDiscard("continue", () => navigate(route, id, true));
    return false;
  }
  currentRoute = route;
  selectedId = targetId;
  history.pushState({ route, id: targetId }, "", routeHash(route, targetId));
  renderApp();
  return true;
}

function navItem(route, label, group) {
  const isActive = currentRoute === route || (route === "batches" && currentRoute === "batch-report");
  const item = button(label, () => navigate(route), `nav-item${isActive ? " is-active" : ""}`);
  item.classList.remove("button");
  item.setAttribute("aria-current", isActive ? "page" : "false");
  item.dataset.route = route;
  group.append(item);
  return item;
}

function settingsNavItem() {
  const isActive = currentRoute === "settings" || currentRoute === "backup";
  const item = button("Backup and restore", () => navigate("settings"), `sidebar-settings-button${isActive ? " is-active" : ""}`);
  item.classList.remove("button");
  item.setAttribute("aria-current", isActive ? "page" : "false");
  item.dataset.route = "settings";
  return item;
}

function applyCommandProjection(commandResult) {
  const changes = commandResult?.changes;
  if (!changes || !state) return false;
  const next = { ...state };
  for (const collection of ["batches", "issues", "audit", "orders"]) {
    const updates = changes[collection];
    if (!Array.isArray(updates) || !updates.length) continue;
    const values = [...(Array.isArray(next[collection]) ? next[collection] : [])];
    for (const update of updates) {
      if (!update?.id) continue;
      const index = values.findIndex((value) => value?.id === update.id);
      if (index < 0) values.push(update);
      else values[index] = { ...values[index], ...update };
    }
    next[collection] = values;
  }
  const revision = Number(commandResult.revision ?? commandResult.result?.revision);
  if (Number.isSafeInteger(revision) && revision >= Number(next.revision || 0)) next.revision = revision;
  state = next;
  return true;
}

function getContext() {
  return {
    service,
    isDemo: demoMode,
    state,
    navigate,
    refresh: requestRefresh,
    announceChange: (revision) => channel?.postMessage({ revision }),
    selectedId,
    registerManualSaveController: (controller) => {
      const registration = { controller };
      manualSaveControllers.push(registration);
      activeManualSaveController = controller;
      return () => {
        const index = manualSaveControllers.indexOf(registration);
        if (index >= 0) manualSaveControllers.splice(index, 1);
        controller.dispose?.();
        if (activeManualSaveController === controller) {
          activeManualSaveController = manualSaveControllers.at(-1)?.controller || null;
        }
      };
    },
    resolveManualChanges,
    refreshState: async ({ render = false } = {}) => enqueueCommand(async () => {
      commandInFlight += 1;
      try {
        const latest = await service.getState({ mode: "lightweight" });
        commandInFlight -= 1;
        state = latest;
        needsAuthoritativeRefresh = false;
        staleMessage = "";
        channel?.postMessage({ revision: latest.revision });
        if (render) renderApp();
        else updateStaleWarning();
        return { ok: true, state: latest };
      } catch (error) {
        commandInFlight -= 1;
        setStale("The latest data could not be loaded. Reload before making another change.");
        return { ok: false, error };
      }
    }),
    run: async (type, data, options = {}) => {
      return enqueueCommand(async () => {
        if (!state) return { ok: false, error: new Error("The local workspace is not ready.") };
        if (needsAuthoritativeRefresh) {
          try {
            state = await service.getState({ mode: "lightweight" });
            needsAuthoritativeRefresh = false;
          } catch (error) {
            setStale("The saved change is awaiting a fresh read. Reload before making another change.");
            if (!options.silent) notify(error instanceof Error ? error.message : "The latest data could not be loaded.", true);
            return { ok: false, error };
          }
        }
        const baseRevision = state.revision;
        let result;
        commandInFlight += 1;
        try {
          result = await service.command(type, data, baseRevision);
        } catch (error) {
          commandInFlight -= 1;
          const message = error instanceof Error ? error.message : "The change could not be saved.";
          if (/revision|stale|reload|changed in another/i.test(message)) {
            setStale("Another tab changed this workspace. Reload the latest data before saving again.");
          }
          if (!options.silent) notify(message, true);
          return { ok: false, error, stale: /revision|stale|reload|changed in another/i.test(message) };
        }
        const commandRevision = Number(result?.revision ?? result?.result?.revision);
        if (applyCommandProjection(result)) {
          commandInFlight -= 1;
          needsAuthoritativeRefresh = false;
          staleMessage = "";
          channel?.postMessage({ revision: state.revision });
          if (options.render !== false) renderApp();
          else updateStaleWarning();
          return { ok: true, result, state, revision: state.revision, refreshed: true, projected: true };
        }
        try {
          const latest = await service.getState({ mode: "lightweight" });
          commandInFlight -= 1;
          state = latest;
          needsAuthoritativeRefresh = false;
          staleMessage = "";
          channel?.postMessage({ revision: latest.revision });
          if (options.render !== false) renderApp();
          else updateStaleWarning();
          return { ok: true, result, state: latest, revision: latest.revision, refreshed: true };
        } catch (readError) {
          commandInFlight -= 1;
          if (Number.isSafeInteger(commandRevision) && commandRevision >= baseRevision) {
            state = { ...state, revision: commandRevision };
          }
          needsAuthoritativeRefresh = true;
          setStale("The change was saved, but the updated data could not be reloaded. Reload before making another change.");
          if (!options.silent) notify(readError instanceof Error ? readError.message : "The change was saved, but the page could not reload.", true);
          return { ok: false, committed: true, refreshed: false, result, revision: commandRevision, error: readError };
        }
      });
    },
  };
}

function renderApp() {
  if (!state) return;
  disposeManualSaveController();
  const thisRender = ++renderNumber;
  const shell = el("div", { className: "app-frame" });
  const homeUrl = demoMode ? "/?workspace=demo" : "/";
  const sidebar = el("aside", { className: "app-sidebar", "aria-label": "Main navigation" },
    el("a", { className: "brand-lockup", href: homeUrl, "aria-label": "MasterQC home" },
      el("span", { className: "brand-mark", "aria-hidden": "true" }, "QC"),
      el("strong", {}, "MasterQC"),
    ),
    el("nav", { className: "primary-nav" },
      (() => {
        const group = el("div", { className: "nav-group" });
        navItem("batches", "Batches", group);
        navItem("issues", "Issues", group);
        navItem("standards", "Standards", group);
        navItem("orders", "Purchase orders", group);
        return group;
      })(),
    ),
    el("div", { className: "sidebar-footer", role: "status", "aria-label": "Storage location" },
      el("span", { className: "local-dot" }),
      el("span", {}, "On this computer"),
    ),
    el("div", { className: "sidebar-settings" }, settingsNavItem()),
  );
  const workspace = el("div", { className: "app-workspace" });
  if (demoMode) {
    const realUrl = new URL(location.href);
    realUrl.searchParams.delete("workspace");
    realUrl.hash = "#/batches";
    workspace.append(el("aside", { className: "demo-banner", role: "status" },
      el("strong", {}, "Demo workspace · Stored separately"),
      el("a", { href: `${realUrl.pathname}${realUrl.search}${realUrl.hash}` }, "Open your real workspace"),
    ));
  }
  workspace.append(el("div", { id: "stale-warning", className: "stale-warning", hidden: true, role: "alert" },
    el("span", { className: "stale-message" }, staleMessage),
    button("Reload latest data", requestRefresh, "button-secondary"),
  ));
  const main = el("main", { className: "app-main", id: "main-content" });
  const slot = el("div", { className: "page-render-slot" });
  main.append(slot);
  workspace.append(main);
  shell.append(sidebar, workspace);
  app.replaceChildren(shell);
  app.classList.remove("app-loading");
  updateStaleWarning();

  const context = getContext();
  if (operationRoutes.has(currentRoute)) {
    void Promise.resolve(renderOperationsPage(slot, currentRoute, context)).catch((error) => {
      if (thisRender !== renderNumber) return;
      slot.replaceChildren(el("section", { className: "error-card card", role: "alert" },
        el("h2", {}, "This page could not load"), el("p", {}, error instanceof Error ? error.message : "An unexpected error occurred."),
        button("Retry page", () => renderApp(), "button-secondary"),
      ));
    });
  } else {
    void Promise.resolve(renderAdminPage(slot, currentRoute, context)).catch((error) => {
      if (thisRender !== renderNumber) return;
      slot.replaceChildren(el("section", { className: "error-card card", role: "alert" },
        el("h2", {}, "This page could not load"), el("p", {}, error instanceof Error ? error.message : "An unexpected error occurred."),
        button("Retry page", () => renderApp(), "button-secondary"),
      ));
    });
  }
}

document.addEventListener("click", (event) => {
  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!anchor || !app.contains(anchor) || anchor.target === "_blank" ||
      (!activeManualSaveController?.hasPending?.() && !hasUnsavedForm())) return;
  const target = new URL(anchor.href, location.href);
  event.preventDefault();
  const openTarget = () => { location.href = target.href; };
  if (activeManualSaveController?.hasPending?.()) void resolveManualChanges("open this link", openTarget);
  else promptToDiscard("open link", openTarget);
});

window.addEventListener("popstate", () => {
  const next = readRoute();
  void (async () => {
    const restoreCurrentUrl = () => history.replaceState({ route: currentRoute, id: selectedId }, "", routeHash(currentRoute, selectedId));
    const openNextRoute = () => {
      if (!closeDialog()) {
        restoreCurrentUrl();
        return false;
      }
      currentRoute = next.route;
      selectedId = next.id;
      history.replaceState({ route: currentRoute, id: selectedId }, "", routeHash(currentRoute, selectedId));
      renderApp();
    };
    if (activeManualSaveController?.hasPending?.()) {
      restoreCurrentUrl();
      await resolveManualChanges("leave this page", openNextRoute);
      return;
    }
    if (!closeDialog()) {
      history.replaceState({ route: currentRoute, id: selectedId }, "", routeHash(currentRoute, selectedId));
      return;
    }
    if (hasUnsavedForm()) {
      restoreCurrentUrl();
      promptToDiscard("continue", openNextRoute);
      return;
    }
    if (next.legacyHistory || next.legacyReports) {
      restoreCurrentUrl();
      openNextRoute();
      return;
    }
    currentRoute = next.route;
    selectedId = next.id;
    renderApp();
  })();
});

window.addEventListener("beforeunload", (event) => {
  if (activeManualSaveController?.hasPending?.() || activeManualSaveController?.isSaving?.()) {
    event.preventDefault();
    event.returnValue = "";
  }
});

async function start() {
  try {
    state = await service.initialize({ mode: "lightweight" });
    const initial = readRoute();
    currentRoute = initial.route;
    selectedId = initial.id;
    if (!location.hash || initial.legacyHistory || initial.legacyReports) history.replaceState({ route: currentRoute, id: selectedId }, "", routeHash(currentRoute, selectedId));
    channel = new BroadcastChannel(`masterqc-web-qc:${service.workspace}`);
    channel.addEventListener("message", (event) => {
      const remoteRevision = Number(event.data?.revision);
      if (Number.isFinite(remoteRevision) && remoteRevision > state.revision) {
        setStale("Another tab changed this workspace. Reload the latest data before saving again.");
      }
    });
    const checkForSharedChanges = async () => {
      if (!state || commandInFlight > 0) return;
      try {
        const latestRevision = await service.getRevision();
        if (latestRevision > state.revision) {
          setStale("Another browser or window changed this workspace. Reload the latest data before saving again.");
        }
      } catch {
        // Preserve the current page and any unsaved edits if the local server is briefly unavailable.
      }
    };
    window.setInterval(() => { void checkForSharedChanges(); }, 5000);
    window.addEventListener("focus", () => { void checkForSharedChanges(); });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void checkForSharedChanges();
    });
    renderApp();
  } catch (error) {
    const message = error instanceof Error ? error.message : "The local workspace could not be opened.";
    app.replaceChildren(el("main", { className: "startup-error" },
      el("p", { className: "eyebrow" }, "MasterQC Web"),
      el("h1", {}, "The local QC service is unavailable"),
      el("p", {}, message),
      el("p", {}, "Start the local server and open http://127.0.0.1:4173 in a regular browser window, then retry."),
      button("Retry", () => { app.replaceChildren(el("p", {}, "Connecting to the local QC service…")); void start(); }, "button-primary"),
    ));
  }
}

void start();
