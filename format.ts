// Pure text-formatting helpers with no Telegram/file-system dependencies —
// safe to import in tests without touching STATE_DIR, bot.pid, or the network.

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
