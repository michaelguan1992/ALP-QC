# Original PDF Import

## Source boundary

The authorized source is `../MasterQC/Master QC 品管主控文档/`. The current Web import covers the 15 PDFs in `S1` (the S11-S14 inspection family) and the 15 PDFs in `S15`. The other product folders are outside the two-family Web catalog. Source files are read-only and are never rewritten.

## Historical batches and source evidence

Historical inspection sheets become historical batches in the normal Batches list and workspace. They retain the printed product description, version, date, batch quantity, inspector, results, notes, and page reference. Some sheets combine product models or cover a different quantity at a different inspection stage. Historical batches preserve these facts with unknown operational links left null; newly entered batches continue to require one variant and one PO line.

The source file is an optional batch attachment, not a separate product category or the batch's identity. A PDF containing several inspection sheets can be linked to several historical batches. Existing imported evidence is converted once, without re-uploading or changing the source records. The staff-facing batch name prefers an explicitly recorded original batch number; otherwise it uses model/family, date, factory, and stage. Actual collisions receive short numeric suffixes. Technical archive identifiers remain internal; PDF page references belong in source details. Future batches entered directly in the system need no PDF.

Imported and directly entered batches share the same lists and workspaces. The attached PDF and source details show which records were transcribed; the interface does not display a separate Historical status label. Operational Draft/Released status remains available in batch detail.

An imported historical record does not constitute a release or contribute to purchase-order progress. A printed signature is retained in the original PDF; it is not recreated as a new digital confirmation.

The inspection quantity and defective count printed in a historical form are evidence. They remain in the imported source record even when staff correct the current result values or when the printed inspected count differs from the current formula. The formula comparison is separate, never a replacement. A printed percentage is also retained even when its arithmetic appears inconsistent; the current defective rate is derived from the editable current counts. Empty cells and dashes remain null, while explicitly printed zeros remain zero. Printed `timeSeconds` stays in source details as the standard shown on the form; actual elapsed seconds are stored separately and default to null.

Historical rows use the operational Results layout and support the Videos, Procedures, and Log attachment slots. They can create linked Issues using the same required reporter, title, and uploaded-photo rules as operational rows. Issue snapshots retain the current saved result values and ordinary disposition/evidence workflow. These edits and Issues do not turn a historical batch into an operational batch: its original PDF and imported source rows remain preserved, and it cannot be deleted, released, or counted toward purchase-order fulfillment. Reports and CSV exports show current saved results alongside printed source values.

Header dates and version labels take precedence over filenames for source transcription. Their raw text remains available. Repeated historical-rate columns are not imported as additional inspections: they lack the complete identity, quantities, and context required to establish independent records.

## Standards and absent checks

Each historical row retains the standard actually shown beside its result. Printed version labels are not corrected from later change logs. A reference draft may be assembled from a clearly identified complete source set for staff review, with the source file and pages stated in its notes; import does not automatically publish it for new batches.

An absent check can be shown with empty results only when its applicability has supporting source evidence. It must be marked `missing-from-source` and identify the standard used. Import must not treat absence as zero defects or borrow a later revision's results.

For this import, the reviewable implementation convention is to consolidate titled checks across source sheets with the same family, printed version, factory, and stage. The user was asked about this convention while extraction continued; absent a contrary reply, the stated default is used. Added display rows identify the source sheet that supplied the check. This does not establish that the check was performed, or that its later appearance proves its historical effective date. Different factories, stages, and printed revisions are never combined for this purpose. Original source rows remain unchanged in the extraction files.

## Attachments and reproducibility

The import package includes the original PDF bytes, their SHA-256 identities, source-linked extracted records, and extraction findings. Original attachments are available from the Batches table's Attachments column, each batch detail, and the file library. An image spanning several rows remains part of the PDF unless its ownership is clear; it is not assigned to an arbitrary inspection record.

Identical repeat imports are skipped. Conflicting identities fail without partially changing the browser database. Existing local records are preserved. Full backup and restore must include the historical records and their source attachments.

The extraction scripts and JSON under `scripts/` and `data/pdf-import/` are reproducible import materials. They are not the live browser database. Actual delivery requires importing through the application's core interface, then reloading the browser and checking the persisted result.

## Extraction pipeline and corrections (2026-10-16)

### Source files

`scripts/pdf-import/source-manifest.json` lists the 30 authorized PDFs by stable key (`S1-01` to `S1-15`, `S15-01` to `S15-15`), family folder, and file name. The extractors read them from the read-only reference folder given by `--source-root` (default `../MasterQC/Master QC 品管主控文档`). Each file must sit directly inside its family folder and begin with `%PDF-`; a missing or unreadable file stops the run with a non-zero status. Keys are identifiers only. Absolute paths and inventory-derived identifiers are not written to any output.

### Regeneration

Run from the project root. The extractors need `pdfplumber` in the Python runtime used for the import. The parser self-check needs only the standard library:

```sh
python3 -I -B scripts/pdf-import/test_pdf_parsers.py
python3 scripts/pdf-import/extract_s1_history.py
python3 scripts/pdf-import-s15/extract_s15.py
node scripts/pdf-import/build_history_package.mjs
```

The extractors write `data/pdf-import/s1-history.json` and `data/pdf-import/s15-extraction.json`; the builder writes `masterqc-history.json`, `summary.json`, and `summary.md`. Outputs contain no timestamps or machine paths, so reruns over the same PDFs are byte-identical. Compare the regenerated package with the previous one before committing it.

### Parsing rules

- A printed bare number in a rate column is a percentage (`1.58` means 1.58%). A printed `0` stays `0`; a blank or dash stays null.
- A result cell that is not one clean number is reported: `result-cell-unparsed` when no value could be read, and `result-cell-parse-mismatch` when only part of the cell was read. S1 and S15 apply the same check.
- A row highlight is a filled rectangle at least 2 pt wide and high. Stroke-only cell borders and hairlines are not highlights.
- S15 Special Notes assign a color only when the single color stated equals the page batch quantity. A color stated for part of the batch leaves color null with basis `special-notes-partial-color-quantity` and a `partial-color-allocation` anomaly. A color named without a quantity uses `special-notes-color-quantity-not-stated` and `color-quantity-not-stated`. Core applies the same rule; `tests/fixtures/s15-color-cases.json` is the shared parity check.
- The builder keeps the factory and stage together as an anomaly context (for example `AP|OQC`). Each same-task anomaly is emitted once.

### Corrections to stored records

`core/qc-history-correction.js` (`correctHistoricalPdfRecords`) corrects records imported before these rules. It runs in `initialize`, and it normalizes incoming JSON backups and history packages before comparison. Each rule applies only while the stored value equals the known incorrect value:

- printed bare-number defective rates and printed zeros in historical comparisons (`sourceDefectiveRate` restored from its raw text);
- S15 batch color unassigned where the notes state a partial color quantity, with the matching anomaly added to the inspection and the package-level list;
- the two self-made S1 row highlights (page 1 of `8.27.26AP自制`, table rows 5 and 8) set from `0.000,0.000,0.000` to `none`, as the rendered page shows no highlight;
- mislabelled AP and UI duplicate anomalies removed where one correctly labelled entry has identical content;
- `path`, `inventoryKey`, `extractorSourceId`, `extractorInspectionId`, and `extractorRowId` removed from sources, inspections, rows, and historical batch rows;
- derived historical batch projections (color, rates, comparisons, highlights, and row fields) rebuilt from the corrected inspection.

Staff-editable batch values (inspected quantity, defective quantity, actual seconds, and row and batch attachments) and all Issues, assets, orders, and versions are preserved. When a batch differs from its source evidence in an unexplained way, that batch and its inspection are left unchanged and the skip is counted. The correction writes one audit entry, `correctHistoricalPdfRecords`, only when something changed; a later start changes nothing.

### Restore and import compatibility

- A JSON backup that holds the earlier values restores into a corrected workspace as an identical skip, and into an empty workspace as the corrected history with the correction audit.
- A history package with the earlier values imports the same way.
- A database snapshot is validated by `launcher/restore-snapshot.mjs` on a copy that is initialized before the swap. That initialization applies the correction once, so the restored workspace holds the corrected records and its audit entry; the snapshot file itself is not changed.

### Verification status (2026-10-16)

- `pdfplumber` is not installed in the working environment, so `data/pdf-import/*` has not been regenerated from the PDFs. The committed package still holds the earlier values, and the import, correction, and restore paths handle it correctly.
- The regenerated package must be compared with the committed one (expected: the changes above only) and re-imported as an identical skip after the correction before it is committed.
- The correction was verified on a copy of the production database: the correction changed only the fields listed above, a second start changed nothing, current results and attachments were unchanged, and the earlier JSON backup and both packages imported as identical skips.
