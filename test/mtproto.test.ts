// Purpose-driven tests for mtproto.ts's pure logic. createMtprotoListener()
// itself (real GramJS TelegramClient, real network) is not unit-tested —
// see raw_format.md / the live verification in the deploy notes for how
// that path was actually exercised (a real 60s MTProto listen against the
// production bot account and group, cross-checked against store.ts).
// What's worth a fast, no-network unit test is the translation logic:
// does a GramJS-shaped event turn into the right HandleInboundContext.

import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildMtprotoContext, loadSessionString, mapEntityClassName } from '../mtproto'

test('mapEntityClassName: recognizes the two entity kinds isMentioned() checks', () => {
  expect(mapEntityClassName('MessageEntityMention')).toBe('mention')
  expect(mapEntityClassName('MessageEntityMentionName')).toBe('text_mention')
})

test('mapEntityClassName: everything else (bold, url, code, ...) maps to undefined', () => {
  expect(mapEntityClassName('MessageEntityBold')).toBeUndefined()
  expect(mapEntityClassName('MessageEntityUrl')).toBeUndefined()
  expect(mapEntityClassName('')).toBeUndefined()
})

test('loadSessionString: missing file returns empty string, not a throw', () => {
  expect(loadSessionString('/nonexistent/path/to/session')).toBe('')
})

test('loadSessionString: reads and trims an existing session file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mtproto-test-'))
  const path = join(dir, 'session')
  writeFileSync(path, '  some-session-string  \n')
  expect(loadSessionString(path)).toBe('some-session-string')
  rmSync(dir, { recursive: true, force: true })
})

test('buildMtprotoContext: a plain group message from a bot maps straight across', () => {
  const ctx = buildMtprotoContext({
    senderId: '133770478',
    senderUsername: 'BaldEagleBot',
    chatId: '-1001068509881',
    chatType: 'supergroup',
    messageId: 154162,
    date: 1789460000,
    text: 'cc hello from another bot',
    sendReply: async () => undefined,
  })
  expect(ctx.from).toEqual({ id: '133770478', username: 'BaldEagleBot' })
  expect(ctx.chat).toEqual({ id: '-1001068509881', type: 'supergroup' })
  expect(ctx.message?.message_id).toBe(154162)
  expect(ctx.message?.text).toBe('cc hello from another bot')
  expect(ctx.message?.entities).toEqual([])
  expect(ctx.message?.reply_to_message).toBeUndefined()
  expect(typeof ctx.reply).toBe('function')
  expect(ctx.mtproto).toBe(true) // lets meta.mtproto="true" distinguish this from the Bot API path
})

test('buildMtprotoContext: an @mention entity survives the translation, non-mention entities are dropped', () => {
  const ctx = buildMtprotoContext({
    senderId: '1', chatId: '1', chatType: 'group', messageId: 1, date: 0,
    text: '@coke2erobot hi', sendReply: async () => undefined,
    entities: [
      { className: 'MessageEntityMention', offset: 0, length: 12 },
      { className: 'MessageEntityBold', offset: 13, length: 2 },
    ],
  })
  expect(ctx.message?.entities).toEqual([{ type: 'mention', offset: 0, length: 12 }])
})

test('buildMtprotoContext: reply_to carries the replied-to message\'s id/text/sender through', () => {
  const ctx = buildMtprotoContext({
    senderId: '1', chatId: '1', chatType: 'group', messageId: 2, date: 0,
    text: 'a reply', sendReply: async () => undefined,
    replyTo: { messageId: 1, text: 'the original', fromId: '999' },
  })
  expect(ctx.message?.reply_to_message).toEqual({
    message_id: 1,
    text: 'the original',
    from: { id: 999 },
  })
})

test('buildMtprotoContext: reply() forwards to whatever sendReply the caller supplied', async () => {
  const calls: string[] = []
  const ctx = buildMtprotoContext({
    senderId: '1', chatId: '1', chatType: 'private', messageId: 1, date: 0,
    text: 'hi', sendReply: async (text: string) => { calls.push(text); return undefined },
  })
  await ctx.reply('pairing required')
  expect(calls).toEqual(['pairing required'])
})
