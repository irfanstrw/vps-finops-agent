#!/usr/bin/env bash
# FinOps VPS agent. Sends CPU, memory, disk and network metrics to the FinOps server.
# Read-only: it only reads /proc and df. It never changes anything on the VPS.
# Config comes from environment (systemd EnvironmentFile=/etc/finops-agent.env):
#   FINOPS_SERVER    e.g. http://10.0.0.5:8080
#   FINOPS_TOKEN     token from the Integrations page
#   FINOPS_INTERVAL  seconds between reports (default 60, min 15)
#   HTTPS_PROXY / HTTP_PROXY  optional, used by curl if your network requires a proxy
set -u

: "${FINOPS_SERVER:?FINOPS_SERVER is not set}"
: "${FINOPS_TOKEN:?FINOPS_TOKEN is not set}"
INTERVAL="${FINOPS_INTERVAL:-60}"
[ "$INTERVAL" -ge 15 ] 2>/dev/null || INTERVAL=60
URL="${FINOPS_SERVER%/}/agent/v1/heartbeat"

cpu_sample() {
  # prints "busy total" from the aggregate cpu line
  awk '/^cpu /{idle=$5+$6; t=0; for(i=2;i<=NF;i++) t+=$i; print t-idle, t; exit}' /proc/stat
}

json_str() {
  # strip characters that would break JSON
  printf '%s' "$1" | tr -d '"\\\000-\037' | cut -c1-100
}

collect() {
  local cpu_pct="$1"
  local mem_total mem_avail disk_total disk_used tx rx uptime os
  mem_total=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
  mem_avail=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
  read -r disk_total disk_used < <(df -B1 -l -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs --total --output=size,used 2>/dev/null | tail -n1)
  read -r rx tx < <(awk -F'[: ]+' 'NR>2 && $2!="lo" && $2 !~ /^(docker|veth|br-|virbr)/ {rx+=$3; tx+=$11} END{printf "%.0f %.0f\n", rx, tx}' /proc/net/dev)
  uptime=$(awk '{printf "%.0f", $1}' /proc/uptime)
  os=$( (. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-Linux}") || echo Linux)

  printf '{"hostname":"%s","os":"%s","arch":"%s","vcpu":%s,"cpu_pct":%s,"mem_total_kb":%s,"mem_used_kb":%s,"disk_total_bytes":%s,"disk_used_bytes":%s,"net_tx_bytes":%s,"net_rx_bytes":%s,"uptime_sec":%s}' \
    "$(json_str "$(hostname)")" "$(json_str "$os")" "$(uname -m)" "$(nproc)" "$cpu_pct" \
    "${mem_total:-0}" "$(( ${mem_total:-0} - ${mem_avail:-0} ))" "${disk_total:-0}" "${disk_used:-0}" \
    "${tx:-0}" "${rx:-0}" "${uptime:-0}"
}

send() {
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
    -H "Authorization: Bearer ${FINOPS_TOKEN}" -H 'Content-Type: application/json' \
    --data-binary "$1" "$URL") || code="000"
  case "$code" in
    200) ;;
    401) echo "Server rejected the token (401). Rotate the token in Integrations and update /etc/finops-agent.env." >&2 ;;
    000) echo "Cannot reach $URL. Check network, firewall or proxy." >&2 ;;
    *) echo "Server returned HTTP $code" >&2 ;;
  esac
  [ "$code" = 200 ]
}

if [ "${1:-}" = "--once" ]; then
  read -r b1 t1 < <(cpu_sample); sleep 2; read -r b2 t2 < <(cpu_sample)
  pct=$(awk -v b=$((b2-b1)) -v t=$((t2-t1)) 'BEGIN{printf "%.2f", t>0 ? b*100/t : 0}')
  payload=$(collect "$pct")
  echo "$payload"
  send "$payload" && echo "OK: server accepted the report."
  exit $?
fi

echo "FinOps agent started. Reporting to $URL every ${INTERVAL}s."
read -r b1 t1 < <(cpu_sample)
while true; do
  sleep "$INTERVAL"
  read -r b2 t2 < <(cpu_sample)
  pct=$(awk -v b=$((b2-b1)) -v t=$((t2-t1)) 'BEGIN{printf "%.2f", t>0 ? b*100/t : 0}')
  b1=$b2; t1=$t2
  send "$(collect "$pct")" || true
done
