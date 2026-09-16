// Every place this plugin touches grammY's Bot directly: the three DM
// commands (/start /help /status), the permission-request relay (Claude
// asks approval → Telegram message with inline buttons → button press
// routes back to Claude), and the per-message-type handlers that adapt a
// Telegram update into a call to handleInbound (./inbound). No access
// decisions happen here — dmCommandGate/gate (via handleInbound) do that;
// this module only translates between grammY's shapes and this plugin's.

import { InlineKeyboard, type Bot, type Context } from 'grammy'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { z } from 'zod'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Access, InboundContext } from './policy'
import { safeName, type AttachmentMeta, type HandleInboundContext } from './inbound'
import { flattenRichMessage } from './rich'

// Envelope/metadata fields common to every Telegram message update
// (grammy's Message.ServiceMessage/CommonMessage/CaptionableMessage base
// fields) — excluded when the catch-all handler logs an unmatched
// message's remaining keys, so the log line names the actual unhandled
// content type (e.g. "poll", "location") instead of fifteen scaffolding
// fields every message already carries.
const MESSAGE_ENVELOPE_KEYS = new Set([
  'message_id', 'message_thread_id', 'from', 'sender_chat', 'date',
  'guest_query_id', 'business_connection_id', 'chat', 'is_topic_message',
  'direct_messages_topic', 'sender_tag', 'receiver_user',
  'ephemeral_message_id', 'sender_boost_count', 'sender_business_bot',
  'forward_origin', 'is_automatic_forward', 'reply_to_message',
  'reply_to_checklist_task_id', 'reply_to_poll_option_id', 'is_paid_post',
  'external_reply', 'quote', 'reply_to_story', 'via_bot',
  'guest_bot_caller_user', 'guest_bot_caller_chat', 'edit_date',
  'has_protected_content', 'show_caption_above_media', 'is_from_offline',
  'author_signature', 'link_preview_options', 'effect_id',
  'paid_star_count', 'reply_markup', 'caption', 'caption_entities',
  'entities',
])

export interface TransportDeps {
  bot: Bot
  mcp: Pick<Server, 'notification' | 'setNotificationHandler'>
  dmCommandGate: (ctx: InboundContext) => { access: Access; senderId: string } | null
  loadAccess: () => Access
  handleInbound: (
    ctx: HandleInboundContext,
    text: string,
    downloadImage: (() => Promise<string | undefined>) | undefined,
    attachment?: AttachmentMeta,
  ) => Promise<void>
  token: string
  inboxDir: string
}

export function registerTransport(deps: TransportDeps): void {
  const { bot, mcp, dmCommandGate, loadAccess, handleInbound, token, inboxDir } = deps

  // Commands are DM-only. Responding in groups would: (1) leak pairing codes
  // via /status to other group members, (2) confirm bot presence in
  // non-allowlisted groups, (3) spam channels the operator never approved.
  // Silent drop matches the gate's behavior for unrecognized groups.

  bot.command('start', async ctx => {
    if (!dmCommandGate(ctx)) return
    await ctx.reply(
      `This bot bridges Telegram to a Claude Code session.\n\n` +
      `To pair:\n` +
      `1. DM me anything — you'll get a 6-char code\n` +
      `2. In Claude Code: /telegram:access pair <code>\n\n` +
      `After that, DMs here reach that session.`
    )
  })

  bot.command('help', async ctx => {
    if (!dmCommandGate(ctx)) return
    await ctx.reply(
      `Messages you send here route to a paired Claude Code session. ` +
      `Text and photos are forwarded; replies and reactions come back.\n\n` +
      `/start — pairing instructions\n` +
      `/status — check your pairing state`
    )
  })

  bot.command('status', async ctx => {
    const gated = dmCommandGate(ctx)
    if (!gated) return
    const { access, senderId } = gated

    if (access.allowFrom.includes(senderId)) {
      const name = ctx.from!.username ? `@${ctx.from!.username}` : senderId
      await ctx.reply(`Paired as ${name}.`)
      return
    }

    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        await ctx.reply(
          `Pending pairing — run in Claude Code:\n\n/telegram:access pair ${code}`
        )
        return
      }
    }

    await ctx.reply(`Not paired. Send me a message to get a pairing code.`)
  })

  // Stores full permission details for "See more" expansion keyed by request_id.
  const pendingPermissions = new Map<string, { tool_name: string; description: string; input_preview: string }>()

  // Receive permission_request from CC → format → send to all allowlisted DMs.
  // Groups are intentionally excluded — the security thread resolution was
  // "single-user mode for official plugins." Anyone in access.allowFrom
  // already passed explicit pairing; group members haven't.
  mcp.setNotificationHandler(
    z.object({
      method: z.literal('notifications/claude/channel/permission_request'),
      params: z.object({
        request_id: z.string(),
        tool_name: z.string(),
        description: z.string(),
        input_preview: z.string(),
      }),
    }),
    async ({ params }) => {
      const { request_id, tool_name, description, input_preview } = params
      pendingPermissions.set(request_id, { tool_name, description, input_preview })
      const access = loadAccess()
      const text = `🔐 Permission: ${tool_name}`
      const keyboard = new InlineKeyboard()
        .text('See more', `perm:more:${request_id}`)
        .text('✅ Allow', `perm:allow:${request_id}`)
        .text('❌ Deny', `perm:deny:${request_id}`)
      for (const chat_id of access.allowFrom) {
        void bot.api.sendMessage(chat_id, text, { reply_markup: keyboard }).catch(e => {
          process.stderr.write(`permission_request send to ${chat_id} failed: ${e}\n`)
        })
      }
    },
  )

  // Inline-button handler for permission requests. Callback data is
  // `perm:allow:<id>`, `perm:deny:<id>`, or `perm:more:<id>`.
  // Security mirrors the text-reply path: allowFrom must contain the sender.
  bot.on('callback_query:data', async ctx => {
    const data = ctx.callbackQuery.data
    const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(data)
    if (!m) {
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }
    const access = loadAccess()
    const senderId = String(ctx.from.id)
    if (!access.allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    const [, behavior, request_id] = m

    if (behavior === 'more') {
      const details = pendingPermissions.get(request_id)
      if (!details) {
        await ctx.answerCallbackQuery({ text: 'Details no longer available.' }).catch(() => {})
        return
      }
      const { tool_name, description, input_preview } = details
      let prettyInput: string
      try {
        prettyInput = JSON.stringify(JSON.parse(input_preview), null, 2)
      } catch {
        prettyInput = input_preview
      }
      const expanded =
        `🔐 Permission: ${tool_name}\n\n` +
        `tool_name: ${tool_name}\n` +
        `description: ${description}\n` +
        `input_preview:\n${prettyInput}`
      const keyboard = new InlineKeyboard()
        .text('✅ Allow', `perm:allow:${request_id}`)
        .text('❌ Deny', `perm:deny:${request_id}`)
      await ctx.editMessageText(expanded, { reply_markup: keyboard }).catch(() => {})
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }

    void mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id, behavior },
    })
    pendingPermissions.delete(request_id)
    const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
    await ctx.answerCallbackQuery({ text: label }).catch(() => {})
    // Replace buttons with the outcome so the same request can't be answered
    // twice and the chat history shows what was chosen.
    const msg = ctx.callbackQuery.message
    if (msg && 'text' in msg && msg.text) {
      await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {})
    }
  })

  bot.on('message:text', async ctx => {
    await handleInbound(ctx, ctx.message.text, undefined)
  })

  bot.on('message:photo', async ctx => {
    const caption = ctx.message.caption ?? '(photo)'
    // Largest size is last in the array.
    const photos = ctx.message.photo
    const best = photos[photos.length - 1]
    // Eager download is deferred until after the gate approves — any user
    // can send photos, and we don't want to burn API quota or fill the
    // inbox for dropped messages. file_id itself is recorded unconditionally
    // via the attachment param below, same as every other media type
    // (document/voice/audio/video/sticker already worked this way) — found
    // live (2026-09-16, Cojad): an undelivered photo had no file_id on
    // record at all, so unlike those other types it could never be fetched
    // later via download_attachment once the moment passed.
    await handleInbound(ctx, caption, async () => {
      try {
        const file = await ctx.api.getFile(best.file_id)
        if (!file.file_path) return undefined
        const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
        const res = await fetch(url)
        const buf = Buffer.from(await res.arrayBuffer())
        const ext = file.file_path.split('.').pop() ?? 'jpg'
        const path = join(inboxDir, `${Date.now()}-${best.file_unique_id}.${ext}`)
        mkdirSync(inboxDir, { recursive: true })
        writeFileSync(path, buf)
        return path
      } catch (err) {
        process.stderr.write(`telegram channel: photo download failed: ${err}\n`)
        return undefined
      }
    }, {
      kind: 'photo',
      file_id: best.file_id,
      size: best.file_size,
    })
  })

  bot.on('message:document', async ctx => {
    const doc = ctx.message.document
    const name = safeName(doc.file_name)
    const text = ctx.message.caption ?? `(document: ${name ?? 'file'})`
    await handleInbound(ctx, text, undefined, {
      kind: 'document',
      file_id: doc.file_id,
      size: doc.file_size,
      mime: doc.mime_type,
      name,
    })
  })

  bot.on('message:voice', async ctx => {
    const voice = ctx.message.voice
    const text = ctx.message.caption ?? '(voice message)'
    await handleInbound(ctx, text, undefined, {
      kind: 'voice',
      file_id: voice.file_id,
      size: voice.file_size,
      mime: voice.mime_type,
    })
  })

  bot.on('message:audio', async ctx => {
    const audio = ctx.message.audio
    const name = safeName(audio.file_name)
    const text = ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? 'audio'})`
    await handleInbound(ctx, text, undefined, {
      kind: 'audio',
      file_id: audio.file_id,
      size: audio.file_size,
      mime: audio.mime_type,
      name,
    })
  })

  bot.on('message:video', async ctx => {
    const video = ctx.message.video
    const text = ctx.message.caption ?? '(video)'
    await handleInbound(ctx, text, undefined, {
      kind: 'video',
      file_id: video.file_id,
      size: video.file_size,
      mime: video.mime_type,
      name: safeName(video.file_name),
    })
  })

  bot.on('message:video_note', async ctx => {
    const vn = ctx.message.video_note
    await handleInbound(ctx, '(video note)', undefined, {
      kind: 'video_note',
      file_id: vn.file_id,
      size: vn.file_size,
    })
  })

  bot.on('message:sticker', async ctx => {
    const sticker = ctx.message.sticker
    const emoji = sticker.emoji ? ` ${sticker.emoji}` : ''
    await handleInbound(ctx, `(sticker${emoji})`, undefined, {
      kind: 'sticker',
      file_id: sticker.file_id,
      size: sticker.file_size,
    })
  })

  // Bot API 10.x "Rich Message" — content lives entirely in
  // rich_message.blocks, there is no plain text/caption field, so without
  // this handler these arrived with nothing for handleInbound to forward
  // (GitHub issue #5724). Requires @grammyjs/types>=5.0.0 for the
  // rich_message field/filter query to exist at all.
  bot.on('message:rich_message', async ctx => {
    const flattened = flattenRichMessage(ctx.message.rich_message)
    await handleInbound(ctx, flattened || '(rich message with no renderable content)', undefined)
  })

  // Catch-all: any message type not matched by a specific handler above
  // (a future Bot API addition we don't know about yet) used to vanish
  // without a trace, same failure mode rich_message had before it got its
  // own handler. This keeps that from repeating silently — logs which
  // non-envelope keys showed up, and still forwards a placeholder so the
  // arrival is at least visible instead of dropped.
  bot.on('message', async ctx => {
    const keys = Object.keys(ctx.message).filter(k => !MESSAGE_ENVELOPE_KEYS.has(k))
    const keyList = keys.join(', ') || '(none)'
    process.stderr.write(`telegram channel: unmatched message type, content keys: ${keyList}\n`)
    await handleInbound(ctx, `(unsupported message type: ${keyList})`, undefined)
  })
}
