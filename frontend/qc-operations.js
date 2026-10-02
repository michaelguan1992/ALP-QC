import { renderBatchesPage } from "./qc-ops-batches.js";
import { renderIssuesPage } from "./qc-ops-issues.js";
import { renderBatchReportPage } from "./qc-ops-reports.js";

export async function renderOperationsPage(root, route, ctx) {
  root.classList.add("qc-ops-root");
  if (route === "batches") return renderBatchesPage(root, ctx);
  if (route === "batch-report") return renderBatchReportPage(root, ctx);
  if (route === "issues") return renderIssuesPage(root, ctx);
  root.replaceChildren();
  root.append(document.createTextNode("Unknown operations page."));
}
