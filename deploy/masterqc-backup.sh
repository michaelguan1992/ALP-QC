#!/usr/bin/env bash
# Creates one encrypted off-site copy of the MasterQC database, verifies each upload, and only then reports success.
#
# Settings come from the environment. systemd loads them from /etc/masterqc/env and /etc/masterqc/backup.env
# (see docs/deployment.md). Required: MASTERQC_BACKUP_AGE_RECIPIENT, MASTERQC_BACKUP_S3_BUCKET, and the AWS CLI
# credentials and region (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION).
# Optional: MASTERQC_BACKUP_S3_PREFIX (default masterqc), MASTERQC_BACKUP_HEARTBEAT_URL, MASTERQC_DATA_DIR
# (default /var/lib/masterqc), MASTERQC_BACKUP_STAGING_DIR (default /var/lib/masterqc-backups/staging), and
# MASTERQC_APP_DIR (default: the release that contains this script).
# Secret values are never printed.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${MASTERQC_APP_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
DATA_DIR="${MASTERQC_DATA_DIR:-/var/lib/masterqc}"
STAGING_DIR="${MASTERQC_BACKUP_STAGING_DIR:-/var/lib/masterqc-backups/staging}"
S3_BUCKET="${MASTERQC_BACKUP_S3_BUCKET:-}"
S3_PREFIX="${MASTERQC_BACKUP_S3_PREFIX:-masterqc}"
S3_PREFIX="${S3_PREFIX%/}"
RECIPIENT="${MASTERQC_BACKUP_AGE_RECIPIENT:-}"
HEARTBEAT_URL="${MASTERQC_BACKUP_HEARTBEAT_URL:-}"
# Local copies are a short recovery cache. Two days keeps several backup cycles on the server.
RETENTION_MINUTES=2880

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
for tool in node age aws find flock stat; do
  command -v "$tool" >/dev/null 2>&1 || die "Required command is not installed: $tool"
done
if [[ -n "$HEARTBEAT_URL" ]]; then
  command -v curl >/dev/null 2>&1 || die "Required command is not installed: curl"
fi

mkdir -p -- "$STAGING_DIR"
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

# Uploads one file and reads its size back from S3. A size mismatch is a failed backup.
upload_and_verify() {
  local local_file="$1"
  local key="$2"
  local expected_size
  local remote_size
  expected_size="$(stat -c '%s' -- "$local_file")"
  if ! aws s3 cp --only-show-errors "$local_file" "s3://$S3_BUCKET/$key" >/dev/null; then
    die "Upload failed for $key."
  fi
  if ! remote_size="$(aws s3api head-object --bucket "$S3_BUCKET" --key "$key" --query ContentLength --output text)"; then
    die "Could not read back the uploaded object $key."
  fi
  [[ "$remote_size" == "$expected_size" ]] || die "The uploaded object $key has a different size from the local file."
  log "Verified $key ($expected_size bytes)."
}

upload_and_verify "$ENCRYPTED" "$S3_PREFIX/$(basename -- "$ENCRYPTED")"
upload_and_verify "$MANIFEST" "$S3_PREFIX/$(basename -- "$MANIFEST")"

find "$STAGING_DIR" -maxdepth 1 -type f \
  \( -name 'masterqc-*.age' -o -name 'masterqc-*.json' -o -name 'masterqc-*.sqlite' \) \
  -mmin "+$RETENTION_MINUTES" -delete

# The heartbeat comes last, so the external monitor counts a run only after its upload is verified.
if [[ -n "$HEARTBEAT_URL" ]]; then
  # curl stays silent here: its errors could echo the heartbeat URL, which carries a secret token.
  if ! curl --fail --silent --retry 3 --max-time 30 --output /dev/null "$HEARTBEAT_URL" 2>/dev/null; then
    die "The success heartbeat could not be delivered; the external monitor will report this backup as missing."
  fi
  log "Success heartbeat delivered."
fi

log "Backup complete: $S3_PREFIX/$(basename -- "$ENCRYPTED")"
