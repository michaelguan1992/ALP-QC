# Local App Acceptance

## Original PDF ingestion verification (2026-09-29)

- Source inventory: 30 original PDFs across S1 and S15, 147 total pages, 22,394,625 original bytes, and 30 distinct SHA-256 identities. Source baseline: `tmp/pdf-import/source-baseline.json`.
- Before importing, the user's Chrome workspace at the fixed origin showed revision 0 with no orders, batches, standards, or attachments. Its pre-import backup was downloaded as `MasterQC-backup-20260929T190813Z.json`.
- The history extension passed all 29 existing and added automated checks. Added coverage includes source fidelity, null versus zero, unusual historical AP IQC quantities, idempotence, atomic conflict rejection, original-file checksum verification, draft sequence conflicts, absent-check evidence, duplicate source IDs, and backward-compatible backup restore.
- The additional builder acceptance test passed, bringing the suite to 30 passing checks. It covers title-based task identity, preservation of original numbering, null supplemental results, and factory/stage isolation.
- Final package: `data/pdf-import/masterqc-history.json`, 32,981,801 bytes. It contains 30 original PDF assets, 89 inspection-page records, 482 unchanged original rows, 9 supplementary null-result rows, and two unpublished reference drafts (16 S11-S14 items and 17 S15 items). All nine supplements are the pressure-gauge/three-way direction check on earlier S15 UI OQC forms; AP forms receive none.
- The package was actually imported through the user's Chrome file chooser into the real workspace at `http://127.0.0.1:4173`, advancing revision 0 to 1. A browser reload retained 30 PDF sources, 89 records, and 491 displayed rows. Family/factory/stage filtering and search correctly reduced the list to one earlier S15 UI OQC record; its fifth row displayed the missing-source evidence and empty results.
- The Standards page displayed both source-labelled drafts, with no published versions. The backup page showed zero orders and zero operational batches; historical import contributed no fulfillment quantities.
- The downloaded post-import backup `MasterQC-backup-20260929T194025Z.json` contained exactly the reviewed source records, historical rows, draft versions, and PDF asset bytes. Its size was 33,275,228 bytes. Downloading the earliest S15 original PDF also produced bytes matching its source SHA-256.
- Final source-directory comparison found no changes to any of the 30 original PDF files. All changes were confined to the Web project and the explicitly requested local browser import.
- A full memory-adapter cycle using the final package verified successful import, unchanged repeat import, and backup export/restore retaining the same records and assets. Windows browser/runtime behavior remains untested.

Status: first local edition acceptance completed, 2026-09-28, within the explicit limits below. This checklist records actual verification separately from intended behavior.

## Required workflow

1. Open the real workspace and confirm that existing initialization settings survive the schema upgrade. No demonstration orders or results appear automatically.
2. Use the isolated demo workspace for operational checks. Install AP source-reference drafts, review model applicability, publish a family version, and create a multi-variant purchase order.
3. Create a 423-unit S15 batch, confirm 43/43/43/423 sample quantities, and confirm that manual inspection-quantity edits are unavailable. Check historical version selection and rejection when no applicable items exist.
4. Save results and row-specific photographs, refresh, and verify persisted values and attachment ownership. Ensure unsaved edits on other rows are preserved or explicitly handled.
5. Create a linked issue, test release blocking, save disposition and three names, add separate discussion, manually close the issue, and then explicitly release the batch. Confirm zero PO contribution before release and exactly one full-batch contribution afterward.
6. Verify independent normal/Yellow order lines, shortage and excess amounts, and final-shipment lot de-duplication. Confirm released records remain read-only.
7. Clone a published version, edit and publish the next sequence, and verify an existing batch retains its original snapshot.
8. Upload and retrieve a library document, open a printable batch report, and export inspection CSV.
9. Export a complete backup, verify its attachments, restore the same backup idempotently, and verify malformed/conflicting imports fail atomically. Core tests also restore into a fresh adapter.
10. Run the relevant automated suite and record actual results. Windows remains untested unless run on Windows.

## Verification record

- Storage memory-adapter checks passed: isolated reads/results, serialized writes, and rollback after rejected or asynchronous mutations (3 tests).
- The existing initialization page loaded the user's saved Chinese draft before the upgrade. After loading the version-2 adapter through the retained initialization page, an exact browser-UI text comparison confirmed that the draft was unchanged. No edit was made to it.
- A public-service smoke check against the memory adapter passed: import AP reference drafts, publish S15, create a PO and a 423-unit batch, calculate 43/43/43/423 samples, save all rows, block release while a linked issue is open, save three confirmation names, manually close, release, export, and restore into a fresh adapter. Restored PO progress was 423 released and 77 remaining against 500 ordered. This was not a browser persistence test.
- Final `npm test`: **21 tests passed, 0 failed**. This includes 12 public-service business tests, 3 memory-adapter tests, 2 original draft tests, and 4 static-server tests. All application JavaScript modules passed syntax checks.
- Mac in-app-browser acceptance used the isolated `masterqc-web-demo` database. The default real workspace remained at revision 0 with no orders or batches.
- Created `DEMO-PO-001` with S15 (500) and S15 Yellow (200). Adding its second line preserved the entered PO number, supplier, notes, first variant, and quantity.
- Created `DEMO-S15-001` for 423 units. All calculated inputs were read-only and displayed 43/43/43/423. Saved batch metadata, all four results, and a photo on the first row. Reloading restored all results and exactly one first-row image. Other rows had no photographs.
- Creating an issue with unsaved row edits was blocked with a save instruction. After saving, the issue displayed the saved remarks, quantities, version/date, and the one source photo. Partial disposition saved successfully; discussion remained separate. The open issue disabled batch release. Three manually entered demonstration names and a disposition were saved, then closure was explicit.
- Before release, both PO lines showed zero released. After explicit release, S15 showed 423 released and 77 remaining; Yellow stayed at zero released and 200 remaining. Released inputs and release action were disabled.
- The read-only report displayed saved row evidence. The downloaded CSV had one header plus four data rows and 30 columns on every row. The browser download-event observer timed out even though the file was saved; the downloaded file itself was inspected successfully.
- Uploaded `user-guide.md` to the library and downloaded it. The downloaded bytes matched the source. The complete JSON backup contained both photo and document data URLs. Browser restore of the identical backup added zero records, skipped 37 identical records, and retained revision 18. Fresh-adapter restore and invalid/conflicting backup rollback were checked by the automated suite.
- Cloned S15 to sequence 2, changed the first sampling percentage from 10% to 20%, and published it. The original batch still showed 43 for that row. A second draft, `DEMO-S15-002` (77 units), selected sequence 2 by default, displayed 16 for the first sample quantity, showed the previous saved batch's rate as history, and had no inherited photos. It remains editable for user review.
- Demonstration records and manually entered names are test data only. The reference source import was used only in the demo workspace during acceptance.

## Review limits

Manual confirmation names are not authenticated signatures. Local browser data is not shared between devices. No live Lark changes are performed. Historical import and batch-history integration are recorded separately below. Release correction, partial release, and mixed allocations require later business design; they are not implied by the full-app request.

## Explicitly untested

- Windows launcher execution and Windows browser behavior.
- Native printing and the operating system's save-as-PDF dialog; the read-only report and print styles were reviewed, but no physical print or exported PDF was verified.
- Multi-user operation, server persistence, and cross-device synchronization are outside this edition.

## Unified batch history (2026-09-29)

- Saved the real Chrome workspace before migration as `MasterQC-backup-20260929T195613Z.json`: revision 1, 89 historical inspection sheets, 491 rows, 30 original PDF assets, zero operational batches, and zero orders.
- Independently verified the core migration against that actual backup in a memory adapter: revision 1 becomes 2 with 89 canonical historical batches and 491 rows. Original `history` and `assets` compare exactly equal to the pre-migration snapshot. Reinitialization leaves the complete migrated state unchanged.
- Opened all 89 workspaces through the public service and confirmed each resolves its original PDF attachment and preserves its source row count. Exported the migrated backup, restored it into a fresh adapter, then restored the legacy backup; canonical batch records remained identical.
- Final automated suite: 35 tests passed. Added coverage verifies canonical batch migration, repeat initialization, legacy/current backups, protected original PDF links, supplementary attachments, source-validation failures, released-batch attachment immutability, and the narrowly scoped local-blob frame policy.
- Real Chrome acceptance: reloading the existing workspace migrated revision 1 to 2 and showed 89 batches. The separate PDF history navigation was removed. Family/factory/stage/search filtering selected the early S15 UI OQC batch; its detail retained 768 inspected, 14 defective, and the printed 1.82% rate, plus the fifth missing-check row with blank results. Another reload retained the same revision and facts.
- Historical batches appeared in Reports. The selected report and downloaded CSV retained the same first-row values; CSV contained five rows and 30 columns, with empty inspected/defect/rate fields on the supplemental fifth row.
- Downloading the PDF from the batch attachment section produced SHA-256 `4e9b697b497b4688ae3c92d76c3fc4c65521987735835691da2f3e996e2b9841`, matching the original source identity.
- Downloaded the post-migration backup `MasterQC-backup-20260929T201400Z.json` (35,591,258 bytes). It contains 89 batches, 491 rows, exactly one additional migration audit event, and source evidence/PDF asset objects identical to the pre-migration backup. Orders remain empty. Windows remains untested.
- Attachment preview initially exposed two browser restrictions: fetching a data URL was blocked by the connection policy, and a blob iframe was blocked by the inherited frame policy. The frontend now decodes attachment bytes directly, and the server permits only same-origin/local-blob frames without widening script or connection sources. Restarted the confirmed Mac server on the same fixed port; screenshot verification showed the original five-page PDF rendering inside the batch attachment dialog. The five relevant server checks passed independently after the change.
- The legacy `#/history` URL redirected to `#/batches`, with 89 data rows and unchanged revision 2. Saved `docs/batch-history-preview.png` and left the user's Chrome tab on the unified Batches list.

## Readable batch names (2026-09-29)

- Automated suite: 39 tests passed, including display-name fallback, color handling, collision stability, operational-name preservation, and query-only workspace projection. Changed JavaScript modules passed syntax checks.
- Names are resolved for display only. Existing batch IDs, persisted archive numbers, source records, attachment links, and backup data are unchanged.
- Real Chrome acceptance after reload showed 89 unique names without the `HIST` prefix, digest, or page suffix. No current imported records require a collision suffix. The workspace remained at revision 2.
- Searching `S15-20260521-UI-OQC` selected the same record in Batches and Reports. Batch detail, report heading, and report metadata used that name. Source details still showed page 2 of 5 and the original PDF attachment.
- Downloaded `S15-20260521-UI-OQC-report.csv`: all five data rows used the concise name, all six CSV rows had 30 columns, first-row values remained 768 / 14 / 1.82, and the supplemental final row retained empty inspected/defective/rate cells.
- Saved `docs/batch-names-preview.png` and left Chrome on the Batches list. Windows was not run.

## Lark version history import (2026-09-29)

- The bundled package was independently reconciled against all 28 revision, 15 product, and 211 spec source rows. It contains 23 family entries (11 S11–S14 and 12 S15) with 120 linked raw spec rows. The two original family reference drafts were not replaced.
- The actual local Chrome workspace was backed up at revision 3 before import. The explicit Standards-page action added all 23 entries and advanced the workspace to revision 4. A second import added nothing and left revision 4 unchanged. After reload, the page showed source history groups of 11 and 12, raw business labels without a synthetic `v` prefix, and the exact source date in each compact card.
- The imported source projections retain each package `rawRecord` and source specification row. The S15 `26.09.05` entry remains Lark `Active`, keeps effective timestamp `2026-09-24T00:00:00.000-07:00` and description `fefe`, and has no spec rows. The broad-linked `VENTUS` record appears in both mapped families with its review marker.
- Comparison with the pre-import backup confirmed that existing families, variants, orders, batches, issues, attachments, history, and both local reference versions were unchanged. The post-import exported backup validated and restored into an empty service with all 25 versions, 89 batches, and 30 assets; source records and raw spec rows matched the package.
- Final automated suite: **44 tests passed, 0 failed**. Regression coverage includes package counts/raw-value preservation, repeat-import idempotence, atomic conflict rejection, backup compatibility, recorded-version operational guards, and the exact JSON static route. Windows remains untested.

## Standards page simplification and version attachments (2026-09-29)

- Final automated suite: **50 tests passed, 0 failed**. New coverage verifies numbered-description formatting without splitting measurements or percentages, and document links for recorded, draft, and published versions through backup restore and repeat source import.
- Real Chrome acceptance showed 23 visible cards and 23 upload controls, with both source groups titled `Versions`. The two recorded `VENTUS` projections, `Recorded Lark source` badges, linked-specification sections, and attachment-metadata sections are omitted from the page. The production workspace stayed at revision 4; source records remain saved.
- In the isolated demo database, uploaded a 68-byte TXT attachment separately to a recorded version, a published version, and a draft. All three document associations remained visible after a full reload. Downloading the recorded version's attachment created a local file whose bytes matched the upload fixture.
- Verified the five-point `26.08.19` description and seven-point `26.4.24` description use separate lines, including the original punctuation-less `3调整` marker. Original source wording, decimal measurements, percentages, and version labels remain unchanged.
- Saved the production-page screenshot at `tmp/standards-review/standards-updated.jpg`. Upload fixtures and operational publication used only the demo workspace. Existing document formats and storage limits apply; Windows was not run.

## Standards without import controls (2026-09-29)

- Removed the Lark and AP import controls from Standards, including the empty-state duplicates. Existing source commands and backup compatibility remain available internally; startup behavior is unchanged.
- Attached the original source PDFs to the existing `25.10.29` drafts for S11-S14 and S15 through the production version upload controls. No duplicate versions were created and neither draft was published.
- Real Chrome verification after a full reload showed zero import buttons, both editable drafts, and both downloadable PDF attachments. The before/after full-backup comparison retained all prior business collections and assets, adding exactly two version-linked documents. Their decoded SHA-256 values matched the source references in the draft notes. Workspace revision advanced from 4 to 6.
- `npm test`: **50 passed, 0 failed**. Result screenshot: `tmp/standards-review/standards-no-import.jpg`. Windows was not run.

## Business-facing version display (2026-09-29)

- Removed the provenance and original revision-field DOM from recorded version cards. Page descriptions, library version labels, upload explanations, and applicable validation diagnostics use neutral business language without extraction-platform labels. Generated technical reference notes and source-reference badges are omitted from cards; ordinary staff notes remain available.
- Real Chrome inspection found no platform mention in Standards or the library, no provenance summaries or raw revision-field blocks, and no generated hash or builder notes. All 23 visible cards retain upload controls. Expanded change descriptions still show numbered points on separate lines.
- The workspace was at revision 6 during final read-only review, with both recently uploaded AP PDFs still linked to their respective draft versions. This cleanup performed no business-data writes. Internal source records, identifiers, and import/backup compatibility remain intact.
- The final suite passed **50 tests, 0 failed**, and the changed JavaScript modules passed syntax checks. A conflict-message assertion was preserved with neutral diagnostic wording. Screenshot: `tmp/standards-review/standards-clean.jpg`. Windows was not run.

## Inline version attachments and removal (2026-09-29)

- The automated suite passed **54 tests, 0 failed**. New coverage verifies removal from draft, published, and archived versions without editing version facts; wrong-version removal rejects atomically; shared batch/history evidence is retained; a shared document survives backup restore after unlinking.
- In real Chrome, the isolated demo workspace displayed the uploaded TXT filename on the version-label row and hid its upload button. Opening it showed the original text, Download, and Delete attachment. Confirmed removal restored Upload attachment; a full reload retained the removal. Uploading a replacement closed the dialog and restored the filename link, which survived another reload.
- DOM geometry confirmed same-row alignment for linked filenames and empty upload controls at the actual desktop viewport. The production workspace retained revision 6 and both original PDF links. Its PDF preview opened through a local blob iframe with Download and Delete controls; no production documents or versions were deleted.
- Screenshot: `tmp/standards-review/standards-inline-attachments.jpg`. Version deletion remains pending clarification of whether the user means the two `25.10.29` operational drafts or their separate group heading. Windows was not run.

## Ordinary PDF-based versions in one list (2026-09-29)

- The user superseded the deletion request: retain ordinary versions built from the PDF contents, with the original PDFs attached. Existing `25.10.29` operational drafts already met that data requirement, so no duplicate versions or attachments were created and no versions were deleted or published.
- Compared the existing 16 S11-S14 items and 17 S15 items against the original three-page PDF transcriptions: title, specification, devices, recording rule, sampling percentage, time, and importance matched every source row. Each version-linked PDF's decoded SHA-256 matched its original source document.
- Standards now has one `Versions` list per family, with no separate draft/published heading. Actual Chrome after reload showed two lists, 23 visible cards, both original PDF links, and both normal draft editing controls. The first PDF opened normally with preview, download, and attachment removal controls. The production workspace remained at revision 6.
- JavaScript syntax verification passed. This presentation-only change did not require new unit tests or a repeated full suite. Screenshot: `tmp/standards-review/ordinary-version-with-pdf.jpg`. Windows was not run.
