#!/bin/bash
# Switch the LIVE telegram plugin between two versions:
#   fork     — this repo's current module set (server.ts + policy/format/
#              poller/outbound/transport/inbound/store.ts). Always deploys
#              whatever is currently checked out here, not a frozen copy —
#              re-run after every change you want to test live.
#   previous — the single-file server.ts that was live before the very
#              first switch this script ever performed. Captured exactly
#              once, on that first run, and never touched again, so it
#              stays a stable rollback target no matter how many times you
#              switch to "fork" afterwards.
#
# Usage:
#   deploy/switch.sh fork
#   deploy/switch.sh previous
#   deploy/switch.sh status
#
# Only swaps files on disk. The MCP server process already running does
# NOT reload them live — for a live channel session, follow this with
# /restart (see memory/cc-self-restart.md) to actually pick up the change.

set -euo pipefail

LIVE="$HOME/.claude/plugins/cache/claude-plugins-official/telegram/0.0.7"
FORK_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSIONS="$HOME/.claude/channels/telegram-versions"
MARKER="$LIVE/.deployed-version"
# Every module file this script manages. server.ts exists in both profiles;
# the rest only exist in "fork" (previous is the pre-split single file).
MODULE_FILES=(server.ts policy.ts format.ts poller.ts outbound.ts transport.ts inbound.ts store.ts mtproto.ts rich.ts package.json bun.lock)

usage() { echo "usage: $(basename "$0") {fork|previous|status}" >&2; exit 1; }

snapshot_previous_once() {
  if [ -f "$VERSIONS/previous/.snapshotted" ]; then return; fi
  mkdir -p "$VERSIONS/previous"
  if [ ! -f "$LIVE/server.ts" ]; then
    echo "error: $LIVE/server.ts not found — nothing to snapshot as 'previous'" >&2
    exit 1
  fi
  cp "$LIVE/server.ts" "$VERSIONS/previous/server.ts"
  touch "$VERSIONS/previous/.snapshotted"
  echo "snapshotted current live server.ts -> $VERSIONS/previous/ (this only ever happens once)" >&2
}

sync_fork_snapshot() {
  mkdir -p "$VERSIONS/fork"
  for f in "${MODULE_FILES[@]}"; do
    if [ ! -f "$FORK_SRC/$f" ]; then
      echo "error: $FORK_SRC/$f missing — refusing to deploy an incomplete fork checkout" >&2
      exit 1
    fi
    cp "$FORK_SRC/$f" "$VERSIONS/fork/$f"
  done
}

# Atomically replace every file the target profile has, then remove any
# managed module file the target profile does NOT have (e.g. policy.ts when
# rolling back to "previous"). server.ts exists in every profile, so it is
# always replaced before anything is removed — LIVE never has a moment with
# no server.ts on disk.
deploy_profile() {
  local profile="$1"
  local dir="$VERSIONS/$profile"
  for f in "$dir"/*; do
    local name; name="$(basename "$f")"
    [ "$name" = ".snapshotted" ] && continue
    cp "$f" "$LIVE/$name.switching-tmp"
    mv "$LIVE/$name.switching-tmp" "$LIVE/$name"
  done
  for f in "${MODULE_FILES[@]}"; do
    if [ ! -f "$dir/$f" ] && [ -f "$LIVE/$f" ]; then
      rm -f "$LIVE/$f"
    fi
  done
  echo "$profile" > "$MARKER"
}

cmd="${1:-}"
case "$cmd" in
  fork)
    snapshot_previous_once
    sync_fork_snapshot
    deploy_profile fork
    rev="$(cd "$FORK_SRC" && git rev-parse --short HEAD 2>/dev/null || echo unknown)"
    echo "deployed: fork ($rev)"
    ;;
  previous)
    if [ ! -f "$VERSIONS/previous/.snapshotted" ]; then
      echo "error: no 'previous' snapshot exists yet — run '$(basename "$0") fork' at least once first" >&2
      exit 1
    fi
    deploy_profile previous
    echo "deployed: previous (pre-fork single-file server.ts)"
    ;;
  status)
    if [ -f "$MARKER" ]; then
      echo "currently deployed: $(cat "$MARKER")"
    else
      echo "currently deployed: unknown (this script has never switched it)"
    fi
    [ -f "$VERSIONS/previous/.snapshotted" ] && echo "previous snapshot: present" || echo "previous snapshot: none yet"
    exit 0
    ;;
  *)
    usage
    ;;
esac

echo "note: the running telegram MCP server process does not reload files live —"
echo "      restart the channel session (/restart) for this to take effect."
