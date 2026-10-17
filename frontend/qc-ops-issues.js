import {
  button,
  dateLabel,
  el,
  errorText,
  field,
  list,
  pageHeading,
  quantity,
  statusPill,
  text,
} from "./qc-ops-common.js";
import { closeDialog, createSingleFlight, showDialog, uploadingLabel } from "./qc-ui.js";
import {
  assertUploadRequestSize,
  issueAttachmentCategory,
  normalizedMimeType,
  readAttachmentFile,
} from "./qc-attachments.js";
import { DOCUMENT_MAX_BYTES, PHOTO_MAX_BYTES } from "../core/qc-domain.js";
import { getBatchProducts, getBatchRowProduct } from "../core/qc-batch-products.js";
import { resolveBatchDisplayNumber } from "../core/qc-batch-display.js";
import { hasRequiredIssuePhoto } from "./qc-issue-drafts.js";
import { issueProductLabel, newRequestId, productSummary, sourceText, variantById } from "./qc-issue-model.js";
import { openIssueDialog } from "./qc-issue-dialog.js";

export { clearIssueDrafts } from "./qc-issue-dialog.js";

export function openNewIssueDialog(state, ctx, options = {}) {
  const requestId = options.requestId || newRequestId();
  const fixedBatch = options.batchId ? list(state.batches).find((batch) => batch.id === options.batchId) : null;
  const fixedRow = fixedBatch ? list(fixedBatch.rows).find((row) => row.id === options.rowId) : null;
  const reportedByInput = el("input", { type: "text", required: true, maxLength: "200", name: "reportedBy", value: options.reportedBy || "" });
  const initialOwnerInput = el("input", { type: "text", maxLength: "200", name: "owner", value: options.owner || "" });
  const titleInput = el("input", {
    type: "text", required: true, maxLength: "180", name: "title", placeholder: "Describe the issue", value: "",
  });
  const descriptionInput = el("textarea", { rows: "3", maxLength: "2000", name: "description" }, options.description || "");
  const formError = el("p", { className: "qc-ops-form-error", role: "alert" });
  const form = el("form", { className: "qc-ops-form qc-ops-new-issue-form", "data-preserve-drafts": "true" });
  const selectedFiles = [];
  const selectedFileHost = el("div", { className: "qc-ops-selected-issue-files" });
  const photoInput = el("input", { type: "file", accept: "image/*", multiple: true, className: "qc-ops-hidden-file", "aria-label": "Choose issue photos" });
  const fileInput = el("input", { type: "file", multiple: true, className: "qc-ops-hidden-file", "aria-label": "Choose issue files" });
  const photosButton = button("Choose photos", () => photoInput.click(), "button-secondary");
  const filesButton = button("Choose files", () => fileInput.click(), "button-secondary");
  const renderSelectedFiles = () => {
    selectedFileHost.replaceChildren(...(selectedFiles.length
      ? [el("ul", { className: "qc-ops-selected-issue-file-list" }, ...selectedFiles.map((entry) => {
        const remove = button("Remove", () => {
          const index = selectedFiles.findIndex((candidate) => candidate.id === entry.id);
          if (index >= 0) selectedFiles.splice(index, 1);
          renderSelectedFiles();
        }, "button-quiet qc-ops-small-button");
        return el("li", {},
          el("span", { title: entry.file.name }, text(entry.file.name, "Attachment")),
          el("small", {}, entry.category === "photo" ? "Photo" : "File"),
          remove,
        );
      }))]
      : []));
  };
  const collectFiles = (input) => {
    for (const file of Array.from(input.files || [])) {
      const mimeType = normalizedMimeType(file.name, file.type);
      selectedFiles.push({ id: newRequestId(), file, category: issueAttachmentCategory(mimeType) });
    }
    input.value = "";
    renderSelectedFiles();
    if (selectedFiles.some((entry) => entry.category === "photo")) formError.textContent = "";
  };
  photoInput.addEventListener("change", () => collectFiles(photoInput));
  fileInput.addEventListener("change", () => collectFiles(fileInput));
  reportedByInput.addEventListener("input", () => {
    if (reportedByInput.value.trim()) formError.textContent = "";
  });

  const editableBatches = list(state.batches).filter((batch) => batch.status !== "released");
  const batchSelect = el("select", { name: "batchId" }, el("option", { value: "" }, "No batch link"), ...editableBatches.map((batch) => {
    const products = getBatchProducts(batch).map((product) => ({ ...product, variant: variantById(state).get(product.variantId) }));
    const summary = products.length
      ? productSummary(products, state)
      : batch.kind === "historical"
        ? `${text(batch.productLabel || batch.model || batch.familyId, "Historical product")} · ${batch.quantity === null || batch.quantity === undefined ? "quantity unknown" : `${quantity(batch.quantity)} units`}${batch.versionLabel ? ` · Version ${batch.versionLabel}` : ""}`
        : text(variantById(state).get(batch.variantId)?.label, batch.variantId);
    return el("option", { value: batch.id }, `${text(resolveBatchDisplayNumber(state, batch.id, batch.number))} · ${summary} · ${text(batch.factory)} ${text(batch.stage)}`);
  }));
  const rowSelect = el("select", { name: "rowId", disabled: true }, el("option", { value: "" }, "No inspection row"));
  const updateRows = () => {
    const batch = list(state.batches).find((entry) => entry.id === batchSelect.value);
    const rows = list(batch?.rows);
    rowSelect.disabled = !batch || !rows.length;
    rowSelect.replaceChildren(el("option", { value: "" }, "No inspection row"), ...rows.map((row) => {
      const product = getBatchRowProduct(batch, row) || {};
      const label = text(row.productLabel, issueProductLabel(product, state));
      const productQty = row.productQuantity ?? product.quantity;
      const productContext = row.productLineId || product.lineId
        ? `${label} · ${productQty === null || productQty === undefined ? "quantity unknown" : `${quantity(productQty)} units`} · `
        : "";
      return el("option", { value: row.id }, `${productContext}${text(row.no)} · ${text(row.title)}${row.titleZh ? ` · ${row.titleZh}` : ""}`);
    }));
  };
  batchSelect.addEventListener("change", updateRows);

  const fixedContext = fixedBatch
    ? el("p", { className: "qc-ops-fixed-issue-source" }, `${text(resolveBatchDisplayNumber(state, fixedBatch.id, fixedBatch.number))} · ${text(fixedRow?.no)} · ${text(fixedRow?.title)}`)
    : null;
  const associationFields = fixedBatch
    ? fixedContext
    : el("div", { className: "qc-ops-form-grid" },
      field("Related batch (optional)", batchSelect),
      field("Inspection row (optional)", rowSelect),
    );
  const submit = el("button", { type: "submit", className: "button button-primary" }, "Create issue");
  const uploadStatus = el("p", { className: "upload-feedback", role: "status", ariaLive: "polite", hidden: true });
  // Photos and files are sent with the Issue, so the controls stay disabled until the request settles.
  const submitFlight = createSingleFlight({ controls: () => [submit, photosButton, filesButton] });
  async function submitIssue() {
    formError.textContent = "";
    const reportedBy = reportedByInput.value.trim();
    if (!reportedBy) {
      formError.textContent = "Enter the name of the person reporting this issue.";
      reportedByInput.focus();
      return;
    }
    if (!form.reportValidity()) return;
    if (!hasRequiredIssuePhoto(selectedFiles)) {
      formError.textContent = "Choose at least one photo.";
      photosButton.focus();
      return;
    }
    const data = { reportedBy, owner: initialOwnerInput.value.trim(), title: titleInput.value.trim(), requestId, files: [] };
    const description = descriptionInput.value.trim();
    if (description) data.description = description;
    const batchId = fixedBatch?.id || batchSelect.value;
    const rowId = fixedRow?.id || rowSelect.value;
    if (batchId) data.batchId = batchId;
    if (rowId) data.rowId = rowId;
    uploadStatus.textContent = uploadingLabel(selectedFiles.reduce((sum, entry) => sum + (Number(entry.file.size) || 0), 0));
    uploadStatus.hidden = false;
    try {
      assertUploadRequestSize(selectedFiles.map((entry) => entry.file));
      data.files = await Promise.all(selectedFiles.map(async (entry) => {
        const payload = await readAttachmentFile(entry.file, {
          maxBytes: entry.category === "photo" ? PHOTO_MAX_BYTES : DOCUMENT_MAX_BYTES,
          category: entry.category === "photo" ? "photo" : null,
        });
        return { ...payload, category: entry.category };
      }));
    } catch (error) {
      uploadStatus.hidden = true;
      formError.textContent = errorText(error, "Could not read the selected file.");
      return;
    }
    const result = await ctx.run("createIssue", data);
    uploadStatus.hidden = true;
    if (!result.ok) {
      formError.textContent = errorText(result.error);
      return;
    }
    closeDialog(true);
    if (options.stayOnBatch) return;
    const issueId = result.result?.entityId || result.result?.issueId;
    if (issueId) ctx.navigate("issues", issueId, true);
    else ctx.navigate("issues", null, true);
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitFlight(submitIssue);
  });
  form.append(
    field("Reported by", reportedByInput),
    field("Initial disposition owner (optional)", initialOwnerInput),
    field("Issue title", titleInput),
    field("Description", descriptionInput),
    associationFields,
    el("div", { className: "qc-ops-new-issue-files" },
      el("div", { className: "qc-ops-new-issue-file-actions" },
        el("span", { className: "qc-ops-new-issue-photo-required" }, "Photos · required"),
        photosButton,
        filesButton,
      ),
      selectedFileHost,
      photoInput,
      fileInput,
    ),
    uploadStatus,
    formError,
    el("div", { className: "qc-ops-dialog-actions" }, button("Cancel", () => closeDialog(), "button button-secondary"), submit)
  );
  updateRows();
  showDialog("Create issue", form);
}

function renderIssueListPage(root, ctx) {
  const state = ctx.state || {};
  const issues = list(state.issues).slice().sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
  const create = button("New issue", () => openNewIssueDialog(state, ctx), "button button-primary");
  const filters = el("div", { className: "qc-ops-list-toolbar" },
    field("Search", el("input", { type: "search", placeholder: "Search issue, owner, batch, or row", "aria-label": "Search issues" })),
    field("Status", el("select", { "aria-label": "Filter issues by status" },
      el("option", { value: "all" }, "All issues"), el("option", { value: "open" }, "Open"), el("option", { value: "closed" }, "Closed")
    ))
  );
  const search = filters.querySelector('input[type="search"]');
  const status = filters.querySelector("select");
  const tbody = el("tbody");
  const isInteractiveTarget = (target) => target instanceof Element && Boolean(target.closest(
    "button, a, input, select, textarea, summary, label, form, [contenteditable='true'], [role='button'], [role='link']"
  ));
  for (const issue of issues) {
    const source = sourceText(issue, state);
    const searchText = [issue.number, issue.title, issue.reportedBy, issue.owner, source, issue.disposition].join(" ").toLowerCase();
    const row = el("tr", {
      className: "qc-ops-issue-row",
      tabIndex: 0,
      ariaLabel: `Open issue ${issue.number}`,
      "data-issue-id": issue.id,
      "data-status": issue.status,
      "data-search": searchText,
    },
      el("td", {}, text(issue.number)),
      el("td", {}, el("strong", {}, text(issue.title)), el("small", { className: "qc-ops-subline" }, source)),
      el("td", { "data-issue-owner": "true" }, text(issue.owner, "Unassigned")),
      el("td", {}, statusPill(issue.status)),
      el("td", {}, dateLabel(issue.createdAt))
    );
    const openIssue = () => {
      if (ctx.selectedId !== issue.id) ctx.navigate("issues", issue.id);
      else openIssueDialog(issue, state, ctx);
    };
    row.addEventListener("click", (event) => {
      if (isInteractiveTarget(event.target)) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && (row.contains(selection.anchorNode) || row.contains(selection.focusNode))) return;
      openIssue();
    });
    row.addEventListener("keydown", (event) => {
      if ((event.key !== "Enter" && event.key !== " ") || isInteractiveTarget(event.target)) return;
      event.preventDefault();
      openIssue();
    });
    tbody.append(row);
  }
  const updateFilters = () => {
    const query = search.value.trim().toLowerCase();
    for (const row of tbody.rows) row.hidden = (status.value !== "all" && row.dataset.status !== status.value) || (query && !row.dataset.search.includes(query));
  };
  search.addEventListener("input", updateFilters);
  status.addEventListener("change", updateFilters);
  const table = el("table", { className: "qc-ops-list-table" },
    el("thead", {}, el("tr", {}, ...["Issue", "Source", "Owner", "Status", "Created"].map((label) => el("th", { scope: "col" }, label)))),
    tbody
  );
  const sections = [];
  if (!issues.length) sections.push(el("section", { className: "card qc-ops-empty-card" },
    el("h2", {}, "No issues recorded"),
    create
  ));
  else sections.push(el("section", { className: "card qc-ops-list-card" }, filters, el("div", { className: "qc-ops-table-scroll" }, table)));
  root.replaceChildren(pageHeading("Issues", "", [create]), ...sections);
  if (ctx.selectedId) {
    const issue = issues.find((item) => item.id === ctx.selectedId);
    if (issue) openIssueDialog(issue, state, ctx);
  }
}
export function renderIssuesPage(root, ctx) {
  renderIssueListPage(root, ctx);
}
