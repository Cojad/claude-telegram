// Purpose-driven tests for inbound.ts: the plan.html §04 reply_to meta
// addition, and §05's "record everything, including drops" store wiring.
// buildReplyMeta() covers the pure truncation/extraction logic; the rest
// exercise the real handleInbound with stubbed gate/bot/mcp/store deps and
// assert on what actually got sent/recorded — not just that a helper
// computes the right value in isolation.

import { expect, test } from 'bun:test'
import type { Context } from 'grammy'
import { buildReplyMeta, createHandleInbound, type InboundDeps } from '../inbound'
import { type Access, type GateResult } from '../policy'
import type { MessageRecord } from '../store'

test('buildReplyMeta: no reply_to_message produces no reply fields', () => {
  expect(buildReplyMeta(undefined)).toEqual({})
})

test('buildReplyMeta: text message includes both id and text', () => {
  expect(buildReplyMeta({ message_id: 42, text: 'original message' })).toEqual({
    reply_to_message_id: '42',
    reply_to_text: 'original message',
  })
})

test('buildReplyMeta: falls back to caption when text is absent (e.g. replying to a photo)', () => {
  expect(buildReplyMeta({ message_id: 7, caption: 'a caption' })).toEqual({
    reply_to_message_id: '7',
    reply_to_text: 'a caption',
  })
})

test('buildReplyMeta: a reply target with neither text nor caption (e.g. a bare sticker) still gives the id', () => {
  expect(buildReplyMeta({ message_id: 9 })).toEqual({ reply_to_message_id: '9' })
})

test('buildReplyMeta: text over 200 chars is truncated with an ellipsis', () => {
  const long = 'x'.repeat(250)
  const result = buildReplyMeta({ message_id: 1, text: long })
  expect(result.reply_to_text!.length).toBe(201) // 200 chars + '…'
  expect(result.reply_to_text!.endsWith('…')).toBe(true)
})

// Cojad 2026-09-15: "why is the replied-to sender's uid missing" — Telegram
// inlines `.from` on the reply_to_message object same as it inlines
// text/caption, but the original type signature never declared the field
// so it was silently dropped. This is the fix.
test('buildReplyMeta: includes reply_to_user_id when Telegram inlines the replied-to sender', () => {
  expect(buildReplyMeta({ message_id: 42, text: 'original message', from: { id: 999 } })).toEqual({
    reply_to_message_id: '42',
    reply_to_text: 'original message',
    reply_to_user_id: '999',
  })
})

test('buildReplyMeta: omits reply_to_user_id when Telegram does not inline a sender (old message)', () => {
  const result = buildReplyMeta({ message_id: 9, text: 'hi' })
  expect('reply_to_user_id' in result).toBe(false)
})

// ---- wired into handleInbound: notification payload + store recording --

function accessAllowingEveryone(): Access {
  return { dmPolicy: 'allowlist', allowFrom: ['1'], groups: {}, pending: {} }
}

interface Harness {
  handleInbound: ReturnType<typeof createHandleInbound>
  notifications: Array<{ method: string; params: Record<string, unknown> }>
  recorded: MessageRecord[]
}

function harness(gateResult: GateResult, seeded: Record<string, MessageRecord> = {}): Harness {
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = []
  const recorded: MessageRecord[] = []
  const deps: InboundDeps = {
    gate: () => gateResult,
    bot: { api: { sendChatAction: async () => {}, setMessageReaction: async () => {} } } as never,
    mcp: { notification: async (n: unknown) => { notifications.push(n as never); return undefined } } as never,
    store: {
      record: (r: MessageRecord) => { recorded.push(r) },
      lookup: (chat_id: string, message_id: string) => seeded[`${chat_id}:${message_id}`] ?? null,
    },
  }
  return { handleInbound: createHandleInbound(deps), notifications, recorded }
}

function ctxFor(overrides: { message_id: number; date?: number; text?: string; reply_to_message?: unknown; from?: unknown; chat?: unknown }): Context {
  return {
    from: overrides.from ?? { id: 1, username: 'alice' },
    chat: overrides.chat ?? { id: 1 },
    message: {
      message_id: overrides.message_id,
      date: overrides.date ?? 0,
      text: overrides.text,
      reply_to_message: overrides.reply_to_message,
    },
    reply: async () => {},
  } as unknown as Context
}

test('handleInbound includes reply_to_message_id/text/user_id in the notification meta when the message is a reply', async () => {
  const { handleInbound, notifications } = harness({ action: 'deliver', access: accessAllowingEveryone() })
  const ctx = ctxFor({
    message_id: 100,
    reply_to_message: { message_id: 55, text: 'earlier question', from: { id: 137438526 } },
  })

  await handleInbound(ctx, 'here is my answer', undefined)

  expect(notifications).toHaveLength(1)
  const meta = notifications[0].params.meta as Record<string, unknown>
  expect(meta.reply_to_message_id).toBe('55')
  expect(meta.reply_to_text).toBe('earlier question')
  expect(meta.reply_to_user_id).toBe('137438526')
})

test('handleInbound omits reply_to fields entirely for a non-reply message', async () => {
  const { handleInbound, notifications } = harness({ action: 'deliver', access: accessAllowingEveryone() })
  const ctx = ctxFor({ message_id: 101 })

  await handleInbound(ctx, 'a fresh message', undefined)

  const meta = notifications[0].params.meta as Record<string, unknown>
  expect('reply_to_message_id' in meta).toBe(false)
  expect('reply_to_text' in meta).toBe(false)
})

test('a delivered message is recorded with delivered: true, matching what was sent', async () => {
  const { handleInbound, recorded } = harness({ action: 'deliver', access: accessAllowingEveryone() })
  const ctx = ctxFor({ message_id: 200, text: 'hello there' })

  await handleInbound(ctx, 'hello there', undefined)

  expect(recorded).toHaveLength(1)
  expect(recorded[0]).toMatchObject({
    chat_id: '1', message_id: '200', direction: 'in', user_id: '1',
    content: 'hello there', delivered: true,
  })
})

test('a message gate() drops is still recorded, with delivered: false — closing the "no trace" gap', async () => {
  const { handleInbound, notifications, recorded } = harness({ action: 'drop' })
  const ctx = ctxFor({ message_id: 201, text: 'not mentioned' })

  await handleInbound(ctx, 'not mentioned', undefined)

  expect(notifications).toHaveLength(0) // never reached Claude
  expect(recorded).toHaveLength(1) // but it's not invisible either
  expect(recorded[0]).toMatchObject({ chat_id: '1', message_id: '201', delivered: false })
})

test('a pairing-code response is recorded as delivered: false (nothing reached Claude yet)', async () => {
  const { handleInbound, recorded } = harness({ action: 'pair', code: 'abc123', isResend: false })
  const ctx = ctxFor({ message_id: 202, text: 'hi' })

  await handleInbound(ctx, 'hi', undefined)

  expect(recorded).toHaveLength(1)
  expect(recorded[0].delivered).toBe(false)
})

test('a store.record failure never blocks message delivery to Claude', async () => {
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = []
  const handleInbound = createHandleInbound({
    gate: () => ({ action: 'deliver', access: accessAllowingEveryone() }),
    bot: { api: { sendChatAction: async () => {}, setMessageReaction: async () => {} } } as never,
    mcp: { notification: async (n: unknown) => { notifications.push(n as never); return undefined } } as never,
    store: { record: () => { throw new Error('disk full') }, lookup: () => null },
  })
  const ctx = ctxFor({ message_id: 300, text: 'still gets through' })

  await handleInbound(ctx, 'still gets through', undefined)

  expect(notifications).toHaveLength(1) // store blowing up didn't swallow the real delivery
})

// ---- reply_to_text fallback to the store (plan.html §06 phase 4) --------

test('reply_to_text falls back to the store when Telegram omits it (e.g. replying to a caption-less photo)', async () => {
  const { handleInbound, notifications } = harness(
    { action: 'deliver', access: accessAllowingEveryone() },
    { '1:55': { chat_id: '1', message_id: '55', direction: 'in', ts: '2026-01-01T00:00:00.000Z', content: 'from the store', delivered: true } },
  )
  // reply_to_message has an id but no text/caption — the exact shape Telegram
  // sends for a reply to a photo with no caption.
  const ctx = ctxFor({ message_id: 100, reply_to_message: { message_id: 55 } })

  await handleInbound(ctx, 'my answer', undefined)

  const meta = notifications[0].params.meta as Record<string, unknown>
  expect(meta.reply_to_message_id).toBe('55')
  expect(meta.reply_to_text).toBe('from the store')
})

test('reply_to_text stays absent when neither Telegram nor the store has it — no crash', async () => {
  const { handleInbound, notifications } = harness({ action: 'deliver', access: accessAllowingEveryone() })
  const ctx = ctxFor({ message_id: 101, reply_to_message: { message_id: 999 } }) // never recorded

  await handleInbound(ctx, 'my answer', undefined)

  const meta = notifications[0].params.meta as Record<string, unknown>
  expect(meta.reply_to_message_id).toBe('999')
  expect('reply_to_text' in meta).toBe(false)
})

test('Telegram-inlined reply_to_text is used as-is, without ever consulting the store', async () => {
  let lookupCalls = 0
  const deps: InboundDeps = {
    gate: () => ({ action: 'deliver', access: accessAllowingEveryone() }),
    bot: { api: { sendChatAction: async () => {}, setMessageReaction: async () => {} } } as never,
    mcp: { notification: async () => undefined } as never,
    store: { record: () => {}, lookup: () => { lookupCalls++; return null } },
  }
  const handleInbound = createHandleInbound(deps)
  const ctx = ctxFor({ message_id: 102, reply_to_message: { message_id: 55, text: 'already inlined' } })

  await handleInbound(ctx, 'my answer', undefined)

  expect(lookupCalls).toBe(0)
})

test('a store.lookup failure during the reply fallback never blocks delivery', async () => {
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = []
  const handleInbound = createHandleInbound({
    gate: () => ({ action: 'deliver', access: accessAllowingEveryone() }),
    bot: { api: { sendChatAction: async () => {}, setMessageReaction: async () => {} } } as never,
    mcp: { notification: async (n: unknown) => { notifications.push(n as never); return undefined } } as never,
    store: { record: () => {}, lookup: () => { throw new Error('db locked') } },
  })
  const ctx = ctxFor({ message_id: 103, reply_to_message: { message_id: 55 } })

  await handleInbound(ctx, 'my answer', undefined)

  expect(notifications).toHaveLength(1)
})
