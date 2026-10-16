# MasterQC Web

A local QC application built around the familiar inspection table: product variants, family design versions, purchase orders, batch inspection, row and issue evidence, issue disposition, release, reports, and backup. It uses plain HTML, CSS, JavaScript, and a local SQLite application service. Chrome and the in-app browser on the same computer share saved data through that service. Multi-computer hosting is a later phase.

## Initial Setup

Install [Node.js](https://nodejs.org/en/download) version 22.13+ on the 22.x line, 23.4+ on the 23.x line, or 24+ once on each Mac and Windows computer. A supported LTS release is recommended.

No package installation is required. The app uses built-in Node.js modules and local browser files.

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

- Batches lock applicable standards and calculate inspection quantities automatically. Leaving inspection within the app automatically saves all modified results and batch details together; field editing does not autosave. Failed saves keep the page open with an explanatory error. Issue disposition uses **Save changes**. Unsaved Issue exits offer Save, Discard, or Cancel. Browser refresh and tab closing warn about unsaved edits without saving.
- Each inspection row can own one video, procedure file, and log file. Rows list every linked Issue; Issues preserve a source snapshot and support multiple photo and general-file attachments. Discussion stays separate from formal disposition.
- Manual issue closure requires an owner, disposition, and three entered confirmation names. These names are not authenticated signatures.
- Every new OQC batch counts each product's full quantity toward its PO line after explicit release; IQC and historical records do not contribute.
- Database snapshots contain records and attachments and restore with the service stopped. Earlier JSON backups restore additively and reject conflicting records without partial import.
- Batches includes imported historical inspections and newly entered batches. Historical inspection quantities, defect counts, and actual elapsed seconds can be corrected; rates are derived, while printed values, standard time, original PDFs, and missing-check provenance stay intact. Historical records remain excluded from release and PO fulfillment. See [Original PDF Import](docs/pdf-import.md).

Use the fixed local address. All browsers on this computer connect to the same selected workspace. Download a database snapshot regularly and before moving computers or changing the service data directory. Attachments allow up to 20 MiB per file in every category, with 500 MiB of attachment content in total. One upload carries up to 64 MiB of files; add larger sets in several uploads. JSON backup files stay limited to 50 MiB, so larger workspaces move as database snapshots.

## Database Location

The default production database is `data/workspace/masterqc-main.sqlite`. Saved records, original PDFs, row photographs, and audit history are inside this file. Attachment payloads are stored separately from business JSON and loaded on demand. Existing inline databases upgrade atomically with a recovery copy; it is explicitly eligible for Git. The separate `masterqc-demo.sqlite` and temporary SQLite journals are ignored. The server does not expose database files as static downloads.

`MASTERQC_DATA_DIR` can explicitly override the directory. An external override opens another database and is not included when sharing this project.

## Backup and Restore

- **Download database snapshot** (Backup and restore page) saves a complete SQLite copy of the workspace: business records, attachments, and revision. The file is named `masterqc-main-<UTC time>.sqlite`. It can be downloaded while the app runs and is unaffected by later edits.
- **Restore a snapshot** replaces a whole workspace. Stop the service first (press Ctrl+C in its terminal), then run from the project folder:

  ```sh
  node launcher/restore-snapshot.mjs /path/to/masterqc-main-20261016T120000Z.sqlite
  ```

  Add `--workspace demo` to restore the demo workspace instead. Before changing anything, the command copies the snapshot, runs SQLite's integrity check, opens it with the current code, validates every business record, and verifies the MIME type, size, and SHA-256 of every attachment and historical PDF. It then keeps the current database as `data/workspace/masterqc-main.sqlite.before-snapshot-restore-<UTC time>.sqlite` and swaps in the validated copy. The kept file is never deleted. The command refuses to run while MasterQC Web listens on 127.0.0.1:4173 or while SQLite journal files sit next to the database. On failure it leaves the live database unchanged and exits with a non-zero status. Start MasterQC Web again afterwards.
- **Restore a JSON backup from the earlier format** imports an older full JSON backup into the running workspace. It is additive: identical records are skipped, and conflicts stop the import without changes.

> **Warning:** GitHub rejects files larger than 100 MB. Attachments are stored as base64 text, so the database passes that size at roughly 70 MiB of attachments. After that, sharing `data/workspace/masterqc-main.sqlite` through Git stops working. Use **Download database snapshot** or the shared server instead.

To share a saved snapshot through GitHub:

1. Save app edits and download a database snapshot.
2. Stop the local service with Ctrl+C before copying or committing its database.
3. Compact the database from the project directory. Every save rewrites the business records, so the file accumulates free pages that can still hold deleted content; compaction removes them and roughly halves the file:

   ```sh
   node -e "new (require('node:sqlite').DatabaseSync)('data/workspace/masterqc-main.sqlite').exec('VACUUM')"
   ```

4. Include `data/workspace/masterqc-main.sqlite` with the application changes in the Git commit and upload it.
5. A collaborator downloads/clones that project and starts the app with a supported Node.js installation. Its saved records and attachments are already present.

Stop the service before pulling or replacing a database as well. Back up local edits first. Git exchanges snapshots; later edits on different computers are independent, and the binary SQLite file cannot be automatically merged. Coordinate which saved database is authoritative before updating it. The configured ALP-QC repository is public, so uploading this file publishes all included business records and attachments.

## Existing Browser Data

The current app uses SQLite and no longer offers direct browser migration. To import an existing full JSON backup from the older browser-only edition, open **Backup and restore**, select the file under **Restore a JSON backup from the earlier format**, and choose **Validate and restore backup**. The service validates the complete data graph, skips identical records, and rejects conflicts without partial changes. Preserved source IndexedDB data is not deleted.

Saved changes go to SQLite. The retired initialization draft and AP table prototype pages and their dedicated files have been removed; existing browser data is not cleared.

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

Browsers on one computer share the local service database. Copying the project with its production database includes the saved records and attachments. Two computers then make independent local changes; Git does not provide live synchronization. Snapshot restore (service stopped) and additive JSON restore remain available for data transfer.

Concrete implementation uses Luna Max subagents; the primary agent coordinates requirements, integration, review, and acceptance. The Lark edition and its live data remain outside this project's mutation scope.

## Verification Boundaries

See [Local App Acceptance](docs/app-acceptance.md) for the current test record. Windows startup and browser behavior have not been run on a Windows computer; a Mac check does not verify Windows.
