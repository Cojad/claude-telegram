#!/bin/bash
# Stop hook: if the start hook left a state file for this turn, edit the
# placeholder into a "✅ Done" summary, wait 5 seconds in the background, then
# delete it — the real answer is a separate `reply` message, this one is
# process narration, not the answer. The 5s delay runs detached (setsid
# nohup) so the hook itself returns immediately instead of blocking the turn.
set -u
IN=$(cat)
SESSION_ID=$(echo "$IN" | python3 -c "import json,sys;print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)
[ -z "$SESSION_ID" ] && exit 0

STATE_FILE="/tmp/claude-tg-progress-${SESSION_ID}.json"
[ -f "$STATE_FILE" ] || exit 0

TG_STATE_DIR="$HOME/.claude/channels/telegram"
TOKEN=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$TG_STATE_DIR/.env" 2>/dev/null | cut -d= -f2-)

if [ -n "$TOKEN" ]; then
  read -r CHAT_ID MSG_ID <<EOF
$(python3 -c "
import json
try:
    s = json.load(open('$STATE_FILE'))
    print(s['chat_id'], s['message_id'])
except Exception:
    print('', '')
")
EOF

  if [ -n "$CHAT_ID" ] && [ -n "$MSG_ID" ]; then
    python3 -c "
import json, subprocess
state_file = '$STATE_FILE'
try:
    state = json.load(open(state_file))
except Exception:
    raise SystemExit
lines = state.get('lines', [])
text = ('✅ Done\n\n' + '\n'.join(lines))[:4000] if lines else '✅ Done'
subprocess.run(
    ['curl', '-s', '-m', '8', 'https://api.telegram.org/bot$TOKEN/editMessageText',
     '--data-urlencode', f'chat_id={state[\"chat_id\"]}',
     '--data-urlencode', f'message_id={state[\"message_id\"]}',
     '--data-urlencode', f'text={text}'],
    capture_output=True,
)
" 2>/dev/null

    setsid nohup bash -c "
      sleep 5
      curl -s -m 8 'https://api.telegram.org/bot$TOKEN/deleteMessage' \
        --data-urlencode 'chat_id=$CHAT_ID' \
        --data-urlencode 'message_id=$MSG_ID' >/dev/null 2>&1
    " > /dev/null 2>&1 < /dev/null &
    disown
  fi
fi

rm -f "$STATE_FILE"
exit 0
