# jev-claude-statusline

Claude Code status line segment powered by [Jev](https://typesafe.ai) (TypeSafe System One). While Claude works, a hook asks Jev how far the turn has progressed; the status line shows an estimate such as `⏳ 45% done · building`.

**Not** official TypeSafe software. Requires a TypeSafe API key and paid Jev inference. Source-reviewed packaging of a working local setup; not a security audit or accuracy benchmark.

## What Jev decides

On each `UserPromptSubmit`, `PostToolUse`, and `Stop` hook, `hooks/jev-progress.mjs` builds a small state object (task text, recent tool summaries, latest assistant message, turn status) and asks Jev:

| Question | Type | Role |
| --- | --- | --- |
| `phase` | Score (0–5) | How far toward completing the request (not started → done) |
| `done` | Noul | Whether the turn finished and reported the outcome |
| `waiting_on_user` | Noul | Whether Claude is stopped waiting on you |

Answers are cached under `~/.claude/cache/jev-progress/<session_id>.json`. `statusline/statusline.sh` reads that cache and renders the segment. Bash tool details sent to Jev use the human `description` field, not raw command text.

## Install

1. Copy into your Claude config dir (default `~/.claude`):

```sh
git clone https://github.com/kevnk/jev-claude-statusline.git
cp jev-claude-statusline/hooks/jev-progress.mjs ~/.claude/hooks/
mkdir -p ~/.claude/statusline
cp jev-claude-statusline/statusline/statusline.sh ~/.claude/statusline/
chmod +x ~/.claude/hooks/jev-progress.mjs ~/.claude/statusline/statusline.sh
```

2. Merge the hooks and `statusLine` from [`settings.snippet.json`](settings.snippet.json) into `~/.claude/settings.json`. Adjust paths if your `CLAUDE_CONFIG_DIR` is not `~/.claude`. Restart the Claude Code session so hooks load.

3. Provide a TypeSafe key (never commit it):

```sh
export TYPESAFE_API_KEY=…   # or write it to ~/.claude/secrets/typesafe_api_key
```

Optional: set `CLAUDE_CONTEXT_WINDOW_SIZE` when Claude Code does not report a context window size (common with some OpenRouter routes).

## Status line output

Alongside model / directory / git / context %, the Jev segment can show:

- `⏳ 45% done · building` — in-progress estimate
- `✓ done` / `⏸ needs you` / `⏹ stopped at …` — after Stop
- `jev off · restart session` — hooks not loaded for this session
- `jev ✗` — last evaluation error (often missing key or API failure)

## Verify

With `TYPESAFE_API_KEY` set and a real Claude Code transcript `.jsonl`:

```sh
./scripts/jev-progress-verify/verify-e2e.sh \
  hooks/jev-progress.mjs \
  statusline/statusline.sh \
  /path/to/session.jsonl
```

`verify-races.sh` exercises concurrent PostToolUse / Stop behavior.

## Privacy

- Task text and latest assistant message (truncated) are sent to TypeSafe.
- Recent tool activity uses names plus short details; Bash uses `description`, not the command string.
- Do not use confidential prompts without authorization for hosted inference.

## Related

- [valentynkit/jev-belay](https://github.com/valentynkit/jev-belay) — Claude Code Stop hook that checks local evidence before Jev judges a completion claim
- [awesome-jev](https://github.com/Amal-David/awesome-jev)

## License

MIT
