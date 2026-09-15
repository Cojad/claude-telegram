// The single chokepoint every inbound Telegram message passes through:
// gate() decides deliver/drop/pair, and a delivered message becomes a
// notifications/claude/channel MCP notification. transport.ts's bot.on
// handlers all funnel into handleInbound() rather than talking to gate()
// or mcp.notification() directly — this is the only place that happens.

import type { Bot, Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Access, GateResult } from './policy'

export type AttachmentMeta = {
  kind: string
  file_id: string
  size?: number
  mime?: string
  name?: string
}

// Filenames and titles are uploader-controlled. They land inside the <channel>
// notification — delimiter chars would let the uploader break out of the tag
// or forge a second meta entry.
export function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

// Permission-reply spec from anthropics/claude-cli-internal
// src/services/mcp/channelPermissions.ts — inlined (no CC repo dep).
// 5 lowercase letters a-z minus 'l'. Case-insensitive for phone autocorrect.
// Strict: no bare yes/no (conversational), no prefix/suffix chatter.
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

export interface InboundDeps {
  gate: (ctx: Context) => GateResult
  bot: Pick<Bot, 'api'>
  mcp: Pick<Server, 'notification'>
}

export function createHandleInbound(deps: InboundDeps) {
  const { gate, bot, mcp } = deps

  return async function handleInbound(
    ctx: Context,
    text: string,
    downloadImage: (() => Promise<string | undefined>) | undefined,
    attachment?: AttachmentMeta,
  ): Promise<void> {
    const result = gate(ctx)

    if (result.action === 'drop') return

    if (result.action === 'pair') {
      const lead = result.isResend ? 'Still pending' : 'Pairing required'
      await ctx.reply(
        `${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`,
      )
      return
    }

    const access: Access = result.access
    const from = ctx.from!
    const chat_id = String(ctx.chat!.id)
    const msgId = ctx.message?.message_id

    // Permission-reply intercept: if this looks like "yes xxxxx" for a
    // pending permission request, emit the structured event instead of
    // relaying as chat. The sender is already gate()-approved at this point
    // (non-allowlisted senders were dropped above), so we trust the reply.
    const permMatch = PERMISSION_REPLY_RE.exec(text)
    if (permMatch) {
      void mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: {
          request_id: permMatch[2]!.toLowerCase(),
          behavior: permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
        },
      })
      if (msgId != null) {
        const emoji = permMatch[1]!.toLowerCase().startsWith('y') ? '✅' : '❌'
        void bot.api.setMessageReaction(chat_id, msgId, [
          { type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] },
        ]).catch(() => {})
      }
      return
    }

    // Typing indicator — signals "processing" until we reply (or ~5s elapses).
    void bot.api.sendChatAction(chat_id, 'typing').catch(() => {})

    // Ack reaction — lets the user know we're processing. Fire-and-forget.
    // Telegram only accepts a fixed emoji whitelist — if the user configures
    // something outside that set the API rejects it and we swallow.
    if (access.ackReaction && msgId != null) {
      void bot.api
        .setMessageReaction(chat_id, msgId, [
          { type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] },
        ])
        .catch(() => {})
    }

    const imagePath = downloadImage ? await downloadImage() : undefined

    // image_path goes in meta only — an in-content "[image attached — read: PATH]"
    // annotation is forgeable by any allowlisted sender typing that string.
    mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: text,
        meta: {
          chat_id,
          ...(msgId != null ? { message_id: String(msgId) } : {}),
          user: from.username ?? String(from.id),
          user_id: String(from.id),
          ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
          ...(imagePath ? { image_path: imagePath } : {}),
          ...(attachment ? {
            attachment_kind: attachment.kind,
            attachment_file_id: attachment.file_id,
            ...(attachment.size != null ? { attachment_size: String(attachment.size) } : {}),
            ...(attachment.mime ? { attachment_mime: attachment.mime } : {}),
            ...(attachment.name ? { attachment_name: attachment.name } : {}),
          } : {}),
        },
      },
    }).catch((err: unknown) => {
      process.stderr.write(`telegram channel: failed to deliver inbound to Claude: ${err}\n`)
    })
  }
}
