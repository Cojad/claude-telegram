// Access-control decisions — who gets to talk to Claude, and whether a
// group message counts as a mention. No Telegram network calls and no
// process/poller state here; file I/O is confined to readAccessFile()
// (an explicit path argument, not a module-level STATE_DIR), and gate() /
// dmCommandGate() take the loaded Access plus a `persist` callback instead
// of reading/writing a file themselves — tests pass an in-memory recorder,
// production wires it to the real writer in server.ts.

import { readFileSync, renameSync } from 'fs'

// Structural subset of grammY's Context — deliberately NOT `import type {
// Context} from 'grammy'`. gate()/isMentioned() only ever read these
// fields, and a real grammY Context satisfies this shape for free
// (structural typing), so the Bot API transport (transport.ts) needs no
// changes. What this buys: a second transport (mtproto.ts, GramJS) can
// feed the exact same gate()/handleInbound() pipeline by constructing one
// of these from a completely different SDK's event shape, without either
// transport depending on the other's library.
export type InboundEntity = { type: string; offset: number; length: number; user?: { is_bot?: boolean; username?: string } }
export type InboundContext = {
  from?: { id: number | string; username?: string }
  chat?: { id: number | string; type?: string }
  /** Set by mtproto.ts's transport; absent (not `false`) for the Bot API
   *  path — lets a message's meta say which channel actually delivered it,
   *  since both can now carry the same kind of traffic (Bot-to-Bot
   *  Communication Mode means the Bot API sees other bots' messages too,
   *  not just this listener). Cojad, 2026-09-15. */
  mtproto?: boolean
  message?: {
    message_id?: number
    date?: number
    text?: string
    caption?: string
    entities?: InboundEntity[]
    caption_entities?: InboundEntity[]
    reply_to_message?: { message_id: number; text?: string; caption?: string; from?: { id: number; username?: string } }
  }
}

export type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  // delivery/UX config — optional, defaults live in the reply handler
  /** Emoji to react with on receipt. Empty string disables. Telegram only accepts its fixed whitelist. */
  ackReaction?: string
  /** Which chunks get Telegram's reply reference when reply_to is passed. Default: 'first'. 'off' = never thread. */
  replyToMode?: 'off' | 'first' | 'all'
  /** Max chars per outbound message before splitting. Default: 4096 (Telegram's hard cap). */
  textChunkLimit?: number
  /** Split on paragraph boundaries instead of hard char count. */
  chunkMode?: 'length' | 'newline'
}

export function defaultAccess(): Access {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    pending: {},
  }
}

// Reads and normalizes access.json. A missing file is a fresh install
// (defaults, not an error); a corrupt one is moved aside so a bad hand-edit
// can't wedge the channel permanently.
export function readAccessFile(accessFile: string): Access {
  try {
    const raw = readFileSync(accessFile, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try {
      renameSync(accessFile, `${accessFile}.corrupt-${Date.now()}`)
    } catch {}
    process.stderr.write(`telegram channel: access.json is corrupt, moved aside. Starting fresh.\n`)
    return defaultAccess()
  }
}

export function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

export type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

// `persist` is called whenever this function mutates `access` (pruning,
// issuing/resending a pairing code) — the caller decides whether/how to
// write it back (a temp+rename to a real file in production, a no-op or a
// recorder in tests).
export function gate(
  ctx: InboundContext,
  access: Access,
  botUsername: string,
  persist: (a: Access) => void,
  newPairingCode: () => string,
): GateResult {
  const pruned = pruneExpired(access)
  if (pruned) persist(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const from = ctx.from
  if (!from) return { action: 'drop' }
  const senderId = String(from.id)
  const chatType = ctx.chat?.type

  if (chatType === 'private') {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    // pairing mode — check for existing non-expired code for this sender
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        // Reply twice max (initial + one reminder), then go silent.
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        persist(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    // Cap pending at 3. Extra attempts are silently dropped.
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    const code = newPairingCode()
    const now = Date.now()
    access.pending[code] = {
      senderId,
      chatId: String(ctx.chat!.id),
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000, // 1h
      replies: 1,
    }
    persist(access)
    return { action: 'pair', code, isResend: false }
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    const groupId = String(ctx.chat!.id)
    const policy = access.groups[groupId]
    if (!policy) return { action: 'drop' }
    const groupAllowFrom = policy.allowFrom ?? []
    const requireMention = policy.requireMention ?? true
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
      return { action: 'drop' }
    }
    if (requireMention && !isMentioned(ctx, botUsername, access.mentionPatterns)) {
      return { action: 'drop' }
    }
    return { action: 'deliver', access }
  }

  return { action: 'drop' }
}

export function dmCommandGate(
  ctx: InboundContext,
  access: Access,
  persist: (a: Access) => void,
): { access: Access; senderId: string } | null {
  if (ctx.chat?.type !== 'private') return null
  if (!ctx.from) return null
  const senderId = String(ctx.from.id)
  const pruned = pruneExpired(access)
  if (pruned) persist(access)
  if (access.dmPolicy === 'disabled') return null
  if (access.dmPolicy === 'allowlist' && !access.allowFrom.includes(senderId)) return null
  return { access, senderId }
}

// botUsername is passed explicitly (not read from module state) so this
// function has no dependency beyond its arguments — the bot's own username
// is only known once grammY has connected, so server.ts closes over the
// live value and passes it through on every call.
export function isMentioned(ctx: InboundContext, botUsername: string, extraPatterns?: string[]): boolean {
  const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? []
  const text = ctx.message?.text ?? ctx.message?.caption ?? ''
  for (const e of entities) {
    if (e.type === 'mention') {
      const mentioned = text.slice(e.offset, e.offset + e.length)
      if (mentioned.toLowerCase() === `@${botUsername}`.toLowerCase()) return true
    }
    if (e.type === 'text_mention' && e.user?.is_bot && e.user.username === botUsername) {
      return true
    }
  }

  // Reply to one of our messages counts as an implicit mention.
  if (ctx.message?.reply_to_message?.from?.username === botUsername) return true

  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(text)) return true
    } catch {
      // Invalid user-supplied regex — skip it.
    }
  }
  return false
}
