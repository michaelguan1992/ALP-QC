# Local App Contract

Status: 2026-09-28 implementation contract. User decisions in requirements.md take precedence. The first build connects catalog, standards, purchasing, inspection, issues, library, reporting, and backup through one durable local workflow.

## Public interface

`core/qc-service.js` exports `createQCService(adapter, options?)`. `core/qc-app.js` composes and exports `qcService` for browser callers. All public operations are asynchronous:

- `initialize()` opens storage and creates the empty catalog state only if absent. Existing imported history is upgraded atomically to canonical historical batches once. No sample orders, batches, results, or signatures are installed automatically.
- `getState()` returns an isolated state snapshot.
- `command(type, data, expectedRevision)` validates current state and writes atomically; returns `{ entityId, revision }`. A supplied stale revision rejects with an actionable reload message. Frontend supplies its current snapshot revision.
- `getBatchWorkspace(batchId)` returns the batch, a query-only `displayNumber`, related entities, rows, release blockers, and resolved attachments. `displayNumber` is outside the persisted batch object. Operational rows include photos, issues, and up to four saved older results. Historical workspaces preserve source values and provenance; unknown related entities remain null.
- `resolveBatchDisplayNumbers(state)` in `core/qc-batch-display.js` returns a `Map` from batch ID to staff-facing name without changing state. It resolves collisions against the complete batch collection before any UI filtering or sorting.
- `getPurchaseOrderProgress(orderId)` returns `{ order, lines }`; each line includes `variant`, `orderedQty`, `releasedQty`, `remainingQty`, `excessQty`, and contributing `batches`.
- `exportBackup()` returns a JSON-serializable `{ format: 'masterqc-web-backup', formatVersion: 1, exportedAt, state }`, including attachments.
- `importBackup(backup, expectedRevision)` validates the full graph before an atomic, additive import. Identical IDs with identical content are skipped; conflicting IDs reject without changes. This operation never clears or overwrites existing data. It returns counts and the new revision.

Errors throw `Error` with English user-facing messages. No DOM or browser dialogs belong in core. Empty strings, nulls, fractions, non-finite quantities, and invalid references must be validated before committing. Reads return copies. Dates use `YYYY-MM-DD`; event timestamps use ISO timestamps.

`core/qc-service.js` also exports attachment limits: `PHOTO_MAX_BYTES` (5 MiB), `DOCUMENT_MAX_BYTES` (10 MiB), `ASSET_TOTAL_MAX_BYTES` (30 MiB decoded payload), and `BACKUP_MAX_BYTES` (50 MiB serialized JSON). `core/qc-app.js` exports `createDemoQCService()` for the separate, explicitly labelled demo workspace.

## State

The version-2 IndexedDB schema preserves `settings` and adds `qcState`, containing a single transactional aggregate under key `main`. This keeps related writes atomic for the first local edition. Attachments are bounded data URLs in the aggregate; larger-scale storage is a future adapter change.

State is `{ schemaVersion: 1, revision, families, variants, versions, orders, batches, issues, assets, audit }`. Collections are arrays; IDs are stable strings generated with UUIDs. Initial catalog contains families `s11-s14` and `s15`, models S11–S15, and standard-red and Yellow variants. Display names omit Red. No source version is assumed to be latest until published by staff.

- Family: `{ id, name, models: string[] }`.
- Variant: `{ id, familyId, model, color, label, active }`; `label` is the displayed name. Extra minor variants may be added with a distinct label.
- Operational version: `{ id, familyId, label, sequence, effectiveDate, status, notes, items, createdAt, publishedAt }`. `sequence` is a positive integer unique within the family and determines latest published version. Published versions are immutable; clone them to create a new draft. An imported Lark source version uses `status: "recorded"`, `sequence: null`, `effectiveDate: null`, `createdAt: null`, `publishedAt: null`, and `items: []`; its original facts live in `source` and `sourceRows`. These records are immutable evidence, not Web drafts or published standards. Their source effective timestamp, raw status, exact label, change description, linked spec values, nulls, and attachments metadata remain unnormalized in the source payload. Recorded versions do not participate in operational sequence ordering, batch defaults, or publication.
- Standard item: `{ id, key, no, title, titleZh, specification, specificationZh, devices, factory, stage, models, samplingPercent, recordingRule, important, timeSeconds, procedureUrl }`. `models: []` means all models in the family. `key` is the stable historical comparison identity. Sampling is numeric and independent of the descriptive recording rule. Item IDs remain stable through editing/cloning unless explicitly adding a new item.
- Order: `{ id, number, date, supplier, notes, lines, createdAt }`; line: `{ id, variantId, orderedQty }`. Order numbers are unique. Referenced lines cannot change variant or be removed.
- Operational batch: `{ id, number, orderId, lineId, variantId, familyId, quantity, factory, stage, lotNumber, countForPO, versionId, versionLabel, date, recorder, notes, status, rows, createdAt, releasedAt, attachmentIds? }`. Number is unique. Creation copies applicable standard items into `rows`, adds result fields, and locks the basis. `lotNumber` identifies physical goods for fulfillment de-duplication. At most one released counting batch per lot and variant; non-counting inspection stages contribute zero to PO progress. Omitted `attachmentIds` in older data means no batch documents. Attachments are optional and independent of row photo ownership.
- Batch row: all standard-item fields plus `{ inspectedQty, defectiveQty: null, remarks: '', savedAt: null, photoIds: [] }`. `inspectedQty = ceil(batch.quantity * samplingPercent / 100)` is locked with the row. Defective rate is derived by core; zero inspected quantity gives null rate. Standards and batch identity/quantity are immutable after creation; recorder, date and notes remain editable until release.
- Issue: `{ id, number, title, batchId, rowId, sourceSnapshot, status, owner, disposition, confirmations: ['', '', ''], discussion, createdAt, closedAt }`. Standalone issues use null source IDs; optionally associate them with a batch. A linked issue is unique by batch+row. Discussion entries: `{ id, text, createdAt }`. Closing requires owner, disposition and all three names, then an explicit action. Closed issues are read-only.
- Asset: `{ id, name, mimeType, dataUrl, kind, batchId, rowId, versionId, createdAt }`. Kinds are `photo` or `document`; photographs belong to one batch row. Raster images only for photos. Library documents may associate with a version. Bound file size and overall import size are reported in the UI.
- Audit entry: `{ id, at, action, entityId, summary }`. Business mutations append an event for local traceability; this is not authenticated identity verification.

## Commands

| Type | Data |
| --- | --- |
| `createVariant` | `{ familyId, model, color, label }` |
| `setVariantActive` | `{ id, active }` |
| `createVersion` | `{ familyId, label, sequence, effectiveDate, notes, items }` |
| `saveVersion` | `{ id, label, sequence, effectiveDate, notes, items }` (draft only) |
| `cloneVersion` | `{ id, label, sequence, effectiveDate }` |
| `publishVersion` | `{ id }` (requires valid applicable items) |
| `installAPReferences` | `{}`; retained compatibility command that creates source-labelled draft versions for both families with the four AP OQC rows from the inspected references; idempotent and no synthetic results. The Standards UI does not expose this command; AP `25.10.29` versions are managed as ordinary versions with their original PDFs linked through version-document controls. |
| `importLarkVersionHistory` | `{ package }`; validates the complete bundled source package, then atomically and additively imports immutable `recorded` entries and their exact linked source rows. Deterministic source IDs make identical imports idempotent; any conflicting existing ID rejects the whole command. Retained for source-ingestion compatibility, not exposed in the Standards UI, and never run at startup. |
| `createOrder` | `{ number, date, supplier, notes, lines: [{ variantId, orderedQty }] }` |
| `saveOrder` | `{ id, number, date, supplier, notes, lines: [{ id?, variantId, orderedQty }] }` |
| `createBatch` | `{ number, orderId, lineId, quantity, factory, stage, lotNumber, countForPO, versionId?, date, recorder, notes }`; omitted version selects greatest published sequence in family; no applicable rows is an error |
| `saveBatchDetails` | `{ id, date, recorder, notes }` |
| `saveInspection` | `{ batchId, rowId, defectiveQty, remarks }`; no inspected quantity input |
| `addPhotos` | `{ batchId, rowId, files: [{ name, mimeType, dataUrl }] }` |
| `removePhoto` | `{ batchId, rowId, assetId }` |
| `createIssue` | `{ title, batchId?, rowId? }`; returns existing linked issue for the same row |
| `saveIssue` | `{ id, owner, disposition, confirmations }` |
| `addDiscussion` | `{ id, text }` |
| `closeIssue` | `{ id }` |
| `releaseBatch` | `{ id }`; requires every row saved, recorder present, no open linked issue, explicit action, counting-lot uniqueness; repeated release is idempotent |
| `addDocument` | `{ name, mimeType, dataUrl, versionId? }` |
| `removeVersionAttachment` | `{ versionId, assetId }`; remove a version-document link from any archived, draft, or published version. Delete the asset only if no batch or historical source references it; otherwise clear `versionId` and retain its evidence. Version facts are unchanged. |
| `addBatchAttachment` | `{ batchId, name, dataUrl, mimeType? }`; attach a supported document to an unreleased operational or historical batch |
| `removeBatchAttachment` | `{ batchId, assetId }`; unlink a supplementary document; original historical source associations and released batches are protected |

No deletion of historical batches/orders/versions and no release withdrawal is implemented in the first edition. Unconfirmed release/allocation choices must be settled before their dependent code is finalized.

## Frontend ownership and integration

The root entry becomes `frontend/index.html`, loading `frontend/qc-main.js` and `frontend/qc.css`. Preserve the old initialization page as `frontend/initialization.html` using its existing scripts and settings. Preserve prototype files independently.

Shared UI helpers live in `frontend/qc-ui.js`: safe DOM creation (`el(tag, props, ...children)`), `field(label, input)`, `button(label, handler, className?)`, `showDialog(title, content)`, `closeDialog()`, `notify(message, error?)`, file-to-data-URL and download helpers. Use textContent for user content, never unsanitized HTML. The owner of the main shell provides these helpers.

Each family in the Standards page has one `Versions` list. It displays internally recorded source entries first in source effective-date order, then operational drafts and published versions in numeric sequence order. The shared list is a presentation only: recorded entries remain immutable evidence, while drafts and published versions retain their separate status and actions; co-location does not merge, duplicate, or publish records. Each card places its attachment control beside its label. If no document is linked, the control offers Upload attachment. If one or more are linked, each filename is a compact preview link and upload stays hidden until all are removed. The viewer previews PDFs in a blob-backed iframe, images as images, and text through safe text content; it also offers Download and a confirmed Delete action. Upload uses `addDocument` with the card's version ID, existing supported document types, and the 10 MiB per-document / 30 MiB aggregate limits. `removeVersionAttachment` verifies ownership; it deletes an unreferenced asset or clears `versionId` while preserving assets referenced by batch attachments or historical sources. This does not alter version facts, source evidence, or schema version. Recorded cards show their label, status, effective date, change description, and linked documents. The business UI omits extraction-origin labels, provenance, anomaly details, and raw revision fields. It also omits generated reference notes beginning `Historical source reference draft.` or `masterqc-ap-oqc-reference-25.10.29.` from cards while keeping ordinary staff notes visible. Recorded descriptions may receive display-only line breaks; the `VENTUS` label filter and generated-note omission do not change persisted records or backups.

Admin pages export `renderAdminPage(root, route, ctx)` from `frontend/qc-admin.js`; routes: `catalog`, `standards`, `orders`, `library`, `settings`, `backup`. Both `settings` and `backup` display Backup and restore directly, with a matching bottom-sidebar label. Operations pages export `renderOperationsPage(root, route, ctx)` from `frontend/qc-operations.js`; routes: `batches`, `issues`, `reports`. `ctx` is `{ service, state, navigate(route, id?), refresh(), run(type, data), selectedId }`. `run` executes using current revision, updates the state and renders; errors are displayed without discarding form inputs. Modules may obtain fresh queries from service, but never access storage directly.

`ctx.run` returns `{ ok: true, result }` or `{ ok: false, error }`; modal callers close only on success. File helpers are named `readFileAsDataURL(file)` and `downloadFile(name, contents, mimeType)`.

## Historical batches and source evidence

The optional `state.history` object contains `sources`, `inspections`, and `anomalies`. States and backups without this object remain valid. These collections preserve transcription evidence. Each imported inspection also has a canonical entry in `state.batches`, shown in the same Batches workspace as newly entered inspections. The evidence collection is not a separate user-facing PDF history module.

Historical batches have `kind: 'historical'`, `status: 'historical'`, and `historyInspectionId` equal to their stable source inspection ID and batch ID. The persisted `HIST-...` archive number remains an internal compatibility value for existing backups and validation; it is not the staff-facing name. A shared core display query resolves concise names without modifying persisted state: prefer an explicitly transcribed original batch number, otherwise model/family-date-factory-stage, with short numeric suffixes only for actual collisions. Operational batch numbers entered by staff remain unchanged. Lists, detail headings, search, and reports/CSV use the same resolved name. Family, product label, model, color, factory, stage, date, printed version label, quantity, recorder, notes, and row results preserve the source. Unknown order, order line, variant, design-version entity, and physical lot links remain null. `countForPO` is false and `releasedAt` is null. Historical batches cannot be released or edited through operational result commands. Their preserved evidence must match the original source record.

`attachmentIds` links document assets to batches. Several batches can reference the same original PDF asset without copying the file bytes. New native batches need no attachment. Supplementary attachments may be added to historical batches; their original source PDF association remains intact.

`importHistory(package, expectedRevision)` accepts the compatible wire format `format: 'masterqc-pdf-history'`, `formatVersion: 1`, and arrays `sources`, `inspections`, and `assets`, with optional `versions` (unpublished source-reference drafts) and `anomalies`. Validate the complete graph and original-file SHA-256 values before an atomic, additive import that also creates historical batches. Identical records are skipped; conflicting records reject without replacement. Full-app backup and restore preserve evidence, canonical batches, and attachments. Older history-only backups are upgraded without a manual re-import.

- Source: `{ id, fileName, sha256, pageCount, family, assetId }`, with optional extraction provenance. `family` is `s11-s14` or `s15`; `assetId` points to an original PDF document in the existing asset collection.
- Historical inspection: `{ id, sourceId, page, printedVersion, printedDate, date, productLabel, model, color, factory, stage, batchQuantity, recorder, notes, rows, anomalies }`. Unknown source facts can be null. This schema deliberately permits mixed or unidentified products and source-specific inspection stages without inventing an operational product variant.
- An optional `inspection.originalBatchNumber` may hold an explicitly transcribed source batch number for display. The current 89-record import contains no such field. Display queries never infer this value from PDF filenames, raw text, or technical archive identifiers.
- Historical row: `{ no, title, specification, devices, samplingPercent, recordingRule, timeSeconds, important, sourceInspectedQty, defectiveQty, sourceDefectiveRate, remarks, raw }`. Source values are retained; source inspection quantities and printed percentages are not replaced with formula results. An optional `status: 'missing-from-source'` requires null result fields and `missingEvidence` identifying the applicable check's source.

The Batches list provides status/family/factory/stage filters and an Attachments column. Historical batch detail provides the recorded inspection table and secondary source provenance; any formula comparison is separately labelled. The old `#/history` route redirects to Batches. User-entered new batches continue to use the existing operational commands and validation rules.

The bundled Lark history remains served from the exact allowlisted static path, `/data/lark-import/version-history.v1.json`; the server does not expose the temporary raw exports. The retained core command can import this package, while the Standards page exposes no source-import controls. Full backups and additive restore preserve recorded-version metadata and raw source rows. Backups created before Lark history import remain valid and do not acquire source entries unless the command is explicitly run.

The main page shows usable navigation, storage status, an empty-state starting path (add standards, create order, create batch), and in-context errors. The inspection workspace preserves the dense bilingual source layout and green important rows. White bordered fields are editable; Auto quantities and computed rates are read-only. Each inspection row owns its photos. Printing uses CSS and includes only the selected batch/report. Backups are downloadable JSON with attachments and additive restore validation.
