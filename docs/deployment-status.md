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

## Done

- Code for hosted mode, per-record conflicts, browser drafts, release verification and rollback, tiered backups: merged to `main` through PR #5, plus later documentation and backup commits on `claude/hopeful-curie-uomtp4`.
- Server purchased and reinstalled with Ubuntu 24.04.
- 2026-10-17, on the server (details and exact commands in [Hosted Deployment](deployment.md) sections 1 to 3):
  1. Key login fixed: after the reinstall `/root/.ssh/authorized_keys` was empty, so the owner's ed25519 public key was added through the KiwiVM web console (**Root shell – basic**). All 82 pending updates installed; no reboot needed. Installed `ufw age unzip curl git xz-utils` (the minimal image has no `ufw`, `git`, or `xz-utils`).
  2. Firewall active: incoming denied except 22, 80, and 443 (IPv4 and IPv6); it persists across reboot. SSH accepts keys only (`/etc/ssh/sshd_config.d/00-masterqc.conf`); a fresh key login succeeds and a password-only attempt is refused.
  3. Node.js `22.23.3` (pinned, SHA-256 checked) at `/usr/bin/node`; Caddy `2.11.7` from the official repository (still serving its default page on port 80); AWS CLI `2.38.1` (signature checked). Installer files remain in `/root/install`.
  4. The `masterqc` system user and the directories from section 2 exist.
  5. First release `20261017T054445Z-1268182` (this branch at `1268182`) installed at `/opt/masterqc/current`, streamed with `git archive` from the owner's Mac. There is no clone on the server, and the release has no `data/` or `tmp/` paths. A smoke test on a scratch directory and port 4174 passed (`/healthz` ok, `/api/session` reports the release); the scratch directory was removed.
  - Not done yet: `/etc/masterqc/env`, the systemd units, the Caddyfile, and anything under `/var/lib/masterqc` (empty). The app is not running, and nothing is exposed except Caddy's default page.
- Harmless on this image: `networking.service` shows as failed from first boot because it tries DHCP on `eth1`, the private-network interface, which is not enabled. `eth0` (public) works.

## Next steps, in order

Run these on the server over SSH as root unless stated otherwise. Confirm each step's output before moving on, and explain anything destructive to the owner first.

Steps 1 to 4 (harden and update, install software, service user and directories, first release) are done; see "Done". Never copy `data/workspace/masterqc-main.sqlite` to the server during the trial.

5. **Configure** (sections 4 and 6): `/etc/masterqc/env` with `MASTERQC_PUBLIC_ORIGIN=https://qc.<domain>`, `MASTERQC_DATA_DIR=/var/lib/masterqc`, `MASTERQC_DEMO=off`, `MASTERQC_TRUSTED_USER_HEADER=x-remote-user`; Caddyfile from `deploy/Caddyfile.example` with one Basic Auth account per user (ask the owner for the list; hashes via `caddy hash-password`). Requires the domain's A record to point at the server's IPv4 address.
6. **Start and verify** (sections 6 and 7) with an empty workspace or synthetic data only.
7. **Network trial** (see the hosting report's test plan): ITDOG ping/TCP tests at Beijing evening peak for Telecom, Unicom, and Mobile; real users in mainland China and the US West Coast measure saves, page loads, and 20 MiB uploads in the same week.
8. **Backups**: the owner creates the AWS account, scratch-bucket lock test, production bucket, lifecycle rules, upload-only key, and an `age` key pair (private key never on the server), following "Set up AWS S3 (Singapore)". Then install `/etc/masterqc/backup.env`, enable the timer, confirm one verified upload, and run the restore drill (section 11).
9. **Cutover** (plan's cutover sequence): only after the trial and the restore drill pass.

## Open items

- Domain name and its DNS record.
- List of user accounts for Basic Auth.
- AWS account, bucket name, and `age` key pair.
- An external heartbeat or uptime monitor (for example healthchecks.io) for backup alerts.
- Not implemented: the plan's automatic write block when off-site coverage is stale.
- Not yet verified anywhere real: Caddy configuration (`caddy validate`), systemd units on a real host, backup uploads to S3, the release script as root, the restore drill.
- Decide how `deploy/release.sh` gets code before the first scripted release. It expects a git clone at `/opt/masterqc/repo`, but the repository history contains the production database and real extracts under `tmp/` and `data/pdf-import/`, so a clone would put real data on the server. The script also does not strip `tmp/` or `data/lark-import/` from a release. Any change to the script is code work for a delegate under AGENTS.md.
- Decided 2026-10-17: trial releases do not include `data/lark-import/version-history.v1.json` (the Lark version-history import package, real business data). Its import route then has no package to offer.
- Optional improvement: long-lived caching for static modules (they are currently served with `Cache-Control: no-store`), which would speed up repeat page loads for distant users.
- The phone-width layout overflows horizontally by about 200 px.
