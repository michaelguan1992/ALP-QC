#!/usr/bin/env bash
# Creates one encrypted off-site copy of the MasterQC database, uploads it to S3 under tiered prefixes, verifies each
# upload, and only then reports success.
#
# Every copy is a separate S3 object with its own COMPLIANCE Object Lock:
#   half-hourly/  when the database revision differs from the last verified half-hourly copy, or that copy is at least
#                 six hours old (locked for 7 days)
#   daily/        the first successful run of each UTC day (locked for 30 days)
#   monthly/      the first successful run of each UTC month (locked for 366 days)
# A run whose revision is unchanged, and whose last half-hourly copy is less than six hours old, uploads no
# half-hourly copy. It still sends its heartbeat, because that copy already holds the current revision.
#
# Copies in the staging directory are a short recovery cache. Copies older than MASTERQC_BACKUP_LOCAL_KEEP_MINUTES
# are removed, except the newest copy that reached S3 intact.
#
# Settings come from the environment. systemd loads them from /etc/masterqc/env and /etc/masterqc/backup.env
# (see docs/deployment.md). Required: MASTERQC_BACKUP_AGE_RECIPIENT, MASTERQC_BACKUP_S3_BUCKET, and the AWS CLI
# credentials and region (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION).
# Optional: MASTERQC_BACKUP_S3_PREFIX (default masterqc), MASTERQC_BACKUP_HEARTBEAT_URL, MASTERQC_DATA_DIR
# (default /var/lib/masterqc), MASTERQC_BACKUP_STAGING_DIR (default /var/lib/masterqc-backups/staging),
# MASTERQC_BACKUP_STATE_DIR (default /var/lib/masterqc-backups/state), MASTERQC_BACKUP_LOCAL_KEEP_MINUTES (default
# 360), and MASTERQC_APP_DIR (default: the release that contains this script).
# Secret values are never printed.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${MASTERQC_APP_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
DATA_DIR="${MASTERQC_DATA_DIR:-/var/lib/masterqc}"
STAGING_DIR="${MASTERQC_BACKUP_STAGING_DIR:-/var/lib/masterqc-backups/staging}"
STATE_DIR="${MASTERQC_BACKUP_STATE_DIR:-/var/lib/masterqc-backups/state}"
S3_BUCKET="${MASTERQC_BACKUP_S3_BUCKET:-}"
S3_PREFIX="${MASTERQC_BACKUP_S3_PREFIX:-masterqc}"
S3_PREFIX="${S3_PREFIX%/}"
RECIPIENT="${MASTERQC_BACKUP_AGE_RECIPIENT:-}"
HEARTBEAT_URL="${MASTERQC_BACKUP_HEARTBEAT_URL:-}"
# Local copies are a short recovery cache; the off-site copies are the real backups. The default window of 360 minutes
# keeps about six hours of runs. The newest copy that reached S3 intact is kept whatever its age.
LOCAL_KEEP_MINUTES="${MASTERQC_BACKUP_LOCAL_KEEP_MINUTES:-360}"
# Object Lock retention per tier, in days. deploy/aws/lifecycle.json hides each copy one day after its lock ends and
# deletes it a day later, so change the two together.
HALF_HOURLY_LOCK_DAYS=7
DAILY_LOCK_DAYS=30
MONTHLY_LOCK_DAYS=366
# An unchanged revision is copied again once its last verified half-hourly copy is six hours old.
UNCHANGED_MAX_AGE_SECONDS=21600

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

[[ -n "$RECIPIENT" ]] || die "MASTERQC_BACKUP_AGE_RECIPIENT is not set."
[[ -n "$S3_BUCKET" ]] || die "MASTERQC_BACKUP_S3_BUCKET is not set."
[[ -f "$APP_DIR/scripts/backup-snapshot.mjs" ]] || die "The snapshot tool was not found under the application directory."
for tool in node age aws find flock stat date; do
  command -v "$tool" >/dev/null 2>&1 || die "Required command is not installed: $tool"
done
if [[ -n "$HEARTBEAT_URL" ]]; then
  command -v curl >/dev/null 2>&1 || die "Required command is not installed: curl"
fi
[[ "$LOCAL_KEEP_MINUTES" =~ ^[1-9][0-9]*$ ]] || die "MASTERQC_BACKUP_LOCAL_KEEP_MINUTES must be a positive whole number of minutes."

# One clock reading drives every decision in this run: the UTC day and month, and the Object Lock dates.
NOW_EPOCH="$(date -u '+%s')"
TODAY="$(date -u -d "@$NOW_EPOCH" '+%Y-%m-%d')"
THIS_MONTH="$(date -u -d "@$NOW_EPOCH" '+%Y-%m')"

if ! mkdir -p -- "$STAGING_DIR" "$STATE_DIR"; then
  die "The backup staging and state directories could not be created."
fi
# A second run started while one is active would compete for the same files, so it stops instead.
exec 9>"$STAGING_DIR/.backup.lock"
flock -n 9 || die "Another backup is still running."

if ! MANIFEST="$(node "$APP_DIR/scripts/backup-snapshot.mjs" --data-dir "$DATA_DIR" --out-dir "$STAGING_DIR" --workspace main)"; then
  die "The database snapshot could not be created or verified."
fi
[[ -f "$MANIFEST" ]] || die "The snapshot manifest was not written."
PLAIN_SNAPSHOT="${MANIFEST%.json}.sqlite"
[[ -f "$PLAIN_SNAPSHOT" ]] || die "The snapshot file is missing."
BASE_NAME="$(basename -- "$PLAIN_SNAPSHOT" .sqlite)"
ENCRYPTED="$STAGING_DIR/$BASE_NAME.sqlite.age"
PARTIAL="$ENCRYPTED.partial"

# The plaintext copy exists only until it is encrypted, so it is removed on every exit path.
cleanup() {
  rm -f -- "$PLAIN_SNAPSHOT" "$PARTIAL"
}
trap cleanup EXIT

if ! age -r "$RECIPIENT" -o "$PARTIAL" "$PLAIN_SNAPSHOT"; then
  die "Encryption failed."
fi
mv -- "$PARTIAL" "$ENCRYPTED"
rm -f -- "$PLAIN_SNAPSHOT"

# The manifest records the database revision that this copy captured. That revision decides whether to upload.
if ! REVISION="$(node -e 'const fs = require("node:fs"); const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(String(manifest.revision));' "$MANIFEST")"; then
  die "The snapshot manifest could not be read."
fi
[[ "$REVISION" =~ ^[0-9]+$ ]] || die "The snapshot manifest has no valid revision."

# Uploads one file under a tier with an explicit COMPLIANCE lock, then reads it back. Any failure stops the run.
upload_and_verify() {
  local local_file="$1"
  local key="$2"
  local retain_epoch="$3"
  local expected_size
  local retain_until
  expected_size="$(stat -c '%s' -- "$local_file")"
  retain_until="$(date -u -d "@$retain_epoch" '+%Y-%m-%dT%H:%M:%SZ')"
  # fileb:// sends the bytes unchanged. SHA256 lets S3 reject a copy that arrives corrupted.
  if ! aws s3api put-object --bucket "$S3_BUCKET" --key "$key" --body "fileb://$local_file" \
    --checksum-algorithm SHA256 --object-lock-mode COMPLIANCE \
    --object-lock-retain-until-date "$retain_until" >/dev/null; then
    die "Upload failed for $key."
  fi
  verify_upload "$key" "$expected_size" "$retain_epoch"
}

# Reads the object back. Its size must match the local file, and it must be under a COMPLIANCE lock that ends no
# earlier than requested. Any other answer is a failed backup.
verify_upload() {
  local key="$1"
  local expected_size="$2"
  local expected_retain_epoch="$3"
  local fields
  local remote_size
  local lock_mode
  local retain_until
  local retain_epoch
  if ! fields="$(aws s3api head-object --bucket "$S3_BUCKET" --key "$key" \
    --query '[ContentLength, ObjectLockMode, ObjectLockRetainUntilDate]' --output text)"; then
    die "Could not read back the uploaded object $key."
  fi
  IFS=$'\t' read -r remote_size lock_mode retain_until <<<"$fields" || true
  [[ "$remote_size" == "$expected_size" ]] || die "The uploaded object $key has a different size from the local file."
  [[ "$lock_mode" == "COMPLIANCE" ]] || die "The uploaded object $key is not under a COMPLIANCE Object Lock."
  [[ -n "$retain_until" && "$retain_until" != "None" ]] || die "The uploaded object $key has no Object Lock retention date."
  retain_epoch="$(date -u -d "$retain_until" '+%s')" || die "The Object Lock retention date of $key cannot be read."
  (( retain_epoch >= expected_retain_epoch )) || die "The uploaded object $key is locked for less time than required."
  log "Verified $key ($expected_size bytes, COMPLIANCE lock until $retain_until)."
}

# Uploads the encrypted copy and its manifest under one tier. Both objects are locked for the tier's period from now.
upload_tier() {
  local tier="$1"
  local lock_days="$2"
  local retain_epoch
  retain_epoch="$(( $(date -u '+%s') + lock_days * 86400 ))"
  upload_and_verify "$ENCRYPTED" "$S3_PREFIX/$tier/$(basename -- "$ENCRYPTED")" "$retain_epoch"
  upload_and_verify "$MANIFEST" "$S3_PREFIX/$tier/$(basename -- "$MANIFEST")" "$retain_epoch"
  # The newest copy that reached S3 intact is the one local pruning always keeps.
  write_state last-copy "$BASE_NAME"
  log "Uploaded and verified the $tier copy, locked for $lock_days days."
}

# State files record the last verified copy of each tier. A tier's state changes only after that tier's uploads verify.
read_state() {
  local value=""
  if [[ -f "$STATE_DIR/$1" ]]; then
    IFS= read -r value <"$STATE_DIR/$1" || true
  fi
  printf '%s' "$value"
}

write_state() {
  local temporary="$STATE_DIR/.$1.tmp"
  printf '%s\n' "$2" >"$temporary" || die "Could not record the $1 state."
  mv -f -- "$temporary" "$STATE_DIR/$1" || die "Could not record the $1 state."
}

# Removes local copies older than the keep window, except the newest copy that reached S3 intact. It runs before the
# uploads, so a run that then fails still trims the cache.
prune_local_copies() {
  local last_copy
  local protected=()
  last_copy="$(read_state last-copy)"
  if [[ -n "$last_copy" ]]; then
    protected=(! -name "$last_copy.sqlite.age" ! -name "$last_copy.json")
  fi
  find "$STAGING_DIR" -maxdepth 1 -type f \
    \( -name 'masterqc-*.age' -o -name 'masterqc-*.json' -o -name 'masterqc-*.sqlite' \) \
    -mmin "+$LOCAL_KEEP_MINUTES" ${protected[@]+"${protected[@]}"} -delete
}

# The half-hourly state is "<revision> <Unix time of the verified upload>".
read -r LAST_HALF_HOURLY_REVISION LAST_HALF_HOURLY_EPOCH <<<"$(read_state last-half-hourly)" || true
HALF_HOURLY_DUE=1
if [[ "$LAST_HALF_HOURLY_REVISION" == "$REVISION" && "$LAST_HALF_HOURLY_EPOCH" =~ ^[0-9]+$ ]]; then
  AGE_SECONDS=$((NOW_EPOCH - LAST_HALF_HOURLY_EPOCH))
  if (( AGE_SECONDS >= 0 && AGE_SECONDS < UNCHANGED_MAX_AGE_SECONDS )); then
    HALF_HOURLY_DUE=0
  fi
fi
DAILY_DUE=1
if [[ "$(read_state last-daily)" == "$TODAY" ]]; then
  DAILY_DUE=0
fi
MONTHLY_DUE=1
if [[ "$(read_state last-monthly)" == "$THIS_MONTH" ]]; then
  MONTHLY_DUE=0
fi

prune_local_copies

if (( HALF_HOURLY_DUE )); then
  upload_tier half-hourly "$HALF_HOURLY_LOCK_DAYS"
  write_state last-half-hourly "$REVISION $(date -u '+%s')"
else
  log "unchanged: revision $REVISION was copied off-site less than six hours ago, so no half-hourly copy is uploaded."
fi
if (( DAILY_DUE )); then
  upload_tier daily "$DAILY_LOCK_DAYS"
  write_state last-daily "$TODAY"
fi
if (( MONTHLY_DUE )); then
  upload_tier monthly "$MONTHLY_LOCK_DAYS"
  write_state last-monthly "$THIS_MONTH"
fi

# The heartbeat comes last, so the external monitor counts a run only after every due upload is verified.
if [[ -n "$HEARTBEAT_URL" ]]; then
  # curl stays silent here: its errors could echo the heartbeat URL, which carries a secret token.
  if ! curl --fail --silent --retry 3 --max-time 30 --output /dev/null "$HEARTBEAT_URL" 2>/dev/null; then
    die "The success heartbeat could not be delivered; the external monitor will report this backup as missing."
  fi
  log "Success heartbeat delivered."
fi

log "Backup complete: revision $REVISION, $BASE_NAME."
