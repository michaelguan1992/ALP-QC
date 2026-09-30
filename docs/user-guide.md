# MasterQC Web Local Edition

## Start and choose a workspace

Start with `Start-Mac.command` or `Start-Windows.cmd`, or run `npm start`. Keep the startup terminal open. Open `http://127.0.0.1:4173/` for the working database. Use `?workspace=demo` for a separately stored rehearsal workspace. The original table prototype remains at `/frontend/prototype.html` and resets on refresh; the complete app saves to IndexedDB.

## Set up standards

Catalog separates product families, models, and variants. S11-S14 share a family; S15 has its own. Standard red products omit the color suffix, while Yellow variants retain it. Minor variants can have distinct ordering identities without introducing another inspection family.

Create or edit a draft family version with a unique numeric sequence and effective date. The existing AP `25.10.29` versions are ordinary family versions; their rows match the original three-page inspection PDFs and are not historical inspection batches. Link each original PDF using the version's **Upload attachment** control, review the standard rows, and publish when ready. Numeric sequence determines the default latest published version. A published version is preserved; clone it to prepare changes.

Each standard item defines factory/stage applicability, optional model applicability, inspection percentage, recording instructions, and inspection requirements. AP uses OQC only. The inspection percentage determines the automatic sample quantity. Recording instructions do not change that quantity.

Each family has one **Versions** list. Recorded source entries appear first in source effective-date order, followed by operational drafts and published versions in numeric sequence order. They remain distinct records: archived cards preserve their source facts, while draft and published cards retain their normal edit, publish, and clone actions. Matching labels do not mean versions were merged or duplicated. Cards show their label, business status, effective date, **Change description**, and linked documents. Extraction origin, provenance, anomaly details, and raw revision fields are omitted from the business view. Sequential numbered points in a change description are separated onto lines for reading, while the saved text remains unchanged. A label of `VENTUS` is hidden from this page after trimming and case-insensitive comparison; the version remains in workspace data and backups. Generated reference notes beginning `Historical source reference draft.` or `masterqc-ap-oqc-reference-25.10.29.` are omitted from cards only; ordinary staff notes remain visible and editable.

Each archived, draft, or published version card places its attachment control beside the version label. Use **Upload attachment** when none is linked. After upload, each filename appears as a compact link; open it to preview the PDF, image, or text, download it, or delete a mistaken upload. Delete asks you to confirm the filename. Upload stays hidden while any documents remain and returns after the last one is removed. Shared historical or batch evidence stays linked to its record when removed from a version. Uploads use the same file types and 10 MiB per-document / 30 MiB total limits as the library, which continues to show linked files.

## Order and inspect

Create a purchase order with one line per separately tracked product variant. Create a batch from an order line, set its quantity and physical lot number, choose factory/stage and a published version, and enter the inspection date and recorder. A batch contains one variant for one order line.

The batch captures its applicable standards and sample quantities when created. Later version changes do not alter it. Sample quantities round up to whole units. Fill defective quantities and remarks in the familiar inspection table, save each row, and attach evidence separately to each row. Green identifies important checks, not successful results.

Raise an issue from an inspection row to preserve its source facts and evidence references. Issues can also be entered independently, with optional batch association. Record discussion separately from formal disposition. Enter the disposition owner and three manual confirmation names, save, and explicitly close the issue. Names are staff-entered confirmations, not authenticated digital signatures.

Release remains a separate action. Complete every row, provide the recorder, and close linked issues before release. Released records are read-only. Only eligible final-shipment releases contribute to the order, using batch quantity rather than inspected sample quantity. Separate variants show separate shortages and excess quantities.

## Reports and documents

Reports show saved batch facts and inspection results. Operational Draft or Released status remains visible in report detail. Use the report's print action for the browser's print/save-as-PDF dialog and CSV export for tabular results. Historical comparisons use saved prior results; empty histories remain empty.

The library stores local documents and can associate them with a design version. Photo evidence remains attached to the specific inspection row. Exported backups contain attachment data, not just filenames.

## Historical batches and attachments

Use **Batches** for both imported inspections and newly entered batches. Filter by family, factory, or stage, or search for the batch you need. Open an imported record to see its original quantities, defects, notes, printed version, and source page. The **Attachments** column and batch detail provide its original PDF, including signatures, photographs, and the complete layout.

Batch names show product/model or family, date, factory, and stage, for example `S15-20260521-UI-OQC`. An explicitly recorded original batch number takes priority when available. Only matching names receive short suffixes such as `-01` and `-02`. Original-PDF provenance and source page numbers appear in the attachment/source details; imported batches have no separate Historical status label. Operational Draft/Released status remains available in batch detail. The same names appear in reports and CSV exports.

Attachments are optional for newly entered batches. Batch documents and inspection-row photos have separate ownership: a PDF can describe the whole batch, while a row photo remains evidence for that particular check.

Use **Open PDF** in the list, or **Open** beside a batch attachment, to preview the document inside the app. **Download** saves the original file. The original imported PDF remains linked as source evidence; removing a supplementary attachment only removes its batch link and keeps the file in the library.

Historical source values are read-only. A separate formula comparison may differ from the original inspected quantity; the original value is preserved. A blank result means no result was recorded, not zero defects. Checks added to complete a same-version checklist are marked as absent from the original sheet and retain empty results with a source explanation.

These historical sheets do not count toward purchase-order fulfillment. They may contain mixed models, partial shipments, or no complete order information. Imported standards drafts also need review before publication and operational use. See [Original PDF Import](pdf-import.md) for the evidence rules.

The historical batch import action in Batches accepts a prepared source package, validates its documents and records, and skips identical records on repeat import. Existing imports automatically appear in Batches after the application upgrade; no re-import is needed. Use full backup and restore to move the complete workspace, including historical batches and their attachments, to another browser or computer.

## Backup and recovery

Open **Backup and restore** at the bottom of the sidebar. Save your edits, then choose **Download full backup** to export the saved workspace records and attachments. To hand off data to a collaborator, share this file separately from the application code; they need a compatible copy of the app and can select the file under **Restore into this workspace**, then choose **Validate and restore backup**. Unsaved edits and application code are not included in the backup.

Export backups regularly and before changing computers or clearing browser data. A backup belongs to the selected workspace. Restore validates the file and all references, then adds missing records. Identical records are skipped; conflicts reject the import rather than overwrite current facts. Use the same browser and `127.0.0.1:4173` origin to return to the same local database.

The first edition limits individual photos to 5 MiB, documents to 10 MiB, aggregate decoded attachments to 30 MiB, and serialized backup files to 50 MiB. Save smaller images when necessary. Browser quota failures are reported instead of being treated as successful saves.

This local edition does not synchronize computers. Sharing the project folder does not share the database. Windows runtime verification must be completed on a Windows computer; Mac checks do not verify it.
