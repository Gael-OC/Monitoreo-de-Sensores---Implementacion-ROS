#!/usr/bin/env bash
# Run on Ubuntu as the laboratory user: sudo bash scripts/monitoring-services.sh activate
set -euo pipefail
ACTION="${1:-status}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_USER="${SUDO_USER:-$USER}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
STATE="$RUN_HOME/.local/state/microalgas-deploy"
if [[ "$ACTION" == status ]]; then
  systemctl --no-pager status monitoring-collector monitoring-web || true
  exit
fi
[[ "$EUID" == 0 ]] || { echo 'Ejecuta este comando con sudo en el PC del laboratorio.' >&2; exit 1; }
if [[ "$ACTION" == rollback ]]; then
  [[ -f "$STATE/old-services" ]] || { echo 'No existe estado previo de activación.'; exit 1; }
  systemctl disable --now monitoring-collector monitoring-web
  if [[ -f "$STATE/serve.json" ]]; then tailscale serve --https=443 off || true; fi
  while read -r unit enabled active; do
    if [[ "$enabled" == enabled ]]; then systemctl enable "$unit"; else systemctl disable "$unit"; fi
    if [[ "$active" == active ]]; then systemctl start "$unit"; else systemctl stop "$unit"; fi
  done < "$STATE/old-services"
  if [[ -f "$STATE/crontab" ]]; then crontab -u "$RUN_USER" "$STATE/crontab"; fi
  echo 'Servicios originales restaurados. Los datos nuevos y sus respaldos se conservan.'
  exit
fi
[[ "$ACTION" == activate ]] || { echo 'Uso: activate | rollback | status'; exit 1; }
[[ -x "$REPO_DIR/.venv/bin/python" && -f /opt/ros/jazzy/setup.bash ]] || { echo 'Falta el entorno virtual o ROS Jazzy'; exit 1; }
[[ ! -d "$STATE" ]] || { echo "Ya existe $STATE. Revisa el despliegue anterior antes de repetir."; exit 1; }
mkdir -p "$STATE"
# Preserve whether the old services were actually enabled/running.
for unit in smart-bridge.service smart-alerter.service; do
  enabled="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
  active="$(systemctl is-active "$unit" 2>/dev/null || true)"
  echo "$unit $enabled $active" >> "$STATE/old-services"
done
touch "$STATE/old-services"
crontab -u "$RUN_USER" -l > "$STATE/crontab" 2>/dev/null || true
tailscale serve status --json > "$STATE/serve.json"
# Do not overwrite an existing private proxy configuration.
python3 - "$STATE/serve.json" <<'PY'
import json,sys
if json.load(open(sys.argv[1])):
    raise SystemExit('Tailscale Serve ya tiene configuración: integrarla manualmente antes de activar.')
PY
for kind in collector web; do
  cat > "/etc/systemd/system/monitoring-$kind.service" <<EOF
[Unit]
Description=Microalgas monitoring $kind
After=network-online.target smart-agent.service
Wants=network-online.target smart-agent.service
[Service]
User=$RUN_USER
WorkingDirectory=$REPO_DIR
Environment=PYTHONUNBUFFERED=1
ExecStart=/bin/bash "$REPO_DIR/scripts/start-monitoring.sh" $kind
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
done
systemctl daemon-reload
# Avoid Telegram reading an archive whose cadence has changed.
while read -r unit enabled active; do systemctl disable --now "$unit"; done < "$STATE/old-services"
python3 - "$STATE/crontab" "$STATE/cron-new" <<'PY'
import sys
lines=open(sys.argv[1]).readlines()
open(sys.argv[2],'w').writelines(line for line in lines if not ('smart_reporter.py' in line or 'smart_alerter.py' in line))
PY
crontab -u "$RUN_USER" "$STATE/cron-new"
# Stop only temporary processes launched from this exact checkout.
python3 - "$REPO_DIR" <<'PYCODE'
import os,signal,sys,time
from pathlib import Path
root=Path(sys.argv[1])
for name in ('collector','web'):
    p=root/'.monitoring'/f'{name}.pid'
    if p.exists():
        pid=int(p.read_text())
        proc=Path('/proc')/str(pid)
        if proc.exists() and (proc/'cwd').resolve()==root and b'monitoring.' in (proc/'cmdline').read_bytes():
            os.kill(pid,signal.SIGTERM)
            for _ in range(50):
                try: os.kill(pid,0)
                except ProcessLookupError: break
                time.sleep(0.1)
PYCODE
systemctl enable --now monitoring-collector monitoring-web
if ! curl --fail --silent http://127.0.0.1:8000/healthz >/dev/null; then
  sleep 3
  curl --fail http://127.0.0.1:8000/healthz || { echo 'Verificar logs o ejecutar rollback.'; exit 1; }
fi
tailscale serve --bg --yes http://127.0.0.1:8000
echo 'Activado. Verifica tailscale serve status y abre el enlace privado.'
