// Pure text-formatting helpers with no Telegram/file-system dependencies —
// safe to import in tests without touching STATE_DIR, bot.pid, or the network.

import type { MessageRecord } from './store'

// A cut point that lands between a UTF-16 high and low surrogate (most
// emoji are two code units wide) would slice one character into two
// invalid lone surrogates. Back the cut off until it isn't — found by
// test/format.test.ts, not by inspection: a 10-char hard cut through
// 9 'A's + '😀' + 9 'B's split the emoji in half.
function backOffSurrogate(text: string, cut: number): number {
  while (cut > 0 && cut < text.length) {
    const before = text.charCodeAt(cut - 1)
    const isHighSurrogate = before >= 0xd800 && before <= 0xdbff
    if (!isHighSurrogate) break
    cut--
  }
  return cut
}

// Telegram caps messages at 4096 chars. Split long replies, preferring
// paragraph boundaries when chunkMode is 'newline'.
export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      // Prefer the last double-newline (paragraph), then single newline,
      // then space. Fall back to hard cut.
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    cut = backOffSurrogate(rest, cut)
    if (cut <= 0) cut = limit // pathological: nothing but surrogates up to the limit — cut anyway
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// GMT+8 (Asia/Taipei has no DST, so this is a fixed +8 year-round) —
// lookup_message results go straight to a person eventually (relayed to
// Telegram), and this plugin's ts is stored as UTC; showing raw UTC to a
// GMT+8 reader is the exact mistake this project's house rules call out.
// formatToParts, not toLocaleString: locale-dependent separators/AM-PM
// have bitten this codebase before, extracting parts sidesteps that.
function tsGmt8(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(iso))
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '??'
  return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
}

// lookup_message used to hand back pretty-printed JSON — correct, but ~10
// lines of braces/quotes/repeated-field-names per message, most of it
// punctuation. This is the same information (nothing dropped — file_ids
// and content are kept in full, never truncated, since a caller may need
// the exact file_id for download_attachment) in roughly one line of
// metadata plus the verbatim content, GMT+8 instead of raw UTC.
export function formatMessageRow(r: MessageRecord): string {
  const dir = r.direction === 'in' ? 'in ' : 'out'
  const who = r.direction === 'out' ? 'bot' : (r.user_id ?? '?')
  const meta: string[] = []
  if (!r.delivered) meta.push('undelivered')
  if (r.reply_to_message_id) meta.push(`reply→${r.reply_to_message_id}`)
  if (r.attachment_kind) {
    meta.push(r.attachment_file_id ? `📎${r.attachment_kind}:${r.attachment_file_id}` : `📎${r.attachment_kind}`)
  }
  const header = `#${r.message_id} ${dir} ${tsGmt8(r.ts)} ${who}${meta.length ? '  [' + meta.join(', ') + ']' : ''}`
  const body = r.content
  return body ? `${header}\n  ${body.replace(/\n/g, '\n  ')}` : header
}

export function formatMessageRows(rows: MessageRecord[]): string {
  if (rows.length === 0) return '(no messages)'
  return rows.map(formatMessageRow).join('\n\n')
}
