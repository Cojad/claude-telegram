// Purpose-driven tests for isMentioned() and gate() — see test-plan.html
// suites 1 and 2. isMentioned's cases are the direct regression test for
// the 2026-09-15 incident: `^柯柯\b` never matched anything in Bun's JS
// regex engine because \b treats CJK characters as non-word, so this
// group's mention trigger silently never fired. gate()'s cases pin the
// access-control decision matrix — the boundary that decides whose
// messages ever reach Claude.

import { expect, test } from 'bun:test'
import type { Context } from 'grammy'
import { defaultAccess, gate, isMentioned, type Access } from '../policy'

// Minimal duck-typed stand-in for grammY's Context — these functions only
// ever read ctx.from / ctx.chat / ctx.message, never call grammY methods,
// so a plain object is enough and keeps the test from depending on grammY
// internals (see test-plan.html §04: don't end up testing grammY itself).
function makeCtx(opts: {
  fromId?: number
  chatId?: number
  chatType?: 'private' | 'group' | 'supergroup'
  text?: string
  entities?: Array<Record<string, unknown>>
  replyFromUsername?: string
}): Context {
  return {
    from: opts.fromId != null ? { id: opts.fromId } : undefined,
    chat: opts.chatId != null ? { id: opts.chatId, type: opts.chatType ?? 'private' } : undefined,
    message: {
      text: opts.text,
      entities: opts.entities,
      reply_to_message: opts.replyFromUsername
        ? { from: { username: opts.replyFromUsername } }
        : undefined,
    },
  } as unknown as Context
}

// ---- isMentioned ------------------------------------------------------

test('isMentioned: CJK pattern without \\b matches a message starting with it', () => {
  const ctx = makeCtx({ fromId: 1, chatId: -1, chatType: 'group', text: '柯柯 早安' })
  expect(isMentioned(ctx, 'coke2erobot', ['^柯柯'])).toBe(true)
})

test('isMentioned: regression — ^柯柯\\b never matched in the real runtime (the 2026-09-15 bug)', () => {
  const ctx = makeCtx({ fromId: 1, chatId: -1, chatType: 'group', text: '柯柯 早安' })
  // This pins the *broken* historical behavior so nobody re-introduces \b on
  // a CJK pattern without noticing: JS's \b only recognizes ASCII word
  // characters, so 柯 is never on either side of a boundary.
  expect(isMentioned(ctx, 'coke2erobot', ['^柯柯\\b'])).toBe(false)
})

test('isMentioned: mention word not at the start of the message does not trigger', () => {
  const ctx = makeCtx({ fromId: 1, chatId: -1, chatType: 'group', text: '嗨嗨 柯柯' })
  expect(isMentioned(ctx, 'coke2erobot', ['^柯柯'])).toBe(false)
})

test('isMentioned: ASCII pattern with \\b matches at the start', () => {
  const ctx = makeCtx({ fromId: 1, chatId: -1, chatType: 'group', text: 'cc 早安' })
  expect(isMentioned(ctx, 'coke2erobot', ['^cc\\b'])).toBe(true)
})

test('isMentioned: ASCII \\b boundary prevents a prefix false-positive', () => {
  const ctx = makeCtx({ fromId: 1, chatId: -1, chatType: 'group', text: 'ccxxx 早安' })
  expect(isMentioned(ctx, 'coke2erobot', ['^cc\\b'])).toBe(false)
})

test('isMentioned: replying to the bot counts as a mention regardless of text or patterns', () => {
  const ctx = makeCtx({
    fromId: 1, chatId: -1, chatType: 'group', text: '完全不相干的文字',
    replyFromUsername: 'coke2erobot',
  })
  expect(isMentioned(ctx, 'coke2erobot', ['^柯柯'])).toBe(true)
})

// ---- gate ---------------------------------------------------------------

function accessWith(overrides: Partial<Access>): Access {
  return { ...defaultAccess(), ...overrides }
}
const noopPersist = () => {}
const fixedCode = () => 'abc123'

test('gate: private chat from an allowlisted sender delivers', () => {
  const access = accessWith({ dmPolicy: 'allowlist', allowFrom: ['42'] })
  const ctx = makeCtx({ fromId: 42, chatId: 42, chatType: 'private' })
  expect(gate(ctx, access, 'coke2erobot', noopPersist, fixedCode).action).toBe('deliver')
})

test('gate: private chat, sender not allowlisted, dmPolicy=allowlist drops', () => {
  const access = accessWith({ dmPolicy: 'allowlist', allowFrom: ['42'] })
  const ctx = makeCtx({ fromId: 99, chatId: 99, chatType: 'private' })
  expect(gate(ctx, access, 'coke2erobot', noopPersist, fixedCode).action).toBe('drop')
})

test('gate: private chat, dmPolicy=pairing, no pending entry issues a new pairing code', () => {
  const access = accessWith({ dmPolicy: 'pairing' })
  const ctx = makeCtx({ fromId: 99, chatId: 99, chatType: 'private' })
  const result = gate(ctx, access, 'coke2erobot', noopPersist, fixedCode)
  expect(result).toEqual({ action: 'pair', code: 'abc123', isResend: false })
})

test('gate: private chat, pairing mode, third ask for the same pending code drops (2-reply cap)', () => {
  const access = accessWith({
    dmPolicy: 'pairing',
    pending: { abc123: { senderId: '99', chatId: '99', createdAt: 0, expiresAt: Date.now() + 1e9, replies: 2 } },
  })
  const ctx = makeCtx({ fromId: 99, chatId: 99, chatType: 'private' })
  expect(gate(ctx, access, 'coke2erobot', noopPersist, fixedCode).action).toBe('drop')
})

test('gate: group with no matching policy entry drops', () => {
  const access = accessWith({})
  const ctx = makeCtx({ fromId: 1, chatId: -100, chatType: 'group', text: 'cc 早安' })
  expect(gate(ctx, access, 'coke2erobot', noopPersist, fixedCode).action).toBe('drop')
})

test('gate: group with a non-empty groupAllowFrom excludes senders not on it, even if mentioned', () => {
  const access = accessWith({ groups: { '-100': { requireMention: true, allowFrom: ['1'] } } })
  const ctx = makeCtx({ fromId: 2, chatId: -100, chatType: 'group', text: 'cc 早安' })
  expect(gate(ctx, access, 'coke2erobot', noopPersist, fixedCode).action).toBe('drop')
})

test('gate: group requiring mention delivers when the message is mentioned', () => {
  const access = accessWith({ groups: { '-100': { requireMention: true, allowFrom: [] } }, mentionPatterns: ['^cc\\b'] })
  const ctx = makeCtx({ fromId: 1, chatId: -100, chatType: 'group', text: 'cc 早安' })
  expect(gate(ctx, access, 'coke2erobot', noopPersist, fixedCode).action).toBe('deliver')
})

test('gate: group requiring mention drops when the message is not mentioned', () => {
  const access = accessWith({ groups: { '-100': { requireMention: true, allowFrom: [] } }, mentionPatterns: ['^cc\\b'] })
  const ctx = makeCtx({ fromId: 1, chatId: -100, chatType: 'group', text: '完全沒點名' })
  expect(gate(ctx, access, 'coke2erobot', noopPersist, fixedCode).action).toBe('drop')
})
