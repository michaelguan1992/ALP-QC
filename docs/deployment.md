# Hosted Deployment (Ubuntu 24.04)

> **Status: sections 1 to 3 ran on the real server on 2026-10-17** (hardening, software, service user, first release with a smoke test on a scratch directory). **Everything from section 4 on is NOT yet tested on a real server.** The code paths were checked locally: unit tests, `systemd-analyze verify` on the unit files, an `age` round trip, and the hosted server started with the production settings on a development machine. The release script (`deploy/release.sh`) and its verification checks were exercised only by the automated tests, with a stub service manager and synthetic data; they have not run on Ubuntu 24.04 with systemd, Caddy, or real S3 storage. The steps below have not been run on Ubuntu 24.04, behind Caddy, with real S3 storage, or in a restore drill. Treat them as a draft until the restore drill in section 11 passes on a disposable server. The AWS steps in section 0 and the backup job's S3 calls were also not run against real AWS; the automated tests use a stub AWS CLI.

This setup runs one Node process and one SQLite database on one Linux server. Caddy terminates HTTPS and enforces individual Basic Auth accounts. Encrypted snapshots go to off-site object storage every 30 minutes. The decision record is [Shared Server Deployment and Data Recovery Plan](server-deployment-plan.md). This guide does not authorize a purchase.

The repository is public. Use placeholders in every file you create on the server, and keep real hashes, keys, and tokens in your password manager.

## 0. Before you start

- Point a DNS record such as `qc.example.com` at the server's public IPv4 address, and wait for it to resolve.
- Prepare one bcrypt password hash per user (section 6), an S3 bucket in Singapore with Object Lock in a separate AWS account, an upload-only access key (`masterqc-backup`), and an `age` key pair. The private key stays off the server. The owner does the AWS steps once, from a personal computer.

### Set up AWS S3 (Singapore)

> **Not run against real AWS.** These commands were written for this guide and tested only against a stub. Run the scratch-bucket test in step 3 before you create the production bucket in step 4.

Two facts shape every step:

- A compliance-mode lock cannot be shortened, removed, or bypassed, not even by the account's root user. A locked copy is stored and billed until its lock ends. Test with one-day locks on a scratch bucket first.
- Keep these off the server: the root sign-in with its MFA device and recovery codes, administrator credentials, and the `age` private key.

Run the commands from your own computer, with an administrator profile for the AWS CLI (v2). Replace each `<placeholder>`. Bucket names are unique across all of AWS and cannot be changed.

1. **Create a separate account.** Sign up for a new AWS account, separate from the account of your server provider. Sign in as root, turn on MFA for root, and do not create root access keys. Create an administrator identity for daily work, such as IAM Identity Center with MFA. Keep the account ID and recovery codes in your password manager.

2. **Select the administrator profile and region:**

   ```sh
   export AWS_PROFILE=<your administrator profile>
   export AWS_REGION=ap-southeast-1
   ```

3. **Test the lock on a scratch bucket.** Use test data only:

   ```sh
   SCRATCH=masterqc-scratch-<random-suffix>
   aws s3api create-bucket --bucket "$SCRATCH" --region ap-southeast-1 \
     --create-bucket-configuration LocationConstraint=ap-southeast-1 \
     --object-lock-enabled-for-bucket
   echo "lock test" > scratch.txt
   aws s3api put-object --bucket "$SCRATCH" --key test/scratch.txt --body fileb://scratch.txt \
     --checksum-algorithm SHA256 --object-lock-mode COMPLIANCE \
     --object-lock-retain-until-date <one day from now in UTC, for example 2026-10-18T12:00:00Z>
   VERSION_ID="$(aws s3api list-object-versions --bucket "$SCRATCH" --prefix test/scratch.txt \
     --query 'Versions[0].VersionId' --output text)"
   aws s3api delete-object --bucket "$SCRATCH" --key test/scratch.txt --version-id "$VERSION_ID"
   ```

   The last command must fail, with a message that the object is protected by Object Lock or that access is denied. If it succeeds, stop: the lock is not in effect, and the production bucket must not be created yet. After the one-day lock ends, the test version and the scratch bucket can be deleted.

4. **Create the production bucket** with Object Lock enabled. Object Lock also turns on versioning, and it cannot be turned off again once it is on.

   ```sh
   BUCKET=<your-unique-bucket-name>
   aws s3api create-bucket --bucket "$BUCKET" --region ap-southeast-1 \
     --create-bucket-configuration LocationConstraint=ap-southeast-1 \
     --object-lock-enabled-for-bucket
   aws s3api put-public-access-block --bucket "$BUCKET" \
     --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
   aws s3api put-bucket-encryption --bucket "$BUCKET" \
     --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
   aws s3api get-object-lock-configuration --bucket "$BUCKET"
   aws s3api get-bucket-versioning --bucket "$BUCKET"
   ```

   The last two commands must show Object Lock `Enabled` and versioning `Enabled`. Public access stays blocked, and encryption uses SSE-S3, which means keys managed by S3. The console equivalent is Create bucket, Region Asia Pacific (Singapore), Object Lock Enable, all four Block Public Access options on, and Default encryption SSE-S3. Console labels change, so the CLI commands are the reference.

5. **Optional: a one-day default lock.** Do this only after step 3 passes. Any object uploaded without its own lock then gets a one-day COMPLIANCE lock. The backup job sets its own, longer lock on every object, so the default only guards against a mistaken upload. Keep it at one day:

   ```sh
   aws s3api put-object-lock-configuration --bucket "$BUCKET" \
     --object-lock-configuration '{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"COMPLIANCE","Days":1}}}'
   ```

6. **Apply the lifecycle rules** from a checkout of this repository. If you change `MASTERQC_BACKUP_S3_PREFIX` from `masterqc`, first edit the prefixes in `deploy/aws/lifecycle.json` and the `Resource` in the upload policy:

   ```sh
   aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
     --lifecycle-configuration file://deploy/aws/lifecycle.json
   aws s3api get-bucket-lifecycle-configuration --bucket "$BUCKET"
   ```

   The rules hide each copy one day after its lock ends and delete it a day after that. Object Lock blocks deletion of a locked copy until its lock ends, lifecycle rules included, so the lock always comes first.

7. **Create the upload-only user.** The policy file `deploy/aws/iam-upload-policy.json` contains the placeholder `YOUR-BUCKET-NAME`. Fill it in on a copy outside the repository:

   ```sh
   aws iam create-user --user-name masterqc-backup
   sed "s/YOUR-BUCKET-NAME/$BUCKET/g" deploy/aws/iam-upload-policy.json > "$HOME/masterqc-upload-policy.json"
   aws iam put-user-policy --user-name masterqc-backup --policy-name masterqc-backup-upload \
     --policy-document "file://$HOME/masterqc-upload-policy.json"
   rm -f "$HOME/masterqc-upload-policy.json"
   aws iam create-access-key --user-name masterqc-backup
   ```

   The last command prints the access key once. Save `AccessKeyId` and `SecretAccessKey` in your password manager, then write them into `/etc/masterqc/backup.env` on the server (section 4). Do not paste them into chat, email, or the repository. The user gets no console password and no other policy.

8. **Set a budget alert.** In AWS Budgets, create a monthly cost budget with an email alert, for example at USD 10, so that a misconfigured upload loop is noticed early.

Where each secret lives:

| Secret | Where it lives | On the server |
| --- | --- | --- |
| Root sign-in, MFA device, recovery codes | Password manager and a second secure location | Never |
| Administrator identity | Your computer and password manager | Never |
| Upload key (`masterqc-backup`) | `/etc/masterqc/backup.env` (root-only) and password manager | Yes, by design |
| `age` private recovery key | Password manager and a second secure location | Never |
| `age` public recipient | `/etc/masterqc/backup.env` | Yes (public) |

#### Monthly cost estimate

These are estimates, not bills. The prices used are S3 Standard storage at USD 0.025 per GB-month, PUT at USD 0.005 per 1,000 requests, and HEAD at USD 0.0004 per 1,000 requests, for Asia Pacific (Singapore). They were not checked against a live AWS price list. **Verify every price on the AWS pricing page before you rely on this table.** The table assumes the worst case: a database that changes at every 30-minute run.

| Item | 35 MB database | 700 MB database |
| --- | --- | --- |
| Stored copies under the lock periods: 378 (336 half-hourly, 30 daily, 12 monthly) | 13.2 GB, about USD 0.33 a month | 264.6 GB, about USD 6.62 a month |
| Stored copies including the one-day lifecycle delay: 477 (432 half-hourly, 32 daily, 13 monthly) | 16.7 GB, about USD 0.42 a month | 333.9 GB, about USD 8.35 a month |
| Requests: about 3,000 PUT and about 3,000 HEAD a month | under USD 0.05 | under USD 0.05 |
| Data into AWS | free | free |
| Outbound upload traffic from the server, worst case (compare with your plan's monthly traffic allowance) | about 50 GB a month | about 1.05 TB a month |

Notes:

- The storage class is S3 Standard. Infrequent-access and archive classes bill a minimum storage duration longer than these copies live, so they would cost more here (verify the minimums).
- Check the upload column against your server plan's monthly traffic allowance. This guide does not assume an allowance. The worst case at 700 MB is about 1.05 TB a month, so it can take a large share of a small allowance. The skip-unchanged rule keeps traffic low while the database is idle.
- The plan allows USD 5–10 a month for backup storage, requests, and transfer. The estimate fits that allowance at both sizes.

## 1. Install the software

> **Run on the BandwagonHost Los Angeles server (Ubuntu 24.04.4) on 2026-10-17**, as root over SSH, for the hardening, software, service user, and first-release steps (sections 1 to 3). The commands below are the ones that ran, written with `sudo` for a non-root administrator.

### Update and harden the server

Check key login first. After a reinstall from the provider's panel, `/root/.ssh/authorized_keys` was empty, even though the panel had shown a key login working before the reinstall. If key login is refused, use the provider's web console (KiwiVM: **Root shell – basic**) to check `ssh-keygen -lf /root/.ssh/authorized_keys` against the fingerprint of your local public key, append the public key line, and try again. The web console does not use SSH or the firewall, so it is also the way back in if a later step locks SSH.

The provider's minimal image has neither `ufw`, `git`, nor `xz-utils`, and its firewall accepts everything. Update and install the base tools:

```sh
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get -y upgrade
sudo apt-get install -y ufw age unzip curl git xz-utils
ls /var/run/reboot-required 2>/dev/null && echo "Reboot needed"
```

`xz-utils` is needed to unpack the Node.js archive. On this image `networking.service` shows as failed from the first boot: it tries DHCP on `eth1`, the provider's private-network interface, which is not enabled. The public interface `eth0` is configured separately and works; the failure is harmless and can be left alone.

Firewall: deny incoming by default and open only SSH, HTTP, and HTTPS. Ports 80 and 443 must stay open to everyone for certificate issuance and renewal. Check that `22/tcp` is in the added rules before you enable it:

```sh
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw show added
sudo ufw --force enable
sudo ufw status verbose
```

Open a new SSH connection before you close the current one. Right after the first `ufw enable`, `systemctl is-active ufw` prints `inactive`, because ufw was installed after boot and its unit has not run yet; the rules are active (`iptables -S ufw-user-input`), and `ENABLED=yes` in `/etc/ufw/ufw.conf` with the enabled unit loads them at every boot.

Allow key login only. The file name starts with `00-` so that it wins over any later file in the directory (sshd uses the first value it reads). Keep one SSH connection open while you change this, and verify with a new one:

```sh
sudo install -m 0644 /dev/stdin /etc/ssh/sshd_config.d/00-masterqc.conf <<'EOF'
# MasterQC hardening: key-only SSH login.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sudo sshd -t
sudo sshd -T | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|pubkeyauthentication) '
sudo systemctl reload ssh
```

`sshd -T` must show `passwordauthentication no`, `kbdinteractiveauthentication no`, `pubkeyauthentication yes`, and `permitrootlogin without-password` (the older name of `prohibit-password`). Ubuntu 24.04 starts SSH through `ssh.socket`; `systemctl reload ssh` is enough. From your computer, in a new terminal, check both directions before you close the old session:

```sh
ssh root@<server> 'echo key-login-ok'
ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive root@<server> true
```

The first prints `key-login-ok`; the second must fail with `Permission denied (publickey)`. Keep a copy of the SSH private key in your password manager. If it is lost, add a new public key through the provider's web console.

### Install Node.js, Caddy, and the AWS CLI

Install Node.js 22, pinned. `22.23.3` (2026-09-23) is installed on the server; `22.22.0` was used for local tests. Check for the latest 22.x security release first:

```sh
NODE_VERSION=22.23.3
curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
grep " node-v${NODE_VERSION}-linux-x64.tar.xz$" SHASUMS256.txt | sha256sum -c -
sudo tar -xJf "node-v${NODE_VERSION}-linux-x64.tar.xz" -C /opt
sudo ln -sfn "/opt/node-v${NODE_VERSION}-linux-x64/bin/node" /usr/bin/node
node --version
```

If a distribution `nodejs` package is installed, remove it first so that `/usr/bin/node` is the pinned build. Node prints an `ExperimentalWarning` for `node:sqlite` at start-up; it is expected.

Install Caddy from the official Debian and Ubuntu repository ([instructions](https://caddyserver.com/docs/install#debian-ubuntu-raspbian)):

```sh
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gnupg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
gpg --show-keys --with-fingerprint /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo apt-get update
sudo apt-get install -y caddy
caddy version
```

The key fingerprint was `6576 0C51 EDEA 2017 CEA2 CA15 155B 6D79 CA56 EA34` (Caddy Web Server), and Caddy `2.11.7` was installed. The package enables and starts Caddy at once with a default site that serves a static welcome page on port 80 and nothing else; section 6 replaces it.

Install AWS CLI v2 with the [official installer](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) and check its signature first. Copy the "AWS CLI Team" PGP public key from that page into `aws-cli.pub`; its fingerprint is `FB5D B77F D5C1 18B8 0511 ADA8 A631 0ACC 4672 475C`:

```sh
export GNUPGHOME="$(mktemp -d)"
gpg --import aws-cli.pub
gpg --fingerprint
curl -fsSLo awscliv2.zip https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip
curl -fsSLo awscliv2.sig https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip.sig
gpg --verify awscliv2.sig awscliv2.zip
unzip -q awscliv2.zip
sudo ./aws/install
aws --version
```

Continue only if `gpg --verify` reports a good signature from the AWS CLI Team. `aws-cli/2.38.1` was installed to `/usr/local/bin/aws`.

## 2. Create the service user and directories

```sh
sudo useradd --system --home-dir /var/lib/masterqc --shell /usr/sbin/nologin masterqc
sudo install -d -o masterqc -g masterqc -m 0750 /var/lib/masterqc
sudo install -d -o masterqc -g masterqc -m 0700 /var/lib/masterqc-backups /var/lib/masterqc-backups/staging /var/lib/masterqc-backups/state
sudo install -d -o root -g root -m 0755 /opt/masterqc /opt/masterqc/releases
sudo install -d -o root -g masterqc -m 0750 /etc/masterqc
```

## 3. Install a release

Build the first release on your own computer and stream it to the server, so that the server never receives a clone. The repository still tracks the production database and real historical extracts, and a clone would copy them in its history. Exclude every data path when you build the archive:

```sh
REF=<tag or commit>
ID="$(date -u '+%Y%m%dT%H%M%SZ')-$(git rev-parse --short=7 "$REF")"
git archive --format=tar "$REF" -- . ':(exclude)data/workspace' ':(exclude)data/pdf-import' \
    ':(exclude)data/lark-import' ':(exclude)tmp' \
  | ssh root@<server> "set -e; test ! -e /opt/masterqc/releases/$ID
      install -d -m 0755 /opt/masterqc/releases/$ID
      tar -x -C /opt/masterqc/releases/$ID
      echo $ID | install -m 0644 /dev/stdin /opt/masterqc/releases/$ID/RELEASE
      ln -sfn /opt/masterqc/releases/$ID /opt/masterqc/current"
```

The name follows `deploy/release.sh` (`<UTC time>-<short commit>`), and the `RELEASE` file makes `/api/session` report it. `tmp/` holds working extracts of real PDF history, and `data/lark-import/` holds the Lark version-history package that the server offers for import. Both are left out during the trial. The app runs without either. The app has no npm dependencies, so nothing else is installed.

Check that no data came along, then run a short smoke test as the service user on a scratch directory and a spare port. It does not touch `/var/lib/masterqc`:

```sh
find /opt/masterqc/current -name '*.sqlite*' -o -name '*history*.json'
D="$(mktemp -d /tmp/mqc-smoke.XXXX)"; sudo chown masterqc:masterqc "$D"
cd /opt/masterqc/current
sudo timeout 12 runuser -u masterqc -- env MASTERQC_DATA_DIR="$D" MASTERQC_LISTEN_PORT=4174 MASTERQC_DEMO=off \
  node launcher/server.mjs --no-open &
sleep 5; curl -sS http://127.0.0.1:4174/healthz; curl -sS http://127.0.0.1:4174/api/session; wait
sudo rm -r "$D"
```

`find` prints nothing. `/healthz` returns `{"ok":true,"revision":0}`, and `/api/session` reports the release ID. Use this manual procedure for the first installation only. Later releases use `deploy/release.sh` (section 9), which creates the new directory and switches the `current` link after verification. Never copy the database into a release directory.

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

The upload credentials are the `masterqc-backup` user from section 0, whose policy is `deploy/aws/iam-upload-policy.json`. It allows writing backup objects under `masterqc/`, and reading their size and lock fields back, and nothing else: no deletion, no retention bypass, and no bucket changes. `MASTERQC_BACKUP_S3_PREFIX` must stay `masterqc`, or the policy's `Resource` must change to match.

Optional: `MASTERQC_BACKUP_LOCAL_KEEP_MINUTES` (default `360`) sets how long encrypted copies stay in the local staging folder. It must be a positive whole number of minutes. The newest copy that reached S3 intact is kept whatever its age.

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

The firewall was set up in section 1 (22, 80, and 443 only). Port 4173 stays on loopback; `sudo ufw status` should still list only those three ports.

Start the backup timer, run one backup now, and check its log:

```sh
sudo systemctl enable --now masterqc-backup.timer
sudo systemctl start masterqc-backup.service
journalctl -u masterqc-backup.service -n 50 --no-pager
```

A run that uploads prints `Verified ...` for each object and `Uploaded and verified the <tier> copy` for each tier. A run whose database is unchanged prints `unchanged:`, uploads nothing, and still sends the heartbeat. A successful run ends with `Success heartbeat delivered.` when a heartbeat URL is set.

## 7. Verify the first deployment

- `https://qc.example.com` asks for Basic Auth. A wrong password is refused.
- Save a batch edit, refresh the page, and confirm the value remains.
- `https://qc.example.com/?workspace=demo` shows no demo data. The demo API returns `404` with `workspace_not_found`.
- On the server, `curl -sS -o /dev/null -w '%{http_code}\n' -H 'Host: qc.example.com' -X POST -H 'Content-Type: application/json' --data '{}' http://127.0.0.1:4173/api/qc/main/initialize` prints `403`, because the request has no Origin.
- Under `masterqc/half-hourly/`, the bucket holds one `.sqlite.age` object and one `.json` manifest for each run that uploads. A run uploads when the database revision changed or the last half-hourly copy is six hours old. The first run of each UTC day also writes `masterqc/daily/`, and the first run of each UTC month writes `masterqc/monthly/`. Every object is under a `COMPLIANCE` lock.
- Run the job again without changing any data. The second run prints `unchanged:`, uploads nothing, and still sends the heartbeat.
- Read one copy's lock with the administrator profile on your own computer: `aws s3api head-object --bucket <bucket> --key <key> --query '[ContentLength,ObjectLockMode,ObjectLockRetainUntilDate]' --output text`. A half-hourly copy shows `COMPLIANCE` and a date about seven days ahead.
- On the server, check that the upload key cannot delete. Load the upload credentials for one command, for example `sudo sh -c 'set -a; . /etc/masterqc/backup.env; set +a; aws s3api delete-object --bucket <bucket> --key masterqc/access-check-missing'`. It must fail with `AccessDenied`. The key does not exist, so a permitted delete would change nothing, and this check never touches a real copy.
- The external monitor alerts when no heartbeat arrives for about 45 minutes. Do not alert on the age of the newest object. An unchanged database is not copied for up to six hours, but its newest copy still holds the current revision.

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

1. Download the newest suitable object and its manifest from the bucket: `aws s3 cp s3://<bucket>/<prefix>/<tier>/<name>.sqlite.age .` and the matching `.json`. Choose `<tier>` by need: `half-hourly` for the latest saved work, `daily` for a mistake found later, or `monthly` for older history. The upload credentials cannot list the bucket, so run this step with the administrator profile on your own computer, then copy the files to the drill server.
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

## 12. Moving to another server

Use this when changing provider or plan, for example to another BandwagonHost location or another provider. The site keeps its domain, so users keep their address, saved logins, bookmarks, and unsent browser drafts. Plan about 30 to 60 minutes without writes.

1. Prepare the new server with sections 1 to 4 and section 6, but do not point DNS at it yet. Copy `/etc/masterqc/env`, `/etc/masterqc/backup.env`, and the Caddyfile (including the Basic Auth hashes) from the old server. Keep the same `MASTERQC_PUBLIC_ORIGIN`.
2. Optional trial: restore a recent snapshot into the new server's data directory (section 5) and have mainland and US users test it through a temporary hosts-file entry or a temporary second DNS name. Real work continues on the old server only. Discard this trial copy before the cutover.
3. A day before the cutover, lower the DNS record's TTL to 300 seconds.
4. Cutover:
   1. Ask users to finish and save their edits. Unsent drafts stay in each browser and survive the move, but saving first keeps the window short.
   2. On the old server, stop writes: `sudo systemctl stop masterqc`. Keep the old server running otherwise.
   3. Create the final snapshot from the stopped database with `scripts/backup-snapshot.mjs` and copy it and its manifest to the new server. Check `sha256sum` against the manifest.
   4. On the new server, with the service stopped, restore it with `launcher/restore-snapshot.mjs` into an empty data directory (section 5), then start the service.
   5. Point the DNS record at the new server's IP address. Caddy obtains a certificate once the name resolves to the new server.
   6. Verify with section 7, open a few batches and attachments, and confirm that the newest saved record is present.
5. Start the backup timer on the new server only, and confirm one successful upload. Disable the backup timer on the old server so two servers never write backups for the same workspace.
6. Keep the old server stopped but intact for at least a week as a frozen copy, then cancel it. Never start its service again once the new server has accepted writes, because its data would diverge.

## 13. Known limits and open items

- `deploy/release.sh` needs a git clone at `/opt/masterqc/repo`. While the repository tracks `data/workspace/masterqc-main.sqlite` and real extracts under `tmp/` and `data/pdf-import/`, that clone would put real data on the server in its history, which the trial forbids. The script also removes only `data/workspace` and `data/pdf-import` from a release, not `tmp/` or `data/lark-import/`. Decide how releases are fetched (for example, an archive streamed from the owner's computer, or a history without the data files) before the first scripted release.
- The release script and its checks were tested only with a stub service manager, synthetic data, and a development machine. Before relying on the script in production, run one ordinary release and one rollback on a disposable copy of the server. Check that the `masterqc` account can read `/var/lib/masterqc-backups/pre-release/`.
- A release that intentionally removes records during its startup cleanup (for example, a superseded version) fails the count check. The script then leaves production unchanged, and the release has to be reviewed before it is installed.
- The script never deletes `/var/lib/masterqc-backups/pre-release/`. Each release adds one full database copy and each verification run adds none, so watch the disk and prune old snapshots by hand once they are no longer needed.
- Backups read the live database. A large `VACUUM INTO` plus `integrity_check` can hold a read lock long enough for saves to wait on the 5-second busy timeout. Measure this on the real server.
- SQLite calls are synchronous in Node, so while a snapshot is copied the whole app pauses, including `/healthz`. A monitor that polls health checks should allow a few seconds of slack.
- The Caddy and systemd files were checked only for syntax (`systemd-analyze verify`; Caddy validation was not run). Run `caddy validate` before reloading.
- The S3 steps in section 0, the upload policy, and the lifecycle rules were not checked against a live AWS account, and the test suite uses a stub AWS CLI, so the real `aws` calls are untested. The heartbeat monitor runs outside this repository. Run the scratch-bucket test before the production bucket exists, and run a restore drill after the first real upload.
- Local staging keeps the encrypted copies made in the last `MASTERQC_BACKUP_LOCAL_KEEP_MINUTES` (default 360, about six hours), which is about 12 copies at the 30-minute cadence, plus the newest copy that reached S3 intact. At 35 MB that is about 0.5 GB; at 700 MB it is about 9 GB. While a run encrypts, a plaintext snapshot and its encrypted copy exist together, so the peak at 700 MB is about 10.5 GB for a few minutes. Pruning runs at the start of each run, before its uploads, so a run that fails still trims the cache. A copy that never reached S3 is removed once it is older than the window.
- Outbound upload traffic is the other size to check. The worst case at 700 MB, a database that changes at every run, is about 1.05 TB a month (section 0). Compare that figure with the monthly traffic allowance on your server plan; this guide does not assume a particular allowance.
- The unchanged-database rule compares revision numbers. A different database that carries the same revision number would be skipped until its six-hour copy. Do not copy `/var/lib/masterqc-backups/state` between servers; a new server starts with an empty state directory (section 12).
- Object Lock compliance cannot be undone. A copy stays, and is billed, until its lock ends. Closing the AWS account is outside Object Lock's protection, so keep the root recovery codes and the `age` private key outside the server (section 0).
- Each object is one `put-object` call, which S3 limits to 5 GB. The database is far below that now. A much larger database needs multipart uploads first.
- An interrupted run can leave an encrypted copy in S3 without its manifest. It is harmless, and the lifecycle rules remove it on the same schedule as any other copy in its tier.
- A run that outlasts the 30-minute timer makes the next run exit with `Another backup is still running`, and that run sends no heartbeat. Measure upload time at 700 MB on the real server link.
- Retention dates come from the server clock. A clock that runs fast shortens every lock, and one that runs slow lengthens it. Confirm that time synchronization is active with `timedatectl`.
- Not implemented: the plan's recommended automatic write block when off-site coverage is older than 55 minutes, and alerts from outside the server.
- Hosted mode also accepts requests to `127.0.0.1:4173` without Basic Auth, because loopback is how Caddy and local tools reach the app. Any local account on the server can therefore use the app directly. Keep shell access limited to administrators.
- Basic Auth controls access only, and every signed-in user may perform every operation. With `MASTERQC_TRUSTED_USER_HEADER` set, new audit entries record the signed-in name; the manual confirmation names on Issues remain unauthenticated business fields.
