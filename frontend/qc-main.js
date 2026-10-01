import { qcService, createDemoQCService, exportLegacyBrowserBackup } from "../core/qc-app.js";
import { renderAdminPage } from "./qc-admin.js";
import { renderOperationsPage } from "./qc-operations.js";
import { button, el, notify, showDialog, closeDialog } from "./qc-ui.js";

const app = document.querySelector("#app");
const routes = new Set(["batches", "batch-report", "issues", "catalog", "standards", "orders", "library", "settings", "backup"]);
const operationRoutes = new Set(["batches", "batch-report", "issues"]);
const routeNames = {
  batches: "Batch inspection",
  "batch-report": "Batch inspection",
  issues: "Issues",
  catalog: "Product catalog",
  standards: "Standards",
  orders: "Purchase orders",
  library: "File library",
  settings: "Backup and restore",
  backup: "Backup and restore",
};
const demoMode = new URLSearchParams(location.search).get("workspace") === "demo";
const service = demoMode ? await createDemoQCService() : qcService;
let state = null;
let currentRoute = "batches";
let selectedId = null;
let staleMessage = "";
let renderNumber = 0;
let channel = null;
let activeAutosaveController = null;
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
  return [...app.querySelectorAll('.app-main form[data-dirty="true"]:not([data-autosave-form="true"])')];
}

function disposeAutosaveController() {
  activeAutosaveController?.dispose?.();
  activeAutosaveController = null;
}

async function flushAutosaves() {
  if (!activeAutosaveController) return true;
  const saved = await activeAutosaveController.flushAll();
  if (!saved) notify("Resolve pending inspection edits before continuing.", true);
  return saved;
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
  const forms = dirtyForms();
  const preserved = forms.length > 0 && forms.every((form) => form.dataset.preserveDrafts === "true");
  const hasPreservedDrafts = forms.some((form) => form.dataset.preserveDrafts === "true");
  const reloadsLatest = actionLabel === "reload latest data";
  const continueLabel = preserved
    ? reloadsLatest ? "Clear drafts and reload latest data" : `Continue and ${actionLabel} with drafts`
    : `Discard and ${actionLabel}`;
  const message = preserved
    ? reloadsLatest
      ? "This page has unsaved inspection edits. Reloading replaces the visible records, so clear this tab’s drafts before loading the latest data."
      : "This page has unsaved inspection edits. They will remain in this tab and be available when you return."
    : "This page has unsaved changes. Save them before leaving, or discard them and continue.";
  showDialog(preserved ? "Unsaved inspection edits" : "Unsaved changes", el("div", { className: "discard-prompt" },
    el("p", {}, message),
    el("div", { className: "button-row" },
      button("Stay on this page", () => closeDialog(true), "button-secondary"),
      button(continueLabel, () => {
        closeDialog(true);
        if (hasPreservedDrafts && (!preserved || reloadsLatest)) {
          window.dispatchEvent(new CustomEvent("masterqc:discard-operation-drafts"));
        }
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

function updateRevisionLabel() {
  const label = document.querySelector(".revision-label");
  if (label && state) label.textContent = `Revision ${state.revision}`;
}

function setStale(message) {
  staleMessage = message;
  updateStaleWarning();
}

async function readLatestState() {
  const next = await service.getState();
  state = next;
  needsAuthoritativeRefresh = false;
  staleMessage = "";
  renderApp();
}

async function requestRefresh() {
  if (!(await flushAutosaves())) {
    showDialog("Unsaved inspection edits", el("div", { className: "discard-prompt" },
      el("p", {}, "Some inspection edits could not be confirmed. Reloading will discard this tab’s drafts."),
      el("div", { className: "button-row" },
        button("Stay on this page", () => closeDialog(true), "button-secondary"),
        button("Discard edits and reload", () => {
          closeDialog(true);
          disposeAutosaveController();
          window.dispatchEvent(new CustomEvent("masterqc:discard-operation-drafts"));
          void refreshLatest();
        }, "button-danger"),
      ),
    ));
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
  if (!(await flushAutosaves())) return false;
  if (!force && hasUnsavedForm()) {
    promptToDiscard("continue", () => navigate(route, id, true));
    return false;
  }
  currentRoute = route;
  selectedId = id;
  history.pushState({ route, id }, "", routeHash(route, id));
  renderApp();
  return true;
}

function navItem(route, label, group) {
  const isActive = currentRoute === route || (route === "batches" && currentRoute === "batch-report");
  const item = button(label, () => navigate(route), `nav-item${isActive ? " is-active" : ""}`);
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

function getContext() {
  return {
    service,
    isDemo: demoMode,
    exportLegacyBrowserBackup,
    state,
    navigate,
    refresh: requestRefresh,
    announceChange: (revision) => channel?.postMessage({ revision }),
    selectedId,
    registerAutosaveController: (controller) => {
      activeAutosaveController = controller;
      return () => {
        if (activeAutosaveController === controller) {
          controller.dispose?.();
          activeAutosaveController = null;
        }
      };
    },
    flushAutosaves,
    refreshState: async ({ render = false } = {}) => enqueueCommand(async () => {
      commandInFlight += 1;
      try {
        const latest = await service.getState();
        commandInFlight -= 1;
        state = latest;
        needsAuthoritativeRefresh = false;
        staleMessage = "";
        channel?.postMessage({ revision: latest.revision });
        if (render) renderApp();
        else {
          updateStaleWarning();
          updateRevisionLabel();
        }
        return { ok: true, state: latest };
      } catch (error) {
        commandInFlight -= 1;
        setStale("The latest data could not be loaded. Reload before making another change.");
        return { ok: false, error };
      }
    }),
    run: async (type, data, options = {}) => {
      if (options.autosave !== true && !(await flushAutosaves())) {
        return { ok: false, blocked: true, error: new Error("Inspection edits could not be saved.") };
      }
      return enqueueCommand(async () => {
        if (!state) return { ok: false, error: new Error("The local workspace is not ready.") };
        if (needsAuthoritativeRefresh) {
          try {
            state = await service.getState();
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
        try {
          const latest = await service.getState();
          commandInFlight -= 1;
          state = latest;
          needsAuthoritativeRefresh = false;
          staleMessage = "";
          channel?.postMessage({ revision: latest.revision });
          if (options.render !== false) renderApp();
          else {
            updateStaleWarning();
            updateRevisionLabel();
          }
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
    importHistory: async (historyPackage) => {
      if (!state) return { ok: false, error: new Error("The local workspace is not ready.") };
      try {
        const result = await service.importHistory(historyPackage, state.revision);
        state = await service.getState();
        staleMessage = "";
        channel?.postMessage({ revision: state.revision });
        renderApp();
        return { ok: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : "The history package could not be imported.";
        if (/revision|stale|reload|changed in another/i.test(message)) {
          setStale("Another tab changed this workspace. Reload the latest data before importing again.");
        }
        notify(message, true);
        return { ok: false, error };
      }
    },
  };
}

function renderApp() {
  if (!state) return;
  disposeAutosaveController();
  const thisRender = ++renderNumber;
  const shell = el("div", { className: "app-frame" });
  const homeUrl = demoMode ? "/?workspace=demo" : "/";
  const sidebar = el("aside", { className: "app-sidebar", "aria-label": "Main navigation" },
    el("a", { className: "brand-lockup", href: homeUrl, "aria-label": "MasterQC home" },
      el("span", { className: "brand-mark", "aria-hidden": "true" }, "QC"),
      el("span", {}, el("strong", {}, "MasterQC"), el("small", {}, "Local workspace")),
    ),
    el("nav", { className: "primary-nav" },
      el("p", { className: "nav-label" }, "Inspection"),
      (() => { const group = el("div", { className: "nav-group" }); navItem("batches", "Batches", group); navItem("issues", "Issues", group); return group; })(),
      el("p", { className: "nav-label nav-label-spaced" }, "Setup and records"),
      (() => { const group = el("div", { className: "nav-group" }); navItem("standards", "Standards", group); navItem("orders", "Purchase orders", group); return group; })(),
    ),
    el("div", { className: "sidebar-footer" },
      el("span", { className: "local-dot" }),
      el("span", {}, demoMode ? "Demo data on this computer" : "Shared on this computer"),
      el("a", { href: "/frontend/initialization.html" }, "Initialization draft"),
      el("a", { href: "/frontend/prototype.html" }, "AP table prototype"),
    ),
    el("div", { className: "sidebar-settings" }, settingsNavItem()),
  );
  const header = el("header", { className: "app-header" },
    el("div", {},
      el("p", { className: "eyebrow" }, "MasterQC Web"),
      el("h1", {}, routeNames[currentRoute] ?? "MasterQC Web"),
    ),
    el("div", { className: "header-status" },
      el("span", { className: "status-pill status-ready", role: "status" }, "Local server ready"),
      el("span", { className: "revision-label" }, `Revision ${state.revision}`),
    ),
  );
  const workspace = el("div", { className: "app-workspace" }, header);
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
      (!activeAutosaveController?.hasPending?.() && !hasUnsavedForm())) return;
  const target = new URL(anchor.href, location.href);
  event.preventDefault();
  void (async () => {
    if (!(await flushAutosaves())) return;
    const openTarget = () => {
      if (anchor.target === "_blank") window.open(target.href, "_blank", "noopener,noreferrer");
      else location.href = target.href;
    };
    if (hasUnsavedForm()) promptToDiscard("open link", openTarget);
    else openTarget();
  })();
});

window.addEventListener("popstate", () => {
  const next = readRoute();
  void (async () => {
    if (!(await flushAutosaves())) {
      history.replaceState({ route: currentRoute, id: selectedId }, "", routeHash(currentRoute, selectedId));
      return;
    }
    if (hasUnsavedForm()) {
      history.replaceState({ route: currentRoute, id: selectedId }, "", routeHash(currentRoute, selectedId));
      promptToDiscard("continue", () => { void navigate(next.route, next.id, true); });
      return;
    }
    currentRoute = next.route;
    selectedId = next.id;
    if (next.legacyHistory || next.legacyReports) {
      history.replaceState({ route: currentRoute, id: selectedId }, "", routeHash(currentRoute, selectedId));
    }
    renderApp();
  })();
});

async function start() {
  try {
    await service.initialize();
    state = await service.getState();
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
      el("p", {}, el("a", { href: "/frontend/initialization.html" }, "Open the preserved initialization draft")),
    ));
  }
}

void start();
