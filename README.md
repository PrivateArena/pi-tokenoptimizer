# pi-tokenoptimizer

Token optimizer for the [pi coding agent](https://pi.dev) — trims redundant shell
output from the built-in `bash` tool before it reaches the LLM, saving context
tokens. Port of zen-mcp's `internal/shell/tokenoptimizer`.

## What it does

Hooks the `tool_result` event for `bash` and applies, in order:

1. **Token profiles** — per-command rewrite rules from a `token-profiles.json`
   (project-relative): `replace` (literal or regex) and `file` actions.
2. **Per-command compaction** — `git status/diff/log/add/commit/push/pull`,
   `ls`, `tree`, `cat`, `rg/grep/ag`, go benchmarks, test runners
   (go/cargo/jest/vitest/pytest/rust), `ruff`, `jq`, plus chained-command
   deduplication and a safe global fallback for everything else.
3. **Blacklist** — cap or suppress output of matched commands.

Execution, streaming and UI rendering of the built-in bash tool are untouched;
the handler fails open (never breaks the tool).

## Install

```bash
pi install /media/jang/home/Deve/pi-tokenoptimizer   # local path
# or, once published:
pi install npm:pi-tokenoptimizer
```

## Configuration

`~/.pi/agent/tokenoptimizer.json`, overridden by `.pi/tokenoptimizer.json` in
the project:

```json
{
  "enabled": true,
  "ultraCompact": false,
  "maxChainedLength": 51200,
  "deduplicateThreshold": 3,
  "profilesPath": "token-profiles.json",
  "blacklist": [
    { "match": "terraform plan", "isRegex": false, "maxLines": 30, "dropOutput": false }
  ]
}
```

## Slash command

- `/tokopt on|off` — toggle (persisted to config)
- `/tokopt ultra` — toggle ultra-compact mode (session only)
- `/tokopt stats` — cumulative savings for the session

## License

MIT
