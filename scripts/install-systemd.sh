#!/usr/bin/env bash
set -euo pipefail

# Installer for BackwardsWords systemd service
# - Detects Node path
# - Fills systemd template placeholders
# - Installs, reloads, enables and starts the service

UNIT_NAME="backwardswords"
USER_NAME="$(id -un)"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKDIR="$REPO_ROOT"
PORT="8000"
HTTPS_PORT="8443"
SSL_CERT_FILE="backwardswords.com.pem"
SSL_KEY_FILE="backwardswords.com.key"

usage() {
  cat <<USAGE
Usage: $0 [options]

Options:
  --unit-name NAME         Systemd unit name (default: $UNIT_NAME)
  --user USER              Runtime user (default: current user: $USER_NAME)
  --workdir PATH           Working directory (default: repository root)
  --port N                 HTTP port (default: $PORT)
  --https-port N           HTTPS port (default: $HTTPS_PORT)
  --ssl-cert FILE          Path to cert file relative to workdir (default: $SSL_CERT_FILE)
  --ssl-key  FILE          Path to key  file relative to workdir (default: $SSL_KEY_FILE)
  -h, --help               Show this help

Example:
  $0 --user catid --workdir "$REPO_ROOT" --port 8000 --https-port 8443
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --unit-name) UNIT_NAME="$2"; shift 2;;
    --user) USER_NAME="$2"; shift 2;;
    --workdir) WORKDIR="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --https-port) HTTPS_PORT="$2"; shift 2;;
    --ssl-cert) SSL_CERT_FILE="$2"; shift 2;;
    --ssl-key) SSL_KEY_FILE="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown option: $1" >&2; usage; exit 1;;
  esac
done

if [[ ! -f "$WORKDIR/server.js" ]]; then
  echo "Error: server.js not found in WORKDIR: $WORKDIR" >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Error: node not found in PATH" >&2
  exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"

# Build PATH for service (include node dir)
SERVICE_PATH="$NODE_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

TEMPLATE="$REPO_ROOT/systemd/backwardswords.service.tmpl"
if [[ ! -f "$TEMPLATE" ]]; then
  echo "Error: template not found: $TEMPLATE" >&2
  exit 1
fi

# Resolve cert/key absolute or leave relative to working directory
CERT_PATH="$SSL_CERT_FILE"
KEY_PATH="$SSL_KEY_FILE"

UNIT_FILE="/etc/systemd/system/${UNIT_NAME}.service"
echo "Installing systemd unit: $UNIT_FILE"

TMP_UNIT="$(mktemp)"
sed -e "s|__USER__|$USER_NAME|g" \
    -e "s|__WORKDIR__|$WORKDIR|g" \
    -e "s|__PORT__|$PORT|g" \
    -e "s|__HTTPS_PORT__|$HTTPS_PORT|g" \
    -e "s|__SSL_CERT_FILE__|$CERT_PATH|g" \
    -e "s|__SSL_KEY_FILE__|$KEY_PATH|g" \
    -e "s|__PATH__|$SERVICE_PATH|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    "$TEMPLATE" > "$TMP_UNIT"

sudo install -m 0644 "$TMP_UNIT" "$UNIT_FILE"
rm -f "$TMP_UNIT"

echo "Reloading systemd, enabling and starting service..."
sudo systemctl daemon-reload
sudo systemctl enable --now "$UNIT_NAME"
echo
systemctl --no-pager --full status "$UNIT_NAME" || true
echo
echo "Logs: journalctl -u $UNIT_NAME -f"

