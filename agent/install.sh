#!/usr/bin/env bash
# Installs the FinOps agent as a systemd service.
# Usage:
#   curl -fsSL <SERVER>/agent/install.sh | sudo bash -s -- --token <TOKEN> [--server <URL>] [--interval 60] [--proxy http://proxy:port]
set -euo pipefail

SERVER="__DEFAULT_SERVER__"
TOKEN=""
INTERVAL=60
PROXY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --proxy) PROXY="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "Run as root (use sudo)." >&2; exit 1; }
[ -n "$TOKEN" ] || { echo "--token is required." >&2; exit 1; }
[[ "$TOKEN" =~ ^fop_[A-Za-z0-9_-]+$ ]] || { echo "Token format looks wrong." >&2; exit 1; }
[[ "$INTERVAL" =~ ^[0-9]+$ ]] || { echo "--interval must be a number." >&2; exit 1; }
command -v systemctl >/dev/null || { echo "systemd is required." >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required (apt install curl / dnf install curl)." >&2; exit 1; }

echo "==> Downloading agent from $SERVER"
CURL_PROXY=()
[ -n "$PROXY" ] && CURL_PROXY=(--proxy "$PROXY")
curl -fsSL ${CURL_PROXY[@]+"${CURL_PROXY[@]}"} "${SERVER%/}/agent/finops-agent.sh" -o /usr/local/bin/finops-agent.tmp
chmod 755 /usr/local/bin/finops-agent.tmp
mv /usr/local/bin/finops-agent.tmp /usr/local/bin/finops-agent

echo "==> Writing /etc/finops-agent.env (root only, mode 600)"
umask 077
{
  echo "FINOPS_SERVER=$SERVER"
  echo "FINOPS_TOKEN=$TOKEN"
  echo "FINOPS_INTERVAL=$INTERVAL"
  if [ -n "$PROXY" ]; then echo "HTTPS_PROXY=$PROXY"; echo "HTTP_PROXY=$PROXY"; fi
} > /etc/finops-agent.env
chmod 600 /etc/finops-agent.env

echo "==> Installing systemd service"
cat > /etc/systemd/system/finops-agent.service <<'UNIT'
[Unit]
Description=FinOps VPS agent (read-only metrics reporter)
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/finops-agent.env
ExecStart=/usr/local/bin/finops-agent
Restart=always
RestartSec=30
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
UNIT

echo "==> Sending a test report"
set -a; . /etc/finops-agent.env; set +a
if /usr/local/bin/finops-agent --once >/dev/null; then
  echo "    Test report accepted."
else
  echo "    Test report failed. The service will keep retrying. Check: journalctl -u finops-agent -f" >&2
fi

systemctl daemon-reload
systemctl enable --now finops-agent
echo
echo "Done. Status: systemctl status finops-agent"
echo "Logs:        journalctl -u finops-agent -f"
