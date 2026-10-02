# MasterQC Web

A local QC application built around the familiar inspection table: product variants, family design versions, purchase orders, batch inspection, row and issue evidence, issue disposition, release, reports, and backup. It uses plain HTML, CSS, JavaScript, and a local SQLite application service. Chrome and the in-app browser on the same computer share saved data through that service. Multi-computer hosting is a later phase.

## Initial Setup

Install [Node.js](https://nodejs.org/en/download) version 22.13+ on the 22.x line, 23.4+ on the 23.x line, or 24+ once on each Mac and Windows computer. A supported LTS release is recommended.

Run this once from the project directory:

```sh
npm ci
```

Dependency versions are pinned by `package-lock.json`. The first installation requires network access; after installation, the application does not depend on an external CDN.

## Daily Startup

- Mac: double-click `Start-Mac.command`.
- Windows: double-click `Start-Windows.cmd`.
- On either platform, you can also run `npm start` from the project directory.

Startup opens `http://127.0.0.1:4173` automatically. Keep the startup terminal open, and press Ctrl+C in that window to stop the server. Closing the browser does not stop the local application service.

The local service runs the existing QC business rules and writes to a persistent SQLite database in the project folder. It listens only on this computer. Browser reloads and service restarts retain saved records. If the port is already in use, identify and stop the old instance before continuing. Do not switch ports and continue entering data. The Mac launcher needs executable permission. If a file-copy tool did not preserve it, run this from the project directory:

```sh
chmod +x Start-Mac.command
```

The operating system may ask you to confirm the first time you open a downloaded script; verify that it came from this project.

## Using the App

Open [the local app](http://127.0.0.1:4173/) after starting the server. Existing product families already have standards, so new-batch entry stays available: create a purchase order and batch, then use the latest eligible version or choose an older recorded, published, or superseded version. Publishing a Web draft is only needed when staff create or edit a draft; imported recorded versions remain unchanged. Each AP `25.10.29` family has one recorded entry with its original PDF attached; the verified PDF-derived duplicate is retained only in backup merge evidence.

The app starts with two inspection families and normal/Yellow product variants. A project copy with its production database opens the saved standards, records, and attachments. An empty database does not automatically import standards or create sample purchase orders, inspection results, or confirmation names. The live Lark system is not modified. [The isolated demo workspace](http://127.0.0.1:4173/?workspace=demo) has a separate SQLite workspace and a visible demo banner.

See [User Guide](docs/user-guide.md) for the complete workflow and [Local App Acceptance](docs/app-acceptance.md) for actual verification and outstanding limits.

- Batches lock applicable standards and calculate inspection quantities automatically.
- Each inspection row can own one video, procedure file, and log file. Rows list every linked Issue; Issues preserve a source snapshot and support multiple photo and general-file attachments. Discussion stays separate from formal disposition.
- Manual issue closure requires an owner, disposition, and three entered confirmation names. These names are not authenticated signatures.
- Every new OQC batch counts each product's full quantity toward its PO line after explicit release; IQC and historical records do not contribute.
- Backup exports contain records and attachments. Restore validates the entire backup and rejects conflicting records without partial import.
- Batches includes imported historical inspections and newly entered batches. Optional batch attachments retain original PDFs; historical quantities, printed versions, and missing-check provenance stay intact without inventing release or PO accounting. See [Original PDF Import](docs/pdf-import.md).

Use the fixed local address. All browsers on this computer connect to the same selected workspace. Export backups regularly and before moving computers or changing the service data directory. Attachments allow up to 5 MiB per photo and 10 MiB per video or general file, with 30 MiB total attachment content and 50 MiB per complete JSON backup.

The original [initialization draft](http://127.0.0.1:4173/frontend/initialization.html) is retained separately. The old [AP table prototype](http://127.0.0.1:4173/frontend/prototype.html) remains temporary and resets on refresh; its records are not part of the app. See [Prototype Scope and Review](docs/prototype.md).

## Database Location

The default production database is `data/workspace/masterqc-main.sqlite`. Saved records, original PDFs, row photographs, and audit history are inside this file; it is explicitly eligible for Git. The separate `masterqc-demo.sqlite` and temporary SQLite journals are ignored. The server does not expose database files as static downloads.

`MASTERQC_DATA_DIR` can explicitly override the directory. An external override opens another database and is not included when sharing this project. For independent recovery backups, use the app's full JSON export.

To share a saved snapshot through GitHub:

1. Save app edits and download a full backup.
2. Stop the local service with Ctrl+C before copying or committing its database.
3. Include `data/workspace/masterqc-main.sqlite` with the application changes in the Git commit and upload it.
4. A collaborator downloads/clones that project, runs `npm ci` once, and starts the app. Its saved records and attachments are already present.

Stop the service before pulling or replacing a database as well. Back up local edits first. Git exchanges snapshots; later edits on different computers are independent, and the binary SQLite file cannot be automatically merged. Coordinate which saved database is authoritative before updating it. The configured ALP-QC repository is public, so uploading this file publishes all included business records and attachments.

## Existing Browser Data

Before switching from the older browser-only edition, export **Download full backup** in the populated browser. After starting the SQLite service, open **Backup and restore** in that same browser and use **Migrate data from this browser**, or restore the full exported backup. The service validates the complete data graph, skips identical records, and rejects conflicts without partial changes. Keep the source IndexedDB and backup until records and attachments have been verified.

Migration is a one-time import, not continuing synchronization with IndexedDB. Subsequent saved changes go to SQLite. The original initialization draft remains browser-local, and the disposable prototype still resets on refresh.

## Development Checks

```sh
npm test
```

Start without automatically opening a browser:

```sh
node launcher/server.mjs --no-open
```

## Collaborative Development

When primarily changing the page, edit the HTML, CSS, and interface JavaScript under `frontend/`, then refresh the browser. Preserve the data-binding identifiers in HTML.

Put business rules in `core/` and database implementation in `storage/`. See [Architecture and Change Boundaries](docs/architecture.md) for detailed boundaries and [Requirements and Decisions](docs/requirements.md) for confirmed product rules.

Browsers on one computer share the local service database. Copying the project with its production database includes the saved records and attachments. Two computers then make independent local changes; Git does not provide live synchronization. Full backup restore remains available for validated additive data transfer.

Concrete implementation uses Luna Max subagents; the primary agent coordinates requirements, integration, review, and acceptance. The Lark edition and its live data remain outside this project's mutation scope.

## Verification Boundaries

See [Local App Acceptance](docs/app-acceptance.md) for the current test record. The existing initialization draft has been checked before and after the database upgrade and remains unchanged. Windows startup and browser behavior have not been run on a Windows computer; a Mac check does not verify Windows.
