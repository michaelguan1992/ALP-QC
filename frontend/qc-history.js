import { button, el, notify } from "./qc-ui.js";

const HISTORY_PACKAGE_MAX_BYTES = 50 * 1024 * 1024;

/** Keep the historical import available from the unified Batches workspace. */
export function historicalBatchImportControl(ctx) {
  const fileInput = el("input", {
    type: "file",
    accept: ".json,application/json",
    hidden: true,
    "aria-label": "Choose historical batch package",
  });
  const choose = button("Import historical batches", () => fileInput.click(), "button-secondary");
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (file.size > HISTORY_PACKAGE_MAX_BYTES) {
      notify("Historical batch package exceeds the 50 MiB import limit.", true);
      fileInput.value = "";
      return;
    }
    try {
      const historyPackage = JSON.parse(await file.text());
      const result = await ctx.importHistory(historyPackage);
      if (!result.ok) return;
      const added = Object.values(result.result.counts?.added ?? {}).reduce((sum, count) => sum + count, 0);
      const skipped = Object.values(result.result.counts?.skipped ?? {}).reduce((sum, count) => sum + count, 0);
      notify(`Historical batch import complete: ${added} records added, ${skipped} identical records skipped.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "The historical batch package could not be imported.", true);
    } finally {
      fileInput.value = "";
    }
  });
  return el("span", { className: "qc-ops-import-control" }, choose, fileInput);
}
