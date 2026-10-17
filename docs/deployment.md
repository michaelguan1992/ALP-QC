# Hosted Deployment (Ubuntu 24.04)

> **Status: NOT yet tested on a real server.** The code paths were checked locally: unit tests, `systemd-analyze verify` on the unit files, an `age` round trip, and the hosted server started with the production settings on a development machine. The release script (`deploy/release.sh`) and its verification checks were exercised only by the automated tests, with a stub service manager and synthetic data; they have not run on Ubuntu 24.04 with systemd, Caddy, or real S3 storage. The steps below have not been run on Ubuntu 24.04, behind Caddy, with real S3 storage, or in a restore drill. Treat them as a draft until the restore drill in section 11 passes on a disposable server.

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

Replace `<tag>` with the release tag. Use this manual procedure for the first installation only. Later releases use `deploy/release.sh` (section 9), which creates the new directory and switches the `current` link after verification. Never copy the database into a release directory.

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

### Operator names and release identity

- `MASTERQC_TRUSTED_USER_HEADER=x-remote-user` (in `env.example`) names the request header that Caddy fills with the Basic Auth user name. The application records that name as `actor` on each audit entry that a request creates, so the audit trail shows who made a change. The header counts only for hosted requests from this computer, and Caddy overwrites any value that a browser sends (see `deploy/Caddyfile.example`). Leave the setting empty to record no operator. The name is for the audit trail only; it does not grant or limit access.
- Each release directory holds a `RELEASE` file that `deploy/release.sh` writes as `<UTC time>-<short commit>`. `GET /api/session` reports that value as `release`. `MASTERQC_RELEASE_ID` overrides the file. Without either, the package version is reported.

## 5. Import the first data

Stop the service before any database change:

```sh
sudo systemctl stop masterqc 2>/dev/null || true
```

On the current computer, open **Backup and restore** and choose **Download database snapshot**. Copy the file to the server, make it readable by the service user, and run the validated restore as that user:

```sh
sudo install -m 0600 -o masterqc -g masterqc ./masterqc-main-<UTC time>.sqlite /var/lib/masterqc-backups/import.sqlite
sudo -u masterqc sh -c 'set -a; . /etc/masterqc/env; set +a; node /opt/masterqc/current/launcher/restore-snapshot.mjs /var/lib/masterqc-backups/import.sqlite'
sudo rm -f /var/lib/masterqc-backups/import.sqlite
```

The restore checks SQLite integrity, the MasterQC format, and every attachment digest before it writes `/var/lib/masterqc/masterqc-main.sqlite`. Do not copy the file by hand, because that skips these checks. The command reads the same settings as the service (`MASTERQC_DATA_DIR`, `MASTERQC_LISTEN_HOST`, and `MASTERQC_LISTEN_PORT`), so the sourced environment file above makes it check the configured port. It refuses to run while the service listens there. Always stop the service first.

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
- Update the release: run `deploy/release.sh` as section 9 describes. Do not copy a release directory and restart by hand, because the script verifies each release before it goes live.
- Watch disk usage on `/var/lib/masterqc` and `/var/lib/masterqc-backups`. The plan requires disk and billing alerts from outside this server.

## 9. Releasing a new version

`deploy/release.sh` installs a release only after the new code proves itself against a fresh copy of production. Run it as root from the release that is running now:

```sh
sudo /opt/masterqc/current/deploy/release.sh <git-ref>
```

`<git-ref>` is a tag, a commit, or a branch name; a branch resolves to `origin/<branch>`. The script needs the clone at `/opt/masterqc/repo` (created with `git clone` once), a running service, and the `current` link from section 3. The steps are:

1. It fetches the clone and extracts the ref into `/opt/masterqc/releases/<UTC time>-<short commit>/`. It writes the `RELEASE` file and removes the tracked database and the PDF import sources from that copy. A release never contains the production database.
2. It reads the record counts from the running service over loopback. It then takes a snapshot with `scripts/backup-snapshot.mjs` from the running release, and keeps that snapshot in `/var/lib/masterqc-backups/pre-release/`. The script never deletes that directory. If saves change the revision while the snapshot is taken, it tries again, up to three times.
3. It copies the snapshot into a fresh directory under `/var/lib/masterqc-backups/verify/` and starts the new release there on `127.0.0.1:4180`, as the `masterqc` account. `scripts/verify-release.mjs` then checks the following. `/healthz` answers. The startup upgrades succeed. `batches`, `issues`, `orders`, and `assets` keep exactly their counts. Every other record collection keeps at least its count. Each attachment reads back at its recorded decoded size. The verification server stops and its copy is deleted.
4. Only after verification passes does it point `previous` at the running release and `current` at the new one, then restart `masterqc`. It waits up to 60 seconds for `/healthz` and for `/api/session` to report the new `release`. If the new service does not become healthy, the script points `current` back at the previous release, restarts, and prints the restore command from section 10.
5. It keeps the five newest releases. It never removes the current or the previous release.

A failure before step 4 leaves production untouched. The script prints the reason and exits with status 1. A verification failure also prints the pre-release snapshot path. The first release of a new installation is installed by hand (section 3). Later releases use the script.

Optional settings for the script: `MASTERQC_ROOT` (default `/opt/masterqc`), `MASTERQC_DATA_DIR` (default `/var/lib/masterqc`), `MASTERQC_BACKUPS_DIR` (default `/var/lib/masterqc-backups`), `MASTERQC_ENV_FILE` (default `/etc/masterqc/env`), `MASTERQC_VERIFY_PORT` (default `4180`), `MASTERQC_SERVICE_UNIT` (default `masterqc.service`), `MASTERQC_SERVICE_USER` (default `masterqc`; empty runs the verification as root), and the timeouts `MASTERQC_HEALTH_TIMEOUT` and `MASTERQC_VERIFY_TIMEOUT`. The defaults match the paths in this guide.

## 10. Rolling back

```sh
sudo /opt/masterqc/current/deploy/release.sh --rollback
```

The script swaps `current` and `previous`, restarts `masterqc`, and waits for the health check to report the older release. Running it again swaps back to the release it left. Rollback changes no data. If the newer release had already upgraded the database and the older code needs the earlier data, restore the pre-release snapshot that the script prints (the newest file in `/var/lib/masterqc-backups/pre-release/`) while the service is stopped:

```sh
sudo systemctl stop masterqc.service
sudo -u masterqc sh -c 'set -a; . /etc/masterqc/env; set +a; node /opt/masterqc/current/launcher/restore-snapshot.mjs /var/lib/masterqc-backups/pre-release/<snapshot>.sqlite'
sudo systemctl start masterqc.service
```

The restore command replaces the database and keeps the previous file beside it. It is never run automatically. After a rollback, `current` is the older release, so the restore command uses its code.

## 11. Restore drill (required before launch and monthly after)

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

## 12. Known limits and open items

- The release script and its checks were tested only with a stub service manager, synthetic data, and a development machine. Before relying on the script in production, run one ordinary release and one rollback on a disposable copy of the server. Check that the `masterqc` account can read `/var/lib/masterqc-backups/pre-release/`.
- A release that intentionally removes records during its startup cleanup (for example, a superseded version) fails the count check. The script then leaves production unchanged, and the release has to be reviewed before it is installed.
- The script never deletes `/var/lib/masterqc-backups/pre-release/`. Each release adds one full database copy and each verification run adds none, so watch the disk and prune old snapshots by hand once they are no longer needed.
- Backups read the live database. A large `VACUUM INTO` plus `integrity_check` can hold a read lock long enough for saves to wait on the 5-second busy timeout. Measure this on the real server.
- SQLite calls are synchronous in Node, so while a snapshot is copied the whole app pauses, including `/healthz`. A monitor that polls health checks should allow a few seconds of slack.
- The Caddy and systemd files were checked only for syntax (`systemd-analyze verify`; Caddy validation was not run). Run `caddy validate` before reloading.
- The S3 bucket's versioning, Object Lock, upload-only credentials, and heartbeat monitor are configured outside this repository.
- Not implemented: the plan's recommended automatic write block when off-site coverage is older than 55 minutes, and alerts from outside the server.
- The frontend's offline message still names `http://127.0.0.1:4173`. Hosted users see it only if the service is unreachable.
- Hosted mode also accepts requests to `127.0.0.1:4173` without Basic Auth, because loopback is how Caddy and local tools reach the app. Any local account on the server can therefore use the app directly. Keep shell access limited to administrators.
- Basic Auth controls access only. The app keeps its manual confirmation names and does not identify users.
