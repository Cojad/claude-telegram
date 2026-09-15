#!/bin/bash
# PreToolUse / PostToolUse hook (stage picked by $1, "pre" or "post"): if the
# start hook left a state file for this turn, append a "▶ ..." line before a
# tool call and rewrite that *same* line to "✅ ..." after it completes,
# instead of stacking a second line. Falls back to appending on "post" if the
# last line doesn't match the expected pre-line (e.g. interleaved parallel
# tool calls). No state file (not a Telegram-triggered turn) -> no-op.
set -u
STAGE="${1:-post}"
IN=$(cat)
SESSION_ID=$(echo "$IN" | python3 -c "import json,sys;print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)
[ -z "$SESSION_ID" ] && exit 0

STATE_FILE="/tmp/claude-tg-progress-${SESSION_ID}.json"
[ -f "$STATE_FILE" ] || exit 0

TOOL_NAME=$(echo "$IN" | python3 -c "import json,sys;print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null)
[ -z "$TOOL_NAME" ] && exit 0
# Don't narrate the plugin's own tool calls — those are the actual reply.
case "$TOOL_NAME" in mcp__plugin_telegram_telegram__*) exit 0 ;; esac

SUMMARY=$(echo "$IN" | python3 -c "
import json, sys
d = json.load(sys.stdin)
name = d.get('tool_name', '?')
ti = d.get('tool_input', {}) or {}
desc = ti.get('description') or ti.get('file_path') or ti.get('command', '')
desc = str(desc)[:60].replace('\n', ' ')
print(f'{name}: {desc}' if desc else name)
" 2>/dev/null)
[ -z "$SUMMARY" ] && SUMMARY="$TOOL_NAME"

TG_STATE_DIR="$HOME/.claude/channels/telegram"
TOKEN=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$TG_STATE_DIR/.env" 2>/dev/null | cut -d= -f2-)
[ -z "$TOKEN" ] && exit 0

STAGE="$STAGE" SUMMARY="$SUMMARY" STATE_FILE="$STATE_FILE" TOKEN="$TOKEN" python3 -c "
import json, os, subprocess, sys

stage = os.environ['STAGE']
summary = os.environ['SUMMARY']
state_file = os.environ['STATE_FILE']
token = os.environ['TOKEN']

try:
    with open(state_file) as f:
        state = json.load(f)
except Exception:
    sys.exit(0)

lines = state.get('lines', [])
pre_line = '▶ ' + summary
post_line = '✅ ' + summary

if stage == 'post' and lines and lines[-1] == pre_line:
    lines[-1] = post_line  # rewrite the same line in place, don't stack a new one
else:
    lines.append(post_line if stage == 'post' else pre_line)

lines = lines[-25:]  # keep the most recent 25 lines, stay under Telegram's 4096-char cap
state['lines'] = lines
with open(state_file, 'w') as f:
    json.dump(state, f)

text = ('🤔 Thinking…\n\n' + '\n'.join(lines))[:4000]

subprocess.run(
    ['curl', '-s', '-m', '8', f'https://api.telegram.org/bot{token}/editMessageText',
     '--data-urlencode', f'chat_id={state[\"chat_id\"]}',
     '--data-urlencode', f'message_id={state[\"message_id\"]}',
     '--data-urlencode', f'text={text}'],
    capture_output=True,
)
" 2>/dev/null
exit 0
