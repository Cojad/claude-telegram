// Purpose-driven tests for the plan.html §04 addition: reply_to_message_id
// / reply_to_text in the outbound meta. buildReplyMeta() covers the pure
// truncation/extraction logic; the second test confirms handleInbound
// actually wires it into the real notification payload, not just that the
// helper works in isolation.

import { expect, test } from 'bun:test'
import type { Context } from 'grammy'
import { buildReplyMeta, createHandleInbound } from '../inbound'
import { type Access } from '../policy'

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

// ---- wired into handleInbound's actual notification payload -------------

function accessAllowingEveryone(): Access {
  return { dmPolicy: 'allowlist', allowFrom: ['1'], groups: {}, pending: {} }
}

test('handleInbound includes reply_to_message_id/text in the notification meta when the message is a reply', async () => {
  const notifications: unknown[] = []
  const handleInbound = createHandleInbound({
    gate: () => ({ action: 'deliver', access: accessAllowingEveryone() }),
    bot: { api: { sendChatAction: async () => {}, setMessageReaction: async () => {} } } as never,
    mcp: { notification: async (n: unknown) => { notifications.push(n); return undefined } } as never,
  })

  const ctx = {
    from: { id: 1, username: 'alice' },
    chat: { id: 1 },
    message: {
      message_id: 100,
      date: 0,
      reply_to_message: { message_id: 55, text: 'earlier question' },
    },
  } as unknown as Context

  await handleInbound(ctx, 'here is my answer', undefined)

  expect(notifications).toHaveLength(1)
  const meta = (notifications[0] as { params: { meta: Record<string, unknown> } }).params.meta
  expect(meta.reply_to_message_id).toBe('55')
  expect(meta.reply_to_text).toBe('earlier question')
})

test('handleInbound omits reply_to fields entirely for a non-reply message', async () => {
  const notifications: unknown[] = []
  const handleInbound = createHandleInbound({
    gate: () => ({ action: 'deliver', access: accessAllowingEveryone() }),
    bot: { api: { sendChatAction: async () => {}, setMessageReaction: async () => {} } } as never,
    mcp: { notification: async (n: unknown) => { notifications.push(n); return undefined } } as never,
  })

  const ctx = {
    from: { id: 1, username: 'alice' },
    chat: { id: 1 },
    message: { message_id: 101, date: 0 },
  } as unknown as Context

  await handleInbound(ctx, 'a fresh message', undefined)

  const meta = (notifications[0] as { params: { meta: Record<string, unknown> } }).params.meta
  expect('reply_to_message_id' in meta).toBe(false)
  expect('reply_to_text' in meta).toBe(false)
})
