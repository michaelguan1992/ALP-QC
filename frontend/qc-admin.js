import { ASSET_TOTAL_MAX_BYTES, BACKUP_MAX_BYTES, DOCUMENT_MAX_BYTES } from "../core/qc-service.js";
import { rawLarkVersionFields } from "../core/qc-lark-versions.js";
import { getPurchaseOrderProgress } from "../core/qc-purchasing.js";
import { formatNumberedDescription } from "./qc-source-description.js";
import { downloadAttachment, loadAssetContent } from "./qc-attachments.js";
import { button, closeDialog, downloadFile, el, field, notify, readFileAsDataURL, showDialog } from "./qc-ui.js";

const h = el;
const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const id = () => crypto.randomUUID();
const bytesInDataUrl = (dataUrl) => {
  const payload = String(dataUrl ?? "").split(",", 2)[1] ?? "";
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(payload.length * 3 / 4) - padding);
};
const bytesForAsset = (asset) => Number.isFinite(Number(asset?.decodedBytes))
  ? Math.max(0, Number(asset.decodedBytes))
  : bytesInDataUrl(asset?.dataUrl);
const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
const text = (value, fallback = "—") => value === null || value === undefined || value === "" ? fallback : String(value);
const familyName = (ctx, familyId) => ctx.state.families.find((family) => family.id === familyId)?.name ?? "Unknown family";
const variantName = (ctx, variantId) => ctx.state.variants.find((variant) => variant.id === variantId)?.label ?? "Unavailable variant";
const statusBadge = (label, tone = "") => h("span", { className: `badge${tone ? ` badge-${tone}` : ""}` }, label);
const LARK_VERSION_FIELDS = rawLarkVersionFields();

function effectiveTimestamp(version) {
  const raw = version.source?.effectiveAtRaw;
  if (typeof raw !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(raw)) return null;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function sortSourceVersions(left, right) {
  const leftDate = effectiveTimestamp(left);
  const rightDate = effectiveTimestamp(right);
  if (leftDate === null && rightDate !== null) return 1;
  if (leftDate !== null && rightDate === null) return -1;
  if (leftDate !== null && rightDate !== null && leftDate !== rightDate) return rightDate - leftDate;
  return left.source.recordId.localeCompare(right.source.recordId);
}

function sourceStatus(version) {
  const raw = version.source.rawRecord[LARK_VERSION_FIELDS.status];
  const status = Array.isArray(raw) ? raw.filter((value) => typeof value === "string").join(", ") : raw;
  return typeof status === "string" && status.trim() ? status : "Not recorded";
}

const GENERATED_REFERENCE_NOTE_PREFIXES = [
  "historical source reference draft.",
  "masterqc-ap-oqc-reference-25.10.29.",
];

function visibleVersionNotes(notes) {
  if (typeof notes !== "string" || !notes.trim()) return "";
  const normalized = notes.trimStart().toLocaleLowerCase();
  if (GENERATED_REFERENCE_NOTE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return "";
  return notes;
}

function renderRecordedVersion(ctx, version) {
  const source = version.source;
  const effectiveValue = source.rawRecord[LARK_VERSION_FIELDS.effectiveAt];
  const effectiveAt = typeof effectiveValue === "string" && /^\d{4}-\d\d-\d\d(?:T|$)/.test(effectiveValue) ? effectiveValue.slice(0, 10) : "Not recorded";
  const status = sourceStatus(version);
  const rawDescription = source.rawRecord[LARK_VERSION_FIELDS.changeDescription];
  const changeDescription = typeof rawDescription === "string" && rawDescription.trim()
    ? formatNumberedDescription(rawDescription)
    : "";
  return h("article", { className: "version-card recorded-version-card" },
    h("header", { className: "version-card-header" }, h("div", {},
      h("div", { className: "button-row version-title-row" },
        h("h3", {}, version.label || "Version label not recorded"),
        statusBadge(status),
        renderVersionAttachmentControl(ctx, version),
      ),
      h("p", {}, `Effective ${effectiveAt}`),
    )),
    changeDescription ? h("details", {}, h("summary", {}, "Change description"),
      h("div", { className: "lark-source-details" },
        h("p", { className: "source-preserve-text" }, changeDescription),
      ),
    ) : null,
  );
}

function pageHeading(root, title, actions = []) {
  root.append(h("header", { className: "page-heading" },
    h("div", {}, h("h1", {}, title)),
    actions.length ? h("div", { className: "page-heading-actions" }, actions) : null,
  ));
}

function emptyState(title, description, actions = []) {
  return h("section", { className: "empty-state" }, h("h3", {}, title), description ? h("p", {}, description) : null, actions);
}

function input(name, value = "", type = "text", props = {}) {
  return h("input", { type, name, value: value ?? "", ...props });
}

function textarea(name, value = "", props = {}) {
  return h("textarea", { name, rows: 3, ...props }, value ?? "");
}

function select(name, options, selectedValue = "", props = {}) {
  const control = h("select", { name, ...props }, options.map((option) => {
    const value = typeof option === "string" ? option : option.value;
    const label = typeof option === "string" ? option : option.label;
    return h("option", { value, selected: String(value) === String(selectedValue) }, label);
  }));
  if (selectedValue !== undefined && selectedValue !== null) control.value = String(selectedValue);
  return control;
}

function itemTable(items) {
  if (!items.length) return h("p", { className: "source-note" }, "No inspection rows in this draft yet.");
  return h("div", { className: "table-shell" }, h("table", { className: "data-table" },
    h("thead", {}, h("tr", {},
      h("th", {}, "No."), h("th", {}, "Inspection item / 检验项目"), h("th", {}, "Specification / 检验标准"),
      h("th", {}, "Factory / stage"), h("th", {}, "Models"), h("th", {}, "Sample %"), h("th", {}, "Recording rule"), h("th", {}, "Important"),
    )),
    h("tbody", {}, items.map((item) => h("tr", {},
      h("td", {}, text(item.no)),
      h("td", {}, h("strong", {}, text(item.title)), item.titleZh ? h("div", { className: "source-note" }, item.titleZh) : null),
      h("td", {}, text(item.specification), item.specificationZh ? h("div", { className: "source-note" }, item.specificationZh) : null),
      h("td", {}, `${text(item.factory)} · ${text(item.stage)}`),
      h("td", {}, item.models?.length ? item.models.join(", ") : "All family models"),
      h("td", {}, `${text(item.samplingPercent, "0")}%`), h("td", {}, text(item.recordingRule)),
      h("td", {}, item.important ? statusBadge("Important", "green") : "—"),
    ))),
  ));
}

function renderCatalog(root, ctx) {
  pageHeading(root, "Catalog", [
    button("Add variant", () => openVariantEditor(ctx), "button-primary"),
  ]);
  const familyGrid = h("div", { className: "admin-grid" }, ctx.state.families.map((family) => h("section", { className: "admin-card family-card card" },
    h("div", { className: "section-heading" },
      h("h3", {}, family.name),
    ),
    h("div", { className: "family-models" }, family.models.map((model) => statusBadge(model))),
  )));
  const variants = [...ctx.state.variants].sort((a, b) => a.familyId.localeCompare(b.familyId) || a.model.localeCompare(b.model) || a.label.localeCompare(b.label));
  const variantTable = variants.length ? h("div", { className: "table-shell variant-table" }, h("table", { className: "data-table" },
    h("thead", {}, h("tr", {}, h("th", {}, "Inspection family"), h("th", {}, "Model"), h("th", {}, "Color / variation"), h("th", {}, "Order display"), h("th", {}, "Status"), h("th", {}, "Action"))),
    h("tbody", {}, variants.map((variant) => h("tr", {},
      h("td", {}, familyName(ctx, variant.familyId)), h("td", {}, variant.model), h("td", {}, variant.color),
      h("td", {}, h("strong", {}, variant.label)),
      h("td", {}, statusBadge(variant.active ? "Active" : "Inactive", variant.active ? "green" : "warn")),
      h("td", {}, button(variant.active ? "Deactivate" : "Activate", async () => {
        await ctx.run("setVariantActive", { id: variant.id, active: !variant.active });
      }, variant.active ? "button-secondary" : "button-primary")),
    ))),
  )) : emptyState("No product variants yet", "");
  root.append(h("div", { className: "admin-grid" },
    h("section", { className: "admin-card admin-card-wide card" },
      h("div", { className: "section-heading" }, h("h3", {}, "Inspection families")),
      familyGrid,
    ),
    h("section", { className: "admin-card admin-card-wide card" },
      h("div", { className: "section-heading" }, h("h3", {}, "Product variants")),
      variantTable,
    ),
  ));
}

function openVariantEditor(ctx) {
  const family = ctx.state.families[0];
  const familySelect = select("familyId", ctx.state.families.map((item) => ({ value: item.id, label: item.name })), family?.id ?? "");
  const modelSelect = select("model", (family?.models ?? []).map((model) => ({ value: model, label: model })), family?.models?.[0] ?? "");
  familySelect.addEventListener("change", () => {
    const selectedFamily = ctx.state.families.find((item) => item.id === familySelect.value);
    modelSelect.replaceChildren(...(selectedFamily?.models ?? []).map((model) => h("option", { value: model }, model)));
    modelSelect.value = selectedFamily?.models?.[0] ?? "";
  });
  const form = h("form", { className: "stack" },
    h("div", { className: "form-grid" },
      field("Inspection family", familySelect), field("Product model", modelSelect),
      field("Color", input("color", "", "text", { required: true, maxLength: 80, placeholder: "For example: Blue" })),
      field("Displayed product name", input("label", "", "text", { required: true, maxLength: 160, placeholder: "For example: S15 Blue" })),
    ),
    h("div", { className: "form-actions" }, h("button", { type: "submit", className: "button button-primary" }, "Create active variant")),
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = new FormData(form);
    const result = await ctx.run("createVariant", {
      familyId: values.get("familyId"), model: values.get("model"), color: values.get("color"), label: values.get("label"),
    });
    if (result.ok) closeDialog(true);
  });
  showDialog("Add product variant", form);
}

function nextSequence(ctx, familyId) {
  return Math.max(0, ...ctx.state.versions.filter((version) => version.familyId === familyId && version.status !== "recorded").map((version) => version.sequence)) + 1;
}

function createItemDraft(familyId, ctx) {
  return {
    id: id(), key: `manual-${id()}`, no: 1, title: "", titleZh: "", specification: "", specificationZh: "", devices: "",
    factory: "AP", stage: "OQC", models: [], samplingPercent: 10, recordingRule: "", important: false, timeSeconds: null, procedureUrl: "",
  };
}

function readVersionForm(form, items, familyId) {
  const values = new FormData(form);
  const selectedFamilyId = String(values.get("familyId") ?? familyId);
  const parsedItems = items.map((item, index) => {
    const models = values.get(`item.${index}.allModels`) === "on" ? [] : values.getAll(`item.${index}.models`).map(String);
    const rawTime = String(values.get(`item.${index}.timeSeconds`) ?? "").trim();
    const rawSampling = String(values.get(`item.${index}.samplingPercent`) ?? "");
    return {
      id: values.get(`item.${index}.id`) || item.id || undefined,
      key: String(values.get(`item.${index}.key`) ?? "").trim(),
      no: Number(values.get(`item.${index}.no`)),
      title: String(values.get(`item.${index}.title`) ?? "").trim(),
      titleZh: String(values.get(`item.${index}.titleZh`) ?? "").trim(),
      specification: String(values.get(`item.${index}.specification`) ?? "").trim(),
      specificationZh: String(values.get(`item.${index}.specificationZh`) ?? "").trim(),
      devices: String(values.get(`item.${index}.devices`) ?? "").trim(),
      factory: String(values.get(`item.${index}.factory`) ?? "").trim(),
      stage: String(values.get(`item.${index}.stage`) ?? "OQC"),
      models,
      samplingPercent: rawSampling === "" ? Number.NaN : Number(rawSampling),
      recordingRule: String(values.get(`item.${index}.recordingRule`) ?? "").trim(),
      important: values.get(`item.${index}.important`) === "on",
      timeSeconds: rawTime === "" ? null : Number(rawTime),
      procedureUrl: String(values.get(`item.${index}.procedureUrl`) ?? "").trim(),
    };
  });
  return {
    familyId: selectedFamilyId,
    label: String(values.get("label") ?? "").trim(),
    sequence: Number(values.get("sequence")),
    effectiveDate: String(values.get("effectiveDate") ?? ""),
    notes: String(values.get("notes") ?? "").trim(),
    items: parsedItems,
  };
}

function renderVersionEditor(ctx, version, initialFamilyId) {
  const familyId = version?.familyId ?? initialFamilyId ?? ctx.state.families[0]?.id;
  const family = ctx.state.families.find((item) => item.id === familyId) ?? ctx.state.families[0];
  const sourceItems = structuredClone(version?.items ?? []);
  let itemDrafts = sourceItems;

  function draw(itemsToDraw, shouldMarkDirty = false, formSnapshot = null) {
    itemDrafts = itemsToDraw;
    const next = nextSequence(ctx, family.id);
    const metadata = h("div", { className: "form-grid form-grid-three" },
      h("div", { className: "field" }, h("span", { className: "field-label" }, "Inspection family"), h("div", { className: "readonly-label" }, family.name), input("familyId", family.id, "hidden")),
      field("Version name", input("label", formSnapshot?.label ?? version?.label ?? `Version ${next}`, "text", { required: true, maxLength: 160 })),
      field("Sequence", input("sequence", formSnapshot?.sequence ?? version?.sequence ?? next, "number", { required: true, min: 1, step: 1 })),
      field("Effective date", input("effectiveDate", formSnapshot?.effectiveDate ?? version?.effectiveDate ?? today(), "date", { required: true })),
      field("Notes", input("notes", formSnapshot?.notes ?? version?.notes ?? "", "text", { maxLength: 5000, className: "form-control" })),
    );
    const editorRows = itemsToDraw.map((item, index) => {
      const allModels = item.models?.length === 0;
      const modelsSelect = select(`item.${index}.models`, family.models.map((model) => ({ value: model, label: model })), "", {
        multiple: true, disabled: allModels, required: true, size: Math.min(4, Math.max(2, family.models.length)),
      });
      for (const option of modelsSelect.options) option.selected = (item.models ?? []).includes(option.value);
      const allCheckbox = h("input", { type: "checkbox", name: `item.${index}.allModels`, checked: allModels });
      allCheckbox.addEventListener("change", () => { modelsSelect.disabled = allCheckbox.checked; });
      return h("section", { className: "item-editor" },
        h("header", { className: "item-editor-header" }, h("strong", {}, `Inspection item ${index + 1}`), button("Remove item", () => {
          const current = readVersionForm(form, itemDrafts, family.id);
          const remaining = current.items.filter((_, currentIndex) => currentIndex !== index);
          draw(remaining, true, current);
        }, "button-danger")),
        input(`item.${index}.id`, item.id ?? "", "hidden"),
        h("div", { className: "item-editor-grid" },
          field("History key", input(`item.${index}.key`, item.key ?? `manual-${id()}`, "text", { required: true, maxLength: 120 })),
          field("Row number", input(`item.${index}.no`, item.no ?? index + 1, "number", { required: true, min: 1, step: 1 })),
          field("Factory", input(`item.${index}.factory`, item.factory ?? "AP", "text", { required: true, maxLength: 100, placeholder: "AP, UI, or factory name" })),
          field("Stage", select(`item.${index}.stage`, ["IQC", "OQC"], item.stage ?? "OQC")),
          field("Inspection title", input(`item.${index}.title`, item.title ?? "", "text", { required: true, maxLength: 300 })),
          field("检验项目", input(`item.${index}.titleZh`, item.titleZh ?? "", "text", { maxLength: 300 })),
          field("Specification", textarea(`item.${index}.specification`, item.specification ?? "", { required: true, maxLength: 5000, rows: 3 })),
          field("检验标准", textarea(`item.${index}.specificationZh`, item.specificationZh ?? "", { maxLength: 5000, rows: 3 })),
          field("Devices / 检测工具", input(`item.${index}.devices`, item.devices ?? "", "text", { maxLength: 1000 })),
          field("Sampling %", input(`item.${index}.samplingPercent`, item.samplingPercent ?? 10, "number", { required: true, min: 0, max: 100, step: "any" })),
          field("Recording rule", input(`item.${index}.recordingRule`, item.recordingRule ?? "", "text", { maxLength: 500, placeholder: "For example: 50% + all failed units" })),
          field("Time (seconds)", input(`item.${index}.timeSeconds`, item.timeSeconds ?? "", "number", { min: 0, step: 1 })),
          h("label", { className: "field" }, h("span", { className: "field-label" }, "Applicable models"),
            h("span", { className: "field-checkbox" }, allCheckbox, "All models in this family"),
            modelsSelect,
          ),
          field("Procedure URL", input(`item.${index}.procedureUrl`, item.procedureUrl ?? "", "url", { maxLength: 2000, placeholder: "https://…" })),
          h("label", { className: "field-checkbox" }, h("input", { type: "checkbox", name: `item.${index}.important`, checked: Boolean(item.important) }), "Important check (green in the inspection table)"),
        ),
      );
    });
    const form = h("form", { className: "stack version-editor-form" },
      metadata,
      h("section", { className: "stack" },
        h("div", { className: "section-heading" }, h("div", {}, h("h3", {}, "Inspection standards")),
          button("Add standard item", () => {
            const current = readVersionForm(form, itemDrafts, family.id);
            const nextNo = Math.max(0, ...current.items.map((item) => Number(item.no) || 0)) + 1;
            const fresh = createItemDraft(family.id, ctx);
            fresh.no = nextNo;
            draw([...current.items, fresh], true, current);
          }, "button-secondary"),
        ),
        editorRows.length ? h("div", { className: "item-editor-list" }, editorRows) : emptyState("No inspection items yet", ""),
      ),
      h("div", { className: "form-actions" }, h("button", { type: "submit", className: "button button-primary" }, version ? "Save draft" : "Create draft")),
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = readVersionForm(form, itemDrafts, family.id);
      const result = await ctx.run(version ? "saveVersion" : "createVersion", version ? { id: version.id, ...payload } : payload);
      if (result.ok) closeDialog(true);
    });
    if (shouldMarkDirty) form.dataset.dirty = "true";
    showDialog(version ? `Edit draft · ${version.label}` : "Create a design version", form);
  }
  draw(itemDrafts);
}

function openNewVersion(ctx, familyId) {
  renderVersionEditor(ctx, null, familyId);
}

function openCloneDialog(ctx, version) {
  const familySequence = nextSequence(ctx, version.familyId);
  const form = h("form", { className: "stack" },
    h("div", { className: "form-grid" },
      field("New version name", input("label", `${version.label} copy`, "text", { required: true, maxLength: 160 })),
      field("Sequence", input("sequence", familySequence, "number", { required: true, min: 1, step: 1 })),
      field("Effective date", input("effectiveDate", today(), "date", { required: true })),
    ),
    h("div", { className: "form-actions" }, h("button", { type: "submit", className: "button button-primary" }, "Create draft copy")),
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = new FormData(form);
    const result = await ctx.run("cloneVersion", { id: version.id, label: values.get("label"), sequence: Number(values.get("sequence")), effectiveDate: values.get("effectiveDate") });
    if (result.ok) closeDialog(true);
  });
  showDialog("Clone published version", form);
}

function confirmPublish(ctx, version) {
  showDialog("Publish immutable standards", h("div", { className: "stack" },
    h("p", {}, `Publish ${version.label} for ${familyName(ctx, version.familyId)}? Published versions cannot be edited. Future changes require a new draft copy.`),
    h("div", { className: "button-row" },
      button("Publish version", async () => {
        const result = await ctx.run("publishVersion", { id: version.id });
        if (result.ok) closeDialog(true);
      }, "button-primary"),
    ),
  ));
}

function renderOperationalVersion(ctx, version) {
  const notes = visibleVersionNotes(version.notes);
  if (version.status === "published" || version.status === "superseded") {
    return h("article", { className: "version-card" },
      h("header", { className: "version-card-header" },
        h("div", {}, h("div", { className: "button-row version-title-row" },
          h("h3", {}, version.label),
          version.status === "published"
            ? statusBadge("Published", "green")
            : statusBadge("Status: 已作废 Superseded"),
          renderVersionAttachmentControl(ctx, version),
        ),
          h("p", {}, `Effective ${text(version.effectiveDate)}`),
        ),
      ),
      h("details", {}, h("summary", {}, "Change description"),
        notes ? h("p", { className: "source-preserve-text" }, notes) : null,
      ),
    );
  }
  const actionButtons = version.status === "draft"
    ? [button("Edit draft", () => renderVersionEditor(ctx, version), "button-secondary"), button("Publish…", () => confirmPublish(ctx, version), "button-primary")]
    : [button("Clone to draft", () => openCloneDialog(ctx, version), "button-secondary")];
  return h("article", { className: "version-card" },
    h("header", { className: "version-card-header" },
      h("div", {}, h("div", { className: "button-row version-title-row" },
        h("h3", {}, version.label),
        statusBadge("Draft", "warn"),
        renderVersionAttachmentControl(ctx, version),
      ),
        h("p", {}, `Effective ${text(version.effectiveDate)} · ${version.items.length} inspection row${version.items.length === 1 ? "" : "s"}${version.publishedAt ? ` · published ${new Date(version.publishedAt).toLocaleDateString()}` : ""}`),
        notes ? h("p", { className: "source-note" }, notes) : null,
      ),
      h("div", { className: "version-actions" }, actionButtons),
    ),
    h("details", {}, h("summary", {}, "View version items"), itemTable(version.items)),
  );
}

function renderStandards(root, ctx) {
  pageHeading(root, "Standards");
  if (!ctx.state.versions.length) {
    root.append(emptyState("No versions yet", "", h("div", { className: "button-row" }, ctx.state.families.map((family) =>
      button(`Create ${family.name} draft`, () => openNewVersion(ctx, family.id), "button-secondary"),
    ))));
    return;
  }
  const sections = ctx.state.families.map((family) => {
    const allFamilyVersions = ctx.state.versions.filter((version) => version.familyId === family.id);
    const familyVersions = allFamilyVersions.filter((version) => version.status !== "recorded").sort((a, b) => b.sequence - a.sequence);
    const allRecordedVersions = allFamilyVersions.filter((version) => version.status === "recorded");
    const recordedVersions = allRecordedVersions
      .filter((version) => String(version.label ?? "").trim().toLocaleLowerCase() !== "ventus")
      .sort(sortSourceVersions);
    const visibleVersions = recordedVersions.map((version) => renderRecordedVersion(ctx, version))
      .concat(familyVersions.map((version) => renderOperationalVersion(ctx, version)));
    return h("section", { className: "admin-card admin-card-wide card" },
      h("div", { className: "section-heading" },
        h("h3", {}, family.name),
        button(`Create ${family.name} draft`, () => openNewVersion(ctx, family.id), "button-secondary"),
      ),
      h("div", { className: "version-list" }, visibleVersions),
    );
  });
  root.append(h("div", { className: "admin-grid" }, sections));
}

function readOrderLines(form, lineDrafts) {
  const values = new FormData(form);
  return lineDrafts.map((line, index) => ({
    ...(values.get(`line.${index}.id`) || line.id ? { id: String(values.get(`line.${index}.id`) || line.id) } : {}),
    variantId: String(values.get(`line.${index}.variantId`) ?? line.variantId ?? ""),
    orderedQty: Number(values.get(`line.${index}.orderedQty`)),
  }));
}

function readOrderForm(form, lineDrafts) {
  const values = new FormData(form);
  return {
    number: String(values.get("number") ?? ""),
    date: String(values.get("date") ?? ""),
    supplier: String(values.get("supplier") ?? ""),
    notes: String(values.get("notes") ?? ""),
    lines: readOrderLines(form, lineDrafts),
  };
}

function openOrderEditor(ctx, order = null) {
  const activeVariants = ctx.state.variants.filter((variant) => variant.active);
  if (!order && activeVariants.length === 0) {
    notify("Activate at least one product variant before creating a purchase order.", true);
    ctx.navigate("catalog");
    return;
  }
  let lineDrafts = structuredClone(order?.lines ?? [{ id: undefined, variantId: activeVariants[0]?.id ?? "", orderedQty: 1 }]);

  function draw(lines, markDirty = false, formSnapshot = null) {
    lineDrafts = lines;
    const referencedIds = new Set(ctx.state.batches.map((batch) => batch.lineId));
    const linesUi = lines.map((line, index) => {
      const referenced = Boolean(line.id && referencedIds.has(line.id));
      const variants = [...ctx.state.variants].filter((variant) => variant.active || variant.id === line.variantId).map((variant) => ({ value: variant.id, label: variant.label }));
      return h("div", { className: "line-editor" },
        input(`line.${index}.id`, line.id ?? "", "hidden"),
        field(`PO line ${index + 1} · Product variant`, select(`line.${index}.variantId`, variants, line.variantId, { required: true, disabled: referenced })),
        field("Ordered quantity", input(`line.${index}.orderedQty`, line.orderedQty ?? 1, "number", { required: true, min: 1, step: 1 })),
        h("div", { className: "button-row" }, referenced ? h("span", { className: "source-note" }, "Referenced by a batch") : button("Remove line", () => {
          const details = readOrderForm(form, lineDrafts);
          draw(details.lines.filter((_, currentIndex) => currentIndex !== index), true, details);
        }, "button-danger")),
      );
    });
    const form = h("form", { className: "stack order-editor-form" },
      h("div", { className: "form-grid" },
        field("PO number", input("number", formSnapshot?.number ?? order?.number ?? "", "text", { required: true, maxLength: 100, placeholder: "For example: PO-2026-001" })),
        field("PO date", input("date", formSnapshot?.date ?? order?.date ?? today(), "date", { required: true })),
        field("Supplier", input("supplier", formSnapshot?.supplier ?? order?.supplier ?? "", "text", { maxLength: 200 })),
        field("Notes", textarea("notes", formSnapshot?.notes ?? order?.notes ?? "", { maxLength: 5000, rows: 2 })),
      ),
      h("section", { className: "stack" },
        h("div", { className: "section-heading" }, h("h3", {}, "Purchase order lines"), button("Add line", () => {
          const details = readOrderForm(form, lineDrafts);
          const used = new Set(details.lines.map((item) => item.variantId));
          const nextVariant = activeVariants.find((variant) => !used.has(variant.id))?.id ?? activeVariants[0]?.id ?? "";
          draw([...details.lines, { variantId: nextVariant, orderedQty: 1 }], true, details);
        }, "button-secondary")),
        linesUi.length ? linesUi : emptyState("No lines", ""),
      ),
      h("div", { className: "form-actions" }, h("button", { type: "submit", className: "button button-primary" }, order ? "Save purchase order" : "Create purchase order")),
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = new FormData(form);
      const payload = {
        number: String(values.get("number") ?? "").trim(), date: values.get("date"), supplier: String(values.get("supplier") ?? "").trim(),
        notes: String(values.get("notes") ?? "").trim(), lines: readOrderLines(form, lineDrafts),
      };
      const result = await ctx.run(order ? "saveOrder" : "createOrder", order ? { id: order.id, ...payload } : payload);
      if (result.ok) closeDialog(true);
    });
    if (markDirty) form.dataset.dirty = "true";
    showDialog(order ? `Edit purchase order · ${order.number}` : "Create purchase order", form);
  }
  draw(lineDrafts);
}

function stat(label, value) {
  return h("div", { className: "progress-stat" }, h("span", {}, label), h("strong", {}, text(value, "0")));
}

async function renderOrders(root, ctx) {
  pageHeading(root, "Purchase orders", [
    button("New purchase order", () => openOrderEditor(ctx), "button-primary"),
  ]);
  if (!ctx.state.orders.length) {
    root.append(emptyState("No purchase orders yet", ""));
    return;
  }
  const results = ctx.state.orders.map((order) => ({ order, progress: getPurchaseOrderProgress(ctx.state, order.id), error: null }));
  root.append(h("div", { className: "admin-grid" }, results.map(({ order, progress, error }) => h("details", { className: "admin-card admin-card-wide card purchase-order-card" },
    h("summary", { className: "purchase-order-summary" },
      h("span", { className: "purchase-order-summary-title" },
        h("strong", { className: "purchase-order-number" }, order.number),
        button("Edit order", (event) => {
          event.preventDefault();
          event.stopPropagation();
          openOrderEditor(ctx, order);
        }, "button-secondary"),
      ),
      h("span", { className: "purchase-order-summary-meta" }, `${text(order.date)}${order.supplier ? ` · ${order.supplier}` : ""}`),
    ),
    h("div", { className: "purchase-order-details" },
      order.notes ? h("p", { className: "source-note purchase-order-notes" }, order.notes) : null,
      error ? h("p", { className: "source-note", role: "alert" }, `Progress could not be loaded: ${error instanceof Error ? error.message : "Unknown error"}`) :
        h("div", { className: "table-shell" }, h("table", { className: "data-table" },
          h("thead", {}, h("tr", {}, h("th", {}, "Product variant"), h("th", {}, "Ordered"), h("th", {}, "Released"), h("th", {}, "Remaining"), h("th", {}, "Excess"), h("th", {}, "Batch contributions"))),
          h("tbody", {}, (progress?.lines ?? []).map((line) => h("tr", {},
            h("td", {}, h("strong", {}, line.variant?.label ?? variantName(ctx, line.variantId))),
            h("td", {}, text(line.orderedQty, "0")), h("td", {}, text(line.releasedQty, "0")), h("td", {}, text(line.remainingQty, "0")), h("td", {}, text(line.excessQty, "0")),
            h("td", {}, (line.batches ?? []).length ? h("div", { className: "stack" }, line.batches.map((batch) => h("span", { className: "readonly-label" }, `${batch.number}: ${batch.quantity} released`))) : "—"),
          ))),
        )),
    ),
  ))));
}

function safeLibraryType(file) {
  const name = file.name.toLowerCase();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  const mime = String(file.type || "").toLowerCase();
  const expectedMime = ({
    ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".txt": "text/plain", ".log": "text/plain", ".csv": "text/csv", ".md": "text/markdown", ".markdown": "text/markdown",
  })[extension];
  return Boolean(expectedMime && (!mime || mime === "application/octet-stream" || mime === expectedMime));
}

function fallbackMime(file) {
  const extension = file.name.toLowerCase().split(".").pop();
  const expected = ({
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    txt: "text/plain", log: "text/plain", csv: "text/csv", md: "text/markdown", markdown: "text/markdown",
  })[extension] ?? "application/octet-stream";
  return file.type && file.type !== "application/octet-stream" ? file.type : expected;
}

function setUploadFeedback(node, message, tone = "") {
  node.textContent = message;
  node.className = `upload-feedback${tone ? ` upload-feedback-${tone}` : ""}`;
  node.hidden = !message;
}

function openVersionAttachmentDialog(ctx, version) {
  let totalBytes = ctx.state.assets.reduce((sum, asset) => sum + bytesForAsset(asset), 0);
  let submitting = false;
  const filePicker = input("file", "", "file", {
    accept: ".pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.log,.csv,.md,.markdown",
    required: true,
  });
  const feedback = h("p", { className: "upload-feedback", role: "status", ariaLive: "polite", hidden: true });
  const limitNote = h("p", { className: "file-size" },
    `Maximum per document: ${formatBytes(DOCUMENT_MAX_BYTES)}. All stored attachment payloads together: ${formatBytes(totalBytes)} of ${formatBytes(ASSET_TOTAL_MAX_BYTES)}.`);
  const submitButton = h("button", { type: "submit", className: "button button-primary" }, "Upload attachment");
  const form = h("form", { className: "stack version-attachment-form" },
    field("Choose one document", filePicker),
    limitNote,
    feedback,
    h("div", { className: "form-actions" }, submitButton),
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting) return;
    const file = filePicker.files?.[0];
    if (!file) { setUploadFeedback(feedback, "Choose a document to upload.", "error"); return; }
    if (!safeLibraryType(file)) {
      setUploadFeedback(feedback, "This file type is not supported. Use a PDF, PNG, JPEG, WebP, GIF, TXT, LOG, CSV, or MD file. HTML and SVG are not accepted.", "error");
      return;
    }
    if (file.size === 0) { setUploadFeedback(feedback, "Choose a non-empty document.", "error"); return; }
    if (file.size > DOCUMENT_MAX_BYTES) {
      setUploadFeedback(feedback, `This document is ${formatBytes(file.size)}; the limit is ${formatBytes(DOCUMENT_MAX_BYTES)}.`, "error");
      return;
    }
    if (totalBytes + file.size > ASSET_TOTAL_MAX_BYTES) {
      setUploadFeedback(feedback, `This upload would exceed the ${formatBytes(ASSET_TOTAL_MAX_BYTES)} total attachment limit.`, "error");
      return;
    }

    submitting = true;
    submitButton.disabled = true;
    filePicker.disabled = true;
    submitButton.textContent = "Uploading…";
    setUploadFeedback(feedback, "Uploading document…");
    try {
      const mimeType = fallbackMime(file);
      const dataUrl = await readFileAsDataURL(new Blob([file], { type: mimeType }));
      const result = await ctx.run("addDocument", { name: file.name, mimeType, dataUrl, versionId: version.id });
      if (!result.ok) {
        setUploadFeedback(feedback, result.error instanceof Error ? result.error.message : "The document could not be uploaded.", "error");
        return;
      }
      closeDialog(true);
      notify(`Uploaded ${file.name} to ${version.label || "this version"}.`);
    } catch (error) {
      setUploadFeedback(feedback, error instanceof Error ? error.message : "The document could not be read.", "error");
    } finally {
      submitting = false;
      submitButton.disabled = false;
      filePicker.disabled = false;
      submitButton.textContent = "Upload attachment";
    }
  });

  showDialog("Upload a version attachment", form);
}

function attachmentBytesFromDataUrl(dataUrl) {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("The stored attachment data is invalid.");
  const metadata = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  if (/;base64/i.test(metadata)) {
    const binary = atob(payload);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  return new TextEncoder().encode(decodeURIComponent(payload));
}

function attachmentBlobFromDataUrl(asset) {
  return new Blob([attachmentBytesFromDataUrl(asset.dataUrl)], { type: asset.mimeType || "application/octet-stream" });
}

async function openVersionAttachmentViewer(ctx, version, asset) {
  let previewUrl = null;
  try {
    const fullAsset = await loadAssetContent(asset, ctx.service);
    const mimeType = String(fullAsset.mimeType || "").toLocaleLowerCase();
    let preview;
    if (mimeType === "application/pdf") {
      previewUrl = URL.createObjectURL(attachmentBlobFromDataUrl(fullAsset));
      preview = h("iframe", { className: "version-attachment-preview-pdf", src: previewUrl, title: fullAsset.name });
    } else if (mimeType.startsWith("image/")) {
      preview = h("img", { className: "version-attachment-preview-image", src: fullAsset.dataUrl, alt: fullAsset.name });
    } else if (mimeType.startsWith("text/")) {
      preview = h("pre", { className: "version-attachment-preview-text" },
        new TextDecoder().decode(attachmentBytesFromDataUrl(fullAsset.dataUrl)));
    } else {
      preview = h("p", { className: "source-note" }, "Preview is unavailable for this file type. Download the file to open it.");
    }

    const feedback = h("p", { className: "upload-feedback", role: "status", ariaLive: "polite", hidden: true });
    const confirmation = h("div", { className: "version-attachment-delete-confirm", hidden: true });
    const deleteButton = button("Delete attachment", () => {
      confirmation.hidden = false;
      const cancelButton = button("Keep attachment", () => {
        confirmation.replaceChildren();
        confirmation.hidden = true;
        feedback.hidden = true;
        feedback.textContent = "";
      }, "button-secondary");
      const confirmButton = button("Delete file", async () => {
        deleteButton.disabled = true;
        confirmButton.disabled = true;
        cancelButton.disabled = true;
        feedback.hidden = false;
        setUploadFeedback(feedback, "Removing attachment…");
        try {
          const result = await ctx.run("removeVersionAttachment", { versionId: version.id, assetId: asset.id });
          if (!result.ok) {
            setUploadFeedback(feedback, result.error instanceof Error ? result.error.message : "The attachment could not be removed.", "error");
            return;
          }
          closeDialog(true);
          notify(`Removed ${asset.name} from ${version.label}.`);
        } catch (error) {
          setUploadFeedback(feedback, error instanceof Error ? error.message : "The attachment could not be removed.", "error");
        } finally {
          deleteButton.disabled = false;
          confirmButton.disabled = false;
          cancelButton.disabled = false;
        }
      }, "button-danger");
      confirmation.replaceChildren(
        h("p", {}, `Delete “${asset.name}” from this version?`),
        h("div", { className: "version-attachment-dialog-actions" }, confirmButton, cancelButton),
      );
    }, "button-danger");
    const downloadButton = button("Download", async () => {
      try { await downloadAttachment(fullAsset, ctx.service); }
      catch (error) { notify(error instanceof Error ? error.message : "The file could not be downloaded.", true); }
    }, "button-secondary");
    const actions = h("div", { className: "version-attachment-dialog-actions" },
      downloadButton,
      deleteButton,
    );
    const dialog = showDialog("Version attachment", h("div", { className: "version-attachment-viewer" },
      h("h3", { className: "version-attachment-viewer-title" }, asset.name),
      preview,
      confirmation,
      feedback,
      actions,
    ));
    if (previewUrl) dialog.addEventListener("close", () => URL.revokeObjectURL(previewUrl), { once: true });
  } catch (error) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    notify(error instanceof Error ? error.message : "The attachment preview could not be opened.", true);
  }
}

function renderVersionAttachmentControl(ctx, version) {
  const attachments = ctx.state.assets
    .filter((asset) => asset.kind === "document" && asset.versionId === version.id)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  const control = h("div", { className: "version-attachment-controls" });
  if (!attachments.length) {
    control.append(button("Upload attachment", () => openVersionAttachmentDialog(ctx, version), "button-secondary version-attachment-upload"));
    return control;
  }
  control.append(...attachments.map((asset) => {
    const link = button(asset.name, () => openVersionAttachmentViewer(ctx, version, asset), "button-quiet version-attachment-link");
    link.title = asset.name;
    link.setAttribute("aria-label", `Open ${asset.name}`);
    return link;
  }));
  return control;
}

function renderLibrary(root, ctx) {
  const totalBytes = ctx.state.assets.reduce((sum, asset) => sum + bytesForAsset(asset), 0);
  pageHeading(root, "File library");
  const versionOptions = [{ value: "", label: "No version link" }, ...ctx.state.versions.map((version) => ({
    value: version.id,
    label: `${familyName(ctx, version.familyId)} · ${version.label || "Version label not recorded"} (${version.status === "recorded" ? "Archived" : version.status})`,
  }))];
  const form = h("form", { className: "backup-panel" },
    h("div", { className: "file-choice" },
      field("Choose a source file", input("file", "", "file", { accept: ".pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.log,.csv,.md,.markdown", required: true })),
      h("p", { className: "file-size" }, `Per-file limit: ${formatBytes(DOCUMENT_MAX_BYTES)} · stored: ${formatBytes(totalBytes)} / ${formatBytes(ASSET_TOTAL_MAX_BYTES)}.`),
    ),
    field("Link to design version", select("versionId", versionOptions, "")),
    h("div", { className: "form-actions" }, h("button", { type: "submit", className: "button button-primary" }, "Save file to library")),
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = form.elements.namedItem("file")?.files?.[0];
    if (!file) { notify("Choose a file to upload.", true); return; }
    if (!safeLibraryType(file)) { notify("This file type is not supported. Use a PDF, PNG, JPEG, WebP, GIF, or plain-text file (TXT, LOG, CSV, MD). HTML and SVG are not accepted.", true); return; }
    if (file.size > DOCUMENT_MAX_BYTES) { notify(`This file is ${formatBytes(file.size)}; the limit is ${formatBytes(DOCUMENT_MAX_BYTES)}.`, true); return; }
    if (totalBytes + file.size > ASSET_TOTAL_MAX_BYTES) { notify(`The library would exceed its ${formatBytes(ASSET_TOTAL_MAX_BYTES)} total attachment limit.`, true); return; }
    try {
      const values = new FormData(form);
      const mimeType = fallbackMime(file);
      const dataUrl = await readFileAsDataURL(new Blob([file], { type: mimeType }));
      const result = await ctx.run("addDocument", {
        name: file.name, mimeType, dataUrl, versionId: values.get("versionId") || null,
      });
      if (result.ok) form.dataset.dirty = "false";
    } catch (error) {
      notify(error instanceof Error ? error.message : "The file could not be read.", true);
    }
  });
  const assets = [...ctx.state.assets].filter((asset) => asset.kind === "document").sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const files = assets.length ? h("div", { className: "asset-list" }, assets.map((asset) => {
    const version = ctx.state.versions.find((candidate) => candidate.id === asset.versionId);
    const size = bytesForAsset(asset);
    return h("article", { className: "asset-card" },
      h("div", { className: "asset-meta" }, h("strong", {}, asset.name),
        h("span", {}, `${asset.mimeType} · ${formatBytes(size)} · added ${new Date(asset.createdAt).toLocaleString()}`),
        h("p", {}, version ? `Linked to ${familyName(ctx, version.familyId)} · ${version.label || "Version label not recorded"}${version.status === "recorded" ? " · Archived" : ""}` : "No design version link")),
      button("Download", async () => {
        try { await downloadAttachment(asset, ctx.service); }
        catch (error) { notify(error instanceof Error ? error.message : "The file could not be downloaded.", true); }
      }, "button-secondary"),
    );
  })) : emptyState("No files yet", "");
  root.append(h("div", { className: "admin-grid" },
    h("section", { className: "admin-card card" }, h("div", { className: "section-heading" }, h("h3", {}, "Add a file")), form),
    h("section", { className: "admin-card admin-card-wide card" }, h("div", { className: "section-heading" }, h("h3", {}, "Library files")), files),
  ));
}

function renderBackup(root, ctx) {
  pageHeading(root, "Backup and restore");
  const exportButton = button("Download full backup", async () => {
    try {
      const backup = await ctx.service.exportBackup();
      const serialized = JSON.stringify(backup, null, 2);
      const size = new TextEncoder().encode(serialized).byteLength;
      if (size > BACKUP_MAX_BYTES) { notify(`This backup is ${formatBytes(size)}; the maximum is ${formatBytes(BACKUP_MAX_BYTES)}.`, true); return; }
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
      await downloadFile(`MasterQC-backup-${stamp}.json`, serialized, "application/json");
      notify(`Backup downloaded (${formatBytes(size)}, including attachments).`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "The backup could not be exported.", true);
    }
  }, "button-primary");
  const form = h("form", { className: "backup-panel" },
    h("div", { className: "file-choice" },
      field("Backup JSON file", input("backup", "", "file", { accept: ".json,application/json", required: true })),
      h("p", { className: "file-size" }, `Maximum backup size: ${formatBytes(BACKUP_MAX_BYTES)}.`),
    ),
    h("div", { className: "form-actions" }, h("button", { type: "submit", className: "button button-secondary" }, "Validate and restore backup")),
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = form.elements.namedItem("backup")?.files?.[0];
    if (!file) { notify("Choose a backup JSON file.", true); return; }
    if (file.size > BACKUP_MAX_BYTES) { notify(`This file is ${formatBytes(file.size)}; the maximum is ${formatBytes(BACKUP_MAX_BYTES)}.`, true); return; }
    let backup;
    try {
      backup = JSON.parse(await file.text());
    } catch {
      notify("This file is not valid JSON. Choose an exported MasterQC backup.", true);
      return;
    }
    try {
      const result = await ctx.service.importBackup(backup, ctx.state.revision);
      form.dataset.dirty = "false";
      ctx.announceChange?.(result.revision);
      const counts = result.counts ?? {};
      const added = Object.values(counts.added ?? {}).reduce((sum, count) => sum + count, 0);
      const skipped = Object.values(counts.skipped ?? {}).reduce((sum, count) => sum + count, 0);
      const adopted = counts.adoptedSeedVariants ?? 0;
      notify(`Restore complete: ${added} records added; ${skipped} identical records skipped; ${adopted} initial catalog preferences adopted.`);
      ctx.refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "The backup could not be restored.", true);
    }
  });
  const assetBytes = ctx.state.assets.reduce((sum, asset) => sum + bytesForAsset(asset), 0);
  const metrics = h("div", { className: "progress-grid" },
    h("div", { className: "progress-stat" }, h("span", {}, "Design versions"), h("strong", {}, String(ctx.state.versions.length))),
    h("div", { className: "progress-stat" }, h("span", {}, "Purchase orders"), h("strong", {}, String(ctx.state.orders.length))),
    h("div", { className: "progress-stat" }, h("span", {}, "Batches"), h("strong", {}, String(ctx.state.batches.length))),
    h("div", { className: "progress-stat" }, h("span", {}, "Attachment payload"), h("strong", {}, `${formatBytes(assetBytes)} / ${formatBytes(ASSET_TOTAL_MAX_BYTES)}`)),
  );
  root.append(h("div", { className: "admin-grid backup-grid" },
    h("section", { className: "admin-card card" }, h("div", { className: "section-heading" }, h("h3", {}, "Export")), exportButton),
    h("section", { className: "admin-card card" }, h("div", { className: "section-heading" }, h("h3", {}, "Restore")), form),
    h("div", { className: "admin-card admin-card-wide card backup-metrics" },
      metrics,
    ),
  ));
}

export function renderAdminPage(root, route, ctx) {
  root.replaceChildren();
  if (route === "catalog") return renderCatalog(root, ctx);
  if (route === "standards") return renderStandards(root, ctx);
  if (route === "orders") return renderOrders(root, ctx);
  if (route === "library") return renderLibrary(root, ctx);
  if (route === "settings" || route === "backup") return renderBackup(root, ctx);
  root.append(emptyState("Unknown setup page", "Choose a page from the left navigation."));
}
