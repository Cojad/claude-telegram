// The four tools Claude calls to talk back to Telegram — reply, react,
// download_attachment, edit_message — plus the static schema ListTools
// returns for them. No inbound/policy/poller concerns here: this module
// only ever sends things Claude asked it to send, to a chat_id the caller
// has already checked is allowed.

import { InputFile, type Bot } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { mkdirSync, statSync, writeFileSync } from 'fs'
import { extname, join } from 'path'
import { chunk, formatMessageRow, formatMessageRows } from './format'
import type { Access } from './policy'
import type { Store } from './store'

export const TOOL_DEFINITIONS = [
  {
    name: 'reply',
    description:
      'Reply on Telegram. Pass chat_id from the inbound message. Optionally pass reply_to (message_id) for threading, and files (absolute paths) to attach images or documents.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        text: { type: 'string' },
        reply_to: {
          type: 'string',
          description: 'Message ID to thread under. Use message_id from the inbound <channel> block.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute file paths to attach. Images send as photos (inline preview); other types as documents. Max 50MB each.',
        },
        format: {
          type: 'string',
          enum: ['text', 'markdownv2'],
          description: "Rendering mode. 'markdownv2' enables Telegram formatting (bold, italic, code, links). Caller must escape special chars per MarkdownV2 rules. Default: 'text' (plain, no escaping needed).",
        },
      },
      required: ['chat_id', 'text'],
    },
  },
  {
    name: 'react',
    description: 'Add an emoji reaction to a Telegram message. Telegram only accepts a fixed whitelist (👍 👎 ❤ 🔥 👀 🎉 etc) — non-whitelisted emoji will be rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        message_id: { type: 'string' },
        emoji: { type: 'string' },
      },
      required: ['chat_id', 'message_id', 'emoji'],
    },
  },
  {
    name: 'download_attachment',
    description: 'Download a file attachment from a Telegram message to the local inbox. Use when the inbound <channel> meta shows attachment_file_id. Returns the local file path ready to Read. Telegram caps bot downloads at 20MB.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'The attachment_file_id from inbound meta' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'edit_message',
    description: 'Edit a message the bot previously sent. Useful for interim progress updates. Edits don\'t trigger push notifications — send a new reply when a long task completes so the user\'s device pings.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        message_id: { type: 'string' },
        text: { type: 'string' },
        format: {
          type: 'string',
          enum: ['text', 'markdownv2'],
          description: "Rendering mode. 'markdownv2' enables Telegram formatting (bold, italic, code, links). Caller must escape special chars per MarkdownV2 rules. Default: 'text' (plain, no escaping needed).",
        },
      },
      required: ['chat_id', 'message_id', 'text'],
    },
  },
  {
    name: 'lookup_message',
    description: 'Look up messages this plugin has seen (sent or received) in a chat, from the local SQLite log — not the Telegram API, which has no history endpoint. Pass message_id for one exact message (e.g. to resolve a reply_to_message_id that had no reply_to_text), or omit it and use limit for the most recent messages in that chat. Includes messages gate() dropped (delivered: false) and nothing else about them.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        message_id: { type: 'string', description: 'Exact message to look up. Omit to list recent messages instead.' },
        limit: { type: 'string', description: 'Max messages to return when message_id is omitted. Default 10, max 100.' },
        before_message_id: { type: 'string', description: 'With limit: page to messages older than this one.' },
      },
      required: ['chat_id'],
    },
  },
] as const

// .jpg/.jpeg/.png/.gif/.webp go as photos (Telegram compresses + shows inline);
// everything else goes as documents (raw file, no compression).
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
const MAX_CHUNK_LIMIT = 4096
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

export interface OutboundDeps {
  bot: Bot
  token: string
  inboxDir: string
  loadAccess: () => Access
  /** Throws if chat_id isn't one the inbound gate would ever deliver from. */
  assertAllowedChat: (chat_id: string) => void
  /** Throws if a file path being sent as an attachment reaches into plugin state. */
  assertSendable: (path: string) => void
  store: Pick<Store, 'record' | 'lookup' | 'recent'>
}

const DEFAULT_LOOKUP_LIMIT = 10
const MAX_LOOKUP_LIMIT = 100

export async function callTool(name: string, args: Record<string, unknown>, deps: OutboundDeps): Promise<ToolResult> {
  const { bot, token, inboxDir, loadAccess, assertAllowedChat, assertSendable, store } = deps
  try {
    switch (name) {
      case 'reply': {
        const chat_id = args.chat_id as string
        const text = args.text as string
        const reply_to = args.reply_to != null ? Number(args.reply_to) : undefined
        const files = (args.files as string[] | undefined) ?? []
        const format = (args.format as string | undefined) ?? 'text'
        const parseMode = format === 'markdownv2' ? 'MarkdownV2' as const : undefined

        assertAllowedChat(chat_id)

        for (const f of files) {
          assertSendable(f)
          const st = statSync(f)
          if (st.size > MAX_ATTACHMENT_BYTES) {
            throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
          }
        }

        const access = loadAccess()
        const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
        const mode = access.chunkMode ?? 'length'
        const replyMode = access.replyToMode ?? 'first'
        const chunks = chunk(text, limit, mode)
        const sentIds: number[] = []
        const recordSent = (message_id: number, content: string): void => {
          try {
            store.record({
              chat_id, message_id: String(message_id), direction: 'out',
              ts: new Date().toISOString(), content, delivered: true,
              ...(reply_to != null ? { reply_to_message_id: String(reply_to) } : {}),
            })
          } catch (err) {
            process.stderr.write(`telegram channel: store.record (outbound) failed: ${err}\n`)
          }
        }

        try {
          for (let i = 0; i < chunks.length; i++) {
            const shouldReplyTo =
              reply_to != null &&
              replyMode !== 'off' &&
              (replyMode === 'all' || i === 0)
            const sent = await bot.api.sendMessage(chat_id, chunks[i], {
              ...(shouldReplyTo ? { reply_parameters: { message_id: reply_to } } : {}),
              ...(parseMode ? { parse_mode: parseMode } : {}),
            })
            sentIds.push(sent.message_id)
            recordSent(sent.message_id, chunks[i])
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          throw new Error(
            `reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`,
          )
        }

        // Files go as separate messages (Telegram doesn't mix text+file in one
        // sendMessage call). Thread under reply_to if present.
        for (const f of files) {
          const ext = extname(f).toLowerCase()
          const input = new InputFile(f)
          const opts = reply_to != null && replyMode !== 'off'
            ? { reply_parameters: { message_id: reply_to } }
            : undefined
          if (PHOTO_EXTS.has(ext)) {
            const sent = await bot.api.sendPhoto(chat_id, input, opts)
            sentIds.push(sent.message_id)
            recordSent(sent.message_id, `(photo: ${f})`)
          } else {
            const sent = await bot.api.sendDocument(chat_id, input, opts)
            sentIds.push(sent.message_id)
            recordSent(sent.message_id, `(document: ${f})`)
          }
        }

        const result =
          sentIds.length === 1
            ? `sent (id: ${sentIds[0]})`
            : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
        return { content: [{ type: 'text', text: result }] }
      }
      case 'react': {
        assertAllowedChat(args.chat_id as string)
        await bot.api.setMessageReaction(args.chat_id as string, Number(args.message_id), [
          { type: 'emoji', emoji: args.emoji as ReactionTypeEmoji['emoji'] },
        ])
        return { content: [{ type: 'text', text: 'reacted' }] }
      }
      case 'download_attachment': {
        const file_id = args.file_id as string
        const file = await bot.api.getFile(file_id)
        if (!file.file_path) throw new Error('Telegram returned no file_path — file may have expired')
        const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
        const res = await fetch(url)
        if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
        const buf = Buffer.from(await res.arrayBuffer())
        // file_path is from Telegram (trusted), but strip to safe chars anyway
        // so nothing downstream can be tricked by an unexpected extension.
        const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
        const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
        const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
        const path = join(inboxDir, `${Date.now()}-${uniqueId}.${ext}`)
        mkdirSync(inboxDir, { recursive: true })
        writeFileSync(path, buf)
        return { content: [{ type: 'text', text: path }] }
      }
      case 'edit_message': {
        const chat_id = args.chat_id as string
        assertAllowedChat(chat_id)
        const editFormat = (args.format as string | undefined) ?? 'text'
        const editParseMode = editFormat === 'markdownv2' ? 'MarkdownV2' as const : undefined
        const edited = await bot.api.editMessageText(
          chat_id,
          Number(args.message_id),
          args.text as string,
          ...(editParseMode ? [{ parse_mode: editParseMode }] : []),
        )
        const id = typeof edited === 'object' ? edited.message_id : Number(args.message_id)
        // The edit replaces what this message_id means — INSERT OR REPLACE
        // on the same (chat_id, message_id) is exactly "this is now current".
        try {
          store.record({ chat_id, message_id: String(id), direction: 'out', ts: new Date().toISOString(), content: args.text as string, delivered: true })
        } catch (err) {
          process.stderr.write(`telegram channel: store.record (edit) failed: ${err}\n`)
        }
        return { content: [{ type: 'text', text: `edited (id: ${id})` }] }
      }
      case 'lookup_message': {
        const chat_id = args.chat_id as string
        assertAllowedChat(chat_id)
        if (args.message_id != null) {
          const found = store.lookup(chat_id, String(args.message_id))
          return { content: [{ type: 'text', text: found ? formatMessageRow(found, { includeRaw: true }) : 'not found' }] }
        }
        const limit = Math.max(1, Math.min(Number(args.limit) || DEFAULT_LOOKUP_LIMIT, MAX_LOOKUP_LIMIT))
        const beforeId = args.before_message_id != null ? String(args.before_message_id) : undefined
        const rows = store.recent(chat_id, limit, beforeId)
        return { content: [{ type: 'text', text: formatMessageRows(rows) }] }
      }
      default:
        return {
          content: [{ type: 'text', text: `unknown tool: ${name}` }],
          isError: true,
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `${name} failed: ${msg}` }],
      isError: true,
    }
  }
}
