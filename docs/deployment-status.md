# Deployment Status and Next Steps

Last updated: 2026-10-17. This is the hand-off for the session that operates the server from the owner's Mac. Read it together with [Hosted Deployment](deployment.md), [Shared Server Deployment and Data Recovery Plan](server-deployment-plan.md), and the "Trial Hosting Decisions" in [Requirements and Decisions](requirements.md).

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
- Server purchased and reinstalled with Ubuntu 24.04; key login works.

## Next steps, in order

Run these on the server over SSH as root unless stated otherwise. Confirm each step's output before moving on, and explain anything destructive to the owner first.

1. **Harden and update** (deployment.md has no section for this yet):
   - `apt-get update && apt-get -y upgrade`; install `ufw age unzip curl git`.
   - `ufw allow 22/tcp`, `80/tcp`, `443/tcp`; `ufw --force enable`. Ports 80 and 443 must stay open to everyone for certificate issuance and renewal.
   - Disable password login with `/etc/ssh/sshd_config.d/00-masterqc.conf` (`PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PermitRootLogin prohibit-password`), check with `sshd -t`, reload, and verify a fresh key login before closing the existing session.
2. **Install software** (deployment.md section 1): pinned Node.js 22, Caddy from the official repository, AWS CLI v2.
3. **Service user and directories** (section 2).
4. **Install the first release** (section 3) from the current `main` or this branch after it is merged. Never copy `data/workspace/masterqc-main.sqlite` to the server during the trial.
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
- Optional improvement: long-lived caching for static modules (they are currently served with `Cache-Control: no-store`), which would speed up repeat page loads for distant users.
- The phone-width layout overflows horizontally by about 200 px.
