# Claude Code hooks

Three hooks I run on every project. Each one exists because I got burned by the thing it now
prevents: a key pasted into a source file, a config change declared "done" without ever being
executed, and a context window compacting in the middle of a refactor.

They're plain Node ESM files with no dependencies. Read stdin, write JSON to stdout, exit with
a status code.

| Hook | Event | What it does |
|---|---|---|
| [`secrets-guard.mjs`](hooks/secrets-guard.mjs) | `PreToolUse` | Blocks writes that put a live-looking API key into a source file |
| [`verify-before-stop.mjs`](hooks/verify-before-stop.mjs) | `Stop` | Requires a real test run before finishing a session that changed config or installed a CLI |
| [`context-nudge.mjs`](hooks/context-nudge.mjs) | `Stop` | Suggests compacting at a clean boundary instead of mid-task |

## Install

Copy the files somewhere stable and reference them from `~/.claude/settings.json`:

```bash
mkdir -p ~/.claude/scripts
cp hooks/*.mjs ~/.claude/scripts/
```

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [{ "type": "command", "command": "node ~/.claude/scripts/secrets-guard.mjs" }]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node ~/.claude/scripts/verify-before-stop.mjs" },
          { "type": "command", "command": "node ~/.claude/scripts/context-nudge.mjs" }
        ]
      }
    ]
  }
}
```

On Windows, use absolute paths with escaped backslashes
(`"node C:\\Users\\you\\.claude\\scripts\\secrets-guard.mjs"`) — `~` is not expanded.

## The hooks

### secrets-guard

Matches known credential formats (Anthropic, OpenAI, AWS, GitHub, GitLab, Slack, Google) against
content being written, and exits 2 to block the write.

Two decisions that matter more than the regex list:

- **It only inspects source files.** Writing a key to `.env` is correct and is never blocked.
  A guard that fires on the right answer gets disabled within a day.
- **It fails open.** Malformed input, an unexpected tool, an unparseable payload — exit 0 and
  allow. A hook on `PreToolUse` runs before *every* matching tool call; one that throws on an
  edge case breaks the editor rather than protecting it.

Pattern matching catches keys with recognisable prefixes. It won't catch a bare 32-character
hex secret with no distinguishing shape, so this is a safety net, not a substitute for
gitignore hygiene and secret scanning in CI.

### verify-before-stop

Scans the session transcript for edits to `settings.json`, `.mcp.json`, anything under a
`hooks/` directory, and for global package installs. If it finds one, it injects a reminder
that the change has to be *executed* before the session ends.

This targets a specific failure: config edits look like they worked because the file saved
successfully. An MCP server with a typo'd path saves perfectly and never loads.

Two details:

- **Bounded reads.** Transcripts grow without limit and this runs on every stop, so it reads at
  most the last 2 MB rather than the whole file. Lines truncated by that window are skipped
  instead of crashing the parse.
- **Fails closed.** If the transcript can't be read, it reminds anyway. The cost of an
  unnecessary reminder is one line of text; the cost of a silently skipped gate is a broken
  config you find out about tomorrow.

### context-nudge

Reads exact token usage from the last assistant message and suggests compacting once you cross
65% of the window.

The point is *when* it fires. Auto-compaction triggers on its own schedule, which is often
halfway through a multi-file change — exactly when losing detail hurts. This fires at a run
boundary, when nothing is in flight. It also counts cache-read and cache-creation tokens, not
just `input_tokens`; cached content occupies the window like anything else, and ignoring it
understates usage badly on long sessions.

Adjust `THRESHOLD_PCT` and `EFFECTIVE_WINDOW` at the top of the file to match your setup.

## Tests

```bash
node --test test/hooks.test.mjs
```

13 cases covering the block/allow paths, the fail-open and fail-closed behaviour, and the token
accounting. No dependencies, no test framework beyond `node:test`.

## License

MIT — see [LICENSE](LICENSE).
