# Deployment Status and Next Steps

Last updated: 2026-10-17, after steps 1 to 4 ran on the server. This is the hand-off for the session that operates the server from the owner's Mac. Read it together with [Hosted Deployment](deployment.md), [Shared Server Deployment and Data Recovery Plan](server-deployment-plan.md), and the "Trial Hosting Decisions" in [Requirements and Decisions](requirements.md).

## Decisions already made

- Trust-based first edition: every signed-in user may do everything. Basic Auth accounts keep outsiders out; the signed-in name is recorded in new audit entries.
- Server: BandwagonHost E-Commerce VPS, Los Angeles, datacenter USCA_9 (Coresite LA2), premium routes to all three mainland carriers. 3 vCPU, 2 GiB RAM (plus 1 GiB swap), 38 GB disk, 2 TB/month transfer, billed quarterly. Managed in the KiwiVM panel, which also offers snapshots and free migration to other E-Commerce locations.
- OS: Ubuntu 24.04.4 LTS (x86_64), matching `docs/deployment.md`.
- Access: public IPv4 known to the owner (kept out of this public repository; ask for it), SSH port 22, root login with the owner's ed25519 key. The owner can still use the KiwiVM emergency console if SSH is lost.
- Domain: the owner is buying a `.com` domain; the site will run at a subdomain such as `qc.<domain>` with DNS only (no CDN proxy). Not yet confirmed which domain.
- Off-site backups: AWS S3 in Singapore (`ap-southeast-1`), separate AWS account, Object Lock in compliance mode, tiered uploads by `deploy/masterqc-backup.sh`. Not set up yet.
- Development never uses real data. Trial users enter real data into the hosted database. The production database moves from the repository to the server at cutover, and the repository then stops tracking it.
- The first quarter is a trial: use synthetic data only until the mainland and US tests pass, so the provider's 30-day refund stays possible (it requires low transfer use, and a refund cancels every service on the account).
- **Superseded for the trial on 2026-10-17** ("Fast prototype launch" in the requirements): the prototype went online at once with a copy of the owner's local database, one shared account, a temporary sslip.io address, and no backups. The old system runs in parallel, so trial data loss is acceptable. The domain, personal accounts, and backup items above apply after the trial. A refund within 30 days would still cancel every service on the account, including this server and its data.

## Done

- Code for hosted mode, per-record conflicts, browser drafts, release verification and rollback, tiered backups: merged to `main` through PR #5, plus later documentation and backup commits on `claude/hopeful-curie-uomtp4`.
- Server purchased and reinstalled with Ubuntu 24.04.
- 2026-10-17, on the server (details and exact commands in [Hosted Deployment](deployment.md) sections 1 to 3):
  1. Key login fixed: after the reinstall `/root/.ssh/authorized_keys` was empty, so the owner's ed25519 public key was added through the KiwiVM web console (**Root shell – basic**). All 82 pending updates installed; no reboot needed. Installed `ufw age unzip curl git xz-utils` (the minimal image has no `ufw`, `git`, or `xz-utils`).
  2. Firewall active: incoming denied except 22, 80, and 443 (IPv4 and IPv6); it persists across reboot. SSH accepts keys only (`/etc/ssh/sshd_config.d/00-masterqc.conf`); a fresh key login succeeds and a password-only attempt is refused.
  3. Node.js `22.23.3` (pinned, SHA-256 checked) at `/usr/bin/node`; Caddy `2.11.7` from the official repository (still serving its default page on port 80); AWS CLI `2.38.1` (signature checked). Installer files remain in `/root/install`.
  4. The `masterqc` system user and the directories from section 2 exist.
  5. First release `20261017T054445Z-1268182` (this branch at `1268182`) installed at `/opt/masterqc/current`, streamed with `git archive` from the owner's Mac. There is no clone on the server, and the release has no `data/` or `tmp/` paths. A smoke test on a scratch directory and port 4174 passed (`/healthz` ok, `/api/session` reports the release); the scratch directory was removed.
  6. Trial launch (see "Fast prototype launch" in the requirements): a verified snapshot of the owner's local database (revision 11) was imported with the validated restore; `/etc/masterqc/env` points at the temporary `https://<server IP with dashes>.sslip.io` address; `masterqc.service` is enabled and running; Caddy serves HTTPS (Let's Encrypt) with one shared account `team`, whose password the owner set on the server. Requests without credentials or with a wrong password get `401`. The backup service and timer are not installed.
- Harmless on this image: `networking.service` shows as failed from first boot because it tries DHCP on `eth1`, the private-network interface, which is not enabled. `eth0` (public) works.

## Next steps, in order

The site is live for the trial. Remaining, in order:

1. **Owner's browser check**: open the site, sign in as `team`, open a batch, save a small change, refresh, and confirm it stays.
2. **Network trial** (see the hosting report's test plan): ITDOG ping/TCP tests at Beijing evening peak for Telecom, Unicom, and Mobile; real users in mainland China and the US West Coast measure saves, page loads, and 20 MiB uploads in the same week.
3. **After the trial confirms the system is usable**: buy the domain and move the address, create personal accounts, set up S3 backups and the heartbeat monitor following "Set up AWS S3 (Singapore)", and run the restore drill (section 11).

## Open items

- Deferred until after the trial: a purchased domain, personal Basic Auth accounts, the AWS account with bucket and `age` key pair.
- An external heartbeat or uptime monitor (for example healthchecks.io) for backup alerts.
- Not implemented: the plan's automatic write block when off-site coverage is stale.
- Not yet verified anywhere real: per-person Caddy accounts, the backup units on a real host, backup uploads to S3, the release script as root, the restore drill.
- Decide how `deploy/release.sh` gets code before the first scripted release. It expects a git clone at `/opt/masterqc/repo`, but the repository history contains the production database and real extracts under `tmp/` and `data/pdf-import/`, so a clone would put old copies of real data on the server. The live database is on the server now, so this matters less than before, but `data/lark-import/` must still stay out of releases. The script also does not strip `tmp/` or `data/lark-import/` from a release. Any change to the script is code work for a delegate under AGENTS.md.
- Decided 2026-10-17: trial releases do not include `data/lark-import/version-history.v1.json` (the Lark version-history import package, real business data). Its import route then has no package to offer.
- Optional improvement: long-lived caching for static modules (they are currently served with `Cache-Control: no-store`), which would speed up repeat page loads for distant users.
- The phone-width layout overflows horizontally by about 200 px.
