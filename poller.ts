// Telegram long-poller lifecycle — who gets to hold bot.pid and call
// bot.start(). Deliberately decoupled from access control (./policy) and
// from message handling (server.ts's transport/inbound code): this module
// only ever answers "am I the one talking to Telegram's getUpdates right
// now", nothing about who's allowed to talk to *us*.
//
// Behavior (upstream PR #5604, cherry-picked into this fork, plus a local
// TELEGRAM_STANDBY_ONLY addition — see commit history): a live holder of
// bot.pid is never killed. A new instance either claims the free slot or
// stands by, polling the pid file every 2s to take over once the holder
// exits. TELEGRAM_STANDBY_ONLY=1 skips even that: the instance never
// touches the Telegram API at all, tools-only.

import { readFileSync, writeFileSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { GrammyError, type Bot } from 'grammy'

// The only grammY surface this module touches — kept narrow so a test can
// hand in a stand-in without constructing a real Bot.
export type PollerBot = Pick<Bot, 'stop' | 'start' | 'api'>

export interface PollerDeps {
  pidFile: string
  bot: PollerBot
  standbyOnly: boolean
  /** Called once bot.start()'s onStart fires with the live @username. */
  onUsername: (username: string) => void
}

export interface Poller {
  /** Try to claim the slot now (idempotent); call once at startup. */
  boot(): void
  /** Release the pid file if we own it, stop polling, exit the process. */
  shutdown(): void
  /** For the orphan watchdog / tests: true once shutdown() has run once. */
  isShuttingDown(): boolean
}

export function createPoller(deps: PollerDeps): Poller {
  const { pidFile, bot, standbyOnly, onUsername } = deps
  let shuttingDown = false
  let polling = false

  // PID liveness alone can't tell an incumbent poller from an unrelated
  // process that recycled its pid — check the process identity too.
  // /proc/<pid>/cmdline (Linux) needs no subprocess; ps covers macOS.
  function livePollerPid(): number | null {
    let holder: number
    try {
      holder = parseInt(readFileSync(pidFile, 'utf8'), 10)
    } catch { return null } // no pid file — slot is free
    if (!(holder > 1) || holder === process.pid) return null
    try {
      process.kill(holder, 0) // throws ESRCH once the process is gone
    } catch (err) {
      // EPERM = alive but owned by another user — never fight over the slot.
      return (err as NodeJS.ErrnoException).code === 'EPERM' ? holder : null
    }
    try {
      const cmdline = readFileSync(`/proc/${holder}/cmdline`, 'utf8')
      return cmdline.includes('server.ts') ? holder : null
    } catch {}
    try {
      const args = execFileSync('ps', ['-p', String(holder), '-o', 'args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      return args.includes('server.ts') ? holder : null
    } catch {
      // Identity unverifiable (Windows has no ps). Treat the slot as free
      // rather than deferring forever to an unknown pid; if it IS a live
      // poller, the 409 retry loop in startPolling reports the conflict
      // instead of us killing anything.
      return null
    }
  }

  function tryBecomePoller(): void {
    if (polling || shuttingDown) return
    const holder = livePollerPid()
    if (holder !== null) return // healthy incumbent — leave it alone
    writeFileSync(pidFile, String(process.pid))
    // Two standbys can race to claim; last writer owns the file, everyone
    // else re-reads, sees a different pid, and stays in standby.
    try {
      if (parseInt(readFileSync(pidFile, 'utf8'), 10) !== process.pid) return
    } catch { return }
    polling = true
    startPolling()
  }

  // Retry polling with backoff on any error. Previously only 409 was
  // retried — a single ETIMEDOUT/ECONNRESET/DNS failure rejected
  // bot.start(), the catch returned, and polling stopped permanently while
  // the process stayed alive (MCP stdin keeps it running). Outbound tools
  // kept working but the bot was deaf to inbound messages until a full
  // restart.
  function startPolling(): void {
    void (async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          await bot.start({
            onStart: info => {
              attempt = 0
              onUsername(info.username)
              process.stderr.write(`telegram channel: polling as @${info.username}\n`)
              void bot.api.setMyCommands(
                [
                  { command: 'start', description: 'Welcome and setup guide' },
                  { command: 'help', description: 'What this bot can do' },
                  { command: 'status', description: 'Check your pairing status' },
                ],
                { scope: { type: 'all_private_chats' } },
              ).catch(() => {})
            },
          })
          return // bot.stop() was called — clean exit from the loop
        } catch (err) {
          if (shuttingDown) return
          // bot.stop() mid-setup rejects with grammy's "Aborted delay" — expected, not an error.
          if (err instanceof Error && err.message === 'Aborted delay') return
          const is409 = err instanceof GrammyError && err.error_code === 409
          if (is409 && attempt >= 8) {
            process.stderr.write(
              `telegram channel: 409 Conflict persists after ${attempt} attempts — ` +
              `another poller is holding the bot token (stray 'bun server.ts' process or a second session). Exiting.\n`,
            )
            return
          }
          const delay = Math.min(1000 * attempt, 15000)
          const detail = is409
            ? `409 Conflict${attempt === 1 ? ' — another instance is polling (zombie session, or a second Claude Code running?)' : ''}`
            : `polling error: ${err}`
          process.stderr.write(`telegram channel: ${detail}, retrying in ${delay / 1000}s\n`)
          await new Promise(r => setTimeout(r, delay))
        }
      }
    })()
  }

  function boot(): void {
    if (standbyOnly) {
      process.stderr.write('telegram channel: TELEGRAM_STANDBY_ONLY=1 — never polling, outbound tools only\n')
      return
    }
    tryBecomePoller()
    if (!polling) {
      process.stderr.write(
        `telegram channel: another session's poller holds this channel — ` +
        `outbound tools active, standing by to take over inbound when it exits\n`,
      )
      const standbyWatcher = setInterval(() => {
        tryBecomePoller()
        if (polling || shuttingDown) clearInterval(standbyWatcher)
      }, 2000)
      standbyWatcher.unref()
    }
  }

  // the bot keeps polling forever as a zombie, holding the token and
  // blocking the next session with 409 Conflict.
  function shutdown(): void {
    if (shuttingDown) return
    shuttingDown = true
    process.stderr.write('telegram channel: shutting down\n')
    try {
      if (parseInt(readFileSync(pidFile, 'utf8'), 10) === process.pid) rmSync(pidFile, { force: true })
    } catch {}
    // bot.stop() signals the poll loop to end; the current getUpdates
    // request may take up to its long-poll timeout to return. Force-exit
    // after 2s.
    setTimeout(() => process.exit(0), 2000)
    void Promise.resolve(bot.stop()).finally(() => process.exit(0))
  }

  return { boot, shutdown, isShuttingDown: () => shuttingDown }
}
