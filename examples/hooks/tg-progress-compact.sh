#!/bin/bash
# PreCompact / PostCompact hook (stage picked by $1, "pre" or "post"): if the
# start hook left a state file for this turn, append "🗜 Compacting context…"
# when compaction begins and rewrite that same line to "✅ Compaction done,
# resuming…" when it ends, instead of stacking a second line. Lets the
# sender see that a mid-turn stall is compaction, not a hang.
#
# Field names verified against a real claude binary, not just docs: both
# PreCompact and PostCompact carry "trigger": "manual" | "auto", and neither
# has a custom_instructions field.
set -u
STAGE="${1:-pre}"
IN=$(cat)
SESSION_ID=$(echo "$IN" | python3 -c "import json,sys;print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)
[ -z "$SESSION_ID" ] && exit 0

STATE_FILE="/tmp/claude-tg-progress-${SESSION_ID}.json"
[ -f "$STATE_FILE" ] || exit 0

TRIGGER=$(echo "$IN" | python3 -c "import json,sys;print(json.load(sys.stdin).get('trigger',''))" 2>/dev/null)
[ -z "$TRIGGER" ] && TRIGGER="?"

TG_STATE_DIR="$HOME/.claude/channels/telegram"
TOKEN=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$TG_STATE_DIR/.env" 2>/dev/null | cut -d= -f2-)
[ -z "$TOKEN" ] && exit 0

STAGE="$STAGE" TRIGGER="$TRIGGER" STATE_FILE="$STATE_FILE" TOKEN="$TOKEN" python3 -c "
import json, os, subprocess, sys

stage = os.environ['STAGE']
trigger = os.environ['TRIGGER']
state_file = os.environ['STATE_FILE']
token = os.environ['TOKEN']

try:
    with open(state_file) as f:
        state = json.load(f)
except Exception:
    sys.exit(0)

lines = state.get('lines', [])
pre_line = f'🗜 Compacting context… (trigger={trigger})'
post_line = '✅ Compaction done, resuming…'

if stage == 'post' and lines and lines[-1] == pre_line:
    lines[-1] = post_line  # rewrite the same line in place, don't stack a new one
else:
    lines.append(post_line if stage == 'post' else pre_line)

lines = lines[-25:]
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
