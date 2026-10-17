// The notice shown on a batch or Issue page when unsent edits were restored, or when some of them could not
// be restored because another person changed the same field. It lists those fields with the value the user
// had typed, so they can be entered again, and offers to discard the restored edits.

import { describeDraftValue } from "./qc-draft-model.js";
import { timestampLabel } from "./qc-ops-common.js";
import { button, el } from "./qc-ui.js";

/**
 * `notice` is `{ savedAt, applied, conflicts }`: how many fields were restored, the time of the edits,
 * and the fields that were not restored. `onAction` runs for the button, which discards the restored
 * edits when any were restored and dismisses the notice otherwise.
 */
export function renderDraftNotice(notice, { onAction = () => {} } = {}) {
  const restored = notice.applied > 0;
  const conflicts = Array.isArray(notice.conflicts) ? notice.conflicts : [];
  return el("section", { className: "qc-draft-notice", role: "status" },
    restored ? el("p", { className: "qc-draft-notice-restored" }, `Restored unsaved edits from ${timestampLabel(notice.savedAt)}.`) : null,
    conflicts.length
      ? el("ul", { className: "qc-draft-notice-conflicts" }, ...conflicts.map((conflict) => el("li", {},
        `Not restored because someone else changed it: ${conflict.label} (your value: ${describeDraftValue(conflict.value)})`)))
      : null,
    el("div", { className: "button-row" },
      button(restored ? "Discard restored edits" : "Dismiss", onAction, "button-secondary qc-draft-notice-action"),
    ),
  );
}
