#!/usr/bin/env bash
# SessionEnd has a short shutdown budget. The CLI only spools and starts its
# detached uploader; no installation, version probe or network wait belongs here.
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/bootstrap.sh
. "${SCRIPT_DIR}/lib/bootstrap.sh"

payload=$(cat)
if [ "${ACTUAL_PLAN_GATE:-on}" = "off" ] || inside_actual_subprocess || ! have_actual; then
  exit 0
fi
printf '%s' "$payload" 2>/dev/null | actual __session-ended >/dev/null 2>&1
exit 0
