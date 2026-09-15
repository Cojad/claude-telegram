// Purpose-driven tests for chunk() — see test-plan.html suite 3.
// Two concrete risks read straight out of the implementation, not a
// generic spec: (1) a hard cut can land inside a UTF-16 surrogate pair
// (most emoji are two code units) and split one character into two
// invalid lone surrogates; (2) every chunk must respect the limit and the
// full text must reconstruct losslessly.

import { expect, test } from 'bun:test'
import { chunk, formatMessageRow, formatMessageRows } from '../format'
import type { MessageRecord } from '../store'

function endsWithLoneHighSurrogate(s: string): boolean {
  const code = s.charCodeAt(s.length - 1)
  return code >= 0xd800 && code <= 0xdbff
}
function startsWithLoneLowSurrogate(s: string): boolean {
  const code = s.charCodeAt(0)
  return code >= 0xdc00 && code <= 0xdfff
}

test('text no longer than the limit is not split', () => {
  expect(chunk('hello', 10, 'length')).toEqual(['hello'])
  expect(chunk('a'.repeat(10), 10, 'length')).toEqual(['a'.repeat(10)])
})

test('mode=length hard-splits into pieces that respect the limit', () => {
  const text = 'a'.repeat(25)
  const parts = chunk(text, 10, 'length')
  expect(parts.join('')).toBe(text)
  for (const p of parts) expect(p.length).toBeLessThanOrEqual(10)
  expect(parts).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)])
})

test('mode=newline prefers a paragraph boundary over a hard cut', () => {
  const text = 'first paragraph here' + '\n\n' + 'second paragraph'
  const parts = chunk(text, 20, 'newline')
  expect(parts[0]).toBe('first paragraph here') // exactly the 20 chars before \n\n
  expect(parts.join('').replace(/\n+/g, '')).toBe(text.replace(/\n+/g, ''))
})

test('mode=newline falls back to a space, then a hard cut, when no newline is in range', () => {
  const text = 'word '.repeat(6).trimEnd() // 29 chars, no newlines
  const parts = chunk(text, 12, 'newline')
  expect(parts.join(' ').replace(/ +/g, ' ')).toContain('word')
  expect(parts.every(p => p.length <= 12)).toBe(true)
})

test('a hard cut never splits a UTF-16 surrogate pair (emoji)', () => {
  // 9 'A's + 😀 (surrogate pair, U+1F600) + 9 'B's, limit=10 lands the cut
  // exactly between the emoji's high and low surrogate.
  const text = 'A'.repeat(9) + '😀' + 'B'.repeat(9)
  const parts = chunk(text, 10, 'length')
  expect(parts.join('')).toBe(text) // no characters lost
  for (let i = 0; i < parts.length - 1; i++) {
    expect(endsWithLoneHighSurrogate(parts[i])).toBe(false)
  }
  for (let i = 1; i < parts.length; i++) {
    expect(startsWithLoneLowSurrogate(parts[i])).toBe(false)
  }
})

// Purpose-driven tests for formatMessageRow/Rows — see
// telegram-slash-output-format.md (memory, not in this repo) for why this
// replaced JSON.stringify: repeated field names/braces per message where
// the actual information (content, file_ids, reply chains) is a small
// fraction of the bytes. Two concrete risks: (1) ts is stored as UTC —
// showing that raw to a GMT+8 reader is the exact bug this house always
// flags; (2) "compact" must not mean "lossy" — file_ids in particular are
// consumed verbatim by download_attachment later, so they must never be
// truncated.

function rec(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    chat_id: '1',
    message_id: '42',
    direction: 'in',
    ts: '2026-09-15T05:16:08.000Z',
    delivered: true,
    ...overrides,
  }
}

test('formatMessageRow shows GMT+8, not the raw UTC timestamp', () => {
  const text = formatMessageRow(rec())
  expect(text).toContain('13:16:08') // 05:16:08 UTC + 8h
  expect(text).not.toContain('05:16:08')
  expect(text).not.toContain('UTC')
  expect(text).not.toContain('Z')
})

test('formatMessageRow keeps content verbatim, including embedded newlines', () => {
  const text = formatMessageRow(rec({ content: 'line one\nline two' }))
  expect(text).toContain('line one')
  expect(text).toContain('line two')
})

test('formatMessageRow never truncates the attachment file_id — download_attachment needs it exact', () => {
  const longId = 'A'.repeat(120)
  const text = formatMessageRow(rec({ attachment_kind: 'sticker', attachment_file_id: longId }))
  expect(text).toContain(longId)
})

test('formatMessageRow flags an undelivered (gate-dropped) message; says nothing extra when delivered', () => {
  const dropped = formatMessageRow(rec({ delivered: false }))
  const delivered = formatMessageRow(rec({ delivered: true }))
  expect(dropped).toContain('undelivered')
  expect(delivered).not.toContain('undelivered')
})

test('formatMessageRow surfaces reply_to_message_id when present', () => {
  const text = formatMessageRow(rec({ reply_to_message_id: '41' }))
  expect(text).toContain('41')
})

test('formatMessageRows renders "(no messages)" for an empty list, not an empty string', () => {
  expect(formatMessageRows([])).toBe('(no messages)')
})

test('formatMessageRows preserves caller-given order (newest-first is the caller\'s job)', () => {
  const text = formatMessageRows([rec({ message_id: '2', content: 'second' }), rec({ message_id: '1', content: 'first' })])
  expect(text.indexOf('second')).toBeLessThan(text.indexOf('first'))
})
