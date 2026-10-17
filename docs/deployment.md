# Hosted Deployment (Ubuntu 24.04)

> **Status: NOT yet tested on a real server.** The code paths were checked locally: unit tests, `systemd-analyze verify` on the unit files, an `age` round trip, and the hosted server started with the production settings on a development machine. The steps below have not been run on Ubuntu 24.04, behind Caddy, with real S3 storage, or in a restore drill. Treat them as a draft until the restore drill in section 9 passes on a disposable server.

This setup runs one Node process and one SQLite database on one Linux server. Caddy terminates HTTPS and enforces individual Basic Auth accounts. Encrypted snapshots go to off-site object storage every 30 minutes. The decision record is [Shared Server Deployment and Data Recovery Plan](server-deployment-plan.md). This guide does not authorize a purchase.

The repository is public. Use placeholders in every file you create on the server, and keep real hashes, keys, and tokens in your password manager.

## 0. Before you start

- Point a DNS record such as `qc.example.com` at the server's public IPv4 address, and wait for it to resolve.
- Prepare one bcrypt password hash per user (section 6), an S3 bucket with versioning and Object Lock in a separate account, and an `age` key pair. The private key stays off the server.

## 1. Install the software

```sh
sudo apt-get update
sudo apt-get install -y age unzip curl
```

Install Node.js 22, pinned. `22.22.0` is the version used for local tests; check for the latest 22.x security release first:

```sh
NODE_VERSION=22.22.0
curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
grep " node-v${NODE_VERSION}-linux-x64.tar.xz$" SHASUMS256.txt | sha256sum -c -
sudo tar -xJf "node-v${NODE_VERSION}-linux-x64.tar.xz" -C /opt
sudo ln -sfn "/opt/node-v${NODE_VERSION}-linux-x64/bin/node" /usr/bin/node
node --version
```

If a distribution `nodejs` package is installed, remove it first so that `/usr/bin/node` is the pinned build.

Install Caddy from the official Debian and Ubuntu repository ([instructions](https://caddyserver.com/docs/install#debian-ubuntu-raspbian)) and AWS CLI v2 from the [official installer](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html).

## 2. Create the service user and directories

```sh
sudo useradd --system --home-dir /var/lib/masterqc --shell /usr/sbin/nologin masterqc
sudo install -d -o masterqc -g masterqc -m 0750 /var/lib/masterqc
sudo install -d -o masterqc -g masterqc -m 0700 /var/lib/masterqc-backups /var/lib/masterqc-backups/staging
sudo install -d -o root -g root -m 0755 /opt/masterqc /opt/masterqc/releases
sudo install -d -o root -g masterqc -m 0750 /etc/masterqc
```

## 3. Install a release

Deploy from a tagged commit. Exclude the committed production database and the PDF import sources, which the server does not serve:

```sh
RELEASE=2026-10-17-1
sudo install -d -m 0755 "/opt/masterqc/releases/$RELEASE"
git archive --format=tar <tag> | sudo tar -x -C "/opt/masterqc/releases/$RELEASE"
sudo rm -rf "/opt/masterqc/releases/$RELEASE/data/workspace" "/opt/masterqc/releases/$RELEASE/data/pdf-import"
sudo ln -sfn "/opt/masterqc/releases/$RELEASE" /opt/masterqc/current
```

Replace `<tag>` with the release tag. A new release is a new directory followed by a changed `current` link. Never copy the database into a release directory.

## 4. Configure the service and backups

Copy the service settings and fill in the public origin:

```sh
sudo install -m 0640 -o root -g masterqc /opt/masterqc/current/deploy/env.example /etc/masterqc/env
sudoedit /etc/masterqc/env
```

Create the backup settings file. Only root may read it:

```sh
sudo install -m 0600 -o root -g root /dev/null /etc/masterqc/backup.env
sudoedit /etc/masterqc/backup.env
```

Required lines (names only; values come from your password manager, and EnvironmentFile values take no quotes):

```text
MASTERQC_BACKUP_S3_BUCKET=<bucket>
MASTERQC_BACKUP_S3_PREFIX=masterqc
MASTERQC_BACKUP_AGE_RECIPIENT=age1<public key>
AWS_ACCESS_KEY_ID=<upload-only access key>
AWS_SECRET_ACCESS_KEY=<secret>
AWS_DEFAULT_REGION=<bucket region>
MASTERQC_BACKUP_HEARTBEAT_URL=<optional external heartbeat URL>
```

The upload credentials need `s3:PutObject` and `s3:GetObject` (for the size check) and nothing else. They must not allow deletion.

## 5. Import the first data

Stop the service before any database change:

```sh
sudo systemctl stop masterqc 2>/dev/null || true
```

On the current computer, open **Backup and restore** and choose **Download database snapshot**. Copy the file to the server, make it readable by the service user, and run the validated restore as that user:

```sh
sudo install -m 0600 -o masterqc -g masterqc ./masterqc-main-<UTC time>.sqlite /var/lib/masterqc-backups/import.sqlite
sudo -u masterqc env MASTERQC_DATA_DIR=/var/lib/masterqc \
  node /opt/masterqc/current/launcher/restore-snapshot.mjs /var/lib/masterqc-backups/import.sqlite
sudo rm -f /var/lib/masterqc-backups/import.sqlite
```

The restore checks SQLite integrity, the MasterQC format, and every attachment digest before it writes `/var/lib/masterqc/masterqc-main.sqlite`. Do not copy the file by hand, because that skips these checks. `restore-snapshot.mjs` refuses to run while something listens on `127.0.0.1:4173`, but that check is hard-coded to that port. Always stop the service first.

## 6. Start the services

```sh
sudo install -m 0644 /opt/masterqc/current/deploy/masterqc.service /etc/systemd/system/masterqc.service
sudo install -m 0644 /opt/masterqc/current/deploy/masterqc-backup.service /etc/systemd/system/masterqc-backup.service
sudo install -m 0644 /opt/masterqc/current/deploy/masterqc-backup.timer /etc/systemd/system/masterqc-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now masterqc.service
curl -fsS http://127.0.0.1:4173/healthz
```

Caddy serves HTTPS and Basic Auth. Create one hash per user with `caddy hash-password`, then paste the hashes into the file:

```sh
sudo cp /opt/masterqc/current/deploy/Caddyfile.example /etc/caddy/Caddyfile
sudoedit /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Open only the ports you need. Restrict SSH to administrator addresses where possible. Port 4173 stays on loopback:

```sh
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Start the backup timer, run one backup now, and check its log:

```sh
sudo systemctl enable --now masterqc-backup.timer
sudo systemctl start masterqc-backup.service
journalctl -u masterqc-backup.service -n 50 --no-pager
```

A successful run prints `Verified ...` for each upload, then `Success heartbeat delivered.` when a heartbeat URL is set.

## 7. Verify the first deployment

- `https://qc.example.com` asks for Basic Auth. A wrong password is refused.
- Save a batch edit, refresh the page, and confirm the value remains.
- `https://qc.example.com/?workspace=demo` shows no demo data. The demo API returns `404` with `workspace_not_found`.
- On the server, `curl -sS -o /dev/null -w '%{http_code}\n' -H 'Host: qc.example.com' -X POST -H 'Content-Type: application/json' --data '{}' http://127.0.0.1:4173/api/qc/main/initialize` prints `403`, because the request has no Origin.
- The bucket holds one `.sqlite.age` object and one `.json` manifest per run, with versioning and Object Lock enabled.

## 8. Operate the service

- Logs: `journalctl -u masterqc -f` for the app (one line per API and health request), `journalctl -u caddy -f` for the proxy.
- Stop: `sudo systemctl stop masterqc`. The server finishes in-flight requests for up to 10 seconds, then closes.
- Add or remove a user: edit `basic_auth` in `/etc/caddy/Caddyfile`, run `caddy validate`, then `systemctl reload caddy`. Removing a line revokes that account.
- Update the release: deploy a new release directory (section 3), then `sudo systemctl restart masterqc`. Take a Backup-page snapshot first.
- Watch disk usage on `/var/lib/masterqc` and `/var/lib/masterqc-backups`. The plan requires disk and billing alerts from outside this server.

## 9. Restore drill (required before launch and monthly after)

Run the drill on a disposable server with its own data directory. Never restore over production.

1. Download the newest object and its manifest from the bucket: `aws s3 cp s3://<bucket>/<prefix>/<name>.sqlite.age .` and the matching `.json`.
2. Decrypt with the recovery private key, which stays outside the server: `age -d -i recovery-key.txt -o restored.sqlite <name>.sqlite.age`.
3. Compare `sha256sum restored.sqlite` with the `sha256` field in the manifest.
4. Restore into an empty data directory with the service stopped. The service user must be able to read the file, so copy it into the drill directory first:

   ```sh
   sudo install -d -o masterqc -g masterqc -m 0750 /var/lib/masterqc-drill
   sudo install -m 0600 -o masterqc -g masterqc restored.sqlite /var/lib/masterqc-drill/import.sqlite
   sudo -u masterqc env MASTERQC_DATA_DIR=/var/lib/masterqc-drill \
     node /opt/masterqc/current/launcher/restore-snapshot.mjs /var/lib/masterqc-drill/import.sqlite
   ```

5. Start a drill instance on that directory, then check the revision, record counts, and an attachment:

   ```sh
   sudo -u masterqc env MASTERQC_DATA_DIR=/var/lib/masterqc-drill MASTERQC_LISTEN_PORT=4174 MASTERQC_DEMO=off \
     node /opt/masterqc/current/launcher/server.mjs --no-open
   curl -fsS http://127.0.0.1:4174/healthz
   ```
6. Record the elapsed time and the most recent saved work that was lost, and confirm both with the owner.

## 10. Known limits and open items

- `restore-snapshot.mjs` checks only `127.0.0.1:4173` before it swaps the database. If you change `MASTERQC_LISTEN_PORT`, stop the service with `systemctl` before any restore, and fix the script's check.
- Backups read the live database. A large `VACUUM INTO` plus `integrity_check` can hold a read lock long enough for saves to wait on the 5-second busy timeout. Measure this on the real server.
- SQLite calls are synchronous in Node, so while a snapshot is copied the whole app pauses, including `/healthz`. A monitor that polls health checks should allow a few seconds of slack.
- The Caddy and systemd files were checked only for syntax (`systemd-analyze verify`; Caddy validation was not run). Run `caddy validate` before reloading.
- The S3 bucket's versioning, Object Lock, upload-only credentials, and heartbeat monitor are configured outside this repository.
- Not implemented: the plan's recommended automatic write block when off-site coverage is older than 55 minutes, and alerts from outside the server.
- The frontend's offline message still names `http://127.0.0.1:4173`. Hosted users see it only if the service is unreachable.
- Hosted mode also accepts requests to `127.0.0.1:4173` without Basic Auth, because loopback is how Caddy and local tools reach the app. Any local account on the server can therefore use the app directly. Keep shell access limited to administrators.
- Basic Auth controls access only. The app keeps its manual confirmation names and does not identify users.
