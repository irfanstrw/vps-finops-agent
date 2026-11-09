#!/usr/bin/env bash
# Removes the FinOps agent from this VPS.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run as root (use sudo)." >&2; exit 1; }
systemctl disable --now finops-agent 2>/dev/null || true
rm -f /etc/systemd/system/finops-agent.service /usr/local/bin/finops-agent /etc/finops-agent.env
systemctl daemon-reload
echo "FinOps agent removed."
