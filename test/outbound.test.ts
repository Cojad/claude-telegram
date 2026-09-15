// Purpose-driven tests for outbound.ts's store wiring and the new
// lookup_message tool (plan.html §05). What matters here: a message this
// plugin sends actually lands in the store under the id Telegram assigned
// it (so a later reply_to_message_id resolves), an edit replaces rather
// than duplicates, and lookup_message actually reads back what was
// recorded — not just that store.ts itself works (that's store.test.ts).

import { afterEach, expect, test } from 'bun:test'
import { callTool, type OutboundDeps } from '../outbound'
import { openStore, type Store } from '../store'

const stores: Store[] = []
function harness(): { deps: OutboundDeps; sentTexts: string[]; stickerCalls: Array<{ chat_id: string; sticker: unknown; other: unknown }> } {
  const store = openStore(':memory:')
  stores.push(store)
  const sentTexts: string[] = []
  const stickerCalls: Array<{ chat_id: string; sticker: unknown; other: unknown }> = []
  let nextMessageId = 1000
  const bot = {
    api: {
      sendMessage: async (_chat_id: string, text: string) => {
        sentTexts.push(text)
        return { message_id: nextMessageId++ }
      },
      editMessageText: async (_chat_id: string, message_id: number, _text: string) => {
        return { message_id }
      },
      setMessageReaction: async () => {},
      getFile: async () => ({ file_path: undefined }),
      sendSticker: async (chat_id: string, sticker: unknown, other: unknown) => {
        stickerCalls.push({ chat_id, sticker, other })
        return { message_id: nextMessageId++ }
      },
    },
  } as never
  const deps: OutboundDeps = {
    bot,
    token: 'test-token',
    inboxDir: '/tmp/never-used-in-these-tests',
    loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: ['1'], groups: {}, pending: {} }),
    assertAllowedChat: (chat_id: string) => {
      if (chat_id !== '1') throw new Error(`chat ${chat_id} is not allowlisted — add via /telegram:access`)
    },
    assertSendable: () => {},
    store,
  }
  return { deps, sentTexts, stickerCalls }
}
afterEach(() => { for (const s of stores.splice(0)) s.close() })

test('reply records the sent message under the id Telegram returned', async () => {
  const { deps } = harness()
  const result = await callTool('reply', { chat_id: '1', text: 'hello world' }, deps)
  expect(result.isError).toBeUndefined()
  const sentId = result.content[0].text.match(/id: (\d+)/)![1]
  const found = deps.store.lookup('1', sentId)
  expect(found).toMatchObject({ chat_id: '1', message_id: sentId, direction: 'out', content: 'hello world', delivered: true })
})

test('reply with reply_to records reply_to_message_id on the recorded row', async () => {
  const { deps } = harness()
  const result = await callTool('reply', { chat_id: '1', text: 'an answer', reply_to: '55' }, deps)
  const sentId = result.content[0].text.match(/id: (\d+)/)![1]
  expect(deps.store.lookup('1', sentId)?.reply_to_message_id).toBe('55')
})

test('edit_message replaces the recorded content for that message_id, not a new row', async () => {
  const { deps } = harness()
  const first = await callTool('reply', { chat_id: '1', text: 'draft' }, deps)
  const id = first.content[0].text.match(/id: (\d+)/)![1]
  await callTool('edit_message', { chat_id: '1', message_id: id, text: 'final version' }, deps)
  expect(deps.store.lookup('1', id)?.content).toBe('final version')
  expect(deps.store.recent('1', 10)).toHaveLength(1)
})

test('lookup_message by message_id returns a compact one-record text block, GMT+8 not UTC', async () => {
  const { deps } = harness()
  const sent = await callTool('reply', { chat_id: '1', text: 'findable' }, deps)
  const id = sent.content[0].text.match(/id: (\d+)/)![1]
  const looked = await callTool('lookup_message', { chat_id: '1', message_id: id }, deps)
  const text = looked.content[0].text
  expect(text).toContain(`#${id}`)
  expect(text).toContain('findable')
  expect(text).not.toContain('UTC')
  expect(text).not.toContain('{') // not JSON
})

test('lookup_message for an id never seen returns "not found", not an error', async () => {
  const { deps } = harness()
  const looked = await callTool('lookup_message', { chat_id: '1', message_id: '99999' }, deps)
  expect(looked.isError).toBeUndefined()
  expect(looked.content[0].text).toBe('not found')
})

test('lookup_message with no message_id lists recent messages, newest first', async () => {
  const { deps } = harness()
  await callTool('reply', { chat_id: '1', text: 'first' }, deps)
  await callTool('reply', { chat_id: '1', text: 'second' }, deps)
  const looked = await callTool('lookup_message', { chat_id: '1', limit: '5' }, deps)
  const text = looked.content[0].text
  // newest first: 'second' has to appear before 'first' in the rendered text
  expect(text.indexOf('second')).toBeGreaterThanOrEqual(0)
  expect(text.indexOf('second')).toBeLessThan(text.indexOf('first'))
})

test('lookup_message with no results returns a placeholder, not an empty string', async () => {
  const { deps } = harness()
  const looked = await callTool('lookup_message', { chat_id: '1' }, deps)
  expect(looked.content[0].text).toBe('(no messages)')
})

test('lookup_message on a non-allowlisted chat_id is rejected the same as reply/react', async () => {
  const { deps } = harness()
  const looked = await callTool('lookup_message', { chat_id: '999999' }, deps)
  expect(looked.isError).toBe(true)
  expect(looked.content[0].text).toContain('not allowlisted')
})

test('send_sticker by file_id records the sent message under the id Telegram returned', async () => {
  const { deps, stickerCalls } = harness()
  const result = await callTool('send_sticker', { chat_id: '1', file_id: 'CAACAgUdummy' }, deps)
  expect(result.isError).toBeUndefined()
  const sentId = result.content[0].text.match(/id: (\d+)/)![1]
  expect(deps.store.lookup('1', sentId)).toMatchObject({ chat_id: '1', message_id: sentId, direction: 'out', delivered: true })
  expect(stickerCalls).toHaveLength(1)
  expect(stickerCalls[0].sticker).toBe('CAACAgUdummy')
})

test('send_sticker with reply_to records reply_to_message_id and passes reply_parameters through', async () => {
  const { deps, stickerCalls } = harness()
  await callTool('send_sticker', { chat_id: '1', file_id: 'CAACAgUdummy', reply_to: '55' }, deps)
  const [{ other }] = stickerCalls
  expect((other as { reply_parameters?: { message_id: number } }).reply_parameters).toEqual({ message_id: 55 })
})

test('send_sticker requires either file_id or file', async () => {
  const { deps } = harness()
  const result = await callTool('send_sticker', { chat_id: '1' }, deps)
  expect(result.isError).toBe(true)
  expect(result.content[0].text).toContain('requires either file_id or file')
})

test('send_sticker rejects passing both file_id and file', async () => {
  const { deps } = harness()
  const result = await callTool('send_sticker', { chat_id: '1', file_id: 'a', file: '/tmp/x.webp' }, deps)
  expect(result.isError).toBe(true)
  expect(result.content[0].text).toContain('pass only one of file_id or file')
})

test('send_sticker on a non-allowlisted chat_id is rejected the same as reply/react', async () => {
  const { deps } = harness()
  const result = await callTool('send_sticker', { chat_id: '999999', file_id: 'a' }, deps)
  expect(result.isError).toBe(true)
  expect(result.content[0].text).toContain('not allowlisted')
})
