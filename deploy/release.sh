#!/usr/bin/env bash
# Releases a MasterQC Web version on the server, or switches back to the previous release.
#
#   sudo /opt/masterqc/current/deploy/release.sh <git-ref>    fetch, verify, switch, and check the new release
#   sudo /opt/masterqc/current/deploy/release.sh --rollback   switch back to the previous release and check it
#
# A release is verified before production changes. The new code starts on an internal port with a fresh copy of
# a pre-release snapshot, runs the startup upgrades, must keep the record counts of the live release, and must read
# every attachment. Production switches only after that passes. If the new service does not become healthy, the
# previous release is restored automatically. Database data is never restored automatically: a failed release prints
# the exact restore command for the pre-release snapshot instead.
#
# Layout under MASTERQC_ROOT (default /opt/masterqc): repo/ is a git clone, releases/<UTC stamp>-<short sha>/ holds each
# release, and current and previous are symbolic links. Settings come from the environment. Unset values fall back to
# /etc/masterqc/env (MASTERQC_DATA_DIR, MASTERQC_LISTEN_HOST, MASTERQC_LISTEN_PORT) and then to the defaults below.
#   MASTERQC_ROOT          /opt/masterqc
#   MASTERQC_DATA_DIR      /var/lib/masterqc
#   MASTERQC_BACKUPS_DIR   /var/lib/masterqc-backups   (pre-release snapshots are kept in pre-release/)
#   MASTERQC_ENV_FILE      /etc/masterqc/env
#   MASTERQC_VERIFY_PORT   4180                        (internal port for the verification run)
#   MASTERQC_SERVICE_UNIT  masterqc.service
#   MASTERQC_SERVICE_USER  masterqc                    (the verification run uses this account; empty runs as the caller)
#   MASTERQC_NODE          node
#   MASTERQC_HEALTH_TIMEOUT  60 seconds to become healthy after a switch
#   MASTERQC_VERIFY_TIMEOUT  120 seconds for the verification server to start
#   SYSTEMCTL              systemctl                   (tests replace it with a stub)
# The release directory never contains the database; the production data directory is the only copy.
set -euo pipefail

ENV_FILE="${MASTERQC_ENV_FILE:-/etc/masterqc/env}"

# Reads KEY from the systemd-style environment file. Empty or missing values fall back to the given default.
env_file_value() {
  local name="$1"
  local fallback="$2"
  local value=""
  if [[ -r "$ENV_FILE" ]]; then
    value="$(grep -E "^${name}=" -- "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  fi
  printf '%s\n' "${value:-$fallback}"
}

ROOT="$(readlink -m -- "${MASTERQC_ROOT:-/opt/masterqc}")"
REPO="$ROOT/repo"
RELEASES="$ROOT/releases"
DATA_DIR="$(readlink -m -- "${MASTERQC_DATA_DIR:-$(env_file_value MASTERQC_DATA_DIR /var/lib/masterqc)}")"
BACKUPS_DIR="$(readlink -m -- "${MASTERQC_BACKUPS_DIR:-/var/lib/masterqc-backups}")"
PRE_RELEASE_DIR="$BACKUPS_DIR/pre-release"
VERIFY_PARENT="$BACKUPS_DIR/verify"
LISTEN_HOST="${MASTERQC_LISTEN_HOST:-$(env_file_value MASTERQC_LISTEN_HOST 127.0.0.1)}"
LISTEN_PORT="${MASTERQC_LISTEN_PORT:-$(env_file_value MASTERQC_LISTEN_PORT 4173)}"
VERIFY_PORT="${MASTERQC_VERIFY_PORT:-4180}"
SERVICE_UNIT="${MASTERQC_SERVICE_UNIT:-masterqc.service}"
SERVICE_USER="${MASTERQC_SERVICE_USER-masterqc}"
NODE_BIN="${MASTERQC_NODE:-node}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
HEALTH_TIMEOUT="${MASTERQC_HEALTH_TIMEOUT:-60}"
VERIFY_TIMEOUT="${MASTERQC_VERIFY_TIMEOUT:-120}"
# Releases kept on disk, newest first. The current and previous releases are always kept as well.
KEEP_RELEASES=5
RELEASE_NAME_PATTERN='^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7,40}$'

if [[ ! "$LISTEN_PORT" =~ ^[0-9]{1,5}$ || ! "$VERIFY_PORT" =~ ^[0-9]{1,5}$ ]]; then
  printf 'release.sh: the service port and the verification port must be whole numbers.\n' >&2
  exit 1
fi

WORK_DIR=""
VERIFY_PID=""
VERIFY_TEMP=""
BASELINE_COUNTS=""
PRE_RELEASE_SNAPSHOT=""

log() {
  printf '%s\n' "$*"
}

die() {
  printf 'release.sh: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'Usage: %s <git-ref> | --rollback\n' "$(basename -- "$0")" >&2
  exit 2
}

# IPv6 literals need brackets in URLs and in the Host header.
bracket() {
  if [[ "$1" == *:* ]]; then printf '[%s]' "$1"; else printf '%s' "$1"; fi
}

cleanup() {
  stop_verify_server
  if [[ -n "$VERIFY_TEMP" ]]; then rm -rf -- "$VERIFY_TEMP"; fi
  if [[ -n "$WORK_DIR" ]]; then rm -rf -- "$WORK_DIR"; fi
  rm -f -- "$ROOT/.current.next" "$ROOT/.previous.next"
}

acquire_lock() {
  mkdir -p -- "$ROOT"
  exec 9>"$ROOT/.release.lock"
  flock -n 9 || die "Another release or rollback is running."
  WORK_DIR="$(mktemp -d)"
  trap cleanup EXIT
}

# Canonical path of a release link, or empty when the link is absent.
link_target() {
  if [[ -L "$ROOT/$1" ]]; then readlink -f -- "$ROOT/$1"; fi
}

# Points a link at a target. The new link is created beside the old one and renamed over it, so readers never see
# a missing link.
point_link() {
  local name="$1"
  local target="$2"
  rm -f -- "$ROOT/.$name.next"
  ln -s -- "$target" "$ROOT/.$name.next"
  mv -T -- "$ROOT/.$name.next" "$ROOT/$name"
}

# Succeeds when the service answers /healthz and, when an expected release is given, reports that release.
service_ready() {
  local host="$1"
  local port="$2"
  local expected="$3"
  local base="http://$(bracket "$host"):$port"
  local host_header="$(bracket "$host"):$port"
  curl -fsS --max-time 3 -H "Host: $host_header" "$base/healthz" >/dev/null 2>&1 || return 1
  if [[ -n "$expected" ]]; then
    local session
    session="$(curl -fsS --max-time 3 -H "Host: $host_header" "$base/api/session" 2>/dev/null)" || return 1
    [[ "$session" == *"\"release\":\"$expected\""* ]] || return 1
  fi
  return 0
}

wait_for_service() {
  local host="$1"
  local port="$2"
  local expected="$3"
  local seconds="$4"
  local deadline=$((SECONDS + seconds))
  while (( SECONDS < deadline )); do
    if service_ready "$host" "$port" "$expected"; then return 0; fi
    sleep 1
  done
  return 1
}

stop_verify_server() {
  if [[ -n "$VERIFY_PID" ]]; then
    kill "$VERIFY_PID" 2>/dev/null || true
    wait "$VERIFY_PID" 2>/dev/null || true
    VERIFY_PID=""
  fi
}

# Starts the candidate on the verification port with the copied data directory, as the service account when set.
start_verify_server() {
  local release_dir="$1"
  local data_dir="$2"
  local log_file="$3"
  # setpriv replaces itself with the server, so VERIFY_PID is the server's own process.
  local -a launch=(env -i "PATH=$PATH" "HOME=${HOME:-/}"
    "MASTERQC_DATA_DIR=$data_dir"
    "MASTERQC_LISTEN_HOST=127.0.0.1"
    "MASTERQC_LISTEN_PORT=$VERIFY_PORT"
    "MASTERQC_PUBLIC_ORIGIN=http://127.0.0.1:$VERIFY_PORT"
    "MASTERQC_DEMO=off"
    "$NODE_BIN" launcher/server.mjs --no-open)
  local -a privileges=()
  if [[ -n "$SERVICE_USER" && "$(id -u)" -eq 0 ]]; then
    privileges=(setpriv "--reuid=$(id -u -- "$SERVICE_USER")" "--regid=$(id -g -- "$SERVICE_USER")" --clear-groups)
  fi
  (
    cd -- "$release_dir"
    exec "${privileges[@]}" "${launch[@]}"
  ) >"$log_file" 2>&1 &
  VERIFY_PID=$!
}

wait_for_verify_server() {
  local deadline=$((SECONDS + VERIFY_TIMEOUT))
  while (( SECONDS < deadline )); do
    if ! kill -0 "$VERIFY_PID" 2>/dev/null; then return 1; fi
    if curl -fsS --max-time 2 -H "Host: 127.0.0.1:$VERIFY_PORT" "http://127.0.0.1:$VERIFY_PORT/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Runs the verification of one candidate against a copy of the snapshot. Production is not touched here.
verify_candidate() {
  local release_dir="$1"
  local snapshot="$2"
  local counts="$3"
  local log_file="$WORK_DIR/verify-server.log"

  if curl -s --max-time 2 -o /dev/null "http://127.0.0.1:$VERIFY_PORT/" 2>/dev/null; then
    log "Port $VERIFY_PORT already answers. Stop the other program using it, or set MASTERQC_VERIFY_PORT."
    return 1
  fi

  mkdir -p -- "$VERIFY_PARENT"
  VERIFY_TEMP="$(mktemp -d "$VERIFY_PARENT/verify.XXXXXXXX")"
  install -m 0600 -- "$snapshot" "$VERIFY_TEMP/masterqc-main.sqlite"
  if [[ -n "$SERVICE_USER" && "$(id -u)" -eq 0 ]]; then
    chown -R -- "$SERVICE_USER" "$VERIFY_TEMP"
  fi

  start_verify_server "$release_dir" "$VERIFY_TEMP" "$log_file"
  if ! wait_for_verify_server; then
    log "The new release did not start on port $VERIFY_PORT. Its log:"
    tail -n 30 -- "$log_file" >&2 || true
    return 1
  fi

  if ! "$NODE_BIN" "$release_dir/scripts/verify-release.mjs" \
    --base-url "http://127.0.0.1:$VERIFY_PORT" \
    --host-header "127.0.0.1:$VERIFY_PORT" \
    --origin "http://127.0.0.1:$VERIFY_PORT" \
    --expect "$counts"; then
    return 1
  fi
  stop_verify_server
  rm -rf -- "$VERIFY_TEMP"
  VERIFY_TEMP=""
  return 0
}

# Reads the "revision" number from a counts file written by count-records.mjs.
revision_of() {
  sed -n 's/^[[:space:]]*"revision": *\([0-9][0-9]*\),\{0,1\}[[:space:]]*$/\1/p' -- "$1" | head -n 1
}

count_records_into() {
  local output="$1"
  "$NODE_BIN" "$2/scripts/count-records.mjs" \
    --base-url "http://$(bracket "$LISTEN_HOST"):$LISTEN_PORT" \
    --host-header "$(bracket "$LISTEN_HOST"):$LISTEN_PORT" >"$output"
}

# Takes the pre-release snapshot and the matching "before" counts. The counts are read before and after the snapshot,
# and the snapshot is accepted only when the revision did not move in between, so both describe the same data.
capture_baseline() {
  local release_dir="$1"
  local attempt
  # The snapshots belong to the service account, so the restore command can read them later.
  mkdir -p -- "$PRE_RELEASE_DIR"
  if [[ -n "$SERVICE_USER" && "$(id -u)" -eq 0 ]]; then chown -- "$SERVICE_USER" "$PRE_RELEASE_DIR"; fi
  chmod 0700 -- "$PRE_RELEASE_DIR"
  for attempt in 1 2 3; do
    local before="$WORK_DIR/before-$attempt.json"
    local after="$WORK_DIR/after-$attempt.json"
    count_records_into "$before" "$release_dir" || die "Could not read the record counts from the running service on $LISTEN_HOST:$LISTEN_PORT."
    local manifest
    # The running release takes the snapshot, so a broken candidate fails during verification rather than here.
    # The tool is started by its resolved path: a script reached through the `current` link must not depend on link handling.
    manifest="$("$NODE_BIN" "$(link_target current)/scripts/backup-snapshot.mjs" --data-dir "$DATA_DIR" --out-dir "$PRE_RELEASE_DIR" --workspace main)" \
      || die "The pre-release database snapshot could not be created or verified."
    count_records_into "$after" "$release_dir" || die "Could not read the record counts after the snapshot."
    local before_revision after_revision
    before_revision="$(revision_of "$before")"
    after_revision="$(revision_of "$after")"
    [[ -n "$before_revision" && -n "$after_revision" ]] || die "The record counts did not include a revision."
    if [[ "$before_revision" == "$after_revision" ]]; then
      BASELINE_COUNTS="$before"
      PRE_RELEASE_SNAPSHOT="${manifest%.json}.sqlite"
      [[ -f "$PRE_RELEASE_SNAPSHOT" ]] || die "The pre-release snapshot file is missing."
      if [[ -n "$SERVICE_USER" && "$(id -u)" -eq 0 ]]; then
        chown -- "$SERVICE_USER" "$PRE_RELEASE_SNAPSHOT" "$manifest"
      fi
      return 0
    fi
    log "Production saved changes while the snapshot was taken; retrying the snapshot."
  done
  die "Production kept changing while the snapshot was taken. Run the release again when no one is saving."
}

print_restore_guidance() {
  local snapshot="$1"
  log ""
  log "Database data was not restored automatically. If the release had already upgraded the database, restore"
  log "the pre-release snapshot while the service is stopped:"
  if [[ -z "$snapshot" ]]; then
    log "  No pre-release snapshot was found in $PRE_RELEASE_DIR."
    return 0
  fi
  # The command names the release that is live now, by its resolved path, so it runs the code that is installed.
  local live_release
  live_release="$(link_target current)"
  log "  sudo $SYSTEMCTL stop $SERVICE_UNIT"
  log "  sudo -u masterqc env MASTERQC_DATA_DIR=$DATA_DIR MASTERQC_LISTEN_HOST=$LISTEN_HOST MASTERQC_LISTEN_PORT=$LISTEN_PORT \\"
  log "    node $live_release/launcher/restore-snapshot.mjs $snapshot"
  log "  sudo $SYSTEMCTL start $SERVICE_UNIT"
  log "Pre-release snapshot: $snapshot"
}

# Keeps the newest releases and never removes the current or previous one.
prune_releases() {
  local current_name previous_name
  current_name="$(basename -- "$(link_target current)" 2>/dev/null || true)"
  previous_name="$(basename -- "$(link_target previous)" 2>/dev/null || true)"
  local index=0
  local name
  # Release names begin with a UTC timestamp, so a reverse sort lists the newest first.
  while IFS= read -r name; do
    [[ "$name" =~ $RELEASE_NAME_PATTERN ]] || continue
    [[ -d "$RELEASES/$name" ]] || continue
    index=$((index + 1))
    if (( index <= KEEP_RELEASES )) || [[ "$name" == "$current_name" || "$name" == "$previous_name" ]]; then
      continue
    fi
    rm -rf -- "$RELEASES/$name"
    log "Removed old release $name."
  done < <(ls -1 -- "$RELEASES" | sort -r)
}

resolve_ref() {
  local ref="$1"
  local sha
  if sha="$(git -C "$REPO" rev-parse --verify --quiet "refs/remotes/origin/$ref^{commit}")"; then
    printf '%s\n' "$sha"
    return 0
  fi
  if sha="$(git -C "$REPO" rev-parse --verify --quiet "$ref^{commit}")"; then
    printf '%s\n' "$sha"
    return 0
  fi
  return 1
}

release_new() {
  local ref="$1"
  git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || die "The release repository is missing. Clone the project into $REPO first."
  [[ -L "$ROOT/current" ]] || die "No current release is installed. Install the first release by hand (docs/deployment.md)."
  [[ "$VERIFY_PORT" != "$LISTEN_PORT" ]] || die "MASTERQC_VERIFY_PORT must differ from the service port $LISTEN_PORT."
  service_ready "$LISTEN_HOST" "$LISTEN_PORT" "" || die "The production service is not answering on $LISTEN_HOST:$LISTEN_PORT. Start it before releasing."

  git -C "$REPO" fetch --quiet --tags --prune origin || die "git fetch failed."
  local sha
  sha="$(resolve_ref "$ref")" || die "Git ref not found: $ref"
  local short stamp id release_dir
  short="$(git -C "$REPO" rev-parse --short=7 "$sha")"
  stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  id="$stamp-$short"
  release_dir="$RELEASES/$id"
  [[ ! -e "$release_dir" ]] || die "Release $id already exists."

  mkdir -p -- "$RELEASES"
  mkdir -- "$release_dir"
  if ! git -C "$REPO" archive --format=tar "$sha" | tar -x -C "$release_dir"; then
    rm -rf -- "$release_dir"
    die "Could not extract $ref into a release directory."
  fi
  # The database lives only in the production data directory. Neither a tracked copy nor the PDF sources ship with a release.
  rm -f -- "$release_dir"/data/workspace/*.sqlite "$release_dir"/data/workspace/*.sqlite-journal \
    "$release_dir"/data/workspace/*.sqlite-wal "$release_dir"/data/workspace/*.sqlite-shm
  rm -rf -- "$release_dir/data/pdf-import"
  printf '%s\n' "$id" >"$release_dir/RELEASE"
  log "Prepared release $id from $ref at $release_dir."

  capture_baseline "$release_dir"
  log "Pre-release snapshot: $PRE_RELEASE_SNAPSHOT"

  verify_candidate "$release_dir" "$PRE_RELEASE_SNAPSHOT" "$BASELINE_COUNTS" \
    || die "The new release failed verification. Production was not changed. Pre-release snapshot: $PRE_RELEASE_SNAPSHOT"
  log "Verification passed on port $VERIFY_PORT."

  local previous_target
  previous_target="$(link_target current)"
  point_link previous "$previous_target"
  point_link current "$release_dir"
  log "Switched current to $id; restarting $SERVICE_UNIT."

  if "$SYSTEMCTL" restart "$SERVICE_UNIT" && wait_for_service "$LISTEN_HOST" "$LISTEN_PORT" "$id" "$HEALTH_TIMEOUT"; then
    prune_releases
    log "Release $id is live and healthy."
    log "Pre-release snapshot kept at: $PRE_RELEASE_SNAPSHOT"
    return 0
  fi

  log "The new release did not become healthy within $HEALTH_TIMEOUT seconds. Switching back to the previous release."
  point_link current "$previous_target"
  if "$SYSTEMCTL" restart "$SERVICE_UNIT" && wait_for_service "$LISTEN_HOST" "$LISTEN_PORT" "$(cat -- "$previous_target/RELEASE")" "$HEALTH_TIMEOUT"; then
    log "The previous release is live and healthy again."
  else
    log "The previous release did not become healthy either. Inspect the service with journalctl -u $SERVICE_UNIT."
  fi
  print_restore_guidance "$PRE_RELEASE_SNAPSHOT"
  die "Release $id was not kept."
}

rollback_release() {
  [[ -L "$ROOT/previous" ]] || die "No previous release is recorded, so there is nothing to roll back to."
  local current_path previous_path previous_id
  current_path="$(link_target current)"
  previous_path="$(link_target previous)"
  [[ -n "$current_path" && -d "$current_path" ]] || die "No current release is installed."
  [[ -f "$previous_path/RELEASE" ]] || die "The previous release is missing or has no RELEASE file."
  [[ "$current_path" != "$previous_path" ]] || die "The current and previous links point to the same release."
  previous_id="$(cat -- "$previous_path/RELEASE")"
  local current_id="unknown"
  if [[ -f "$current_path/RELEASE" ]]; then
    current_id="$(cat -- "$current_path/RELEASE")"
  fi

  log "Rolling back from $current_id to $previous_id."
  # The two links swap, so a second rollback returns to the release that was just left.
  point_link current "$previous_path"
  point_link previous "$current_path"
  if ! "$SYSTEMCTL" restart "$SERVICE_UNIT" || ! wait_for_service "$LISTEN_HOST" "$LISTEN_PORT" "$previous_id" "$HEALTH_TIMEOUT"; then
    log "The rolled-back release did not become healthy within $HEALTH_TIMEOUT seconds. Inspect the service with journalctl -u $SERVICE_UNIT."
    print_restore_guidance "$(newest_pre_release_snapshot)"
    exit 1
  fi
  log "Rolled back to $previous_id; it is live and healthy."
  print_restore_guidance "$(newest_pre_release_snapshot)"
}

newest_pre_release_snapshot() {
  ls -1t -- "$PRE_RELEASE_DIR"/*.sqlite 2>/dev/null | head -n 1 || true
}

main() {
  case "$#" in
    1) ;;
    *) usage ;;
  esac
  case "$1" in
    --rollback)
      acquire_lock
      rollback_release
      ;;
    -h|--help|-*)
      usage
      ;;
    *)
      acquire_lock
      release_new "$1"
      ;;
  esac
}

main "$@"
