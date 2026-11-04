#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir "$WORK/bin"
cat > "$WORK/bin/actual" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CAPTURE.args"
cat >> "$CAPTURE.stdin"
printf 'unexpected output\n'
printf 'unexpected error\n' >&2
exit "${STATUS:-0}"
FAKE
chmod +x "$WORK/bin/actual"
export CAPTURE="$WORK/capture"
payload='{"session_id":"s1","transcript_path":"/private/transcript","cwd":"/repo","hook_event_name":"SessionEnd","reason":"prompt_input_exit"}'
for status in 0 2 101; do
  printf '%s' "$payload" | env PATH="$WORK/bin:$PATH" STATUS="$status" bash "$ROOT/session-end.sh" > "$WORK/out" 2> "$WORK/err"
  test ! -s "$WORK/out" && test ! -s "$WORK/err"
done
test "$(wc -l < "$CAPTURE.args" | tr -d ' ')" = 3
test "$(sort -u "$CAPTURE.args")" = '__session-ended'
test "$(cat "$CAPTURE.stdin")" = "$payload$payload$payload"
rm "$CAPTURE.args" "$CAPTURE.stdin"
for setting in ACTUAL_PLAN_GATE=off ACTUAL_CLI_SUBPROCESS=1; do
  printf '%s' "$payload" | env PATH="$WORK/bin:$PATH" "$setting" bash "$ROOT/session-end.sh" > "$WORK/out" 2> "$WORK/err"
  test ! -e "$CAPTURE.args"
  test ! -s "$WORK/out" && test ! -s "$WORK/err"
done
printf '%s' "$payload" | env PATH=/usr/bin:/bin bash "$ROOT/session-end.sh" > "$WORK/out" 2> "$WORK/err"
test ! -s "$WORK/out" && test ! -s "$WORK/err"
python3 - "$ROOT/hooks.json" <<'PY'
import json, sys
hooks=json.load(open(sys.argv[1]))['hooks']['SessionEnd']
assert len(hooks)==1
assert len(hooks[0]['hooks'])==1
assert hooks[0]['hooks'][0]['command']=='"${CLAUDE_PLUGIN_ROOT}"/hooks/session-end.sh'
PY
printf 'SessionEnd registration, forwarding, silence and opt-outs passed\n'
