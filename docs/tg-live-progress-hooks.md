# Live progress via Claude Code hooks

A companion pattern — not part of the plugin's own code — that turns the "thinking…" gap
between an inbound Telegram message and the final reply into a live-updating status message,
using four Claude Code hook events plus this plugin's `reply` / `edit_message` behavior
(via the raw Bot API, since hooks run outside the MCP tool-call context).

Reference scripts live in [`examples/hooks/`](../examples/hooks/); copy them into your own
project's `.claude/hooks/` and wire them up in `.claude/settings.json` as shown in
[`examples/hooks/settings.json`](../examples/hooks/settings.json).

## Why

Without this, a Telegram-triggered turn that takes 30–90 seconds (multiple tool calls, a
subagent, a context compaction) looks dead from the sender's side — no indication anything is
happening until the final reply lands. This turns that gap into a single message that updates
line by line.

## How it works

1. **`UserPromptSubmit`** (`tg-progress-start.sh`) — fires on every new turn. Parses the
   `<channel source="...telegram..." chat_id="...">` tag out of the prompt text. If present,
   sends a `🤔 思考中…` placeholder via `sendMessage` and writes
   `/tmp/claude-tg-progress-<session_id>.json` recording `{chat_id, message_id, lines: []}`.
   If the turn wasn't Telegram-triggered, the state file is absent and every later hook in this
   set becomes a no-op.

2. **`PreToolUse` / `PostToolUse`** (`tg-progress-append.sh pre|post`) — if the state file
   exists, appends a `▶ ToolName: summary` line before a tool call and — this is the part worth
   calling out — **rewrites that same line in place** to `✅ ToolName: summary` after it
   completes, instead of appending a second line. The message grows by one line per tool call,
   not two. (Falls back to appending if the last line doesn't match, e.g. interleaved parallel
   tool calls — a rare edge case, not worth solving precisely.) Calls to the telegram plugin's
   own tools are skipped so the progress message doesn't narrate itself.

3. **`PreCompact` / `PostCompact`** (`tg-progress-compact.sh pre|post`) — same
   append-then-rewrite-in-place trick, so a context compaction mid-turn shows up as
   `🗜 Compacting context… (trigger=auto)` and then flips to `✅ Compaction done, resuming…`
   instead of leaving the sender staring at a stalled message wondering if it's broken.

4. **`Stop`** (`tg-progress-stop.sh`) — edits the placeholder to `✅ Done` (keeping the full
   line log above it), then backgrounds a `sleep 5 && deleteMessage` (via `setsid nohup`, so the
   hook itself returns immediately rather than blocking the turn) and clears the state file.
   The actual answer is a separate `reply` — this message is process narration, not the answer,
   so deleting it after a few seconds keeps the chat from filling up with scaffolding.

## Field names that aren't quite what the docs say

Two things were verified against real hook invocations rather than trusted from documentation,
because a docs summary got this wrong once already:

- `UserPromptSubmit`'s prompt text is in a field called **`prompt`**, not `user_prompt`.
- `PreCompact`/`PostCompact` carry **`trigger`**: `"manual" | "auto"` — no `custom_instructions`
  field exists on either.

If you adapt these scripts and something silently doesn't fire, log the full raw stdin JSON to
a file first and check the actual field names before assuming the hook itself isn't running.

## Requirements

- A `TELEGRAM_BOT_TOKEN` readable from the state dir's `.env` (same one the plugin server uses).
- `python3` and `curl` on PATH.
- `jq`-free by design — the scripts shell out to `python3 -c` for JSON so they don't add a
  dependency.

Not part of this plugin's own test suite — these are hooks in the *host project*, not code the
MCP server loads, so there's nothing here for `bun test` to cover.
