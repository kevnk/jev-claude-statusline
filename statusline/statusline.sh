#!/bin/bash

# Read the JSON input from stdin
input=$(cat)

# Extract values using jq
model=$(echo "$input" | jq -r '.model.display_name')
model_id=$(echo "$input" | jq -r '.model.id // ""')
current_dir=$(echo "$input" | jq -r '.workspace.current_dir')

# Get context window info from Claude Code
context_size=$(echo "$input" | jq -r '.context_window.context_window_size // "null"')
usage=$(echo "$input" | jq '.context_window.current_usage')
context_estimated=false

# OpenRouter/Third-party provider fallback for context window size
# When Claude Code doesn't know the context size (e.g., using OpenRouter),
# use CLAUDE_CONTEXT_WINDOW_SIZE env var or fall back to a sensible default
if [ "$context_size" = "null" ] || [ "$context_size" = "0" ] || [ -z "$context_size" ]; then
    context_estimated=true
    # Check for user-defined override via environment variable
    if [ -n "$CLAUDE_CONTEXT_WINDOW_SIZE" ]; then
        context_size="$CLAUDE_CONTEXT_WINDOW_SIZE"
    else
        # Default fallback: 200k tokens (common for most Claude models via OpenRouter)
        # Users can override this by setting CLAUDE_CONTEXT_WINDOW_SIZE env var
        # Common values:
        #   - 200000 for Claude 3.5 Sonnet, Claude 3 Opus, Claude 3 Haiku
        #   - 1000000 for Claude Sonnet 4.5 with 1M context
        #   - 128000 for many other models
        context_size=200000
    fi
fi

# Try to get token usage from multiple sources
# 1. First try current_usage from statusline JSON
# 2. Fall back to used_percentage if available
# 3. Fall back to total tokens if current_usage is null
current_tokens=0
has_usage_data=false

if [ "$usage" != "null" ] && [ -n "$usage" ]; then
    # Try to calculate from current_usage object
    current_tokens=$(echo "$usage" | jq -r '(.input_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0)' 2>/dev/null)
    if [ -n "$current_tokens" ] && [ "$current_tokens" != "null" ] && [ "$current_tokens" -gt 0 ] 2>/dev/null; then
        has_usage_data=true
    fi
fi

# If current_usage didn't work, try used_percentage directly
if [ "$has_usage_data" = false ]; then
    used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // "null"')
    if [ "$used_pct" != "null" ] && [ -n "$used_pct" ]; then
        # We have used_percentage, use it directly
        percent_left=$(echo "100 - $used_pct" | bc 2>/dev/null || echo "100")
        # Round to integer
        percent_left=${percent_left%.*}
        has_usage_data=true
    fi
fi

# If we still don't have usage data, try total_input_tokens as last resort
if [ "$has_usage_data" = false ]; then
    total_input=$(echo "$input" | jq -r '.context_window.total_input_tokens // "null"')
    if [ "$total_input" != "null" ] && [ -n "$total_input" ] && [ "$total_input" -gt 0 ] 2>/dev/null; then
        current_tokens=$total_input
        has_usage_data=true
    fi
fi

# Calculate context percentage left
if [ "$has_usage_data" = true ] && [ "$current_tokens" -gt 0 ] 2>/dev/null; then
    percent_left=$((100 - (current_tokens * 100 / context_size)))
    # Ensure percent_left is within bounds
    [ "$percent_left" -lt 0 ] && percent_left=0
    [ "$percent_left" -gt 100 ] && percent_left=100
elif [ -z "${percent_left:-}" ]; then
    # No usage data at all - show as unknown or full
    percent_left=100
fi

# Get the basename of current directory for display
dir_name=$(basename "$current_dir")

# Build the left side (model, dir, branch)
left_side=""

# Get git branch if in a git repository
if git -C "$current_dir" rev-parse --git-dir >/dev/null 2>&1; then
    # Skip git locks to avoid hanging
    branch=$(git -C "$current_dir" --no-optional-locks branch --show-current 2>/dev/null || echo "detached")
    left_side=$(printf "\033[2m%s\033[0m \033[35m%s\033[0m on \033[36m%s\033[0m" "$model" "$dir_name" "$branch")
else
    left_side=$(printf "\033[2m%s\033[0m \033[35m%s\033[0m" "$model" "$dir_name")
fi

# Color the percentage based on remaining context
# Add a tilde (~) prefix if context size is estimated (OpenRouter/third-party)
prefix=""
if [ "$context_estimated" = true ]; then
    prefix="~"
fi

if [ "$has_usage_data" = false ]; then
    # No usage data available - show "?" indicator
    context_display=$(printf "\033[2m? left\033[0m")
elif [ "$percent_left" -ge 50 ]; then
    # Green for plenty of context
    context_display=$(printf "\033[32m%s%d%% left\033[0m" "$prefix" "$percent_left")
elif [ "$percent_left" -ge 25 ]; then
    # Yellow for moderate context
    context_display=$(printf "\033[33m%s%d%% left\033[0m" "$prefix" "$percent_left")
else
    # Red for low context
    context_display=$(printf "\033[31m%s%d%% left\033[0m" "$prefix" "$percent_left")
fi

# jev task-progress segment: rendered from the cache that hooks/jev-progress.mjs writes
session_id=$(echo "$input" | jq -r '.session_id // ""')
prompt_id=$(echo "$input" | jq -r '.prompt_id // ""')
jev_display=""
jev_file="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/cache/jev-progress/${session_id}.json"
if [ -n "$session_id" ] && [ ! -f "$jev_file" ] && [ -n "$prompt_id" ]; then
    # A prompted session with no cache means the hook never ran: hooks load at session start.
    jev_display=$(printf "\033[2mjev off · restart session\033[0m")
elif [ -n "$session_id" ] && [ -f "$jev_file" ]; then
    now_ms=$(( $(date +%s) * 1000 ))
    IFS='|' read -r j_prompt j_status j_pct j_conf j_label j_done j_wait j_age j_err <<< "$(jq -r --argjson now "$now_ms" '
        def text: if (. // "") == "" then "-" else . end;
        [ (.prompt_id | text),
          (.turn_status | text),
          (if .progress != null then (.progress * 20 | round | . * 5) else -1 end),
          (((.phase.confidence // 0) * 100) | round),
          (.phase.label | text | gsub(" "; "_")),
          (((.done // 0) * 100) | round),
          (((.waiting_on_user // 0) * 100) | round),
          (if .evaluated_at then (($now - .evaluated_at) / 1000 | floor) else -1 end),
          (if .last_error and ((.last_error_at // 0) > (.evaluated_at // 0)) then 1 else 0 end)
        ] | join("|")' "$jev_file" 2>/dev/null)"
    if [ -n "$prompt_id" ] && [ -n "$j_prompt" ] && [ "$j_prompt" != "-" ] && [ "$j_prompt" != "$prompt_id" ]; then
        jev_display=$(printf "\033[2m⏳ …\033[0m")
    elif [ "${j_pct:--1}" -lt 0 ]; then
        if [ "$j_err" = "1" ]; then
            jev_display=$(printf "\033[2mjev ✗\033[0m")
        else
            jev_display=$(printf "\033[2m⏳ …\033[0m")
        fi
    else
        [ "$j_pct" -gt 100 ] && j_pct=100
        label=${j_label//_/ }
        if [ "$j_status" = "stopped" ] && [ "$j_err" = "1" ]; then
            jev_display=$(printf "\033[2m⏹ stopped · jev ✗\033[0m")
        elif [ "$j_status" = "stopped" ] && [ "$j_wait" -ge 70 ]; then
            jev_display=$(printf "\033[33m⏸ needs you\033[0m")
        elif [ "$j_status" = "stopped" ] && [ "$j_done" -ge 80 ]; then
            jev_display=$(printf "\033[32m✓ done\033[0m")
        elif [ "$j_status" = "stopped" ]; then
            jev_display=$(printf "\033[31m⏹ stopped at %d%% · %s\033[0m" "$j_pct" "$label")
        elif [ "$j_conf" -lt 30 ]; then
            jev_display=$(printf "\033[2m⏳ ~%d%% done · %s?\033[0m" "$j_pct" "$label")
        elif [ "$j_age" -gt 120 ]; then
            jev_display=$(printf "\033[2m⏳ %d%% done · %s\033[0m" "$j_pct" "$label")
        else
            jev_display=$(printf "\033[36m⏳ %d%% done · %s\033[0m" "$j_pct" "$label")
        fi
        if [ "$j_err" = "1" ]; then
            jev_display="$jev_display $(printf "\033[2m!\033[0m")"
        fi
    fi
fi

# Output: left side | context % (hide context if model name contains "/")
if [[ "$model" == *"/"* ]]; then
    # Model name contains "/" - hide context display
    printf "%s" "$left_side"
else
    # Normal display with context
    printf "%s  \033[2m|\033[0m  %s" "$left_side" "$context_display"
fi
if [ -n "$jev_display" ]; then
    printf "  \033[2m|\033[0m  %s" "$jev_display"
fi