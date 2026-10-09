# Architecture and Change Boundaries

## Three Layers

```text
frontend/  HTML / CSS / page interactions
    ↓
core/      business behavior / data-service interface
    ↓
storage/   browser HTTP transport / SQLite adapter
```

`launcher/` starts a loopback application service and serves the allowlisted static frontend. Browser operations cross a same-origin HTTP interface; the server executes the existing core service and stores records in SQLite. The browser does not open the SQLite file directly.

The core module decomposition is described in [Core Business Design](core-business-design.md). The complete local edition follows [Local App Contract](app-contract.md), which defines command inputs, state, transactional storage, and backup behavior.

## Where Changes Belong

| Change | Primary location | Does it affect persisted structure? |
| --- | --- | --- |
| Fonts, colors, spacing, column widths, print layout | CSS under `frontend/` | No |
| Titles, headers, button copy, and row templates | HTML under `frontend/` | No; preserve binding identifiers |
| Expanding attachments, switching views, and save messages | JavaScript under `frontend/` | Usually no |
| Calculation rules, issue state transitions, and version selection | `core/` | Check behavior for historical impact |
| Adding a field that must be saved | Data interface and `storage/` | Yes; keep existing data compatible |
| Replacing the database or connecting shared service | `storage/` adapter and backend | Yes; isolate through a stable interface |

Dynamic repeated inspection rows use HTML templates so they are easy to edit directly. A visible name is not an internal field key; layout changes must not change business record IDs. Database errors pass through the data layer, and the interface reports failure rather than pretending that a save succeeded.

New Issue creation validates and persists the manually entered `reportedBy` name in core. The aggregate validator accepts older Issues without this field, while validating it when present. The field travels through existing queries, SQLite persistence, and backup restore without a schema reset or synthetic backfill.

New Issue creation may initialize the existing `owner` field from an optional disposition owner; it does not add a separate attribution field. Issue photo thumbnails resolve Issue-owned evidence independently from immutable source-row photo references. These display and command changes preserve existing assets and snapshots without a migration.

## Current Storage

The main app and demo use separate SQLite workspaces managed by the local application service. All browsers using the same `http://127.0.0.1:4173` service read the same selected workspace. The browser HTTP facade preserves the asynchronous core-service interface; the server's `createQCService` validates business commands and expected revisions inside atomic SQLite transactions. The API accepts only explicit application operations, never arbitrary SQL, caller functions, or unrestricted state replacement.

SQLite stores business JSON separately from attachment payloads in the same database. Business assets retain stable IDs, ownership metadata, and content references; browser state and ordinary command transactions use metadata without rebuilding every Data URL. Attachment content is read on demand. Full service reads and JSON backup exports preserve the original complete aggregate format, including bounded Data URLs, for compatibility. The default production database lives at `data/workspace/masterqc-main.sqlite` inside the project; an explicit data-directory override remains available. The demo database and transaction files remain ignored, and the server never serves the workspace directory as static files. SQLite uses DELETE journaling and FULL synchronization. Stop the service before Git or file-copy operations on the database to avoid reading a transaction in progress.

The address stays `http://127.0.0.1:4173`, bound to loopback. Port conflicts fail instead of switching ports. The API validates request Host and Origin, JSON content type, request size, operation, and workspace. This is same-computer sharing, not LAN or cloud hosting.

Legacy IndexedDB data is left untouched in each browser. The retired initialization draft, AP table prototype, and their dedicated modules have been removed. The app no longer includes Dexie or exposes direct browser migration or reads legacy QC data. Existing full JSON backups remain compatible with validated additive restore into the selected SQLite workspace. The source IndexedDB is not deleted or continuously synchronized. Conflicting records stop restore without partial changes.

Pages show that data is stored on this computer. A lightweight revision check while the page is open detects changes from other clients; stale saves reject and request a reload. Batch detail automatically saves all modified inspection rows and metadata in one transaction before in-app departure, without a Save changes button. Departure waits for acknowledgment, including newer edits made during saving; failures preserve the page and drafts with an explanatory error. Issue detail has one manual disposition save. Input, change, blur, and input pauses never write these fields. Save responses carry the acknowledged revision and saved-record projections, so successful field saves update local state without full-state reloads or duplicate queries. Draft generations preserve typing that occurs during a save. Partial numeric results persist as null; failed or invalid edits remain local. Unsaved Issue disposition changes require Save, Discard, or Cancel before navigation and consequential actions. Batch departure and guarded release/deletion automatically flush edits. Native browser unload protection covers tab closing/reloading without saving. Discussion and attachments remain independent explicit operations. The demo remains separate.

Original PDF ingestion retains an optional historical-evidence section in the aggregate and creates canonical historical entries in `batches`. The batch discriminator separates immutable imported facts from editable current results on historical rows. Inspected quantity, defective quantity, and actual elapsed time can be corrected through the existing atomic batch-save command; rate is derived. Printed values, standard `timeSeconds`, the source rows, and original PDF remain unchanged. Historical rows use the existing row-attachment slots and Issue workflow, while historical batches cannot be deleted or released and do not enter PO accounting. An operational batch belongs to one PO and may include several color allocations of one model, each with its own quantity, locked version, and inspection rows. Core queries normalize existing single-product records without rewriting them. Sampling, issues, comparisons, and PO progress use the row's or allocation's product basis. The core upgrades existing imported evidence atomically and idempotently; the frontend does not maintain a second batch collection or concatenate PDF pages into a separate history product. Optional batch attachment references use the existing document assets. Older states and backups remain supported. See [Original PDF Import](pdf-import.md) for transcription and provenance rules.

Business records remain one aggregate and are intended for modest local data volumes. Graph validation still checks every business association and asset link. Validated stored-content metadata avoids repeated payload parsing; incoming and restored Data URLs receive complete validation. Attachment and business changes commit together, with cache trust refreshed for changed payload generations and different clients. Existing inline databases upgrade atomically with recovery preserved; schema conversion must retain full-state equality, IDs, revisions, historical facts, and attachment bytes. Full backups and restore remain deliberately more expensive than ordinary field saves because they process every payload. This remains a local application, not a scalable multi-user database.

## Service Boundary and Future Multi-Computer Use

```text
Browser frontend → core HTTP service facade → storage HTTP transport
                                     ↓
                         loopback application API
                                     ↓
                    existing core business service
                                     ↓
                 SQLite business / attachment adapter
                                     ↓
                       persistent database file
```

SQLite is accessed only by the backend. Ordinary UI edits preserve bindings and do not reset storage. Exported backups include records and attachments. A project copy containing the production database starts with the same saved snapshot. Each computer subsequently writes its own database; Git transfers committed snapshots and does not synchronize live changes. Binary database conflicts require deliberate selection or validated data migration, not an automatic merge. A later shared deployment needs an accessible host, access controls, operational backups, and multi-client conflict handling beyond this loopback scope.
