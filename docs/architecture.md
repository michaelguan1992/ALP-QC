# Architecture and Change Boundaries

## Three Layers

```text
frontend/  HTML / CSS / page interactions
    ↓
core/      business behavior / data-service interface
    ↓
storage/   IndexedDB adapter / Dexie / database upgrades
```

`launcher/` is a local startup tool, not a business backend. The browser loads the three JavaScript layers; records are written to browser-managed IndexedDB, not to the launcher's folder.

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

Dexie is installed with the project, and the local server serves its browser script; the application does not use a runtime CDN. Database version 2 preserves the original `settings` store and adds `qcState`. Catalog, versions, orders, batches, issues, and bounded attachments are stored in a single aggregate document for atomic business operations in this first local edition. The core validates the current revision and all related facts inside the write transaction. Pages never directly write IndexedDB.

The fixed address is `http://127.0.0.1:4173`. A change to the host, protocol, or port changes the website origin. Therefore, a port conflict must produce an error instead of silently choosing another port. Different browsers and browser profiles also have separate storage. Do not use a private browsing window for long-term data.

Database upgrades are handled centrally in `storage/`. Ordinary page changes do not upgrade or clear the database. Backup exports include attachment content. Restore is additive, validates references and conflicts, and never silently replaces existing records. The original initialization draft stays at the same settings key and is available through its retained page.

The default workspace uses `masterqc-web`. An explicit `?workspace=demo` opens the separate `masterqc-web-demo` database with a persistent demo label; neither workspace automatically creates sample orders or results. The old throwaway prototype remains memory-only and independent.

Original PDF ingestion retains an optional historical-evidence section in the aggregate and creates canonical historical entries in `batches`. The batch discriminator separates preserved historical facts from newly entered operational batches, whose one-variant, one-order-line rules remain enforced. The core upgrades existing imported evidence atomically and idempotently; the frontend does not maintain a second batch collection or concatenate PDF pages into a separate history product. Optional batch attachment references use the existing document assets. Historical batches do not enter release or PO accounting, and older states/backups remain supported. See [Original PDF Import](pdf-import.md) for transcription and provenance rules.

Storing the first edition as one aggregate keeps writes consistent but is intended for modest local data volumes. It is not a scalable multi-user database. A later adapter may split attachments and indexed entities after migration and backup validation; changing storage must not weaken the existing atomic business operations.

## Future SQLite Option

```text
Same frontend/ and core/ interfaces
    ↓
HTTP data adapter
    ↓
Small shared backend
    ↓
SQLite file + separate attachment directory
```

The shared backend accesses SQLite; the browser does not open the database file directly. Store the database and attachments in persistent directories outside the deployed application. Interface isolation can reduce page changes, but a future move still requires an API, data migration, and multi-client conflict handling; it is not a one-switch change.

Sharing code across platforms does not sync the current data automatically. A future migration must specify record IDs, versions, and the attachment inventory, then be validated on a copy before switching over.
