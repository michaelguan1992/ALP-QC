import { qcService, createDemoQCService } from "../core/qc-app.js";
import { renderAdminPage } from "./qc-admin.js";
import { renderOperationsPage } from "./qc-operations.js";
import { button, el, notify, showDialog, closeDialog, hasUnsavedDialogForm } from "./qc-ui.js";
import { createManualSaveRegistry } from "./qc-manual-save-registry.js";
import { createQCSession } from "./qc-session.js";
import { SHARED_CHANGE_MESSAGE, messageOf } from "./qc-command-rules.js";
import { configureDraftRecovery, purgeExpiredStoredDrafts } from "./qc-draft-recovery.js";
import { RELEASE_NOTICE_MESSAGE, createReleaseWatch, readServerSession } from "./qc-server-session.js";

const app = document.querySelector("#app");
const routes = new Set(["batches", "batch-report", "issues", "catalog", "standards", "orders", "library", "settings", "backup"]);
const operationRoutes = new Set(["batches", "batch-report", "issues"]);
const demoMode = new URLSearchParams(location.search).get("workspace") === "demo";
const service = demoMode ? await createDemoQCService() : qcService;
let currentRoute = "batches";
let selectedId = null;
let renderNumber = 0;
let channel = null;
let releaseWatch = null;
let releaseAvailable = false;
const saves = createManualSaveRegistry();

function updateNotices({ blocking, sharedChange }) {
  const warning = document.querySelector("#stale-warning");
  if (warning) {
    warning.hidden = !blocking;
    const message = warning.querySelector(".stale-message");
    if (message) message.textContent = blocking;
  }
  // While the blocking banner explains a rejected save, the informational notice stays out of the way.
  const notice = document.querySelector("#shared-change-notice");
  if (notice) notice.hidden = !sharedChange || Boolean(blocking);
}

function updateReleaseNotice() {
  const notice = document.querySelector("#release-notice");
  if (notice) notice.hidden = !releaseAvailable;
}

/** Reloads for a newer release. Pending edits are saved first, or the user decides; unsent edits survive a reload in this browser. */
async function reloadForNewRelease() {
  const reload = () => {
    location.reload();
  };
  if (saves.hasPending()) {
    await saves.resolve("reload this page", reload);
    return;
  }
  if (hasUnsavedForm()) {
    promptToDiscard("reload", reload);
    return;
  }
  reload();
}

const session = createQCSession({
  service,
  notify,
  render: () => renderApp(),
  announceRevision: (revision) => channel?.postMessage({ revision }),
  onNotices: updateNotices,
});

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

async function refreshLatest() {
  const result = await session.loadLatest();
  if (result.ok) notify("Latest data loaded.");
  else notify(messageOf(result.error, "The latest data could not be loaded."), true);
}

async function requestRefresh() {
  // Pending edits stay in their drafts; the refreshed page reopens them. Nothing is saved implicitly.
  if (saves.hasPending()) {
    await refreshLatest();
    return;
  }
  if (hasUnsavedForm()) {
    promptToDiscard("reload latest data", () => { void refreshLatest(); });
    return;
  }
  void refreshLatest();
}

async function navigate(route, id = null, force = false) {
  if (!routes.has(route)) return false;
  const targetId = id ?? null;
  if (route === currentRoute && targetId === selectedId) return false;
  if (!force && saves.hasPending()) {
    await saves.resolve(`leave for ${route === "batch-report" ? "the report" : route}`, () => navigate(route, targetId, true));
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

function renderApp() {
  const state = session.state;
  if (!state) return;
  // Controllers of the replaced page keep guarding departure until this render has registered its own.
  saves.retireRendered();
  const thisRender = ++renderNumber;
  const notices = session.notices;
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
      el("span", {}, "Shared workspace"),
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
  // The blocking warning is for a rejected save or a failed reload. The notice only reports newer changes.
  workspace.append(el("div", { id: "stale-warning", className: "stale-warning", hidden: !notices.blocking, role: "alert" },
    el("span", { className: "stale-message" }, notices.blocking),
    button("Reload latest data", requestRefresh, "button-secondary"),
  ));
  workspace.append(el("div", { id: "shared-change-notice", className: "shared-change-notice", hidden: !notices.sharedChange || Boolean(notices.blocking), role: "status" },
    el("span", {}, SHARED_CHANGE_MESSAGE),
    button("Reload", requestRefresh, "button-secondary"),
  ));
  workspace.append(el("div", { id: "release-notice", className: "release-notice", hidden: !releaseAvailable, role: "status" },
    el("span", {}, RELEASE_NOTICE_MESSAGE),
    button("Reload now", reloadForNewRelease, "button-secondary"),
  ));
  const main = el("main", { className: "app-main", id: "main-content" });
  const slot = el("div", { className: "page-render-slot" });
  main.append(slot);
  workspace.append(main);
  shell.append(sidebar, workspace);
  app.replaceChildren(shell);
  app.classList.remove("app-loading");

  const context = getContext(thisRender);
  if (operationRoutes.has(currentRoute)) {
    void Promise.resolve(renderOperationsPage(slot, currentRoute, context)).then(releaseRetiredWhenCurrent(thisRender), (error) => {
      if (thisRender !== renderNumber) return;
      slot.replaceChildren(el("section", { className: "error-card card", role: "alert" },
        el("h2", {}, "This page could not load"), el("p", {}, error instanceof Error ? error.message : "An unexpected error occurred."),
        button("Retry page", () => renderApp(), "button-secondary"),
      ));
    });
  } else {
    void Promise.resolve(renderAdminPage(slot, currentRoute, context)).then(releaseRetiredWhenCurrent(thisRender), (error) => {
      if (thisRender !== renderNumber) return;
      slot.replaceChildren(el("section", { className: "error-card card", role: "alert" },
        el("h2", {}, "This page could not load"), el("p", {}, error instanceof Error ? error.message : "An unexpected error occurred."),
        button("Retry page", () => renderApp(), "button-secondary"),
      ));
    });
  }
}

function releaseRetiredWhenCurrent(thisRender) {
  return () => {
    if (thisRender === renderNumber) saves.releaseRetired();
  };
}

function getContext(thisRender) {
  return {
    service,
    isDemo: demoMode,
    state: session.state,
    navigate,
    refresh: requestRefresh,
    announceChange: (revision) => channel?.postMessage({ revision }),
    selectedId,
    isCurrentRender: () => thisRender === renderNumber,
    registerManualSaveController: (controller) => {
      // A replaced page must not guard departure, so its controller is disposed at once.
      if (thisRender !== renderNumber) {
        controller.dispose?.();
        return () => {};
      }
      return saves.register(controller);
    },
    resolveManualChanges: (actionLabel, action, options) => saves.resolve(actionLabel, action, options),
    refreshState: session.refreshState,
    run: session.run,
  };
}

document.addEventListener("click", (event) => {
  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!anchor || !app.contains(anchor) || anchor.target === "_blank" ||
      (!saves.hasPending() && !hasUnsavedForm())) return;
  const target = new URL(anchor.href, location.href);
  event.preventDefault();
  const openTarget = () => { location.href = target.href; };
  if (saves.hasPending()) void saves.resolve("open this link", openTarget);
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
    if (saves.hasPending()) {
      restoreCurrentUrl();
      await saves.resolve("leave this page", openNextRoute);
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
  // Unsaved batch or Issue edits, and an edited form in an open dialog, all warn before the tab closes.
  if (saves.hasPending() || saves.active()?.isSaving?.() || hasUnsavedDialogForm()) {
    event.preventDefault();
    event.returnValue = "";
  }
});

async function start() {
  try {
    const [initialState, serverSession] = await Promise.all([
      service.initialize({ mode: "lightweight" }),
      readServerSession(),
    ]);
    // Unsent edits are kept per origin, workspace, and signed-in user. Without a known user, "anonymous" is used.
    configureDraftRecovery({ origin: location.origin, workspace: service.workspace, actor: serverSession?.actor ?? "anonymous" });
    purgeExpiredStoredDrafts();
    releaseWatch = createReleaseWatch({
      startRelease: serverSession?.release ?? null,
      onNewRelease: () => {
        releaseAvailable = true;
        updateReleaseNotice();
      },
    });
    session.setInitialState(initialState);
    const initial = readRoute();
    currentRoute = initial.route;
    selectedId = initial.id;
    if (!location.hash || initial.legacyHistory || initial.legacyReports) history.replaceState({ route: currentRoute, id: selectedId }, "", routeHash(currentRoute, selectedId));
    channel = new BroadcastChannel(`masterqc-web-qc:${service.workspace}`);
    channel.addEventListener("message", (event) => {
      session.noteRemoteRevision(event.data?.revision);
    });
    // The release is checked on this same poll, at most every five minutes, and again when the page regains focus.
    window.setInterval(() => {
      void session.checkForSharedChanges();
      releaseWatch?.tick();
    }, 5000);
    window.addEventListener("focus", () => {
      void session.checkForSharedChanges();
      void releaseWatch?.check();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      void session.checkForSharedChanges();
      void releaseWatch?.check();
    });
    renderApp();
  } catch (error) {
    const message = messageOf(error, "The QC workspace could not be opened.");
    app.replaceChildren(el("main", { className: "startup-error" },
      el("p", { className: "eyebrow" }, "MasterQC Web"),
      el("h1", {}, "The QC server is unavailable"),
      el("p", {}, message),
      el("p", {}, "Check that the MasterQC server is running and reachable, then retry."),
      button("Retry", () => { app.replaceChildren(el("p", {}, "Connecting to the QC server…")); void start(); }, "button-primary"),
    ));
  }
}

void start();
