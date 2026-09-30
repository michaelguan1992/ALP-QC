# MasterQC Web — Project Guidance

## Getting Started

- Before changing functionality, read [Requirements and Decisions](docs/requirements.md). Web rules follow that document and the user's latest decisions.
- Before changing code, read [Architecture and Change Boundaries](docs/architecture.md). Startup and verification instructions are in [README](README.md) and `package.json`.
- `../MasterQC/` contains Lark edition reference materials. Read it only to check business rules, original PDFs, or historical sources. Do not modify that directory or the live Lark system during Web development.

## Work Assignment

- The user specified that concrete code implementation should be delegated to a subagent using `gpt-6-luna` with reasoning effort `max` (Luna Max). Give each delegate a defined scope, file ownership, and acceptance criteria.
- The primary agent handles requirement clarification, interface design, integration, code review, and acceptance. When broader model coverage is needed, use a subagent that does not inherit the full conversation history and provide the necessary context explicitly.
- If the specified model is unavailable, explain the blocker and ask about an alternative. Do not silently switch models.

## Language Policy

Write all new or modified project documentation and code in English by default. This includes comments, identifiers, diagnostics, tests, launcher output, and UI copy, unless the user explicitly specifies otherwise. Preserve genuine Chinese or bilingual business field labels, source data, and localization content. Do not casually translate persisted keys or binding IDs, or existing Chinese user-facing text, as part of unrelated changes.

## Code Boundaries

- `frontend/` maintains HTML templates, styles, and page interactions; it accesses data through `core/` interfaces.
- `core/` maintains business behavior and stable data interfaces. It does not depend on the DOM or scatter database operations.
- `storage/` handles IndexedDB, database versions, and migrations; a future SQLite backend will connect through an HTTP adapter.
- Keep page text separate from internal field keys. Preserve data-binding identifiers when changing layout, copy, or colors.
- When adding persisted fields, update the data contract. Database upgrades must preserve existing user data; never clear the database on startup or replace it with sample data.

## Verification and Delivery

- Run checks relevant to the change. For storage changes, verify that saved data returns after a page refresh; for launcher changes, check the relevant platform.
- Clearly mark platforms that were not actually run as untested. A successful Mac check does not verify Windows.
- Distinguish sample data from production data. Browser data is not copied or synced automatically with project code.
