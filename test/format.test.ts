// Purpose-driven tests for chunk() — see test-plan.html suite 3.
// Two concrete risks read straight out of the implementation, not a
// generic spec: (1) a hard cut can land inside a UTF-16 surrogate pair
// (most emoji are two code units) and split one character into two
// invalid lone surrogates; (2) every chunk must respect the limit and the
// full text must reconstruct losslessly.

import { expect, test } from 'bun:test'
import { chunk } from '../format'

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
