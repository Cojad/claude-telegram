// The only module that touches SQLite. Every other module reaches the
// database exclusively through record()/lookup()/recent() — nobody else
// prepares a statement or sees a raw row. Uses bun:sqlite (built into Bun,
// no dependency to add).
//
// Two things this fixes that plan.html called out as gaps:
//   - inbound.ts records every message it sees, including ones gate()
//     drops (delivered: false) — previously a dropped message left no
//     trace anywhere, not even in a debug log.
//   - lookup() gives inbound.ts a fallback for reply_to_text when
//     Telegram doesn't inline the replied-to message (old messages) —
//     not wired up yet (plan.html phase 4), this module just makes it
//     possible.

import { Database } from 'bun:sqlite'

export type Direction = 'in' | 'out'

export interface MessageRecord {
  chat_id: string
  message_id: string
  direction: Direction
  ts: string
  user_id?: string
  content?: string
  reply_to_message_id?: string
  attachment_kind?: string
  attachment_file_id?: string
  /** Whether gate() actually delivered this to Claude. Always true for direction 'out'. */
  delivered: boolean
}

// What SQLite hands back from a row — integers for the boolean, undefined
// fields as null. Kept private; toRecord() below is the only place this
// shape is seen.
interface MessageRow {
  chat_id: string
  message_id: string
  direction: string
  ts: string
  user_id: string | null
  content: string | null
  reply_to_message_id: string | null
  attachment_kind: string | null
  attachment_file_id: string | null
  delivered: number
}

function toRecord(row: MessageRow): MessageRecord {
  return {
    chat_id: row.chat_id,
    message_id: row.message_id,
    direction: row.direction as Direction,
    ts: row.ts,
    user_id: row.user_id ?? undefined,
    content: row.content ?? undefined,
    reply_to_message_id: row.reply_to_message_id ?? undefined,
    attachment_kind: row.attachment_kind ?? undefined,
    attachment_file_id: row.attachment_file_id ?? undefined,
    delivered: row.delivered === 1,
  }
}

export interface Store {
  /** Insert or, for the same (chat_id, message_id), replace. */
  record(r: MessageRecord): void
  /** O(1) — backed by a UNIQUE index on (chat_id, message_id). */
  lookup(chat_id: string, message_id: string): MessageRecord | null
  /** Most recent first. `beforeId`, when given, pages older than that message_id. */
  recent(chat_id: string, limit: number, beforeId?: string): MessageRecord[]
  close(): void
}

export function openStore(dbPath: string): Store {
  const db = new Database(dbPath, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      ts TEXT NOT NULL,
      user_id TEXT,
      content TEXT,
      reply_to_message_id TEXT,
      attachment_kind TEXT,
      attachment_file_id TEXT,
      delivered INTEGER NOT NULL DEFAULT 1
    )
  `)
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_chat_msg ON messages(chat_id, message_id)')

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO messages
      (chat_id, message_id, direction, ts, user_id, content, reply_to_message_id, attachment_kind, attachment_file_id, delivered)
    VALUES
      ($chat_id, $message_id, $direction, $ts, $user_id, $content, $reply_to_message_id, $attachment_kind, $attachment_file_id, $delivered)
  `)
  const lookupStmt = db.prepare('SELECT * FROM messages WHERE chat_id = $chat_id AND message_id = $message_id')
  const recentStmt = db.prepare('SELECT * FROM messages WHERE chat_id = $chat_id ORDER BY id DESC LIMIT $limit')
  const recentBeforeStmt = db.prepare(`
    SELECT * FROM messages
    WHERE chat_id = $chat_id
      AND id < COALESCE((SELECT id FROM messages WHERE chat_id = $chat_id AND message_id = $before_id), 9223372036854775807)
    ORDER BY id DESC LIMIT $limit
  `)

  return {
    record(r) {
      insertStmt.run({
        $chat_id: r.chat_id,
        $message_id: r.message_id,
        $direction: r.direction,
        $ts: r.ts,
        $user_id: r.user_id ?? null,
        $content: r.content ?? null,
        $reply_to_message_id: r.reply_to_message_id ?? null,
        $attachment_kind: r.attachment_kind ?? null,
        $attachment_file_id: r.attachment_file_id ?? null,
        $delivered: r.delivered ? 1 : 0,
      })
    },
    lookup(chat_id, message_id) {
      const row = lookupStmt.get({ $chat_id: chat_id, $message_id: message_id }) as MessageRow | null
      return row ? toRecord(row) : null
    },
    recent(chat_id, limit, beforeId) {
      const rows = (beforeId
        ? recentBeforeStmt.all({ $chat_id: chat_id, $before_id: beforeId, $limit: limit })
        : recentStmt.all({ $chat_id: chat_id, $limit: limit })) as MessageRow[]
      return rows.map(toRecord)
    },
    close() {
      db.close()
    },
  }
}
