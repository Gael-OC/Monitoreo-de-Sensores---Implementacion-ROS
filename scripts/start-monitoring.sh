#!/usr/bin/env bash
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"
case "${1:-}" in
collector)
  set +u
  source /opt/ros/jazzy/setup.bash
  set -u
  export ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST
  exec "$REPO_DIR/.venv/bin/python" -m monitoring.collector ;;
web) exec "$REPO_DIR/.venv/bin/python" -m uvicorn monitoring.api:app --host 127.0.0.1 --port 8000 --workers 1 ;;
*) echo 'Uso: collector | web' >&2; exit 1 ;;
esac
