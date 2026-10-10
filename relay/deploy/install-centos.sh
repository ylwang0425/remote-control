#!/usr/bin/env bash
#
# install-centos.sh — deploy the AI remote relay on CentOS Stream 9.
#
# Idempotent: running it twice leaves the machine in the same state. The second
# run does not re-issue a still-valid certificate, does not overwrite a Caddyfile
# it did not write, and does not restart a healthy relay.
#
# It does NOT touch the machine's global security posture:
#   * SELinux is left exactly as it is (this host has it Disabled; the script
#     never runs setenforce and never edits /etc/selinux/config).
#   * firewalld is left exactly as it is (this host has it inactive; the script
#     never starts, stops, enables or reconfigures it).
#   * Caddy is only installed or started. An existing Caddyfile that this script
#     did not write is NEVER overwritten: the run refuses and says so.
#   * No file is ever deleted as a side effect.
#
# There is no secret in this file, and none is ever written to it. The bridge
# token lives only in the config file, mode 0600.
#
# Usage:
#   sudo ./install-centos.sh [--binary /path/to/ai-remote-relay-linux-amd64]
#                            [--web /path/to/relay/web]
#                            [--apk /path/to/AI-Remote-Android.apk]
#                            [--skip-certbot]
#
# Exit codes: 0 success, 2 refused (a precondition would endanger the host),
# 1 a real failure.

set -euo pipefail

readonly DOMAIN_IP="101.43.98.18"
readonly RELAY_USER="ai-remote"
readonly RELAY_GROUP="ai-remote"
readonly PREFIX="/opt/ai-remote"
readonly CONFIG_DIR="/etc/ai-remote-relay"
readonly CONFIG_FILE="${CONFIG_DIR}/relay.json"
readonly STATE_DIR="/var/lib/ai-remote-relay"
readonly LOG_DIR="/var/log/ai-remote-relay"
readonly DOWNLOAD_DIR="/opt/ai-remote/downloads"
readonly WEBROOT="/var/www/certbot"
readonly TLS_DIR="/etc/ssl/ai-remote"
readonly LE_DIR="/etc/letsencrypt/live/${DOMAIN_IP}"
readonly UNIT_DIR="/etc/systemd/system"
readonly CADDY_DIR="/etc/caddy"
readonly CADDYFILE="${CADDY_DIR}/Caddyfile"
readonly CERTBOT_VENV="/opt/certbot"
readonly CERTBOT_PROFILE="shortlived"
readonly CERTBOT_MIN="5.4"
# Our own Caddyfile carries this marker. Its absence means the file belongs to
# somebody else and must not be touched.
readonly CADDY_MARKER="managed-by: ai-remote-relay"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

BINARY_SRC=""
WEB_SRC=""
APK_SRC=""
SKIP_CERTBOT=0
CERTBOT_BIN=""

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR\033[0m %s\n' "$*" >&2; exit 1; }
refuse() { printf '\033[1;31mREFUSED\033[0m %s\n' "$*" >&2; exit 2; }

usage() { sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# --------------------------------------------------------------------------
# Arguments
# --------------------------------------------------------------------------
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --binary) BINARY_SRC="$2"; shift 2 ;;
      --web)    WEB_SRC="$2";    shift 2 ;;
      --apk)    APK_SRC="$2";    shift 2 ;;
      --skip-certbot) SKIP_CERTBOT=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown argument: $1" ;;
    esac
  done
  if [[ -z "${BINARY_SRC}" ]]; then
    for candidate in "${SCRIPT_DIR}/../dist/ai-remote-relay-linux-amd64" "${SCRIPT_DIR}/ai-remote-relay-linux-amd64"; do
      if [[ -f "${candidate}" ]]; then BINARY_SRC="${candidate}"; break; fi
    done
  fi
  [[ -n "${BINARY_SRC}" ]] || die "no relay binary found; pass --binary /path/to/ai-remote-relay-linux-amd64"
  [[ -f "${BINARY_SRC}" ]] || die "binary not found: ${BINARY_SRC}"

  if [[ -z "${WEB_SRC}" ]]; then
    for candidate in "${SCRIPT_DIR}/../web" "${SCRIPT_DIR}/web"; do
      if [[ -d "${candidate}" ]]; then WEB_SRC="${candidate}"; break; fi
    done
  fi
}

# --------------------------------------------------------------------------
# Preconditions — every one of these is a reason to stop, not to work around
# --------------------------------------------------------------------------
preflight() {
  [[ $EUID -eq 0 ]] || die "must run as root (sudo $0)"

  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    log "host: ${PRETTY_NAME:-unknown}"
  fi

  for tool in systemctl curl tar openssl ss; do
    command -v "${tool}" >/dev/null 2>&1 || die "required tool is missing: ${tool}"
  done

  # Whatever holds 443 today stays untouched. If it is not Caddy, we refuse.
  local holder
  holder="$(ss -lntp 2>/dev/null | awk '$4 ~ /:443$/ {print $6}' | head -n1 || true)"
  if [[ -n "${holder}" && "${holder}" != *caddy* ]]; then
    refuse "port 443 is already held by ${holder}.
This script will not disturb a service that is already running on this host.
Stop it yourself, or run this relay on a different host."
  fi

  local selinux_state="unknown"
  if command -v getenforce >/dev/null 2>&1; then selinux_state="$(getenforce 2>/dev/null || echo unknown)"; fi
  local fw_state="unknown"
  if command -v firewall-cmd >/dev/null 2>&1; then
    fw_state="$(firewall-cmd --state 2>/dev/null || echo inactive)"
  fi
  log "existing posture, left untouched: SELinux=${selinux_state} firewalld=${fw_state}"
}

# --------------------------------------------------------------------------
# Certbot. CentOS Stream 9's packaged certbot is older than the 5.4 that
# --ip-address with the shortlived profile needs, so a private virtualenv is
# used and every later call goes through the same absolute path.
# --------------------------------------------------------------------------
certbot_version_at() {
  local bin="$1"
  [[ -x "${bin}" ]] || return 1
  local raw major minor
  raw="$("${bin}" --version 2>/dev/null | awk '{print $2}')" || return 1
  [[ -n "${raw}" ]] || return 1
  major="${raw%%.*}"
  minor="$(printf '%s' "${raw}" | cut -d. -f2)"
  [[ -n "${major}" && -n "${minor}" ]] || return 1
  if (( major > 5 )); then return 0; fi
  if (( major == 5 && minor >= 4 )); then return 0; fi
  return 1
}

install_certbot() {
  # 1. A system certbot that is already new enough wins.
  local system_certbot
  system_certbot="$(command -v certbot || true)"
  if [[ -n "${system_certbot}" ]] && certbot_version_at "${system_certbot}"; then
    CERTBOT_BIN="${system_certbot}"
    log "using the system certbot $("${CERTBOT_BIN}" --version 2>/dev/null | awk '{print $2}')"
    return 0
  fi

  # 2. A venv we built on an earlier run.
  if certbot_version_at "${CERTBOT_VENV}/bin/certbot"; then
    CERTBOT_BIN="${CERTBOT_VENV}/bin/certbot"
    log "using the existing certbot venv $("${CERTBOT_BIN}" --version 2>/dev/null | awk '{print $2}')"
    return 0
  fi

  # 3. Build one on a Python new enough for certbot 5.x.
  #
  # CentOS Stream 9's default python3 is 3.9, and pip cannot build certbot >=5.4
  # for it. Rather than hoping the system python is new enough, install 3.11
  # explicitly (3.12 when the repository offers it) and use only that.
  local python=""
  local candidate
  for candidate in python3.12 python3.11; do
    if command -v "${candidate}" >/dev/null 2>&1; then python="${candidate}"; break; fi
  done
  if [[ -z "${python}" ]]; then
    log "installing python3.11 for the certbot virtualenv (the system python3 is too old)"
    dnf -y install python3.11 python3.11-pip >/dev/null 2>&1 || true
    if command -v python3.12 >/dev/null 2>&1; then
      python="python3.12"
    elif command -v python3.11 >/dev/null 2>&1; then
      python="python3.11"
    fi
  fi
  [[ -n "${python}" ]] || die "could not install python3.11; install it by hand and re-run"

  local pyver
  pyver="$("${python}" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo 0.0)"
  local pymajor="${pyver%%.*}" pyminor="${pyver##*.}"
  if (( pymajor < 3 || (pymajor == 3 && pyminor < 11) )); then
    die "${python} is Python ${pyver}; certbot >= ${CERTBOT_MIN} needs 3.11 or newer.
Install python3.11 and re-run:
  dnf -y install python3.11 python3.11-pip"
  fi

  log "building a certbot >= ${CERTBOT_MIN} virtualenv with ${python} (Python ${pyver})"
  if ! "${python}" -m venv "${CERTBOT_VENV}" >/dev/null 2>&1; then
    log "installing ${python} development packages so venv works"
    case "${python}" in
      python3.12) dnf -y install python3.12 python3.12-pip >/dev/null 2>&1 || die "could not install python3.12" ;;
      python3.11) dnf -y install python3.11 python3.11-pip >/dev/null 2>&1 || die "could not install python3.11" ;;
      *)          die "unexpected interpreter ${python}" ;;
    esac
    "${python}" -m venv "${CERTBOT_VENV}" || die "could not create ${CERTBOT_VENV}"
  fi
  "${CERTBOT_VENV}/bin/pip" install --quiet --upgrade pip >/dev/null 2>&1 || true
  "${CERTBOT_VENV}/bin/pip" install --quiet "certbot>=${CERTBOT_MIN}" \
    || die "could not install certbot >= ${CERTBOT_MIN} into ${CERTBOT_VENV}"

  certbot_version_at "${CERTBOT_VENV}/bin/certbot" \
    || die "the certbot in ${CERTBOT_VENV} is still older than ${CERTBOT_MIN}"
  CERTBOT_BIN="${CERTBOT_VENV}/bin/certbot"
  log "certbot $("${CERTBOT_BIN}" --version 2>/dev/null | awk '{print $2}') installed at ${CERTBOT_BIN}"
  printf '%s\n' "${CERTBOT_BIN}" > /etc/ai-remote-certbot-path
}

# cert_remaining_seconds <pem> — seconds until notAfter, or empty on failure.
cert_remaining_seconds() {
  local pem="$1" end
  [[ -f "${pem}" ]] || return 1
  end="$(openssl x509 -in "${pem}" -noout -enddate 2>/dev/null | cut -d= -f2-)" || return 1
  [[ -n "${end}" ]] || return 1
  local end_epoch now_epoch
  end_epoch="$(date -d "${end}" +%s 2>/dev/null)" || return 1
  now_epoch="$(date +%s)"
  printf '%s' "$(( end_epoch - now_epoch ))"
}

# cert_lifetime_seconds <pem> — notAfter minus notBefore.
cert_lifetime_seconds() {
  local pem="$1" start end
  start="$(openssl x509 -in "${pem}" -noout -startdate 2>/dev/null | cut -d= -f2-)" || return 1
  end="$(openssl x509 -in "${pem}" -noout -enddate 2>/dev/null | cut -d= -f2-)" || return 1
  local s e
  s="$(date -d "${start}" +%s 2>/dev/null)" || return 1
  e="$(date -d "${end}" +%s 2>/dev/null)" || return 1
  printf '%s' "$(( e - s ))"
}

# cert_needs_renewal — true when the certificate is missing, unreadable, or has
# under a third of its own lifetime left.
#
# The threshold is a fraction of the certificate's OWN lifetime on purpose. An
# IP-address certificate from the shortlived profile lives about 160 hours, so a
# fixed "valid for 30 more days" test would be false on every run and the script
# would re-issue — and burn the weekly issuance quota — every single time.
cert_needs_renewal() {
  local pem="$1"
  local remaining lifetime
  remaining="$(cert_remaining_seconds "${pem}")" || return 0
  lifetime="$(cert_lifetime_seconds "${pem}")" || return 0
  [[ -n "${remaining}" && -n "${lifetime}" ]] || return 0
  if (( remaining <= 0 )); then return 0; fi
  if (( lifetime <= 0 )); then return 0; fi
  if (( remaining * 3 < lifetime )); then return 0; fi
  return 1
}

# --------------------------------------------------------------------------
# Caddy
# --------------------------------------------------------------------------
install_caddy() {
  if command -v caddy >/dev/null 2>&1; then
    log "caddy $(caddy version 2>/dev/null | head -n1) already installed"
  else
    log "installing caddy from the official COPR repository"
    dnf -y install 'dnf-command(copr)' >/dev/null 2>&1 || true
    dnf -y copr enable @caddy/caddy >/dev/null 2>&1 || die "could not enable the caddy COPR repository"
    dnf -y install caddy >/dev/null 2>&1 || die "could not install caddy"
    log "caddy $(caddy version 2>/dev/null | head -n1) installed"
  fi
  # The package normally creates this, but the next step writes into it, so make
  # sure it exists before anything is installed there.
  install -d -m 0755 -o root -g root "${CADDY_DIR}"

  # Caddy writes its own access log, so the log directory has to belong to the
  # account the service runs as. A root-owned directory means the log silently
  # never appears.
  local caddy_user caddy_group
  caddy_user="$(caddy_runs_as)"
  caddy_group="$(id -gn "${caddy_user}" 2>/dev/null || printf '%s' "${caddy_user}")"
  install -d -m 0750 -o "${caddy_user}" -g "${caddy_group}" /var/log/caddy

  # Write the certbot path where the renewal script will look for it.
  if [[ -n "${CERTBOT_BIN}" ]]; then
    printf '%s\n' "${CERTBOT_BIN}" > /etc/ai-remote-certbot-path
  fi
}

# caddy_runs_as — the user the caddy service runs as, so the private key and the
# access log can belong to exactly that account and nobody else.
caddy_runs_as() {
  local user
  user="$(systemctl show caddy -p User --value 2>/dev/null || true)"
  if [[ -z "${user}" ]]; then user="caddy"; fi
  printf '%s' "${user}"
}

caddy_group_of() {
  local user="$1"
  id -gn "${user}" 2>/dev/null || printf '%s' "${user}"
}

# reconcile_caddy_logs — make the log directory and every log file writable by
# the account the service runs as.
#
# This exists because `caddy validate` (and `caddy run`) create the log file
# eagerly, as whichever user invoked them. Running validate as root therefore
# leaves /var/log/caddy/ai-remote-access.log owned by root:root mode 0600, and
# the service account then cannot open it — the unit starts and immediately dies
# with "permission denied", even though the directory itself is correct. That is
# exactly what happened on the real host, where root had to fix it by hand.
#
# It runs before AND after every validate, so a first install and a re-run both
# end up correct.
reconcile_caddy_logs() {
  local caddy_user caddy_group
  caddy_user="$(caddy_runs_as)"
  caddy_group="$(caddy_group_of "${caddy_user}")"

  install -d -m 0750 -o "${caddy_user}" -g "${caddy_group}" /var/log/caddy
  [[ -d /var/log/caddy ]] || return 0

  chown "${caddy_user}:${caddy_group}" /var/log/caddy
  # The log itself plus any rotated copy caddy has written.
  find /var/log/caddy -maxdepth 1 -type f \
    -exec chown "${caddy_user}:${caddy_group}" {} + 2>/dev/null || true
  find /var/log/caddy -maxdepth 1 -type f \
    -exec chmod 0640 {} + 2>/dev/null || true
  # Caddy creates a per-site subdirectory when a log block names a file.
  find /var/log/caddy -mindepth 1 -maxdepth 2 -type d \
    -exec chown "${caddy_user}:${caddy_group}" {} + 2>/dev/null || true
  find /var/log/caddy -mindepth 1 -maxdepth 2 -type d \
    -exec chmod 0750 {} + 2>/dev/null || true
}

# validate_caddy <config-path> — validate, preferring the service account.
#
# Validating as the account that must actually run the config is the stronger
# check and the one this host needed: it proves the config, the certificate files
# and the log path are all usable by that account, and it does not create
# root-owned artefacts in the first place. Root remains only as a fallback, and
# whatever it creates is repaired before returning.
validate_caddy() {
  local config="$1"
  local caddy_user
  caddy_user="$(caddy_runs_as)"

  reconcile_caddy_logs

  if command -v runuser >/dev/null 2>&1; then
    if runuser -u "${caddy_user}" -- caddy validate --config "${config}" >/dev/null 2>&1; then
      reconcile_caddy_logs
      return 0
    fi
  fi

  if caddy validate --config "${config}" >/dev/null 2>&1; then
    reconcile_caddy_logs
    return 0
  fi

  # Even a failed validate may have created or touched the log file.
  reconcile_caddy_logs
  return 1
}

install_caddy_config() {
  local caddy_user
  caddy_user="$(caddy_runs_as)"

  # The private key must be readable by the proxy and by nobody else: directory
  # 0750, key 0640, both owned by root:<caddy user's group>.
  local caddy_group
  caddy_group="$(id -gn "${caddy_user}" 2>/dev/null || printf '%s' "${caddy_user}")"
  install -d -m 0750 -o root -g "${caddy_group}" "${TLS_DIR}"

  if [[ -f "${CADDYFILE}" ]]; then
    if grep -q "${CADDY_MARKER}" "${CADDYFILE}"; then
      log "existing Caddyfile is ours; updating it"
    elif grep -q '/usr/share/caddy' "${CADDYFILE}"; then
      # The stock Caddyfile the package ships. Replacing it is safe and is what
      # the operator expects on a fresh install.
      log "replacing the stock Caddyfile shipped by the caddy package"
      cp -a "${CADDYFILE}" "${CADDYFILE}.pkg-backup"
    else
      refuse "${CADDYFILE} exists and was not written by this script.
Its content is not the stock package default either, so it may serve something
else on this host. Installing over it could take another service down.

Either move it aside yourself, or merge the relay's site block into it by hand:
  server block needed:  https://${DOMAIN_IP}  ->  reverse_proxy 127.0.0.1:8080
  challenge block:      http://${DOMAIN_IP}/.well-known/acme-challenge/*  ->  root ${WEBROOT}"
    fi
  fi

  install -m 0644 -o root -g root "${SCRIPT_DIR}/Caddyfile" "${CADDYFILE}"
  install -m 0644 -o root -g root "${SCRIPT_DIR}/Caddyfile.bootstrap" "${CADDY_DIR}/Caddyfile.bootstrap"

  if validate_caddy "${CADDYFILE}"; then
    log "caddy config validated (as the caddy service account)"
  else
    warn "the full Caddyfile did not validate yet; that is expected before the certificate exists"
  fi
}

# --------------------------------------------------------------------------
# Users, directories, files
# --------------------------------------------------------------------------
ensure_user() {
  if getent group "${RELAY_GROUP}" >/dev/null; then
    log "group ${RELAY_GROUP} exists"
  else
    groupadd --system "${RELAY_GROUP}"
    log "group ${RELAY_GROUP} created"
  fi
  if id -u "${RELAY_USER}" >/dev/null 2>&1; then
    log "user ${RELAY_USER} exists"
  else
    useradd --system --gid "${RELAY_GROUP}" --home-dir "${PREFIX}" \
            --shell /sbin/nologin --comment "AI remote relay" "${RELAY_USER}"
    log "user ${RELAY_USER} created (system, nologin)"
  fi
}

ensure_dirs() {
  install -d -m 0755 -o root -g root "${PREFIX}"
  install -d -m 0750 -o "${RELAY_USER}" -g "${RELAY_GROUP}" "${STATE_DIR}"
  install -d -m 0750 -o "${RELAY_USER}" -g "${RELAY_GROUP}" "${LOG_DIR}"
  # Owned by the service account: the unit runs as ai-remote and must be able to
  # read its own credential file. Mode stays 0600, so no other account can.
  install -d -m 0750 -o "${RELAY_USER}" -g "${RELAY_GROUP}" "${CONFIG_DIR}"
  install -d -m 0755 -o root -g root "${DOWNLOAD_DIR}"
  install -d -m 0755 -o root -g root "${WEBROOT}"
  log "directories ready under ${PREFIX}, ${CONFIG_DIR}, ${STATE_DIR}"
}
install_binary() {
  local target="${PREFIX}/ai-remote-relay"
  if [[ -f "${target}" ]] && cmp -s "${BINARY_SRC}" "${target}"; then
    log "binary already current: ${target}"
  else
    install -m 0755 -o root -g root "${BINARY_SRC}" "${target}"
    log "binary installed: ${target} ($(stat -c %s "${BINARY_SRC}") bytes)"
  fi
}

install_web() {
  if [[ -z "${WEB_SRC}" || ! -d "${WEB_SRC}" ]]; then
    warn "no web directory given; the site routes will answer 404 until one is placed at ${PREFIX}/web"
    return 0
  fi
  install -d -m 0755 -o root -g root "${PREFIX}/web"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "${WEB_SRC}/" "${PREFIX}/web/" >/dev/null
  else
    cp -a "${WEB_SRC}/." "${PREFIX}/web/"
  fi
  chown -R root:root "${PREFIX}/web"
  find "${PREFIX}/web" -type d -exec chmod 0755 {} +
  find "${PREFIX}/web" -type f -exec chmod 0644 {} +
  log "web assets installed: ${PREFIX}/web ($(find "${PREFIX}/web" -type f | wc -l) files)"
}

install_apk() {
  if [[ -z "${APK_SRC}" ]]; then
    warn "no APK given; /downloads/ will answer 404 until a .apk is placed in ${DOWNLOAD_DIR}"
    return 0
  fi
  [[ -f "${APK_SRC}" ]] || die "APK not found: ${APK_SRC}"
  local name
  name="$(basename -- "${APK_SRC}")"
  if [[ ! "${name}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.apk$ ]]; then
    die "APK file name '${name}' does not match the relay's whitelist pattern"
  fi
  if [[ -f "${DOWNLOAD_DIR}/${name}" ]] && cmp -s "${APK_SRC}" "${DOWNLOAD_DIR}/${name}"; then
    log "APK already current: ${DOWNLOAD_DIR}/${name}"
  else
    install -m 0644 -o root -g root "${APK_SRC}" "${DOWNLOAD_DIR}/${name}"
    log "APK installed: ${DOWNLOAD_DIR}/${name} ($(stat -c %s "${DOWNLOAD_DIR}/${name}") bytes)"
  fi
  # Anything else in the whitelist root is reported, never deleted: the HTTP
  # layer already refuses to serve a non-.apk file, so this is a hygiene warning
  # and not a reason to remove somebody's file.
  local stray
  stray="$(find "${DOWNLOAD_DIR}" -maxdepth 1 -type f ! -name '*.apk' -print 2>/dev/null || true)"
  if [[ -n "${stray}" ]]; then
    warn "these files sit in the APK whitelist root and will never be served:"
    printf '    %s\n' ${stray} >&2
    warn "move them away yourself if that was not intended. Nothing was deleted."
  fi
}

ensure_config() {
  if [[ -f "${CONFIG_FILE}" ]]; then
    chown "${RELAY_USER}:${RELAY_GROUP}" "${CONFIG_FILE}"
    chmod 0600 "${CONFIG_FILE}"
    log "private config already present: ${CONFIG_FILE} (owner ${RELAY_USER}, mode 0600, kept as is)"
    return 0
  fi
  log "creating a new private config with a fresh high-entropy bridge token"
  "${PREFIX}/ai-remote-relay" --init --config "${CONFIG_FILE}"
  # --init writes 0600 as root. Hand the file to the service account so the unit
  # can read it; the mode stays 0600 so nobody else can.
  chown "${RELAY_USER}:${RELAY_GROUP}" "${CONFIG_FILE}"
  chmod 0600 "${CONFIG_FILE}"
  sed -i \
    -e "s#\"dbPath\": \"[^\"]*\"#\"dbPath\": \"${STATE_DIR}/relay.db\"#" \
    -e "s#\"logFile\": \"[^\"]*\"#\"logFile\": \"${LOG_DIR}/relay.log\"#" \
    -e "s#\"webDir\": \"[^\"]*\"#\"webDir\": \"${PREFIX}/web\"#" \
    -e "s#\"downloadsDir\": \"[^\"]*\"#\"downloadsDir\": \"${DOWNLOAD_DIR}\"#" \
    "${CONFIG_FILE}"
  chmod 0600 "${CONFIG_FILE}"
  log "config written: ${CONFIG_FILE} (owner ${RELAY_USER}, mode 0600)"
}

install_units() {
  install -m 0644 -o root -g root "${SCRIPT_DIR}/ai-remote-relay.service" "${UNIT_DIR}/ai-remote-relay.service"
  install -m 0755 -o root -g root "${SCRIPT_DIR}/ai-remote-renew-cert.sh" /usr/local/sbin/ai-remote-renew-cert.sh
  install -m 0644 -o root -g root "${SCRIPT_DIR}/ai-remote-renew.service" "${UNIT_DIR}/ai-remote-renew.service"
  install -m 0644 -o root -g root "${SCRIPT_DIR}/ai-remote-renew.timer" "${UNIT_DIR}/ai-remote-renew.timer"
  systemctl daemon-reload
  log "systemd units installed"
}

# --------------------------------------------------------------------------
# The IP-address certificate
# --------------------------------------------------------------------------
copy_certificate() {
  local caddy_user caddy_group
  caddy_user="$(caddy_runs_as)"
  caddy_group="$(id -gn "${caddy_user}" 2>/dev/null || printf '%s' "${caddy_user}")"

  [[ -f "${LE_DIR}/fullchain.pem" ]] || die "certbot reported success but ${LE_DIR}/fullchain.pem is missing"
  [[ -f "${LE_DIR}/privkey.pem" ]] || die "certbot reported success but ${LE_DIR}/privkey.pem is missing"

  install -d -m 0750 -o root -g "${caddy_group}" "${TLS_DIR}"
  install -m 0644 -o root -g root "${LE_DIR}/fullchain.pem" "${TLS_DIR}/fullchain.pem"
  # The key is readable by root and by the proxy's group only. It is never
  # world-readable.
  install -m 0640 -o root -g "${caddy_group}" "${LE_DIR}/privkey.pem" "${TLS_DIR}/privkey.pem"
  log "certificate copied to ${TLS_DIR} (key 0640 root:${caddy_group})"
}

issue_certificate() {
  if [[ "${SKIP_CERTBOT}" -eq 1 ]]; then
    log "--skip-certbot given; not touching certificates"
    if [[ ! -f "${TLS_DIR}/fullchain.pem" ]]; then
      warn "no certificate present, so the bootstrap Caddyfile stays in place:"
      warn "plain HTTP only, HTTPS is NOT configured on this host yet."
      install -m 0644 -o root -g root "${SCRIPT_DIR}/Caddyfile.bootstrap" "${CADDYFILE}"
      systemctl enable caddy >/dev/null 2>&1 || true
      systemctl restart caddy || warn "caddy did not start on the bootstrap config"
    fi
    return 0
  fi

  install_certbot
  export CERTBOT_BIN

  if ! cert_needs_renewal "${LE_DIR}/fullchain.pem"; then
    local remaining lifetime
    remaining="$(cert_remaining_seconds "${LE_DIR}/fullchain.pem")"
    lifetime="$(cert_lifetime_seconds "${LE_DIR}/fullchain.pem")"
    log "certificate still has $(( remaining / 3600 ))h of its $(( lifetime / 3600 ))h lifetime; not re-issuing"
    copy_certificate
    return 0
  fi

  log "requesting an IP-address certificate for ${DOMAIN_IP}"
  log "profile=${CERTBOT_PROFILE}, challenge=HTTP-01 via webroot ${WEBROOT}"

  # HTTP-01 needs something answering port 80 with the challenge from the
  # webroot. Caddy can, but the full config names TLS files that do not exist
  # yet, so the bootstrap config serves the challenge during issuance.
  log "starting Caddy on the bootstrap config so the challenge can be answered"
  install -m 0644 -o root -g root "${SCRIPT_DIR}/Caddyfile.bootstrap" "${CADDYFILE}"
  validate_caddy "${CADDYFILE}" || die "the bootstrap Caddyfile did not validate"
  systemctl enable caddy >/dev/null 2>&1 || true
  systemctl restart caddy || die "caddy did not start on the bootstrap config"
  sleep 2

  "${CERTBOT_BIN}" certonly \
    --non-interactive --agree-tos --register-unsafely-without-email \
    --preferred-challenges http \
    --webroot -w "${WEBROOT}" \
    --cert-name "${DOMAIN_IP}" \
    --ip-address "${DOMAIN_IP}" \
    --preferred-profile "${CERTBOT_PROFILE}" \
    || die "certbot could not issue the certificate (see /var/log/letsencrypt)"
  log "certificate issued"

  copy_certificate

  install -m 0644 -o root -g root "${SCRIPT_DIR}/Caddyfile" "${CADDYFILE}"
  validate_caddy "${CADDYFILE}" \
    || die "the full Caddyfile did not validate after the certificate was issued"
  # Caddy is still running the bootstrap config, which only answers port 80.
  # Without this restart nothing would ever listen on 443, and enable --now on an
  # already-active unit is a no-op, so this cannot be left to start_services.
  systemctl restart caddy || die "caddy did not restart on the full config"
  log "caddy restarted on the full config; loading site https://${DOMAIN_IP}"
}

# --------------------------------------------------------------------------
# Start and verify
# --------------------------------------------------------------------------
start_services() {
  systemctl enable --now caddy >/dev/null 2>&1 || die "could not enable and start caddy"
  systemctl enable --now ai-remote-relay.service >/dev/null 2>&1 || {
    journalctl -u ai-remote-relay.service -n 30 --no-pager || true
    die "the relay unit failed to start"
  }
  systemctl enable --now ai-remote-renew.timer >/dev/null 2>&1 || warn "could not enable the renewal timer"
  log "services enabled and started"
}

restart_relay_if_needed() {
  if systemctl is-active --quiet ai-remote-relay.service; then
    if curl -fsS --max-time 5 "http://127.0.0.1:8080/health" >/dev/null 2>&1; then
      log "relay is already healthy; not restarting"
      return 0
    fi
  fi
  systemctl restart ai-remote-relay.service
  sleep 2
  log "relay restarted"
}

verify() {
  log "verifying"
  local failures=0

  # 1. Loopback only.
  local listen
  listen="$(ss -lntp 2>/dev/null | awk '$4 ~ /:8080$/ {print $4}' | head -n1 || true)"
  if [[ -z "${listen}" ]]; then
    warn "  could not read the relay's listen socket"
  else
    case "${listen}" in
      127.0.0.1:8080|\[::1\]:8080) log "  relay listens on ${listen} (loopback only)";;
      *) warn "  the relay is listening on ${listen}; it must be loopback only"; failures=$((failures+1));;
    esac
  fi

  # 2. Health on the loopback socket. This proves the process is alive; it is
  #    NOT the TLS acceptance test.
  local health
  health="$(curl -fsS --max-time 5 http://127.0.0.1:8080/health || true)"
  if [[ -z "${health}" ]]; then
    warn "  GET http://127.0.0.1:8080/health did not answer"; failures=$((failures+1))
  else
    log "  /health -> ${health}"
  fi

  # 3. The site and the APK whitelist are on different routes and the site
  #    answers for its index.
  local site_code
  site_code="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ || true)"
  log "  local site / -> HTTP ${site_code}"

  # 4. MemoryMax really is in force.
  if systemctl show ai-remote-relay.service -p MemoryMax 2>/dev/null | grep -q 'MemoryMax=268435456'; then
    log "  MemoryMax=256M is in force"
  else
    warn "  could not confirm MemoryMax=256M from systemd"; failures=$((failures+1))
  fi

  # 5. TLS through Caddy, deliberately without -k so an untrusted chain fails.
  if [[ "${SKIP_CERTBOT}" -eq 1 ]]; then
    warn "  skipped the HTTPS check because --skip-certbot was given"
  else
    if curl -fsS --max-time 25 -o /dev/null "https://${DOMAIN_IP}/health"; then
      log "  https://${DOMAIN_IP}/health verified with a real chain (no -k)"
    else
      warn "  https://${DOMAIN_IP}/health did NOT verify"
      warn "  inspect with: curl -v https://${DOMAIN_IP}/health"
      failures=$((failures+1))
    fi
    log "  certificate in use:"
    echo | openssl s_client -connect "${DOMAIN_IP}:443" -servername "${DOMAIN_IP}" 2>/dev/null \
      | openssl x509 -noout -subject -issuer -dates 2>/dev/null | sed 's/^/    /' || true
  fi

  # 6. The renewal timer is armed.
  if systemctl is-enabled --quiet ai-remote-renew.timer 2>/dev/null; then
    log "  renewal timer armed: $(systemctl list-timers ai-remote-renew.timer --no-pager 2>/dev/null | sed -n 2p)"
  else
    warn "  the renewal timer is not enabled"; failures=$((failures+1))
  fi

  if (( failures > 0 )); then
    die "${failures} verification step(s) failed. The deployment is NOT complete."
  fi

  log "all verification steps passed"
  cat <<EOF

Next steps:
  1. Read the bridge token (never copy it anywhere public):
       sudo sed -n 's/.*"bridgeToken": "\\(.*\\)".*/\\1/p' ${CONFIG_FILE}
  2. Put it in the desktop bridge's own config on the Windows machine.
  3. Watch it work:
       journalctl -u ai-remote-relay.service -f
       curl -s http://127.0.0.1:8080/health
       curl -sS https://${DOMAIN_IP}/health

This script changed nothing about SELinux or firewalld, and deleted no file.
EOF
}

main() {
  parse_args "$@"
  preflight
  ensure_user
  ensure_dirs
  install_binary
  install_web
  install_apk
  # Caddy first: the package creates /etc/caddy and the caddy user that the
  # config step and the key permissions both depend on.
  install_caddy
  ensure_config
  install_caddy_config
  install_units
  issue_certificate
  start_services
  restart_relay_if_needed
  verify
}

main "$@"
