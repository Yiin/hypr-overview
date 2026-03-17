#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/ags.log"

if /usr/bin/ags list | grep -qx 'ags'; then
  /usr/bin/ags quit || true
  sleep 0.5
fi

/usr/bin/ags run --log-file "$LOG_FILE"

pid=""
for _ in $(seq 1 50); do
  pid="$(pgrep -n -u "${USER:-$(id -un)}" -f '^gjs -m /run/user/[0-9]+/ags\.js$' || true)"
  if [[ -n "$pid" ]]; then
    break
  fi
  sleep 0.1
done

if [[ -z "$pid" ]]; then
  echo "failed to find AGS gjs process" >&2
  exit 1
fi

exec tail --pid="$pid" -f /dev/null
