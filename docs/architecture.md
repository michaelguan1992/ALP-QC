# Architecture and Change Boundaries

## Three Layers

```text
frontend/  HTML / CSS / page interactions
    ↓
core/      business behavior / data-service interface
    ↓
storage/   browser HTTP transport / SQLite adapter / legacy IndexedDB migration
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

## Current Storage

The main app and demo use separate SQLite workspaces managed by the local application service. All browsers using the same `http://127.0.0.1:4173` service read the same selected workspace. The browser HTTP facade preserves the asynchronous core-service interface; the server's `createQCService` validates business commands and expected revisions inside atomic SQLite transactions. The API accepts only explicit application operations, never arbitrary SQL, caller functions, or unrestricted state replacement.

Keep the aggregate state shape and bounded data-URL attachments for this change. This preserves source facts, IDs, backup compatibility, and all-or-nothing business writes without redesigning the domain model. The default production database lives at `data/workspace/masterqc-main.sqlite` inside the project and is eligible for Git so project copies include saved records and attachments. An explicit data-directory override remains available. The demo database and transaction files remain ignored, and the server never serves the workspace directory as static files. SQLite uses DELETE journaling and FULL synchronization. Stop the service before Git or file-copy operations on the database to avoid reading a transaction in progress.

The address stays `http://127.0.0.1:4173`, bound to loopback. Port conflicts fail instead of switching ports. The API validates request Host and Origin, JSON content type, request size, operation, and workspace. This is same-computer sharing, not LAN or cloud hosting.

The existing Dexie version-2 database, including `settings` and `qcState`, is retained unchanged in each browser. The original initialization draft continues to use its settings key. An explicit migration action reads the legacy QC aggregate, produces the full backup format, and invokes validated additive restore into the selected SQLite workspace. The source IndexedDB is not deleted or continuously synchronized. Conflicting records stop restore without partial changes.

Pages show that data is stored on this computer. A lightweight revision check while the page is open detects changes from other clients; stale saves reject and request a reload. The interface preserves unsaved forms until the user chooses how to proceed. The demo remains separate, and the old prototype remains memory-only.

Original PDF ingestion retains an optional historical-evidence section in the aggregate and creates canonical historical entries in `batches`. The batch discriminator separates preserved historical facts from newly entered operational batches. An operational batch belongs to one PO and may include several product allocations, each with its own quantity, locked version, and inspection rows. Core queries normalize existing single-product records without rewriting them. Sampling, issues, comparisons, and PO progress use the row's or allocation's product basis. The core upgrades existing imported evidence atomically and idempotently; the frontend does not maintain a second batch collection or concatenate PDF pages into a separate history product. Optional batch attachment references use the existing document assets. Historical batches do not enter release or PO accounting, and older states/backups remain supported. See [Original PDF Import](pdf-import.md) for transcription and provenance rules.

Storing the first edition as one aggregate keeps writes consistent but is intended for modest local data volumes. It is not a scalable multi-user database. A later adapter may split attachments and indexed entities after migration and backup validation; changing storage must not weaken the existing atomic business operations.

## Service Boundary and Future Multi-Computer Use

```text
Browser frontend → core HTTP service facade → storage HTTP transport
                                     ↓
                         loopback application API
                                     ↓
                    existing core business service
                                     ↓
                      SQLite aggregate adapter
                                     ↓
                       persistent database file
```

SQLite is accessed only by the backend. Ordinary UI edits preserve bindings and do not reset storage. Exported backups include records and attachments. A project copy containing the production database starts with the same saved snapshot. Each computer subsequently writes its own database; Git transfers committed snapshots and does not synchronize live changes. Binary database conflicts require deliberate selection or validated data migration, not an automatic merge. A later shared deployment needs an accessible host, access controls, operational backups, and multi-client conflict handling beyond this loopback scope.
