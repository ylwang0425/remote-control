#!/usr/bin/env bash
#
# ai-remote-renew-cert.sh — renew the IP-address certificate and reload Caddy
# only when the certificate really changed.
#
# Installed by install-centos.sh to /usr/local/sbin/ai-remote-renew-cert.sh and
# driven by ai-remote-renew.timer. Safe to run by hand.
#
# There is no secret in this file. Certbot keeps its own account key.
#
# Errors are never swallowed: a renewal that fails, or a certificate that is
# missing or unreadable afterwards, exits non-zero so systemd records a failed
# unit instead of a silently stale certificate.

set -euo pipefail

readonly DOMAIN_IP="101.43.98.18"
readonly LE_DIR="/etc/letsencrypt/live/${DOMAIN_IP}"
readonly WEBROOT="/var/www/certbot"
readonly TLS_DIR="/etc/ssl/ai-remote"
readonly CADDYFILE="/etc/caddy/Caddyfile"
readonly CERTBOT_PATH_FILE="/etc/ai-remote-certbot-path"
readonly CERTBOT_VENV="/opt/certbot"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { printf '%s ERROR %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "must run as root"

# The renewal must use the same certbot that issued the certificate. The path is
# recorded at install time; the fallbacks cover a host where that file was lost.
CERTBOT_BIN=""
if [[ -r "${CERTBOT_PATH_FILE}" ]]; then
  candidate="$(cat "${CERTBOT_PATH_FILE}")"
  if [[ -x "${candidate}" ]]; then CERTBOT_BIN="${candidate}"; fi
fi
if [[ -z "${CERTBOT_BIN}" && -x "${CERTBOT_VENV}/bin/certbot" ]]; then
  CERTBOT_BIN="${CERTBOT_VENV}/bin/certbot"
fi
if [[ -z "${CERTBOT_BIN}" ]]; then
  candidate="$(command -v certbot || true)"
  if [[ -n "${candidate}" ]]; then CERTBOT_BIN="${candidate}"; fi
fi
[[ -n "${CERTBOT_BIN}" ]] || die "no certbot found; re-run install-centos.sh"
log "using certbot at ${CERTBOT_BIN} ($("${CERTBOT_BIN}" --version 2>/dev/null | awk '{print $2}' || echo unknown))"

cert_remaining_seconds() {
  local pem="$1" end
  [[ -f "${pem}" ]] || return 1
  end="$(openssl x509 -in "${pem}" -noout -enddate 2>/dev/null | cut -d= -f2-)" || return 1
  local end_epoch now_epoch
  end_epoch="$(date -d "${end}" +%s 2>/dev/null)" || return 1
  now_epoch="$(date +%s)"
  printf '%s' "$(( end_epoch - now_epoch ))"
}

cert_lifetime_seconds() {
  local pem="$1" start end
  start="$(openssl x509 -in "${pem}" -noout -startdate 2>/dev/null | cut -d= -f2-)" || return 1
  end="$(openssl x509 -in "${pem}" -noout -enddate 2>/dev/null | cut -d= -f2-)" || return 1
  local s e
  s="$(date -d "${start}" +%s 2>/dev/null)" || return 1
  e="$(date -d "${end}" +%s 2>/dev/null)" || return 1
  printf '%s' "$(( e - s ))"
}

# Renewal window: the last third of the certificate's own lifetime. An IP
# certificate from the shortlived profile lives about 160 hours, so this is
# roughly the last 53 hours — comfortably more than one daily timer interval.
remaining="$(cert_remaining_seconds "${LE_DIR}/fullchain.pem" || true)"
lifetime="$(cert_lifetime_seconds "${LE_DIR}/fullchain.pem" || true)"

if [[ -n "${remaining}" && -n "${lifetime}" ]] && (( lifetime > 0 )) && (( remaining > 0 )) && (( remaining * 3 >= lifetime )); then
  log "certificate still has $(( remaining / 3600 ))h of $(( lifetime / 3600 ))h; nothing to do"
  exit 0
fi

before=""
if [[ -f "${LE_DIR}/fullchain.pem" ]]; then
  before="$(sha256sum "${LE_DIR}/fullchain.pem" | awk '{print $1}')"
fi

# No --preferred-profile here on purpose: certbot records the profile chosen at
# issuance in the renewal configuration and reuses it. Passing the flag again on
# `renew` would depend on a subcommand-level option we cannot verify on this
# host, and an unrecognised flag would abort the renewal.
log "asking certbot to renew ${DOMAIN_IP} (webroot ${WEBROOT})"
if ! "${CERTBOT_BIN}" renew --cert-name "${DOMAIN_IP}" --webroot -w "${WEBROOT}" --quiet; then
  die "certbot renew failed; see /var/log/letsencrypt"
fi

after=""
if [[ -f "${LE_DIR}/fullchain.pem" ]]; then
  after="$(sha256sum "${LE_DIR}/fullchain.pem" | awk '{print $1}')"
fi
[[ -n "${after}" ]] || die "no certificate at ${LE_DIR}/fullchain.pem after the renewal run"

if ! openssl x509 -in "${LE_DIR}/fullchain.pem" -noout -checkend 86400 >/dev/null 2>&1; then
  die "the certificate at ${LE_DIR} expires within 24h; refusing to continue"
fi

caddy_user="$(systemctl show caddy -p User --value 2>/dev/null || true)"
[[ -n "${caddy_user}" ]] || caddy_user="caddy"
caddy_group="$(id -gn "${caddy_user}" 2>/dev/null || printf '%s' "${caddy_user}")"

install -d -m 0750 -o root -g "${caddy_group}" "${TLS_DIR}"
install -m 0644 -o root -g root "${LE_DIR}/fullchain.pem" "${TLS_DIR}/fullchain.pem"
install -m 0640 -o root -g "${caddy_group}" "${LE_DIR}/privkey.pem" "${TLS_DIR}/privkey.pem"
log "copied the certificate to ${TLS_DIR} (key 0640 root:${caddy_group})"

# `caddy validate` creates the access log as whichever user runs it, so a root
# validate leaves a root:root 0600 file that the service account cannot open —
# the unit then dies with "permission denied". Repair the log path around it.
reconcile_caddy_logs() {
  install -d -m 0750 -o "${caddy_user}" -g "${caddy_group}" /var/log/caddy
  [[ -d /var/log/caddy ]] || return 0
  chown "${caddy_user}:${caddy_group}" /var/log/caddy
  find /var/log/caddy -maxdepth 1 -type f -exec chown "${caddy_user}:${caddy_group}" {} + 2>/dev/null || true
  find /var/log/caddy -maxdepth 1 -type f -exec chmod 0640 {} + 2>/dev/null || true
  find /var/log/caddy -mindepth 1 -maxdepth 2 -type d -exec chown "${caddy_user}:${caddy_group}" {} + 2>/dev/null || true
  find /var/log/caddy -mindepth 1 -maxdepth 2 -type d -exec chmod 0750 {} + 2>/dev/null || true
}

if [[ "${before}" == "${after}" ]]; then
  log "certificate unchanged; not reloading Caddy"
  reconcile_caddy_logs
  exit 0
fi

log "certificate changed; validating as ${caddy_user} before reloading Caddy"
reconcile_caddy_logs
# Validate as the account that must actually serve it, so a certificate or log
# path only root can read is caught here instead of by an outage.
if command -v runuser >/dev/null 2>&1; then
  if ! runuser -u "${caddy_user}" -- caddy validate --config "${CADDYFILE}" >/dev/null 2>&1; then
    reconcile_caddy_logs
    die "${caddy_user} cannot use ${CADDYFILE}: the certificate or the log path is not readable by the service account"
  fi
elif ! caddy validate --config "${CADDYFILE}" >/dev/null 2>&1; then
  reconcile_caddy_logs
  die "the Caddyfile no longer validates; not reloading"
fi
reconcile_caddy_logs

systemctl reload caddy || die "caddy did not reload"

# No -k: this must fail if the served chain is not actually trusted.
if curl -fsS --max-time 25 -o /dev/null "https://${DOMAIN_IP}/health"; then
  log "post-reload TLS check passed (real chain, no -k)"
else
  die "https://${DOMAIN_IP}/health does not verify after the reload"
fi

log "certificate now valid for:"
openssl x509 -in "${LE_DIR}/fullchain.pem" -noout -dates
