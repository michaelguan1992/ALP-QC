# MasterQC Web

A local QC application built around the familiar inspection table: product variants, family design versions, purchase orders, batch inspection, row photographs, issue disposition, release, reports, and backup. It uses plain HTML, CSS, JavaScript, and browser IndexedDB. A shared backend is a later phase.

## Initial Setup

Install [Node.js](https://nodejs.org/en/download) version 22 or later once on each Mac and Windows computer. A supported LTS release is recommended.

Run this once from the project directory:

```sh
npm ci
```

Dependency versions are pinned by `package-lock.json`. The first installation requires network access; after installation, the application does not depend on an external CDN.

## Daily Startup

- Mac: double-click `Start-Mac.command`.
- Windows: double-click `Start-Windows.cmd`.
- On either platform, you can also run `npm start` from the project directory.

Startup opens `http://127.0.0.1:4173` automatically. Keep the startup terminal open, and press Ctrl+C in that window to stop the server. Closing the browser does not stop the static server.

This is a static file server with no business backend; the database runs in the browser. If the port is already in use, identify and stop the old instance before continuing. Do not switch ports and continue entering data. The Mac launcher needs executable permission. If a file-copy tool did not preserve it, run this from the project directory:

```sh
chmod +x Start-Mac.command
```

The operating system may ask you to confirm the first time you open a downloaded script; verify that it came from this project.

## Using the App

Open [the local app](http://127.0.0.1:4173/) after starting the server. Follow the first-run steps: create a family version where needed, review and publish standards, create a purchase order, and create a batch. The existing AP `25.10.29` entries are ordinary versions; use their version-document controls to attach the original PDFs, then review before publication.

The app starts with two inspection families and normal/Yellow product variants. It does not create sample purchase orders, inspection results, or confirmation names. [The isolated demo workspace](http://127.0.0.1:4173/?workspace=demo) has separate browser storage and a visible demo banner.

See [User Guide](docs/user-guide.md) for the complete workflow and [Local App Acceptance](docs/app-acceptance.md) for actual verification and outstanding limits.

- Batches lock applicable standards and calculate inspection quantities automatically.
- Each inspection row owns its photographs. Issues preserve a source snapshot and keep discussion separate from formal disposition.
- Manual issue closure requires an owner, disposition, and three entered confirmation names. These names are not authenticated signatures.
- Only explicitly released, eligible full-batch quantities count toward the selected PO line.
- Backup exports contain records and attachments. Restore validates the entire backup and rejects conflicting records without partial import.
- Batches includes imported historical inspections and newly entered batches. Optional batch attachments retain original PDFs; historical quantities, printed versions, and missing-check provenance stay intact without inventing release or PO accounting. See [Original PDF Import](docs/pdf-import.md).

Use a regular browser profile and the fixed local address. Export backups regularly and before moving computers or clearing browser data. This edition allows up to 5 MiB per photo, 10 MiB per library file, 30 MiB total attachment content, and 50 MiB per complete JSON backup.

The original [initialization draft](http://127.0.0.1:4173/frontend/initialization.html) is retained separately. The old [AP table prototype](http://127.0.0.1:4173/frontend/prototype.html) remains temporary and resets on refresh; its records are not part of the app. See [Prototype Scope and Review](docs/prototype.md).

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

Two computers can share project code, but each browser has its own IndexedDB data. Copying code does not copy or sync records. Backup restore is an explicit operation, not ongoing synchronization.

Concrete implementation uses Luna Max subagents; the primary agent coordinates requirements, integration, review, and acceptance. The Lark edition and its live data remain outside this project's mutation scope.

## Verification Boundaries

See [Local App Acceptance](docs/app-acceptance.md) for the current test record. The existing initialization draft has been checked before and after the database upgrade and remains unchanged. Windows startup and browser behavior have not been run on a Windows computer; a Mac check does not verify Windows.
