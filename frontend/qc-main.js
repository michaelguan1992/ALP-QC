import { qcService, createDemoQCService, exportLegacyBrowserBackup } from "../core/qc-app.js";
import { getBatchVersions } from "../core/qc-batch-versions.js";
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
  return [...app.querySelectorAll('.app-main form[data-dirty="true"]')];
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

function setStale(message) {
  staleMessage = message;
  updateStaleWarning();
}

async function readLatestState() {
  const next = await service.getState();
  state = next;
  staleMessage = "";
  renderApp();
}

function requestRefresh() {
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

function navigate(route, id = null, force = false) {
  if (!routes.has(route)) return false;
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
    run: async (type, data) => {
      if (!state) return { ok: false, error: new Error("The local workspace is not ready.") };
      try {
        const result = await service.command(type, data, state.revision);
        try {
          const latest = await service.getState();
          state = latest;
          staleMessage = "";
          channel?.postMessage({ revision: latest.revision });
          renderApp();
        } catch (readError) {
          setStale("The change was saved, but the updated data could not be reloaded. Reload before making another change.");
          notify(readError instanceof Error ? readError.message : "The change was saved, but the page could not reload.", true);
        }
        return { ok: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : "The change could not be saved.";
        if (/revision|stale|reload|changed in another/i.test(message)) {
          setStale("Another tab changed this workspace. Reload the latest data before saving again.");
        }
        notify(message, true);
        return { ok: false, error };
      }
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

function renderGettingStarted() {
  const hasStarted = state.orders.length > 0 || state.batches.length > 0;
  if (currentRoute !== "batches" || hasStarted) return null;
  const families = Array.isArray(state.families) ? state.families : [];
  const familiesWithVersions = families.filter((family) => getBatchVersions(state, family.id).length > 0).length;
  const intro = el("section", { className: "getting-started card", "aria-labelledby": "getting-started-title" },
    el("div", { className: "getting-started-heading" },
      el("div", {}, el("p", { className: "eyebrow" }, "First run"), el("h2", { id: "getting-started-title" }, "Set up your first inspection")),
      el("p", { className: "muted" }, "Review design versions, create a purchase order, then create an inspection batch."),
    ),
    el("ol", { className: "setup-steps" },
      el("li", {},
        el("strong", {}, "Review design versions"),
        el("span", {}, familiesWithVersions
          ? `Version records are available for ${familiesWithVersions} product famil${familiesWithVersions === 1 ? "y" : "ies"}. Review their inspection items in Standards.`
          : "Create or review a design version for the product family in Standards."),
        button("Open standards", () => navigate("standards"), "button-secondary"),
      ),
      el("li", {},
        el("strong", {}, "Create a purchase order"),
        el("span", {}, "Add one or more variant lines with ordered quantities."),
        button("Open purchase orders", () => navigate("orders"), "button-secondary"),
      ),
      el("li", {},
        el("strong", {}, "Create the inspection batch"),
        el("span", {}, "Choose a purchase order line and an applicable version. The selected version and inspection rows are locked on the batch."),
        button("Open batches", () => navigate("batches"), "button-secondary"),
      ),
    ),
  );
  return intro;
}

function renderApp() {
  if (!state) return;
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
      el("span", {}, "Demo records use a separate local database on this computer."),
      el("a", { href: `${realUrl.pathname}${realUrl.search}${realUrl.hash}` }, "Open your real workspace"),
    ));
  }
  workspace.append(el("div", { id: "stale-warning", className: "stale-warning", hidden: true, role: "alert" },
    el("span", { className: "stale-message" }, staleMessage),
    button("Reload latest data", requestRefresh, "button-secondary"),
  ));
  const main = el("main", { className: "app-main", id: "main-content" });
  const firstRun = renderGettingStarted();
  if (firstRun) main.append(firstRun);
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
  if (!anchor || !app.contains(anchor) || !hasUnsavedForm()) return;
  const target = new URL(anchor.href, location.href);
  if (target.origin !== location.origin) return;
  event.preventDefault();
  promptToDiscard("open link", () => { location.href = target.href; });
});

window.addEventListener("popstate", () => {
  const next = readRoute();
  if (hasUnsavedForm()) {
    history.pushState({ route: currentRoute, id: selectedId }, "", routeHash(currentRoute, selectedId));
    promptToDiscard("continue", () => navigate(next.route, next.id, true));
    return;
  }
  currentRoute = next.route;
  selectedId = next.id;
  if (next.legacyHistory || next.legacyReports) {
    history.replaceState({ route: currentRoute, id: selectedId }, "", routeHash(currentRoute, selectedId));
  }
  renderApp();
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
      if (!state) return;
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
