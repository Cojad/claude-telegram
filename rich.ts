// Flattens Telegram's Rich Message format (`message.rich_message`, added in
// Bot API 10.x / @grammyjs/types@5.0.0) into plain Markdown text, so a rich
// message reads the same as any other inbound text instead of arriving
// empty. Root cause of the original bug (GitHub issue #5724): OpenClaw's
// "Rich Message" sends have no `text`/`caption` field at all — the content
// lives entirely in `rich_message.blocks` — so without this, transport.ts
// had nothing to hand to handleInbound.
//
// Block/mark type shapes verified against the real @grammyjs/types@5.0.0
// declarations (unpkg.com/@grammyjs/types@5.0.0/{message,rich}.d.ts), not
// assumed from the GitHub issue discussion alone.
import type { RichBlock, RichBlockCaption, RichBlockTable, RichMessage, RichText } from '@grammyjs/types'

function flattenRichText(text: RichText): string {
  if (typeof text === 'string') return text
  if (Array.isArray(text)) return text.map(flattenRichText).join('')
  switch (text.type) {
    case 'bold': return `**${flattenRichText(text.text)}**`
    case 'italic': return `_${flattenRichText(text.text)}_`
    case 'underline': return `__${flattenRichText(text.text)}__`
    case 'strikethrough': return `~~${flattenRichText(text.text)}~~`
    case 'spoiler': return `||${flattenRichText(text.text)}||`
    case 'code': return `\`${flattenRichText(text.text)}\``
    case 'url': return `[${flattenRichText(text.text)}](${text.url})`
    case 'custom_emoji': return text.alternative_text
    case 'mathematical_expression': return text.expression
    case 'anchor': return ''
    case 'button': return flattenRichText(text.button.text)
    // date_time, text_mention, subscript, superscript, marked,
    // email_address, phone_number, bank_card_number, mention, hashtag,
    // cashtag, bot_command, anchor_link, reference, reference_link — all
    // carry a `.text` field with no clean plain-text equivalent for their
    // extra metadata, so just recurse into the visible text.
    default: return flattenRichText(text.text)
  }
}

function mediaPlaceholder(kind: string, caption?: RichBlockCaption): string {
  // A media block flattened to '' reads as an empty/missing message rather
  // than "there was media here" — always leave a marker (GitHub issue
  // #5724 comment specifically calls this out as a content-losing bug).
  const cap = caption ? `: ${flattenRichText(caption.text)}` : ''
  return `[${kind}${cap}]`
}

function flattenTable(block: RichBlockTable): string {
  const rows = block.cells.map(row =>
    row.map(cell => (cell.text ? flattenRichText(cell.text) : '').replace(/\|/g, '\\|')),
  )
  if (rows.length === 0) return ''
  const colCount = Math.max(...rows.map(r => r.length))
  const pad = (r: string[]) => Array.from({ length: colCount }, (_, i) => r[i] ?? '')
  const header = `| ${pad(rows[0]).join(' | ')} |`
  const sep = `| ${pad(rows[0]).map(() => '---').join(' | ')} |`
  const body = rows.slice(1).map(r => `| ${pad(r).join(' | ')} |`)
  const caption = block.caption ? `\n\n${flattenRichText(block.caption)}` : ''
  return [header, sep, ...body].join('\n') + caption
}

export function flattenRichBlock(block: RichBlock): string {
  switch (block.type) {
    case 'paragraph': return flattenRichText(block.text)
    case 'heading': return `${'#'.repeat(block.size)} ${flattenRichText(block.text)}`
    case 'pre': return `\`\`\`${block.language ?? ''}\n${flattenRichText(block.text)}\n\`\`\``
    case 'footer': return flattenRichText(block.text)
    case 'divider': return '---'
    case 'mathematical_expression': return block.expression
    case 'anchor': return ''
    case 'list':
      return block.items
        .map(item => {
          const checkbox = item.has_checkbox ? (item.is_checked ? '[x] ' : '[ ] ') : ''
          const inner = item.blocks.map(flattenRichBlock).join('\n')
          return `${item.label} ${checkbox}${inner}`
        })
        .join('\n')
    case 'blockquote': {
      const inner = block.blocks.map(flattenRichBlock).join('\n')
      const quoted = inner.split('\n').map(l => `> ${l}`).join('\n')
      return block.credit ? `${quoted}\n> — ${flattenRichText(block.credit)}` : quoted
    }
    case 'expandable_blockquote': {
      const quoted = flattenRichText(block.text).split('\n').map(l => `> ${l}`).join('\n')
      return block.credit ? `${quoted}\n> — ${flattenRichText(block.credit)}` : quoted
    }
    case 'pullquote': {
      const credit = block.credit ? ` — ${flattenRichText(block.credit)}` : ''
      return `> ${flattenRichText(block.text)}${credit}`
    }
    case 'table': return flattenTable(block)
    case 'details': {
      const inner = block.blocks.map(flattenRichBlock).join('\n')
      return `<details><summary>${flattenRichText(block.summary)}</summary>\n\n${inner}\n\n</details>`
    }
    case 'collage':
    case 'slideshow': {
      const inner = block.blocks.map(flattenRichBlock).join('\n')
      const caption = block.caption ? `\n${flattenRichText(block.caption.text)}` : ''
      return inner + caption
    }
    case 'map': {
      const caption = block.caption ? `: ${flattenRichText(block.caption.text)}` : ''
      return `[map${caption}]`
    }
    case 'animation': return mediaPlaceholder('animation', block.caption)
    case 'audio': return mediaPlaceholder('audio', block.caption)
    case 'document': return mediaPlaceholder('document', block.caption)
    case 'photo': return mediaPlaceholder('photo', block.caption)
    case 'video': return mediaPlaceholder('video', block.caption)
    case 'voice_note': return mediaPlaceholder('voice note', block.caption)
    case 'buttons': return block.buttons.map(b => `[${flattenRichText(b.text)}]`).join(' ')
    case 'thinking': return flattenRichText(block.text)
    default: {
      // Unknown future block type: stay visible (a bare '[unknown block: X]'
      // marker) rather than silently vanishing like the original bug.
      const unknown = block as { type?: string }
      return `[unknown block: ${unknown.type ?? '?'}]`
    }
  }
}

export function flattenRichMessage(rich: RichMessage): string {
  return rich.blocks.map(flattenRichBlock).join('\n\n')
}
