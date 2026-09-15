// Purpose-driven tests for store.ts, per plan.html §05: the two things
// this module exists for are (chat_id, message_id) O(1) lookup, and
// recording delivered=false rows so a dropped message isn't a total
// blackout. Each test below maps to one of those, plus the upsert
// behavior the UNIQUE index implies and basic recent()-pagination
// correctness — not an exhaustive SQL spec.

import { afterEach, expect, test } from 'bun:test'
import { openStore, type MessageRecord, type Store } from '../store'

const stores: Store[] = []
function freshStore(): Store {
  const s = openStore(':memory:')
  stores.push(s)
  return s
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
})

function rec(overrides: Partial<MessageRecord>): MessageRecord {
  return {
    chat_id: '-100',
    message_id: '1',
    direction: 'in',
    ts: '2026-09-15T00:00:00.000Z',
    delivered: true,
    ...overrides,
  }
}

test('record then lookup by (chat_id, message_id) round-trips every field', () => {
  const store = freshStore()
  store.record(rec({
    message_id: '42', user_id: '137438526', content: 'hello',
    reply_to_message_id: '10', attachment_kind: 'photo', attachment_file_id: 'ABC123',
  }))
  const found = store.lookup('-100', '42')
  expect(found).toEqual(rec({
    message_id: '42', user_id: '137438526', content: 'hello',
    reply_to_message_id: '10', attachment_kind: 'photo', attachment_file_id: 'ABC123',
  }))
})

test('lookup on an id that was never recorded returns null, not throw', () => {
  const store = freshStore()
  expect(store.lookup('-100', '999')).toBeNull()
})

test('a message gate() dropped is still recorded, with delivered: false', () => {
  const store = freshStore()
  store.record(rec({ message_id: '5', delivered: false, content: 'not mentioned, dropped' }))
  const found = store.lookup('-100', '5')
  expect(found?.delivered).toBe(false)
  expect(found?.content).toBe('not mentioned, dropped')
})

test('recording the same (chat_id, message_id) again replaces the row, not duplicates it', () => {
  const store = freshStore()
  store.record(rec({ message_id: '1', delivered: false }))
  store.record(rec({ message_id: '1', delivered: true, content: 'now delivered' }))
  expect(store.lookup('-100', '1')?.delivered).toBe(true)
  expect(store.recent('-100', 10)).toHaveLength(1)
})

test('the same message_id in two different chats does not collide', () => {
  const store = freshStore()
  store.record(rec({ chat_id: '-100', message_id: '1', content: 'group A' }))
  store.record(rec({ chat_id: '-200', message_id: '1', content: 'group B' }))
  expect(store.lookup('-100', '1')?.content).toBe('group A')
  expect(store.lookup('-200', '1')?.content).toBe('group B')
})

test('recent() returns newest first and respects the limit', () => {
  const store = freshStore()
  for (let i = 1; i <= 5; i++) store.record(rec({ message_id: String(i), content: `msg ${i}` }))
  const top3 = store.recent('-100', 3)
  expect(top3.map(r => r.message_id)).toEqual(['5', '4', '3'])
})

test('recent() with beforeId pages older messages, excluding beforeId itself', () => {
  const store = freshStore()
  for (let i = 1; i <= 5; i++) store.record(rec({ message_id: String(i), content: `msg ${i}` }))
  const page = store.recent('-100', 10, '3')
  expect(page.map(r => r.message_id)).toEqual(['2', '1'])
})

test('an outbound (direction: out) record round-trips the same as inbound', () => {
  const store = freshStore()
  store.record(rec({ direction: 'out', message_id: '7', content: 'sent by the bot' }))
  expect(store.lookup('-100', '7')?.direction).toBe('out')
})

test('raw round-trips when present, stays undefined (not "null") when absent', () => {
  const store = freshStore()
  store.record(rec({ message_id: '8', raw: '{"className":"Message","id":8}' }))
  store.record(rec({ message_id: '9' }))
  expect(store.lookup('-100', '8')?.raw).toBe('{"className":"Message","id":8}')
  expect(store.lookup('-100', '9')?.raw).toBeUndefined()
})
