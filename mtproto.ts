// Supplementary inbound channel: MTProto (via GramJS), listening ONLY for
// messages from other bots — the one gap the primary Bot API transport
// (poller.ts/transport.ts, grammY) cannot close. Telegram's Bot API
// deliberately never delivers bot-authored messages to another bot via
// getUpdates, regardless of privacy-mode or admin settings (confirmed
// against the official Bots FAQ and reproduced live: a 60s MTProto listen
// alongside the running Bot API poller saw two messages from another bot
// that never reached this plugin's own SQLite log at all). MTProto has no
// such restriction.
//
// Deliberately narrow scope, not a second general-purpose transport:
//   - only sender.bot === true messages are forwarded — human messages are
//     already delivered reliably by the Bot API path, so this never
//     duplicates that; nothing here needs to out-race or replace it.
//   - de-duplicated against the same store.ts (chat_id, message_id) log
//     the Bot API path already writes to, as a second line of defense
//     beyond "only forward bot senders" (Cojad, 2026-09-15: "MTProto 來的
//     訊息要記得去重").
//   - feeds the exact same gate()/handleInbound() pipeline as the Bot API
//     path (via the InboundContext/HandleInboundContext structural types
//     in policy.ts/inbound.ts) — same access control, same store writes,
//     same notification shape. No separate rules for "messages from bots."
//
// Split for testability the same way buildReplyMeta() is in inbound.ts:
// buildMtprotoContext() is pure (plain data in, HandleInboundContext out) —
// tests construct fake input directly, no fake GramJS class instances
// needed. onEvent() is the thin, untested-by-unit-test glue that pulls
// real data out of a GramJS NewMessageEvent and calls the pure function.
//
// Session persistence: a GramJS StringSession, saved to a file under
// STATE_DIR after every start() — same bot_token login as the Bot API
// transport, a completely independent connection (Telegram's Bot API
// getUpdates and MTProto's own update stream are separate delivery
// mechanisms for the same bot account; verified they can run concurrently
// without conflict in the same live test above).

import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { NewMessage, type NewMessageEvent } from 'telegram/events'
import { Logger, LogLevel } from 'telegram/extensions/Logger'
import { readFileSync, writeFileSync } from 'fs'
import type { HandleInboundContext } from './inbound'
import type { InboundEntity } from './policy'
import type { Store } from './store'

// Telegram Desktop's own api_id/api_hash — NOT this deployment's secret,
// a widely-known, publicly reverse-engineered pair shared by the official
// Windows/macOS/Linux client itself (see telegramdesktop/tdesktop and the
// many open-source Telegram tools — Telethon's own docs among them — that
// use this exact pair for the same reason: MTProto requires *an*
// application identity to log in, but this listener isn't "an app" in any
// meaningful sense, it's this bot account reading its own group's traffic
// over a different transport). Cojad, 2026-09-15: explicitly chose this
// over registering and hardcoding a personal my.telegram.org app pair,
// specifically so nothing account-specific ever needs to live in this
// public repo. Trade-off, stated plainly: Telegram's own official docs
// (tdesktop/docs/api_credentials.md) warn that using shared/reused
// api_id/api_hash pairs outside their originally-issued client risks
// rate-limit or enforcement action from Telegram — this pair is reused
// this way by enough of the ecosystem that it works in practice, but it
// is not officially sanctioned for that use.
const TELEGRAM_DESKTOP_API_ID = 2040
const TELEGRAM_DESKTOP_API_HASH = 'b18441a1ff607e10a989891a5462e627'

export interface MtprotoDeps {
  botToken: string
  sessionFile: string
  store: Pick<Store, 'lookup'>
  handleInbound: (
    ctx: HandleInboundContext,
    text: string,
    downloadImage: (() => Promise<string | undefined>) | undefined,
  ) => Promise<void>
}

export function loadSessionString(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return ''
  }
}

// GramJS entity class names -> the string `type` isMentioned() switches on.
// Telegram's raw TL schema only has these two entity kinds relevant to
// mention detection; everything else (bold, url, code, ...) isMentioned()
// already ignores.
export function mapEntityClassName(className: string): 'mention' | 'text_mention' | undefined {
  if (className === 'MessageEntityMention') return 'mention'
  if (className === 'MessageEntityMentionName') return 'text_mention'
  return undefined
}

export type RawMtprotoEntity = { className?: string; offset: number; length: number }

export interface MtprotoMessageInput {
  senderId: string
  senderUsername?: string
  chatId: string
  chatType: 'private' | 'group' | 'supergroup'
  messageId: number
  date: number
  text: string
  entities?: RawMtprotoEntity[]
  replyTo?: { messageId: number; text?: string; fromId?: string }
  sendReply: (text: string) => Promise<unknown>
}

// Pure: no GramJS types, no network, no store — just "given this data,
// what HandleInboundContext does it become". This is the part worth unit
// testing; the surrounding onEvent() is thin GramJS-object plumbing.
export function buildMtprotoContext(input: MtprotoMessageInput): HandleInboundContext {
  const entities: InboundEntity[] = (input.entities ?? [])
    .map((e): InboundEntity | undefined => {
      const type = mapEntityClassName(e.className ?? '')
      return type ? { type, offset: e.offset, length: e.length } : undefined
    })
    .filter((e): e is InboundEntity => e != null)

  return {
    from: { id: input.senderId, username: input.senderUsername },
    chat: { id: input.chatId, type: input.chatType },
    mtproto: true,
    message: {
      message_id: input.messageId,
      date: input.date,
      text: input.text,
      entities,
      reply_to_message: input.replyTo
        ? {
            message_id: input.replyTo.messageId,
            text: input.replyTo.text,
            from: input.replyTo.fromId != null ? { id: Number(input.replyTo.fromId) } : undefined,
          }
        : undefined,
    },
    reply: input.sendReply,
  }
}

export function createMtprotoListener(deps: MtprotoDeps) {
  const { botToken, sessionFile, store, handleInbound } = deps
  const client = new TelegramClient(
    new StringSession(loadSessionString(sessionFile)),
    TELEGRAM_DESKTOP_API_ID,
    TELEGRAM_DESKTOP_API_HASH,
    {
      connectionRetries: 5,
      // GramJS's default logger calls console.log() — straight to stdout,
      // which for an MCP server over stdio IS the JSON-RPC protocol
      // channel. Found live (2026-09-15): the very first production boot
      // of this file produced "Ignoring non-JSON line on stdout: JSON
      // Parse error: Unrecognized token ''" in Claude Code's own
      // MCP client log — that escape byte is GramJS's ANSI color code for
      // an INFO-level connection message. Silencing the logger entirely
      // isn't a preference, it's required correctness for a stdio
      // transport; this module's own diagnostics already go through
      // process.stderr.write, same as every other file in this plugin.
      baseLogger: new Logger(LogLevel.NONE),
    },
  )

  async function onEvent(event: NewMessageEvent): Promise<void> {
    try {
      const message = event.message
      const sender = await message.getSender()
      // Defensive duck check — GramJS's Entity union isn't narrowed to
      // User here; a channel/chat "sender" simply won't have `.bot`, and
      // `undefined !== true` correctly skips it.
      const isBot = (sender as { bot?: boolean } | undefined)?.bot === true
      if (!isBot) return // human senders: the Bot API path already has this

      const chatIdBig = event.chatId
      const senderIdBig = message.senderId
      if (!chatIdBig || !senderIdBig) return
      const chatId = chatIdBig.toString()

      // Early-exit optimization, not the only line of defense: handleInbound()
      // (inbound.ts) now does this same store.lookup() check itself, as the
      // single authoritative cross-transport dedup point — this one just
      // skips the extra getReplyMessage()/getSender() work below for a
      // message we already know would be dropped there anyway.
      if (store.lookup(chatId, String(message.id))) return

      const replyToMessage = message.replyTo ? await message.getReplyMessage().catch(() => undefined) : undefined
      const replySender = replyToMessage ? await replyToMessage.getSender().catch(() => undefined) : undefined
      const replySenderId = (replySender as { id?: { toString(): string } } | undefined)?.id

      const ctx = buildMtprotoContext({
        senderId: senderIdBig.toString(),
        senderUsername: (sender as { username?: string } | undefined)?.username,
        chatId,
        chatType: event.isPrivate ? 'private' : event.isChannel ? 'supergroup' : 'group',
        messageId: message.id,
        date: message.date,
        text: message.message ?? '',
        entities: (message.entities ?? []) as RawMtprotoEntity[],
        replyTo: replyToMessage
          ? { messageId: replyToMessage.id, text: replyToMessage.message || undefined, fromId: replySenderId?.toString() }
          : undefined,
        sendReply: (text: string) => client.sendMessage(chatId, { message: text }),
      })

      await handleInbound(ctx, ctx.message?.text ?? '', undefined)
    } catch (err) {
      process.stderr.write(`telegram channel (mtproto): failed to process event: ${err}\n`)
    }
  }

  async function start(): Promise<void> {
    // Found live (2026-09-15): GramJS's _authFlow branches on
    // `"phoneNumber" in authParams` — merely having that KEY present (even
    // as a callback that returns '') routes into the USER phone-login flow
    // (signInUser) instead of the bot flow (signInBot), which is why the
    // first production run threw PHONE_NUMBER_INVALID from auth.SendCode
    // and every message from another bot silently never arrived (the
    // client was never actually authorized). Bot-token login wants
    // *exactly* botAuthToken + onError, nothing else in this object.
    await client.start({
      botAuthToken: botToken,
      onError: err => process.stderr.write(`telegram channel (mtproto): auth error: ${err}\n`),
    })
    const sessionString = client.session.save() as unknown as string
    if (sessionString) {
      try {
        writeFileSync(sessionFile, sessionString, { mode: 0o600 })
      } catch (err) {
        process.stderr.write(`telegram channel (mtproto): failed to save session: ${err}\n`)
      }
    }
    client.addEventHandler(onEvent, new NewMessage({}))
    process.stderr.write('telegram channel (mtproto): listening for other bots\' messages\n')
  }

  async function stop(): Promise<void> {
    await client.disconnect()
  }

  return { start, stop }
}
