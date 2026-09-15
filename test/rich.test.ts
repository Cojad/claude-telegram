// Covers rich.ts's flattening of Bot API 10.x Rich Message blocks — see
// GitHub issue #5724 for the original bug (rich_message arrived with no
// text/caption, so it read as an empty message). Block shapes here are
// built directly from the real @grammyjs/types@5.0.0 interfaces, not
// guessed — see rich.ts's own header comment for where those were
// verified.
import { expect, test } from 'bun:test'
import { flattenRichBlock, flattenRichMessage } from '../rich'
import type { RichBlock, RichMessage } from '@grammyjs/types'

test('paragraph and inline marks flatten to Markdown', () => {
  const block: RichBlock = {
    type: 'paragraph',
    text: ['plain ', { type: 'bold', text: 'bold' }, ' ', { type: 'italic', text: 'italic' }],
  }
  expect(flattenRichBlock(block)).toBe('plain **bold** _italic_')
})

test('numbered list (2 items) uses the block-provided label, not a reimplemented marker', () => {
  const block: RichBlock = {
    type: 'list',
    items: [
      { label: '1.', blocks: [{ type: 'paragraph', text: 'first' }] },
      { label: '2.', blocks: [{ type: 'paragraph', text: 'second' }] },
    ],
  }
  expect(flattenRichBlock(block)).toBe('1. first\n2. second')
})

test('list item checkbox state renders [x] or [ ]', () => {
  const block: RichBlock = {
    type: 'list',
    items: [
      { label: '-', blocks: [{ type: 'paragraph', text: 'done' }], has_checkbox: true, is_checked: true },
      { label: '-', blocks: [{ type: 'paragraph', text: 'not done' }], has_checkbox: true },
    ],
  }
  expect(flattenRichBlock(block)).toBe('- [x] done\n- [ ] not done')
})

test('table (2x2) flattens to a pipe table with a separator row', () => {
  const block: RichBlock = {
    type: 'table',
    cells: [
      [{ text: 'a', align: 'left', valign: 'top', is_header: true }, { text: 'b', align: 'left', valign: 'top', is_header: true }],
      [{ text: '1', align: 'left', valign: 'top' }, { text: '2', align: 'left', valign: 'top' }],
    ],
  }
  expect(flattenRichBlock(block)).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |')
})

test('table cell pipe characters are escaped so the table does not collapse', () => {
  const block: RichBlock = {
    type: 'table',
    cells: [[{ text: 'a|b', align: 'left', valign: 'top' }]],
  }
  expect(flattenRichBlock(block)).toBe('| a\\|b |\n| --- |')
})

test('language-tagged code block keeps the language on the fence', () => {
  const block: RichBlock = { type: 'pre', text: 'const x = 1', language: 'ts' }
  expect(flattenRichBlock(block)).toBe('```ts\nconst x = 1\n```')
})

test('blockquote credit becomes an attribution line', () => {
  const block: RichBlock = {
    type: 'blockquote',
    blocks: [{ type: 'paragraph', text: 'quoted text' }],
    credit: 'Someone',
  }
  expect(flattenRichBlock(block)).toBe('> quoted text\n> — Someone')
})

test('pullquote credit is inline after an em dash', () => {
  const block: RichBlock = { type: 'pullquote', text: 'a pull quote', credit: 'Author' }
  expect(flattenRichBlock(block)).toBe('> a pull quote — Author')
})

test('details round-trips to the same HTML tag the Bot API accepts', () => {
  const block: RichBlock = {
    type: 'details',
    summary: 'click to expand',
    blocks: [{ type: 'paragraph', text: 'hidden content' }],
  }
  expect(flattenRichBlock(block)).toBe('<details><summary>click to expand</summary>\n\nhidden content\n\n</details>')
})

test('a photo-only block leaves a placeholder instead of flattening to an empty string', () => {
  const block: RichBlock = {
    type: 'photo',
    photo: [{ file_id: 'f1', file_unique_id: 'u1', width: 10, height: 10 }],
  }
  expect(flattenRichBlock(block)).toBe('[photo]')
  expect(flattenRichBlock(block)).not.toBe('')
})

test('media block caption is preserved in the placeholder', () => {
  const block: RichBlock = {
    type: 'photo',
    photo: [{ file_id: 'f1', file_unique_id: 'u1', width: 10, height: 10 }],
    caption: { text: 'a caption' },
  }
  expect(flattenRichBlock(block)).toBe('[photo: a caption]')
})

test('an unknown future block type stays visible instead of vanishing silently', () => {
  const block = { type: 'some_future_block_type', payload: 'x' } as unknown as RichBlock
  expect(flattenRichBlock(block)).toBe('[unknown block: some_future_block_type]')
})

test('divider and heading render as their Markdown equivalents', () => {
  expect(flattenRichBlock({ type: 'divider' })).toBe('---')
  expect(flattenRichBlock({ type: 'heading', text: 'Title', size: 2 })).toBe('## Title')
})

test('flattenRichMessage joins top-level blocks with a blank line', () => {
  const rich: RichMessage = {
    blocks: [
      { type: 'paragraph', text: 'first' },
      { type: 'paragraph', text: 'second' },
    ],
  }
  expect(flattenRichMessage(rich)).toBe('first\n\nsecond')
})
