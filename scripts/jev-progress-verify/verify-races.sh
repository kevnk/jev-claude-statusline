#!/bin/bash
# Concurrency and failure edge cases for the jev progress hook. Usage: verify-races.sh <hook.mjs> <transcript.jsonl> [statusline.sh]
set -uo pipefail
HOOK=$1; TR=$2; SL=${3:-"$(cd "$(dirname "$0")/../.." && pwd)/statusline/statusline.sh"}; SID=$(basename "$TR" .jsonl)
export CLAUDE_CONFIG_DIR=$(mktemp -d)/.claude; mkdir -p "$CLAUDE_CONFIG_DIR"
DIR="$CLAUDE_CONFIG_DIR/cache/jev-progress"; CACHE="$DIR/$SID.json"; LOCK="$DIR/$SID.lock"
pay() { jq -n --arg sid "$SID" --arg tr "$TR" --arg ev "$1" --arg pid "$2" --arg id "$3" '{session_id:$sid, transcript_path:$tr, cwd:"/x", hook_event_name:$ev, prompt_id:$pid, tool_name:"Grep", tool_input:{pattern:"x"}, tool_use_id:$id, last_assistant_message:"Done. Everything is wired and verified."}'; }
field() { jq -r "$1" "$CACHE" 2>/dev/null; }
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1: got '$2' want '$3'"; fail=$((fail+1)); fi; }

pay UserPromptSubmit p1 - | jq '. + {prompt:"race test task"}' | node "$HOOK"

echo "== A. four concurrent PostToolUse -> exactly one evaluation"
for i in 1 2 3 4; do pay PostToolUse p1 "t$i" | node "$HOOK" & done; wait
check "A samples==1" "$(field '.samples|length')" "1"
check "A no lock left" "$(ls "$DIR" | grep -c lock)" "0"

echo "== B. Stop waits for a held lock instead of skipping"
mkdir "$LOCK"; ( sleep 2; rmdir "$LOCK" ) &
t0=$(date +%s); pay Stop p1 - | node "$HOOK"; wait; dt=$(( $(date +%s) - t0 ))
check "B turn_status stopped" "$(field .turn_status)" "stopped"
check "B waited >=2s" "$([ "$dt" -ge 2 ] && echo yes || echo no)" "yes"
check "B done populated ($(field .done))" "$(field '.done != null')" "true"

echo "== C. PostToolUse skips a fresh lock (no wait, no write)"
before=$(field .evaluated_at); mkdir "$LOCK"; pay PostToolUse p1 t9 | node "$HOOK"; rmdir "$LOCK"
check "C evaluated_at unchanged" "$(field .evaluated_at)" "$before"

echo "== D. stale lock (>20s) is broken by PostToolUse"
mkdir "$LOCK"; touch -t "$(date -v-60S +%Y%m%d%H%M.%S)" "$LOCK"
pay PostToolUse p1 t10 | node "$HOOK"
check "D evaluated_at advanced" "$([ "$(field .evaluated_at)" != "$before" ] && echo yes || echo no)" "yes"
check "D no lock left" "$(ls "$DIR" | grep -c lock)" "0"

echo "== E. reset mid-flight is not clobbered"
( pay PostToolUse p1 t11 | node "$HOOK" ) & sleep 0.15; pay UserPromptSubmit p2 - | jq '. + {prompt:"second task"}' | node "$HOOK"; wait
check "E prompt_id p2" "$(field .prompt_id)" "p2"
check "E no phase from old prompt" "$(field '.phase == null')" "true"

echo "== F. missing key keeps prior fields, sets last_error"
pay PostToolUse p2 t12 | node "$HOOK"; sc=$(field .phase.score)
pay PostToolUse p2 t13 | TYPESAFE_API_KEY= node "$HOOK"
check "F score kept" "$(field .phase.score)" "$sc"
check "F last_error set" "$(field '.last_error')" "TYPESAFE_API_KEY not set"
pay PostToolUse p2 t14 | node "$HOOK"
check "F last_error cleared on success" "$(field '.last_error')" "null"

echo "== G. subagent events ignored"
before=$(field .evaluated_at); pay PostToolUse p2 t15 | jq '. + {agent_id:"a1", agent_type:"Explore"}' | node "$HOOK"
check "G evaluated_at unchanged" "$(field .evaluated_at)" "$before"

echo "== H. failed evaluation on a new prompt never renders the old prompt's estimate"
pay PostToolUse p3 t16 | TYPESAFE_API_KEY= node "$HOOK"
rendered=$(jq -n --arg sid "$SID" '{session_id:$sid, prompt_id:"p3", model:{display_name:"F",id:"x"}, workspace:{current_dir:"/tmp"}, context_window:{context_window_size:200000, used_percentage:10, current_usage:{input_tokens:1000}}}' | bash "$SL")
check "H old estimate hidden" "$(printf '%s' "$rendered" | grep -c 'done ·')" "0"
check "H last_error recorded" "$(field .last_error)" "TYPESAFE_API_KEY not set"
echo "leftovers: $(ls "$DIR" | tr '\n' ' ')"
echo "$pass passed, $fail failed"; [ "$fail" -eq 0 ]
