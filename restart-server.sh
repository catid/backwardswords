#!/usr/bin/env bash
set -euo pipefail

# Restart the BackwardsWords server.
# Prefers systemd unit 'backwardswords'; falls back to killing and
# background-starting `npm start` from this repo directory.

UNIT_NAME="${UNIT_NAME:-backwardswords}"
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

have_systemctl() { command -v systemctl >/dev/null 2>&1; }
unit_exists() {
  # consider unit present if status returns any output or file exists
  systemctl status "$UNIT_NAME" >/dev/null 2>&1 || [[ -f "/etc/systemd/system/${UNIT_NAME}.service" ]]
}

if have_systemctl && unit_exists; then
  echo "Restarting systemd unit: $UNIT_NAME"
  sudo systemctl restart "$UNIT_NAME"
  systemctl --no-pager --full status "$UNIT_NAME" || true
  echo "Logs: journalctl -u $UNIT_NAME -f"
  exit 0
fi

echo "Systemd unit not found. Restarting npm process in background..."

# Stop existing node server for this repo
PIDS=$(pgrep -f "node server.js" || true)
if [[ -n "${PIDS}" ]]; then
  for pid in $PIDS; do
    if [[ -L "/proc/$pid/cwd" ]]; then
      CWD=$(readlink -f "/proc/$pid/cwd" || true)
      if [[ "$CWD" == "$REPO_ROOT" ]]; then
        echo "Stopping PID $pid"
        kill -INT "$pid" || true
      fi
    fi
  done
  sleep 1
fi

cd "$REPO_ROOT"
mkdir -p logs
LOG_FILE="logs/backwardswords.out"
echo "Starting npm start (background). Logs: $LOG_FILE"
nohup npm start >> "$LOG_FILE" 2>&1 &
echo $! > .pid
echo "Started PID $(cat .pid)"

