#!/bin/bash
# Offline render tests for statusline/statusline.sh: every Jev segment state, from made-up cache files.
# Usage: tests/statusline-test.sh. Needs bash and jq. No API key, no network, no real ~/.claude.
# shellcheck disable=SC2016 # $now in single quotes is a jq variable.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home" CLAUDE_CONFIG_DIR="$TMP/config"
unset TYPESAFE_API_KEY
CACHE="$CLAUDE_CONFIG_DIR/cache/jev-progress/s1.json"
mkdir -p "$HOME" "$TMP/work" "$TMP/bin" "$(dirname "$CACHE")"

# Pin the clock so the 120-second stale boundary can't flake. statusline.sh only calls `date +%s`.
NOW=1700000000
printf '#!/bin/sh\necho %s\n' "$NOW" > "$TMP/bin/date"; chmod +x "$TMP/bin/date"
export PATH="$TMP/bin:$PATH"

# Compare raw escape codes: stale and normal differ only by color.
ESC=$'\033'
DIM="${ESC}[2m" RED="${ESC}[31m" GREEN="${ESC}[32m" YELLOW="${ESC}[33m" CYAN="${ESC}[36m" OFF="${ESC}[0m"
LINE="${DIM}Test Model$OFF ${ESC}[35mwork$OFF  $DIM|$OFF  ${GREEN}90% left$OFF"
SEP="  $DIM|$OFF  "

# Same shape as the record hooks/jev-progress.mjs writes after a good evaluation.
RECORD='{session_id:"s1", prompt_id:"p1", task:"Made-up task for render tests", turn_status:"working", evaluated_at:$now, progress:0.45, phase:{score:2.25, confidence:0.9, top_level:2, label:"building"}, done:0.1, waiting_on_user:0.1, samples:[]}'
STOPPED='.turn_status="stopped"'
FAILED='.last_error="made-up failure" | .last_error_at=$now+1000'

PENDING="${DIM}⏳ …$OFF"
NORMAL="${CYAN}⏳ 45% done · building$OFF"
JEV_ERROR="${DIM}jev ✗$OFF"
# The trailing ! is what the script prints today: its error marker isn't limited to working turns.
STOPPED_ERROR="${DIM}⏹ stopped · jev ✗$OFF $DIM!$OFF"
NEEDS_YOU="${YELLOW}⏸ needs you$OFF"
DONE="${GREEN}✓ done$OFF"
STOPPED_AT="${RED}⏹ stopped at 45% · building$OFF"
LOW_CONFIDENCE="${DIM}⏳ ~45% done · building?$OFF"
STALE="${DIM}⏳ 45% done · building$OFF"

render() { # session_id prompt_id
    jq -n --arg dir "$TMP/work" --arg sid "$1" --arg pid "$2" \
        '{session_id:$sid, prompt_id:$pid, model:{display_name:"Test Model"}, workspace:{current_dir:$dir}, context_window:{context_window_size:200000, current_usage:{input_tokens:20000}}}' \
        | bash "$ROOT/statusline/statusline.sh" 2>&1
}

pass=0; fail=0
check() { # name want_segment [session_id] [prompt_id]
    local got want="$LINE"
    [ -n "$2" ] && want="$LINE$SEP$2"
    got=$(render "${3-s1}" "${4-p1}")
    if [ "$got" = "$want" ]; then
        echo "PASS $1"; pass=$((pass+1))
    else
        echo "FAIL $1"; echo "  got  ${got//$ESC/\\e}"; echo "  want ${want//$ESC/\\e}"; fail=$((fail+1))
    fi
}
write_cache() { jq -n --argjson now "$((NOW*1000))" "$RECORD | $1" > "$CACHE"; }
state() { write_cache "$2"; check "$1" "$3"; } # name jq_filter want_segment

echo "== no cache file"
check "jev off · restart session" "${DIM}jev off · restart session$OFF" none p1
check "no prompt yet: no segment" "" none ""
check "no session id: no segment" "" "" p1

echo "== no estimate to show"
state "prompt mismatch hides the old estimate" '.prompt_id="p0"' "$PENDING"
state "first evaluation pending" 'del(.progress)' "$PENDING"
state "jev ✗" "del(.progress) | $FAILED" "$JEV_ERROR"
printf 'not json' > "$CACHE"
check "corrupt cache shows pending" "$PENDING"

echo "== stopped"
state "⏹ stopped · jev ✗" "$STOPPED | $FAILED" "$STOPPED_ERROR"
state "⏸ needs you at 70%" "$STOPPED | .waiting_on_user=0.7" "$NEEDS_YOU"
state "not needs you at 69%" "$STOPPED | .waiting_on_user=0.69" "$STOPPED_AT"
state "✓ done at 80%" "$STOPPED | .done=0.8" "$DONE"
state "not done at 79%" "$STOPPED | .done=0.79" "$STOPPED_AT"
state "⏹ stopped at N%" "$STOPPED" "$STOPPED_AT"
state "null done and waiting" "$STOPPED | .done=null | .waiting_on_user=null" "$STOPPED_AT"
state "jev ✗ beats needs you" "$STOPPED | .waiting_on_user=0.9 | $FAILED" "$STOPPED_ERROR"
state "needs you beats done" "$STOPPED | .waiting_on_user=0.9 | .done=0.9" "$NEEDS_YOU"
state "stopped beats low confidence" "$STOPPED | .phase.confidence=0.1" "$STOPPED_AT"

echo "== working"
state "normal" '.' "$NORMAL"
state "low confidence ~N%? at 29%" '.phase.confidence=0.29' "$LOW_CONFIDENCE"
state "not low confidence at 30%" '.phase.confidence=0.3' "$NORMAL"
state "stale at 121s" '.evaluated_at=$now-121000' "$STALE"
state "not stale at 120s" '.evaluated_at=$now-120000' "$NORMAL"
state "low confidence beats stale" '.phase.confidence=0.1 | .evaluated_at=$now-121000' "$LOW_CONFIDENCE"
state "! after a failed re-evaluation" "$FAILED" "$NORMAL $DIM!$OFF"
state "no ! when the error is older than the estimate" '.last_error="made-up failure" | .last_error_at=$now-1000' "$NORMAL"
state "no ! when the error has the same timestamp" '.last_error="made-up failure" | .last_error_at=$now' "$NORMAL"
state "progress rounds down to 5% steps" '.progress=0.42' "${CYAN}⏳ 40% done · building$OFF"
state "progress rounds up to 5% steps" '.progress=0.43' "$NORMAL"
state "progress caps at 100%" '.progress=1.2' "${CYAN}⏳ 100% done · building$OFF"
state "label keeps its space" '.phase.label="wrapping up"' "${CYAN}⏳ 45% done · wrapping up$OFF"
state "cache without a prompt id is not a mismatch" '.prompt_id=""' "$NORMAL"
write_cache '.'
check "status input without a prompt id is not a mismatch" "$NORMAL" s1 ""

echo "$pass passed, $fail failed"; [ "$fail" -eq 0 ]
