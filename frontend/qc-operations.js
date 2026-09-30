import { renderBatchesPage } from "./qc-ops-batches.js";
import { renderIssuesPage } from "./qc-ops-issues.js";
import { renderReportsPage } from "./qc-ops-reports.js";
import { clearBatchDrafts } from "./qc-ops-batches.js";
import { clearIssueDrafts } from "./qc-ops-issues.js";

export async function renderOperationsPage(root, route, ctx) {
  root.classList.add("qc-ops-root");
  if (route === "batches") return renderBatchesPage(root, ctx);
  if (route === "issues") return renderIssuesPage(root, ctx);
  if (route === "reports") return renderReportsPage(root, ctx);
  root.replaceChildren();
  root.append(document.createTextNode("Unknown operations page."));
}

export function clearOperationsDrafts() {
  clearBatchDrafts();
  clearIssueDrafts();
}
