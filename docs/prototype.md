# Familiar Inspection Table Prototype

Status: 2026-09-28. User-requested interactive prototype; design review is pending. This is a disposable demonstration, not the production QC workflow.

## Question

Can staff recognize their original AP OQC inspection form and keep a familiar row-by-row filling workflow while gaining individual photo evidence, issue handling, and released-quantity PO tracking?

The user explicitly chose the familiar PDF table direction. This prototype therefore explores one faithful layout rather than alternative dashboard or card layouts.

## Open

Start the existing application with `npm start` or a platform launcher, then open:

`http://127.0.0.1:4173/frontend/prototype.html`

The original initialization page remains at `/`. Prototype state is in memory only; reloading resets demo records and photos. It does not modify the existing IndexedDB database.

## Source Layout and Standards

The AP-branded OQC page (PDF page 3) was visually inspected in both source files below, with text extraction used to check the inspection wording. Only reference material inside the authorized original-PDF folder was read. The original files were not changed.

- S11-S14 reference: `../MasterQC/Master QC 品管主控文档/S1/8.27.26AP检查资料 HyperSmoke检验规范（主控文件） HyperSmoke Master QC List 26.9.3(1).pdf`.
- S15 reference: `../MasterQC/Master QC 品管主控文档/S15/9.3.26AP检查资料 HyperSmoke检验规范 S15（主控文件） HyperSmoke Master QC List 26.9.3(1).pdf`.

Both selected AP OQC page headers show version `25.10.29`. This is a source reference revision, not a claim that it is the latest reliable business version. PDF filenames, batch dates, and change-log entries are not used to establish version ordering.

Preserved structure:

- OQC context and compact boxed batch metadata.
- Full-width special-notes row.
- Grouped table headers for quality-control quantities and historical defect rates.
- Four source inspection rows in order: Air Pump Test, Power Test, Smoke Machine Leak Test, Final Packaging.
- Green important-check backgrounds, separate from release or pass/fail status.
- Source-specific requirements: S11/S13 power 32.3-34.0 W, S12/S14 and S15 power 30.1-31.8 W; S11-S14 leak check at 12 PSI with at least 11.8 PSI after 30 seconds, S15 at 20 PSI with at least 19.8 PSI after 30 seconds.

Intentional changes:

- Each batch inspection row has its own photo cell and photo references, instead of a shared cross-row photo area.
- Editable fields, issue controls, and a manual release action supplement the familiar table.
- The title identifies an editable batch inspection workspace. The source company-name footer is omitted, and editable fields have visible borders and white backgrounds.
- Inspection quantity is read-only and calculated from batch quantity and the inspection percentage (the first percentage in the sampling rule). The recording percentage does not affect this count. The prototype rounds up to whole units, pending user review of that convention. Defective quantity and remarks are entered by staff; defective rate is calculated.
- Historical values, batch quantities, people, PO progress, and any demo images are demonstration data. Historic people's signatures and original batch results are not represented as new inspections.
- Normal red variants omit the color label (`S15`); special yellow variants show `Yellow` (`S15 Yellow`).

## Prototype Assumptions

For this demonstration only: AP OQC, one product variant and one PO line per batch, full-batch release, and a single source-reference revision. Any requirement to complete all four rows before release is a demo safeguard rather than a newly confirmed production release policy. Mixed batches, partial release, release withdrawal, cross-stage physical-goods identity, and reliable version ordering remain open decisions in the requirements document.

## Review Walkthrough

1. Open a draft batch and compare the table's order, density, and labels with the original form.
2. Check the automatic inspection quantity, enter defective quantity and remarks, and save the row. For a 423-unit S15 batch, 10% checks show 43 and the 100% packaging check shows 423; one defective unit out of 43 gives 2.33%.
3. Add an image to one row and inspect a different row and batch to verify separate photo ownership.
4. Create an issue from a row. Record discussion and formal disposition separately, enter three manual confirmation names, and explicitly close the issue.
5. Try releasing with an open issue, then release after all demo conditions are met.
6. Inspect PO progress. Only released quantities contribute; normal and Yellow variants remain separate. Repeating a release must not add the quantity again.
7. Create a new batch to confirm that it starts without another batch's results or photos.

## Review Boundary

Visual familiarity must still be confirmed by the user. The prototype is not a validated import of all standards, a backup system, an authenticated approval system, or a Windows runtime verification. Production implementation will use the confirmed interface and data contracts after prototype review.

## Verification Notes

- 2026-09-28 update: ad hoc core checks verified rounded sampling, full inspection, ignored quantity overrides, blank/oversized defect rejection, derived rates, issue snapshots, and preservation of released quantities. Mac browser checks confirmed read-only values of 43/43/43/423 for a new 423-unit S15 batch, saving one defective unit with a 2.33% rate, and read-only released records. The existing user tab was preserved while a separate preview was tested.
- Existing project checks: `npm test`, 6 passed on 2026-09-27.
- Core review: an ad hoc in-memory walkthrough verified unique batch IDs, all ten model/color variants, blank-vs-zero validation, family-specific standard thresholds, row/batch photo isolation, issue deduplication, explicit closure, open-issue release blocking, released-only PO quantities, and retry protection against duplicate release counting.
- Mac in-app browser review: the original-style metadata and grouped table were inspected at the normal panel size and a 1440-pixel desktop test width. Horizontal table scrolling is available in narrower panels; the viewport override was reset after review.
- Browser walkthrough passed row editing and rate calculation, preservation of other unsaved row/metadata drafts, S11 Yellow batch creation with the correct family standards, actual local-image selection with a resulting row thumbnail, demo-image preview/removal, and photo separation when switching between regular and Yellow batches.
- Browser workflow review passed incomplete-disposition closure blocking, open-issue release blocking, separate discussion/disposition, explicit issue closure, and manual batch release. In the demo, releasing the 160-unit S15 batch changed the S15 released quantity from 240 to 400 while the Yellow line remained at zero.
- Reloading restored the initial demo state as intended. No browser console errors were observed during the successful workflow review. [Desktop preview](prototype-preview.png).
- Windows launch/runtime: not tested during this prototype work.
