# Original PDF Import

## Source boundary

The authorized source is `../MasterQC/Master QC 品管主控文档/`. The current Web import covers the 15 PDFs in `S1` (the S11-S14 inspection family) and the 15 PDFs in `S15`. The other product folders are outside the two-family Web catalog. Source files are read-only and are never rewritten.

## Historical batches and source evidence

Historical inspection sheets become historical batches in the normal Batches list and workspace. They retain the printed product description, version, date, batch quantity, inspector, results, notes, and page reference. Some sheets combine product models or cover a different quantity at a different inspection stage. Historical batches preserve these facts with unknown operational links left null; newly entered batches continue to require one variant and one PO line.

The source file is an optional batch attachment, not a separate product category or the batch's identity. A PDF containing several inspection sheets can be linked to several historical batches. Existing imported evidence is converted once, without re-uploading or changing the source records. The staff-facing batch name prefers an explicitly recorded original batch number; otherwise it uses model/family, date, factory, and stage. Actual collisions receive short numeric suffixes. Technical archive identifiers remain internal; PDF page references belong in source details. Future batches entered directly in the system need no PDF.

Imported and directly entered batches share the same lists and workspaces. The attached PDF and source details show which records were transcribed; the interface does not display a separate Historical status label. Operational Draft/Released status remains available in batch detail.

An imported historical record does not constitute a release or contribute to purchase-order progress. A printed signature is retained in the original PDF; it is not recreated as a new digital confirmation.

The inspection quantity printed in a historical form is evidence. It is retained even when it differs from the current formula. The formula comparison is a separate value, never a replacement. A printed percentage is also retained even when its arithmetic appears inconsistent. Empty cells and dashes remain null, while explicitly printed zeros remain zero.

Header dates and version labels take precedence over filenames for source transcription. Their raw text remains available. Repeated historical-rate columns are not imported as additional inspections: they lack the complete identity, quantities, and context required to establish independent records.

## Standards and absent checks

Each historical row retains the standard actually shown beside its result. Printed version labels are not corrected from later change logs. A reference draft may be assembled from a clearly identified complete source set for staff review, with the source file and pages stated in its notes; import does not automatically publish it for new batches.

An absent check can be shown with empty results only when its applicability has supporting source evidence. It must be marked `missing-from-source` and identify the standard used. Import must not treat absence as zero defects or borrow a later revision's results.

For this import, the reviewable implementation convention is to consolidate titled checks across source sheets with the same family, printed version, factory, and stage. The user was asked about this convention while extraction continued; absent a contrary reply, the stated default is used. Added display rows identify the source sheet that supplied the check. This does not establish that the check was performed, or that its later appearance proves its historical effective date. Different factories, stages, and printed revisions are never combined for this purpose. Original source rows remain unchanged in the extraction files.

## Attachments and reproducibility

The import package includes the original PDF bytes, their SHA-256 identities, source-linked extracted records, and extraction findings. Original attachments are available from the Batches table's Attachments column, each batch detail, and the file library. An image spanning several rows remains part of the PDF unless its ownership is clear; it is not assigned to an arbitrary inspection record.

Identical repeat imports are skipped. Conflicting identities fail without partially changing the browser database. Existing local records are preserved. Full backup and restore must include the historical records and their source attachments.

The extraction scripts and JSON under `scripts/` and `data/pdf-import/` are reproducible import materials. They are not the live browser database. Actual delivery requires importing through the application's core interface, then reloading the browser and checking the persisted result.
