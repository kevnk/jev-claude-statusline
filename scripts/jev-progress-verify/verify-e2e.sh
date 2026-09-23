#!/bin/bash
# End-to-end check: real transcript -> hook -> cache -> statusline. Usage: verify-e2e.sh <hook.mjs> <statusline.sh> <transcript.jsonl>
set -euo pipefail
HOOK=$1; SL=$2; TR=$3
SID=$(basename "$TR" .jsonl)
export CLAUDE_CONFIG_DIR=$(mktemp -d)/.claude
mkdir -p "$CLAUDE_CONFIG_DIR"
CACHE="$CLAUDE_CONFIG_DIR/cache/jev-progress/$SID.json"
common() { jq -n --arg sid "$SID" --arg tr "$TR" --arg ev "$1" --arg pid "$2" '{session_id:$sid, transcript_path:$tr, cwd:"/Users/kk/.claude", permission_mode:"auto", hook_event_name:$ev, prompt_id:$pid}'; }
sl_payload() { jq -n --arg sid "$SID" --arg pid "$1" '{session_id:$sid, prompt_id:$pid, model:{display_name:"Fable",id:"claude-fable-5-1"}, workspace:{current_dir:"/Users/kk/.claude"}, context_window:{context_window_size:200000, used_percentage:30, current_usage:{input_tokens:50000,cache_creation_input_tokens:0,cache_read_input_tokens:10000}}}'; }
show() { echo "--- $1"; jq -c '{prompt_id, turn_status, task: (.task // "" | .[0:70]), phase, done, waiting_on_user, samples: (.samples|length), last_error}' "$CACHE" 2>/dev/null || echo "(no cache)"; printf 'statusline: '; sl_payload "$2" | bash "$SL"; echo; }

echo "== 1. UserPromptSubmit resets"
common UserPromptSubmit p1 | jq '. + {prompt: "add a jev progress segment to the status line"}' | node "$HOOK"
show "after prompt" p1
echo "== 2. PostToolUse evaluates (real transcript tail)"
t0=$(date +%s%N)
common PostToolUse p1 | jq '. + {tool_name:"Bash", tool_input:{command:"bash -n statusline-git.sh", description:"Syntax-check the status line script"}, tool_use_id:"toolu_e2e_1"}' | JEV_STATE_LOG="$CLAUDE_CONFIG_DIR/state.json" node --import "$(cd "$(dirname "$0")" && pwd)/logfetch.mjs" "$HOOK"
echo "hook wall time: $(( ($(date +%s%N) - t0) / 1000000 ))ms"
show "after tool call" p1
echo "== 3. Stop evaluates with last_assistant_message"
common Stop p1 | jq '. + {stop_hook_active:false, last_assistant_message:"Done. The status line now shows a jev progress estimate; hook, settings, and statusline are wired and verified end to end."}' | node "$HOOK"
show "after stop" p1
echo "== 4. New prompt shows pending, old estimate hidden"
common UserPromptSubmit p2 | jq '. + {prompt: "now also show it in green"}' | node "$HOOK"
show "after second prompt" p2
echo "== 5. leftovers"
ls -la "$CLAUDE_CONFIG_DIR/cache/jev-progress/"
echo "== 6. state sent to jev on step 2 (privacy: Bash details must be descriptions, never command text)"
jq -c '{task: .task[0:80], turn_status, latest: .claude_latest_message[0:80], activity_count: (.activity|length)}' "$CLAUDE_CONFIG_DIR/state.json"
jq -r '.activity[] | "  \(.tool): \(.detail)"' "$CLAUDE_CONFIG_DIR/state.json"
if jq -r '.activity[] | select(.tool=="Bash") | .detail' "$CLAUDE_CONFIG_DIR/state.json" | grep -qE '^(cd |cat |ls |jq |node |bash |curl |sed )'; then echo "PRIVACY FAIL: raw command text in Bash detail"; exit 1; else echo "privacy ok"; fi
