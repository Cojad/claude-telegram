#!/bin/bash
# UserPromptSubmit hook: if this turn was triggered by a Telegram message
# (the prompt contains a <channel source="...telegram..." chat_id="..."> tag),
# send a "thinking…" placeholder and remember its chat_id/message_id for the
# other hooks in this set. Not Telegram-triggered (a turn typed directly in
# the terminal) -> the tag is absent, so this is a no-op.
#
# Adjust TG_STATE_DIR below if you run the plugin with a custom
# TELEGRAM_STATE_DIR instead of the default ~/.claude/channels/telegram.
set -u
IN=$(cat)

SESSION_ID=$(echo "$IN" | python3 -c "import json,sys;print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)
[ -z "$SESSION_ID" ] && exit 0

STATE_FILE="/tmp/claude-tg-progress-${SESSION_ID}.json"
rm -f "$STATE_FILE"  # every turn starts clean, no leftovers from a previous one

# The field is "prompt", not "user_prompt" — verified against a real
# UserPromptSubmit payload; a docs summary had this wrong.
PROMPT=$(echo "$IN" | python3 -c "import json,sys;print(json.load(sys.stdin).get('prompt',''))" 2>/dev/null)
CHAT_ID=$(echo "$PROMPT" | grep -o '<channel source="[^"]*telegram[^"]*"[^>]*chat_id="[^"]*"' | grep -o 'chat_id="[^"]*"' | head -1 | cut -d'"' -f2)
[ -z "$CHAT_ID" ] && exit 0  # not a Telegram-triggered turn

TG_STATE_DIR="$HOME/.claude/channels/telegram"
TOKEN=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$TG_STATE_DIR/.env" 2>/dev/null | cut -d= -f2-)
[ -z "$TOKEN" ] && exit 0

RESP=$(curl -s -m 10 "https://api.telegram.org/bot$TOKEN/sendMessage" \
  --data-urlencode "chat_id=$CHAT_ID" --data-urlencode "text=🤔 Thinking…")
MSG_ID=$(echo "$RESP" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('result',{}).get('message_id',''))" 2>/dev/null)
[ -z "$MSG_ID" ] && exit 0

python3 -c "
import json
json.dump({'chat_id': '$CHAT_ID', 'message_id': $MSG_ID, 'lines': []}, open('$STATE_FILE', 'w'))
"
exit 0
