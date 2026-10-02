# Manual Save and Performance Acceptance

Date: 2026-10-01 (America/Los_Angeles). Implementation: Luna Max delegates for frontend, core/API, and storage; primary integration, review, and acceptance.

## Runtime and measurement source

The original port-4173 process ran from `/Users/michael/.codex/worktrees/5521/MasterQC-Web`, but its open production database was `/Users/michael/.codex/worktrees/f343/MasterQC-Web/data/workspace/masterqc-main.sqlite`. The checkout database was not the measurement source. A consistent read-only SQLite snapshot of the actual open database supplied every performance and browser test. No test records were written to production.

The source revision was 15, with 90 batches, one Issue, one purchase order, 26 audit events, and 33 attachments. Serialized state was 35,366,538 bytes; attachment Data URLs occupied 31,553,078 bytes (89.22%). Baseline core and storage code matched the original running implementation. Tests used macOS, Node 26.3.1, headless Chromium driven through the actual frontend with Playwright, loopback HTTP, and independent temporary databases. Windows was not run.

Evidence scripts, raw JSON timings, logs, snapshots, and screenshots are under `/private/tmp/masterqc-save-acceptance/`. This temporary evidence directory is not a production storage location or a committed database snapshot.

## Implemented behavior

- Batch detail has one **Save changes** action for modified inspection rows and editable batch details. `saveBatchChanges` validates and commits the complete change set in one transaction and advances revision once.
- Issue detail explicitly saves owner, disposition, and three confirmation names together. Input, change, blur, and pauses do not submit those fields.
- Drafts show Unsaved changes, Saving…, Saved, or failure. Saved follows server acknowledgment. Failure and version conflicts retain drafts. An earlier response cannot overwrite newer typing or discard edits made while saving.
- In-app navigation, dialog closing, batch release, and Issue closure offer Save, Discard, and Cancel when these fields are dirty. Choosing Save rechecks for newer pending edits before leaving. Browser reload/tab close uses the browser's native unsaved-change warning; browsers cannot present the application's three-button dialog during unload. Save before confirming browser exit.
- Discussion, attachment upload, replacement, and deletion remain explicit independent actions. Existing commands, full reads, and full JSON backups remain compatible.
- Save responses return the saved records, new audit events, and latest revision. The frontend applies these projections without a full-state fetch. Purchase-order progress is derived locally instead of querying each order after a save.
- SQLite `qc_state` contains business records and stable attachment references; `qc_asset_payloads` contains content. Ordinary saves never reassemble all Data URLs. New or restored content is fully validated. Stored content validation is trusted only against verified metadata and the current payload generation; SQL triggers invalidate trust for writes from other connections. Every business association, ownership rule, type, and size limit remains checked.
- Legacy conversion creates a verified `.pre-attachment-payload-migration.sqlite` recovery copy, then converts atomically without changing business revision or attachment bytes. DELETE journaling and FULL synchronization remain enabled.

## Local command measurements

Three independent source-sized temporary databases per operation. The timed path includes command execution and response JSON encoding/decoding. Baseline additionally calls full `getState`, matching the old frontend path; the optimized path returns the compact acknowledged projection. Initialization/migration is outside the timed save. These are local Node timings, not browser timings.

| Operation | Before median | After median | Commands / write transactions before → after |
| --- | ---: | ---: | --- |
| Inspection result | 2,485 ms | 300 ms | 1 / 1 → 1 / 1 |
| Issue disposition | 2,213 ms | 307 ms | 1 / 1 → 1 / 1 |
| Batch details | 2,180 ms | 328 ms | 1 / 1 → 1 / 1 |
| Create purchase order | 2,314 ms | 295 ms | 1 / 1 → 1 / 1 |
| Four inspection rows plus batch details | 10,957 ms | 306 ms | 5 / 5 → 1 / 1 |

Single-operation response size fell from about 35.37 MB to 0.60–6.42 KB. Four rows plus details previously produced about 176.84 MB across five full reads; the combined response is 6.48 KB. Business JSON after migration is about 3.81 MB, with all 33 payload rows retained. Single-operation command paths improved by approximately 85–88%; the combined operation improved by approximately 97%.

## Browser measurements

Three observations per single-operation class. Browser timers surround the automated click/blur call and end when the rendered status is observed; they include browser interaction overhead. Before: blur-triggered submission through visible Saved. After: clicking Save changes through visible Saved. The old 425 ms input debounce is excluded; removing it is not counted as database improvement. New-order timing instead ends when the dialog closes and the saved order appears, because that flow has no Saved label. Application request counts exclude independent revision polling and unrelated visible attachment fetches.

| Operation | Before UI median | After UI median | Application requests before → after | Write transactions before → after |
| --- | ---: | ---: | ---: | ---: |
| Inspection result | 2,978 ms | 353 ms | 2 → 1 | 1 → 1 |
| Issue disposition | 2,823 ms | 344 ms | 2 → 1 | 1 → 1 |
| Batch details | 2,777 ms | 358 ms | 2 → 1 | 1 → 1 |
| Create purchase order | 5,294 ms | 388 ms | 4 / 5 / 6 → 1 | 1 → 1 |
| Four rows plus batch details | Not measured | 387 ms (one observation) | Not measured → 1 | Not measured → 1 |

The original PO observations included the command, full state, and one progress request per visible order (two, three, then four). An initial optimized PO run under concurrent acceptance activity measured 1,530 / 416 / 388 ms. A separate final run measured 389 / 388 / 370 ms, used in the table. All optimized field-save observations sent one POST, with no subsequent full-state or progress request. Transaction counts were checked by adapter instrumentation and revision progression.

## Acceptance results

`npm test`: **175 passed, 0 failed**. JavaScript syntax checks and `git diff --check` passed. Browser acceptance completed 21 behavioral checks with no page errors:

- Multiple result/time rows and batch fields: input, blur, change, and an 850 ms pause produced zero saves; one click saved every edit; refresh preserved the result.
- Clearing numeric and Issue fields persisted correctly. Blank numeric values remained null, partial companion values survived, and incomplete rows had no completion timestamp. Invalid numeric input stayed editable and produced no command request.
- Injected HTTP failure retained the draft; explicit retry saved successfully. Held responses followed by newer typing preserved the new input for another explicit save, for both batches and Issues.
- Navigation and Issue dialog Save/Discard/Cancel worked; Discard sent no save. Save completed before leaving. Release and Issue closure supported Cancel, and choosing Save then the consequential action used two explicit transactions.
- Two independent Chromium clients rejected a stale save without overwriting the other client's saved data, while retaining the stale client's draft.
- Discussion submission did not save dirty formal disposition fields. Issue evidence thumbnails loaded on demand. An original PDF previewed through a Blob URL, and its downloaded bytes matched the source.
- Native browser reload warned for unsaved batch fields.

Actual-source conversion preserved complete full-state deep equality, including every record, ID, revision, audit event, historical source, and Data URL. All 33 individual attachments matched. Reopening SQLite preserved the result. Both an old-code JSON backup and a new complete JSON backup restored into separate empty databases with equal business collections and attachments. Independent adapters rejected stale revisions. Storage tests additionally cover invalid legacy graphs/history checksums, failed migration recovery, content corruption, payload-generation changes, replacement, deletion, cache isolation, and atomic rollback.

## Active service verification

The normal port-4173 service now runs the reviewed implementation from `/Users/michael/Documents/Projects/MasterQC-Web`, with `MASTERQC_DATA_DIR` explicitly retaining the original `/Users/michael/.codex/worktrees/f343/MasterQC-Web/data/workspace` directory. Both workspaces were captured before the switch. Production migration preserved full-state equality at revision 15; the previously empty demo remained empty. SQLite integrity returned `ok`. The adjacent production recovery file is `masterqc-main.sqlite.pre-attachment-payload-migration.sqlite`.

A separate read-only live-browser check confirmed one Save changes button in batch detail and one in Issue detail, no page errors, zero business commands, and complete unchanged state after viewing both routes. The already-modified production snapshot in this checkout was not touched; its Git object hash remained `38cd9ce46b01518eaf27b30bda7e9795c4ab5df1`. No database file was staged, committed, or pushed. The current running service retains its explicit directory override; a future ordinary launch without that override follows the documented project-contained default.

## Remaining costs and scope

Business records remain one approximately 3.81 MB aggregate. A five-save profile measured median transaction time of 299 ms, including a median 158 ms in the business mutator. CPU samples still showed aggregate cloning, graph/business validation, JSON serialization, and SQLite work. Entity-level business persistence would address that remaining cost; this change removes attachment work from ordinary saves. Full exports, imports, first-time migration, and initial verification still process every payload intentionally.

These measurements describe this Mac and dataset. They do not verify Windows, remote hosting, or higher data volumes. Browser unload cannot offer a custom Save/Discard/Cancel dialog. No production database snapshot was committed or pushed, and the original PDF/reference directory and live Lark system were not modified.
