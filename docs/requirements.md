# Web Edition Requirements and Decisions

Status: 2026-09-28, first complete local application implemented and locally verified. The following items were confirmed by the user in this task; they are not a fresh check of the live Lark system.

## Goals and Presentation

- Bring QC standards, original files, inspection records, and issue disposition together in one system.
- Use the dense inspection table in the original PDF as the main interface reference, retaining inspection standards, current data, historical comparisons, and attachment access.
- Use one consistent Web interface and workflow; do not create a separate mobile interface for entering items one at a time.
- Mark important checks in green. Green indicates importance, not pass/fail status.
- Confirmed again on 2026-09-27: build the batch inspection workspace around the original PDF's table layout. Preserve its inspection grouping, item order, and standards presentation when translating it into an editable Web table; inspect the original PDF before implementing the layout.
- The familiar form is an adoption requirement: staff moving from the original spreadsheet should recognize the table and experience a small change in their filling workflow. Add the new system capabilities to that familiar structure instead of replacing it with a substantially different presentation.
- Give each inspection record within its batch its own photo association and photo cell, following the Lark approach. Do not merge photo cells into a shared photo area across inspection rows, and do not reuse one batch's evidence as another batch's evidence simply because the inspection item is the same.
- Batch inspection is the main workspace. Product and standards setup, purchasing, issue handling, and the library support it; each batch detail provides access to its read-only report.
- Confirmed on 2026-09-29: visual simplicity is a standing design principle. Use it when deciding whether to add pages, navigation entries, buttons, or other visible controls. Avoid unnecessary standalone entry points when the relevant business workspace already provides access to the function.
- Business-facing UI must not describe records as extracted from Lark. Use business labels for versions, statuses, documents, and messages. Standards must omit source provenance, original revision fields, import anomaly details, and generated technical reference notes; retain version dates, change descriptions, business notes, and attachments. Preserve the underlying records and backup compatibility.
- Applying that principle: hide the Product catalog and File library sidebar entries. Retain product data and document storage, including opening and downloading attachments from batches; hiding navigation does not delete these capabilities or their records.
- Place Backup and restore at the bottom of the sidebar, separate from everyday business navigation. Use this specific name instead of Settings while backup and restore is its only function. Keep backups as saved business data and attachments, not application code or automatic multi-user synchronization.
- Confirmed on 2026-09-28: remove the source form's company-name footer. Present the page clearly as an editable batch inspection workspace, with visible input fields for inspection results and notes while preserving the familiar table layout.

## Versions, Issues, and Signatures

- A new Web batch defaults to the latest version for the corresponding product and allows manual selection of a historical version. This decision overrides the Lark edition's behavior of making no default selection.
- Before implementing version selection, define the ordering data for “latest.” Do not infer version order from string size or file modification time.
- An inspection issue can be converted to a standalone Issue; repeated saves must not create duplicate Issues. Issues can also be reported independently.
- Discussion and formal disposition records are stored separately. Each issue can be traced to its source inspection and evidence.
- The initial trust-based approach retains three blank signature fields for users to enter the voters' names. Do not add login identity verification or server-side vote validation, and do not describe a manually entered name as an identity-verified signature.
- The rest of the closure flow follows the previous plan: the disposition owner, a formal disposition record, and confirmation from all three people must be present before manual closure. The third signature does not close the issue automatically. Any linked issue that remains open blocks batch release; closing all issues does not release the batch automatically. Details of the interaction will be refined during implementation.
- Do not add automatic reminders that continue after the Web page is closed or background scheduled tasks for now.
- Preserve the history of original files, archived reports, and saved batch facts. Generate the in-app per-batch report from saved facts without storing each report as a separate archive or listing reports as a standalone workspace. New standards or formulas must not silently overwrite archived facts.

## Design Versions, Standards, and Batch Inspections

Confirmed on 2026-09-26. Domain terms are defined in [the glossary](../CONTEXT.md).

- Each design version defines one complete inspection standard set containing multiple inspection items. Applicable items differ by factory and inspection stage (IQC or OQC); these are selections within the version's complete set, not independently versioned standards unless a later decision establishes otherwise.
- At creation, a batch locks its selected design version and the applicable inspection standards for its factory and inspection stage. The default remains the latest design version for the product, with historical selection allowed as described above. Later version changes must not silently change the standards locked for an existing batch.
- In the user's example, AP performs OQC only. A new AP OQC batch defaults to the AP OQC items within the latest design version's standard set.
- The same inspection item has separate inspection records across different batches. Results from one batch must not overwrite another batch's results.
- Confirmed on 2026-09-28: inspection quantity is calculated from batch quantity and the applicable inspection sampling percentage, and is not manually editable. The recording percentage is separate and does not determine inspection quantity. The prototype rounds fractional quantities up to whole units (for example, 423 units at 10% gives 43); this rounding convention is an implementation assumption pending review. Defective quantity and remarks remain editable, and defective rate is derived from the calculated inspection quantity.
- Reinspection means another inspection of the same item within the same batch. The user has not confirmed a need for this behavior; do not treat same-batch reinspection rounds or multiple attempts as an established requirement.
- The first-edition implementation conventions below define numeric version ordering, rejection of empty applicability, and copied batch snapshots while preserving the confirmed lock-at-creation rule.

## Inspection Families, Product Variants, and Purchase Quantities

Confirmed on 2026-09-26:

- The Web edition currently has two inspection families: S11-S14 share one inspection family, while S15 belongs to a second family with its own inspection requirements. S11, S12, S13, and S14 remain distinct product models even though they share an inspection family.
- Both families have color variants. Future minor variations may remain within the same inspection family; a color or minor variation does not by itself require a separate inspection family.
- Color naming clarified on 2026-09-27: the normal product color is red, but its displayed product name does not need a color label. The special yellow variant uses the `Yellow` label. For example, display `S15` and `S15 Yellow`; keep the variants distinct for ordering and quantity aggregation even when the normal variant has no visible color label. Earlier black/white examples were illustrative, not actual product definitions.
- Purchase quantities must distinguish the ordered product and its color or other relevant variation. Sharing inspection requirements must not merge purchase quantities for different product variants.
- A purchase order can order multiple variants, and quantities across multiple batches must be compared with the ordered quantity for each variant to show whether the purchase quantity has been reached.
- Only quantities that have passed inspection release count toward purchase order completion. Unreleased quantities do not contribute, and inspection sample counts are not fulfillment quantities. Reaching the ordered quantity is a quantity-progress result, not an automatic batch release or purchase order closure action.

Proposed model, pending confirmation:

- Separate inspection family, product model, and product variant. A variant identifies the model, color, and any distinguishing minor variation needed for ordering; whether a separate SKU code is needed remains open.
- Represent each separately tracked purchase requirement as a purchase order line referring to a product variant and an ordered quantity. Link batch quantities to the relevant order line so that progress can be calculated per variant and summarized for the order.
- Keep ordered quantity, counted quantity, shortage, and overdelivery distinguishable. An overdelivery of one variant must not hide a shortage of another.

Confirmed for the first complete local edition on 2026-09-28:

- One batch contains one product variant and supplies one explicitly selected purchase order line. Release covers the entire batch; released batch quantity contributes to that line.
- Design versions belong to the inspection family: S11-S14 share a version set, while S15 has its own. Individual standard items can have model-specific applicability within the family.
- Build the single-computer edition first, including data export and restore. Shared multi-computer storage is a later phase.

Remaining decisions and scope boundaries:

- Partial release, mixed batches, and split allocations are outside the confirmed first-edition scope. Release correction or withdrawal needs a separate historical adjustment design; released records cannot be casually edited.
- The user was asked about cross-stage counting. Pending further feedback, the first build uses an explicitly entered physical lot number and a final-shipment eligibility flag. Only released eligible batches count, with at most one counting release per variant and physical lot. This is an implementation convention, not a confirmed requirement for more complex split-lot operations.
- Staff explicitly select the purchase order line when creating a batch; do not infer an automatic matching rule.

## Technology and Collaboration

- Use plain HTML, CSS, and JavaScript for now so collaborators can maintain pages directly. Do not introduce React or a framework that requires a build step for editing.
- The database is browser IndexedDB, accessed through Dexie. There is no business backend, login, or cloud sync.
- Mac and Windows use the same Web code and have separate double-click launchers. Install Node.js and project dependencies once, then launch by double-clicking.
- The local static file server serves application files only; it does not contain business rules or store QC data.
- A small backend with SQLite is an option for future use by several people. This phase keeps only the adapter boundary and does not build a server-side database in advance.
- IndexedDB data belongs to the current browser and fixed website origin; sharing project code does not share data. The complete local edition includes explicit backup export and validated additive restore, including attachments.
- Concrete code implementation uses a Luna Max subagent. The primary agent coordinates, reviews, and verifies the work.

## Complete Local Edition Scope

The user requested the complete app on 2026-09-28 to review through practical use. Connect catalog and variants, draft/published family versions, editable inspection standards, purchase orders, batch creation and inspection, row photographs, issue disposition, explicit release, order progress, historical comparison, a local document library, read-only per-batch reports with print and CSV export, and backup export/additive restore.

Preserve the existing initialization draft and disposable prototype separately. The main app must not automatically install demonstration orders, batches, inspection outcomes, or signatures. AP `25.10.29` is represented by ordinary family versions with their original PDFs attached through the existing version-document controls. Staff review and publish those versions through the normal workflow.

Initial implementation conventions: order published versions by a unique numeric sequence within each family; copy applicable standards and computed sample quantities into each batch; reject batch creation with no applicable items; round sampling quantities up. Require saved results for every row, a recorder, and no open linked issues before explicit release. These conventions remain reviewable during the user's first-app review.

See [Local App Contract](app-contract.md) for command interfaces, data shapes, migration, and backup behavior.

## Original PDF Import (2026-09-29)

- The user authorized scanning and importing the original PDF files. Import the two established Web families (the source folder `S1` represents S11-S14, and `S15` represents S15). Other source product families remain outside the current Web scope.
- Preserve the version printed on each inspection sheet even when it appears to be an outdated or mistaken version number. Do not silently substitute the newest version or a version inferred from a filename.
- If an applicable standard contains a check that is absent from the filled form, show the check with empty results. Retain the evidence used to establish applicability; do not assume that a later revision applied retroactively.
- Preserve original recorded inspection quantities, defects, percentages, remarks, and blank cells. A blank or dash does not mean zero. Show a formula comparison separately when the source sample quantity differs from the current Web calculation.
- Retain source files and page references. Historical percentage columns provide context; they do not establish complete additional batch records.
- Historical source sheets may combine multiple models, cover different quantities at different stages, or omit purchase-order information. Preserve those unknowns instead of inventing order quantities, model allocations, or release events. Historical import does not contribute to PO fulfillment.
- Original PDFs and the live Lark system remain unchanged. Import is explicit, additive, and repeatable without duplicating identical records.

## Unified Batch History (2026-09-29)

- The user clarified that imported inspection content is the system's batch history. Historical and newly entered batches belong in the same Batches list and batch workspace; there is no separate PDF history product area.
- A batch has optional attachments. Original PDFs belong in the batch's Attachments column and detail section. A future batch entered entirely in the Web app does not require a PDF.
- Existing imported inspection sheets become historical batch records, retaining the existing factory/stage boundaries. A source PDF may be attached to several batches when it contains several inspection sheets; the PDF file itself does not define batch identity.
- Historical batches retain printed versions, quantities, results, missing checks, and source references. Unknown PO, variant allocation, physical lot, and release facts remain unknown. Archive identifiers are system identifiers, not invented original batch numbers.
- The operational rule requiring one variant and one PO line still applies to newly created batches. Historical records can preserve mixed or incomplete source facts without being falsely marked as draft or released. They remain read-only evidence and contribute no PO fulfillment.
- Convert existing browser records without re-importing files, duplicating batches, or changing original evidence. Older backups and import packages remain supported.
- Batch names shown to staff use an explicitly recorded original batch number when available; otherwise use product/model (or the known inspection family), date, factory, and stage, for example `S15-20260521-UI-OQC`. Only actual naming collisions add short numeric suffixes such as `-01` and `-02`. Omit the `HIST` prefix, technical digest, and PDF page suffix from the displayed name. Superseding the earlier decision to keep historical status as a tag: imported-batch provenance appears in attachment and source details, with no separate Historical status label. Operational Draft/Released status remains available in batch detail. Internal record identities and attachment associations remain unchanged.

## Reports Within Batches (2026-09-29)

- Do not provide a Reports sidebar item or standalone report list. Historical, operational draft, and released batch details each provide a compact **View report** action.
- The report is a read-only view of that batch's saved facts and results, including its locked inspection table, saved historical comparisons, linked issues, and row photos. Local unsaved inspection and detail drafts are excluded. The existing warning must explain that drafts remain in the current tab; returning with **Back to batch** opens the same batch with those in-tab drafts intact.
- Keep **Print / save as PDF** and **Download CSV** available from the report. The report is not an independently stored or archived record, and this navigation adds no persisted fields or schema changes.
- Use `#/batches/<encoded batch ID>/report` as the canonical report URL, with Batches remaining active in the sidebar and as the top-level context. Redirect legacy `#/reports` to Batches and `#/reports/<id>` to that batch's report. Preserve normal browser history behavior.

## Archived Design Version History (2026-09-29)

- Record the complete relevant Lark version history as immutable `recorded` source entries in the existing Standards page. The reviewed package has 23 family projections from 13 distinct linked revision records: 11 for S11–S14 and 12 for S15, with 120 linked spec rows. Zero-spec versions stay in the ledger. See [the package report](lark-import.md) for source counts, excluded revisions, and anomalies.
- Preserve each raw version label, effective timestamp including its original timezone offset, source status, change description, attachment metadata, and exact linked specification rows. Blank and null values remain distinct. Do not fill missing criteria from another revision, coerce nonnumeric sampling rules to zero, or treat Lark's Active value as Web publication.
- The Standards page presents recorded source entries and operational drafts/published versions together in one `Versions` list per family. Keep the existing order: visible recorded entries first in source effective-date order, then operational entries in numeric sequence order. This shared presentation does not merge the records; each card retains its status and behavior. Recorded cards show the version label, business status, effective date, change description, and linked documents, and omit the linked-specification table and attachment-metadata section. Do not display extraction-platform labels, provenance, source anomalies, or raw revision fields.
- Hide recorded versions whose trimmed label is `VENTUS`, without deleting, rewriting, or excluding those records from backups or repeat imports. Omit generated reference notes beginning `Historical source reference draft.` or `masterqc-ap-oqc-reference-25.10.29.` from card display only; continue showing ordinary staff-entered notes. These presentation choices do not modify persisted facts, notes, or backups.
- Format sequential numbered points in recorded change descriptions onto separate lines for readability. Keep the stored source text unchanged, including decimals, percentages, version labels, and measurements.
- Every visible archived, draft, and published version card places its attachment control on the same line as the version label. With no linked documents, the control is `Upload attachment`; after upload, each linked filename appears as a compact preview link and upload stays hidden until all links are removed. Do not add a separate attachments section or empty attachment status. Opening a filename previews PDFs, images, or safe text and offers Download and a confirmed Delete action.
- Removing a version attachment deletes the asset only when no batch `attachmentIds` or historical source references it. For a shared file, clear its version link while preserving the asset and evidence. Version records and source facts remain unchanged; no database schema upgrade is needed. Retain backup and restore compatibility and the existing file types and 10 MiB per-document / 30 MiB aggregate limits.
- The retained `importLarkVersionHistory` core command validates the complete package, adds records atomically, skips identical entries on repeat, and rejects conflicting IDs without partial changes. It remains explicit and never runs at startup; the Standards page does not expose it as a user control.
- Recorded entries are not editable, publishable, cloneable into empty operational drafts, or selectable for new batches. They have no operational sequence and do not affect the latest published version. Keep existing PDF-derived `25.10.29` reference drafts as distinct operational records even when a recorded source entry has the same label. Show each existing record once in the shared list; do not delete, merge, duplicate, or automatically publish versions.
- Full backups retain raw source metadata and rows. Existing backups without Lark entries remain compatible. Actual browser, repeat-import, reload, and backup verification is listed in [Local App Acceptance](app-acceptance.md); Windows remains untested.

## Standards UI Simplification (2026-09-29)

- Standing presentation rule: business UI must not identify the platform from which version data was extracted or display raw version-source technical metadata. Keep internal source facts, import compatibility, and backups intact; hide provenance, anomaly details, raw revision fields, and the specified generated reference notes from version cards while preserving ordinary staff notes.
- The Standards page has no Lark or AP import buttons, menus, or import instructions. When no versions exist, it prompts staff to create a family version. Version creation, editing, publication, and document upload/download remain available.
- Existing AP `25.10.29` drafts are ordinary operational family versions with their original PDFs linked through the existing version-document controls. They appear in the same family `Versions` list as recorded source entries, while remaining distinct records with their existing draft actions; showing them together does not create, merge, or publish versions.
- This is a presentation decision only. Keep the existing source packages, core import commands, imported records, and backup/restore compatibility. Imports never run automatically at startup.
