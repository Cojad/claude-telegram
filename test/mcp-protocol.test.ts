// Speaks real MCP over stdio to server.ts, the way Claude Code actually
// does — added after Stage B's outbound.ts extraction shipped with
// mcp.connect(new StdioServerTransport()) accidentally deleted by an
// imprecise find-and-replace. bun test's other suites (poller-lifecycle,
// policy, format) never touch the protocol layer at all, so that bug was
// invisible to them: the process started, logged normally, and both roles
// (poller and standby) behaved — the standby instance just silently
// exited seconds later because nothing was left consuming stdin to keep
// its event loop alive. Only a real client round-trip catches this class
// of bug, so one now runs on every `bun test`.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SERVER = join(import.meta.dir, '..', 'server.ts')
let dir: string
let client: Client

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tg-mcp-protocol-'))
  writeFileSync(join(dir, '.env'), 'TELEGRAM_BOT_TOKEN=123456789:AAHdummy_for_protocol_test\n')
  const transport = new StdioClientTransport({
    command: 'bun',
    args: [SERVER],
    env: { ...(process.env as Record<string, string>), TELEGRAM_STATE_DIR: dir },
    stderr: 'ignore',
  })
  client = new Client({ name: 'protocol-test', version: '0.0.0' }, { capabilities: {} })
  await client.connect(transport)
}, 15_000)

afterAll(async () => {
  await client?.close()
  rmSync(dir, { recursive: true, force: true })
})

test('tools/list returns exactly the six documented tools', async () => {
  const { tools } = await client.listTools()
  expect(tools.map(t => t.name).sort()).toEqual(
    ['download_attachment', 'edit_message', 'lookup_message', 'react', 'reply', 'send_sticker'].sort(),
  )
})

test('tools/call lookup_message on a non-allowlisted chat_id is rejected too', async () => {
  const result = await client.callTool({ name: 'lookup_message', arguments: { chat_id: '999999' } })
  expect(result.isError).toBe(true)
  expect(String((result.content as Array<{ text: string }>)[0].text)).toContain('not allowlisted')
})

test('tools/call routes through outbound.ts and surfaces assertAllowedChat as isError', async () => {
  const result = await client.callTool({
    name: 'react',
    arguments: { chat_id: '999999', message_id: '1', emoji: '👍' },
  })
  expect(result.isError).toBe(true)
  expect(String((result.content as Array<{ text: string }>)[0].text)).toContain('not allowlisted')
})

test('tools/call on an unknown tool name returns isError, not a crash', async () => {
  const result = await client.callTool({ name: 'not_a_real_tool', arguments: {} })
  expect(result.isError).toBe(true)
  expect(String((result.content as Array<{ text: string }>)[0].text)).toContain('unknown tool')
})
