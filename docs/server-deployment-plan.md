# Shared Server Deployment and Data Recovery Plan

Date: 2026-10-14. Status: proposed; no server purchased or deployed, no backup job installed, and no production data moved.

## Confirmed Targets

- Up to 10 people, accessing one shared workspace from the US and mainland China.
- Monthly infrastructure budget: USD 30–60.
- Acceptable loss of saved work after a disaster: at most one hour.
- Proposed recovery-time target: service restored within four hours after an operator responds. This must be demonstrated in a recovery drill; it does not include an unattended overnight response delay.

The one-hour target concerns work committed to the server. Unsaved browser edits have a different failure mode and need separate protection, described below. Periodic backups are an operational recovery target, not a guarantee against every failure.

## Recommended Deployment

Start with one Linux server in Hong Kong, using Alibaba Cloud Simple Application Server as the first candidate and Tencent Cloud Hong Kong as the alternative if measured access or pricing is better. Hong Kong is a candidate compromise between the two user locations; its suitability must be measured on the users' actual connections. Do not commit to an annual subscription before testing.

Target specifications: 2 vCPU, 4 GiB RAM, at least 50 GiB SSD, a fixed public IPv4 address, and enough included outbound transfer for the app and off-site backups. Evaluate a general-purpose plan; avoid the International family, whose explicitly non-China-optimized routes are documented as unsuitable for mainland users. A general-purpose label still does not guarantee acceptable mainland connectivity. Alibaba documents both [Hong Kong instance families](https://www.alibabacloud.com/help/en/simple-application-server/product-overview/instance-families/) and [possible latency and packet loss](https://www.alibabacloud.com/help/en/simple-application-server/user-guide/create-a-server). Final regional availability and prices must be checked in the purchase console.

Use a domain or subdomain such as `qc.<your-domain>`, direct DNS to the server, and HTTPS. Keep browser assets and login protection on this server so normal use does not depend on a separate overseas identity service or externally hosted scripts. Evaluate the direct connection first; add acceleration only if network tests justify it.

The topology is:

```text
US and China browsers
        |
        | HTTPS, individual credentials
        v
Hong Kong server: Caddy -> Node application on loopback
                                  |
                                  v
                     One persistent SQLite database
                                  |
                           Consistent snapshots
                                  |
                                  v
                Encrypted, protected off-site object storage
                  Separate provider/account and region
```

Both countries use the same application and database. Keep one application writer process and local disk storage. Do not run independently writable US and China copies or put the SQLite file on a shared network filesystem. A second running application is unnecessary for the selected recovery target.

For an internet website hosted in mainland China, ICP requirements apply; Alibaba says servers outside mainland China, including Hong Kong, do not require that filing. This is a hosting distinction, not a guarantee of access or a blanket exemption from other obligations. See [Simple Application Server usage notes](https://www.alibabacloud.com/help/en/simple-application-server/product-overview/usage-notes). Mainland hosting is a later option if real Hong Kong access tests fail and the relevant filing prerequisites can be met.

## Changes Required Before Internet Access

The current app is intentionally local. Its server binds to `127.0.0.1:4173`, checks the exact local Host and Origin, and has no authentication. Existing transactional storage and stale-revision rejection are useful foundations, but remote performance and simultaneous use are unverified.

1. **Protect the entire app and API.** Use Caddy automatic HTTPS and individual Basic Auth credentials for this small internal team, with hashed passwords and a documented revocation process. Protect attachment, state, export, and mutation routes as well as the page. Restrict restore and prepared history import to designated administrators at the access layer. Login credentials grant access only; existing manually entered QC confirmation names remain manual business fields. [Caddy HTTPS](https://caddyserver.com/docs/automatic-https), [Basic Auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth).
2. **Configure the public origin explicitly.** Separate the loopback listening address from the allowed public Host and HTTPS Origin. Preserve same-origin protections and reject unexpected origins. Do not solve proxy compatibility by removing validation or blindly trusting forwarded headers. Keep the current local launch mode working.
3. **Separate releases from data.** Put the cloud database in `/var/lib/masterqc/masterqc-main.sqlite`, using the existing `MASTERQC_DATA_DIR` override. Deploy code separately, run Node under an unprivileged service account, and use systemd for automatic restart and boot startup. Allow public HTTP/HTTPS only; limit SSH to administrators and keep port 4173 private. Git updates must never replace the cloud database.
4. **Harden durability and operations.** Retain atomic business/attachment transactions. With the current DELETE journal, evaluate `synchronous=EXTRA` to strengthen power-loss durability; FULL alone has a documented rollback-mode limitation. Test the effect on save latency. Add readiness checks, bounded logs, disk-space monitoring, backup status, and billing/renewal alerts. [SQLite synchronization modes](https://sqlite.org/pragma.html#pragma_synchronous).
5. **Validate simultaneous use and poor connections.** Test two users editing the same batch, users editing different batches, stale revisions, connection loss during a save, refresh, browser restart, and file uploads. The current revision is workspace-wide, so edits to different records can conflict. Preserve drafts and make conflict recovery usable; measure whether this is acceptable at the team's actual save rate before launch. Never blindly retry a potentially committed mutation.
6. **Review capacity before launch.** Current limits are 500 MiB total attachment content, 20 MiB per file in every category, 64 MiB of file content per upload request, and 50 MiB per JSON backup or historical package. Full-content reads and JSON exports above 50 MiB of attachments are refused in favor of the database snapshot. These limits follow the user decision of 2026-10-16; a cloud server does not change them. Measured on 2026-10-16 with a scratch copy of the production database filled to 500 MiB (56 attachments; a 706 MB database file, about 673 MiB, and a snapshot of the same size): a snapshot download took 2.9 s; a validated restore into another directory took 17.2 s with 526 MiB peak RSS; the first business read after start took 5.2 s, with a sampled server peak of 602 MiB RSS; ordinary batch saves over HTTP had a median of 0.32 s (in-process, the same save on the code before the payload-metadata cache took 1.76 s); and a 64 MiB multi-file upload peaked at 802 MiB RSS. Estimate expected new uploads and the daily snapshot storage and transfer before launch, then explicitly agree on any changes. Application, proxy, and backup limits must remain compatible; the proxy must allow upload request bodies of at least 86.3 MiB (90,527,062 bytes).

Concrete code work must be delegated to a Claude Haiku subagent with reasoning effort `max` (Haiku Max), defined ownership and acceptance criteria, as required by AGENTS.md. The primary agent reviews, integrates, and accepts the work. This document does not authorize a purchase or start implementation.

## Backup Policy

Use a consistent snapshot of the complete production SQLite database. It contains records, audit history, and attachment payloads in separate tables within the same file. Use a SQLite-aware online copy in a separate backup process, such as `VACUUM INTO`, which also omits free pages, or the CLI `.backup` operation; do not copy a live database file with ordinary file-copy commands. [SQLite Online Backup API](https://sqlite.org/backup.html).

| Copy | Schedule | Retention | Purpose |
| --- | --- | --- | --- |
| Complete SQLite snapshot, encrypted off-site | Every 30 minutes | 7 days | Recover recent saved work after server/disk failure |
| Selected daily complete snapshot | Daily | 30 days | Recover from delayed discovery of mistakes |
| Selected monthly complete snapshot | Monthly | 12 months | Longer-term recovery history |
| Full application JSON export | Weekly and before changes | 12 weekly copies; pre-change copies at least 30 days | Portable recovery of business records and attachments |
| Separate encrypted offline download | Weekly | 4 weekly copies on another device | Additional recovery path if cloud accounts are unavailable |

Select daily/monthly snapshots from the successful frequent snapshots rather than creating unnecessary duplicate reads. Keep a short local recovery cache for convenience, but count only completed, verified off-site uploads toward the recovery target.

First-choice off-site destination: a private AWS S3 bucket in Singapore, in an account separate from the application provider. Enable versioning and Object Lock with an initial seven-day retention policy. Give the server narrowly scoped upload credentials without delete, retention-bypass, or account-administration permissions. Use unique timestamped object names; lifecycle cleanup runs under separate administration. Validate the lock policy on disposable data before applying it to production. [S3 Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html).

Encrypt snapshots before upload with a public recipient key; keep the private recovery key outside the app server, in a password manager and a second secure recovery location. Keep provider recovery codes and deployment configuration recoverable outside the server too. Protect cloud administrative accounts with MFA. Encryption keys must survive server loss and account-access problems.

Each successful backup records snapshot time, database revision, application release, file size, and a cryptographic checksum. Validate SQLite integrity on the snapshot. Verify upload completion and checksum before advancing the externally monitored success marker. A failed or partial upload must never be marked successful. Keep the previous successful backup.

The independent monitor warns when the newest off-site snapshot's capture time is more than 45 minutes old, or the expected success heartbeat stops. Backup failures retry promptly and alert the owner. Recommend that the application automatically block new writes when verified off-site coverage reaches 55 minutes, or its freshness cannot be established, with saves resuming only after a fresh backup is verified. This gives a margin before the one-hour boundary and prioritizes the requested recovery limit over continuous write availability. Check coverage at the mutation boundary, preserve browser drafts, and test stalled jobs, clock handling, server restart, and transactions already in progress. Without this safeguard, the target can be missed during backup outages. Alerts must come from monitoring outside the app server so complete server failure is detected.

The current checkout's database file is approximately 70 MB on 2026-10-15, but about half of it is free pages left by whole-aggregate rewrites; a compacted snapshot is about 35 MB. At that size, uploading a full uncompressed snapshot every 30 minutes would transfer roughly 50 GB per month and use roughly 12 GB for seven days of frequent copies, before daily/monthly copies. Compression can reduce this, but do not assume a ratio. Include backup uploads when checking the server's outbound-transfer allowance and storage charges.

Do not treat Git commits or a second file on the same disk as disaster recovery. Do not rely solely on provider disk snapshots: use application-consistent database snapshots in a separate failure domain.

## Recovery Procedure and Verification

1. Stop or isolate application writes and preserve the failed/current database for investigation.
2. Provision a replacement server and install the application release recorded in the selected backup. Restore access controls and configuration from the recovery package.
3. Download, verify, and decrypt the newest suitable complete SQLite snapshot. For accidental deletion or a bad release, choose a snapshot from before the problem.
4. Restore into a separate data directory while the service is stopped; run SQLite integrity and application-level checks. Compare revision, record counts, stable IDs, and attachment hashes. Open representative PDFs, photos, and videos.
5. Start the recovered service, confirm login and save/refresh behavior, then update routing if needed. Ensure the old server cannot accept writes. Account for DNS caching in the recovery-time drill.
6. Confirm a fresh off-site backup succeeds, record the actual lost-work window and recovery duration, and notify users which recent records need re-entry.

The existing UI restore is an additive import that rejects conflicting records. It is not a rewind function for a changed production database. Full disaster recovery should restore the complete SQLite snapshot while offline. Use the JSON export in a clean isolated workspace for portable recovery and verification.

Run a restore drill before launch and monthly thereafter. The drill must download an actual off-site object, use the separately stored recovery key, and restore into an empty environment; a successful upload alone is insufficient. Test backup failure alerts, missing heartbeats, and protected-object deletion rejection before launch.

## Unsaved Work

The present workflow saves batch edits on in-app departure and Issue disposition through Save changes. Typing, blur, tab closure, and browser refresh do not save these edits to the server. Backups cannot recover edits that never reached the database.

Propose a separate browser-draft recovery improvement for batch and Issue edits: persist drafts on change to browser-local storage, restore them after an accidental refresh/reopen, clear them only after server acknowledgment or explicit discard, and reconcile stale revisions before submission. Scope drafts to the workspace and access user, and avoid caching attachment bodies or credentials. This does not change the approved server-save workflow. The proposal needs a separate decision because it introduces retained local business data on shared computers. Device loss and cleared browser storage remain outside server backup coverage.

## Cutover Sequence

1. Confirm the domain, team access list, administrator, hosting-account owner, backup/recovery owner, and alert channel. Obtain a current Hong Kong console quote within the budget.
2. Implement the server mode, access controls, operations, backup tooling, and necessary concurrency fixes on the current branch. Run relevant existing checks and dedicated remote acceptance checks against an isolated copy of production.
3. Deploy that isolated copy to a short-term Hong Kong test server. Check DNS, HTTPS, login, batch save/refresh, Issue save, PDF/photo/video access, and uploads from the actual US and mainland China networks, including peak mainland evening hours. Aim for typical field saves within two seconds and page interactions within three seconds; these are provisional acceptance targets, not measured claims.
4. Complete an off-site recovery drill and confirm the one-hour data-loss and four-hour recovery targets are achievable. If China access is poor, compare a Tencent Hong Kong candidate or Singapore using the same tests before moving real usage.
5. Schedule a short cutover window. Have users finish and save edits, stop local writes, export a full JSON backup, and create a consistent final SQLite snapshot. Preserve both locally and off-site.
6. Copy the final authoritative database to the cloud, verify records and attachment hashes, and open the shared URL to the team. Thereafter everyone enters new data through that URL. Retain the old local database as a frozen recovery copy.
7. Verify automatic backups during the first day and monitor saves/conflicts and storage use during the first week. Once the cloud has new writes, rollback must preserve or migrate those writes; starting the old local database would discard them.

## Budget and Remaining Decisions

These are planning allowances, not provider quotes:

| Item | Monthly allowance |
| --- | --- |
| Hong Kong server with disk and adequate outbound transfer | USD 20–40 |
| Off-site backup storage, requests, and incidental transfer | USD 5–10 |
| Domain annual cost averaged monthly | USD 1–2 |
| Monitoring and cost headroom | USD 0–8 |
| Total | USD 26–60 |

Alibaba's [published pricing](https://www.alibabacloud.com/en/product/swas/pricing?_p_lc=1) and [billing documentation](https://www.alibabacloud.com/help/en/simple-application-server/product-overview/billable-items) describe different plan generations; the current Hong Kong purchase console prevails. Check renewal rates, bandwidth, disk/snapshot charges, taxes, and payment eligibility before ordering. Do not base the budget on temporary promotional prices.

Required decisions before execution: domain/account ownership, access credentials and administrator assignment, backup owner and alert destination, capacity limits, and whether browser-draft recovery is wanted. The recommended backup-freshness safeguard trades write availability for the selected recovery limit and should be included in implementation acceptance. Network suitability, cloud/Linux runtime behavior, concurrency, backup uploads, and recovery remain untested. Existing local production data and the running app have not been modified by this planning work.
