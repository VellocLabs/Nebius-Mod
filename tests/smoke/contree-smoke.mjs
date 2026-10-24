// Live smoke test against a real Nebius Sandbox through contree-mcp and the
// plugin's own `run` normalization. Opt-in: skipped unless NEBIUS_API_KEY and
// NEBIUS_AI_PROJECT are set; needs `uvx`. Run: `npm run smoke`.
// Covers: a spaced local path → rsync → run from directory_state_id; env
// omitted / null / {}; a saving run's result image keeps a file; a disposable
// run leaves nothing for the next one.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { withRunEnv } from '../../hooks/sandbox/lanes.js'

const IMAGE = process.env.NEBIUS_SMOKE_IMAGE || 'tag:python:3.12'
const live = Boolean(process.env.NEBIUS_API_KEY && process.env.NEBIUS_AI_PROJECT)
const skip = live ? false : 'set NEBIUS_API_KEY and NEBIUS_AI_PROJECT to run the live sandbox smoke test'

/** A minimal MCP client over the server's stdio: newline-delimited JSON-RPC. */
function startServer() {
  const child = spawn('uvx', ['--with', 'mcp==1.*', 'contree-mcp'], {
    env: { ...process.env, CONTREE_NO_UPDATE_CHECK: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  })
  let buffer = ''
  let nextId = 1
  const pending = new Map()
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.on('data', chunk => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line)
      const waiter = pending.get(message.id)
      if (!waiter) continue
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
      else waiter.resolve(message.result)
    }
  })
  child.on('exit', code => {
    for (const waiter of pending.values()) waiter.reject(new Error(`contree-mcp exited (${code}): ${stderr.slice(-2000)}`))
    pending.clear()
  })
  const send = message => child.stdin.write(`${JSON.stringify(message)}\n`)
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })
  return {
    async initialize() {
      await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'nebius-smoke', version: '1' } })
      send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    },
    /** `tools/call` → `{ isError, data }`, `data` parsed from the text reply when it is JSON. */
    async call(tool, args) {
      const result = await request('tools/call', { name: tool, arguments: args })
      const text = (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
      let data = result.structuredContent?.result ?? result.structuredContent
      if (data === undefined) { try { data = JSON.parse(text) } catch { data = text } }
      return { isError: result.isError === true, text, data }
    },
    stop() { child.kill() },
  }
}

let server
let folder

before(async () => {
  if (!live) return
  folder = join(mkdtempSync(join(tmpdir(), 'nebius smoke ')), 'my project')
  mkdirSync(join(folder, 'pkg'), { recursive: true })
  writeFileSync(join(folder, 'pkg', '__init__.py'), '')
  writeFileSync(join(folder, 'pkg', 'main.py'), 'def greet(name):\n    return f"Hello, {name}!"\n')
  writeFileSync(join(folder, 'test_main.py'), 'import unittest\nfrom pkg.main import greet\n\nclass T(unittest.TestCase):\n    def test_greet(self):\n        self.assertEqual(greet("A"), "Hello, A!")\n')
  server = startServer()
  await server.initialize()
})

after(() => {
  server?.stop()
  if (folder) rmSync(join(folder, '..'), { recursive: true, force: true })
})

/** A `run` as the plugin sends it: env normalized at its boundary. */
const run = args => server.call('run', withRunEnv('run', { image: IMAGE, wait: true, ...args }))

test('a folder with spaces in its path syncs, and its tests run from the synced state', { skip }, async () => {
  const synced = await server.call('rsync', { source: folder, destination: '/app', exclude: ['__pycache__'] })
  assert.equal(synced.isError, false, synced.text)
  const stateId = Number(typeof synced.data === 'object' ? synced.data.result ?? synced.data : synced.data)
  assert.ok(Number.isInteger(stateId), `directory_state_id: ${synced.text}`)
  const ran = await run({ command: 'python -m unittest -v', cwd: '/app', directory_state_id: stateId })
  assert.equal(ran.isError, false, ran.text)
  assert.equal(ran.data.exit_code, 0, ran.text)
  assert.match(ran.data.stderr, /test_greet .* ok/)
})

test('run is accepted with env omitted, null or empty once normalized', { skip }, async () => {
  for (const env of [undefined, null, {}]) {
    const args = env === undefined ? { command: 'echo ok' } : { command: 'echo ok', env }
    const ran = await run(args)
    assert.equal(ran.isError, false, `env ${JSON.stringify(env)}: ${ran.text}`)
    assert.equal(ran.data.exit_code, 0, ran.text)
  }
})

test('a saving run keeps its file in the result image; a disposable run keeps nothing', { skip }, async () => {
  const saved = await run({ command: 'mkdir -p /work && echo kept > /work/marker', disposable: false })
  assert.equal(saved.isError, false, saved.text)
  const image = saved.data.result_image_uuid ?? saved.data.result?.image
  assert.ok(image, `a saving run names its result image: ${saved.text}`)
  const read = await run({ image, command: 'cat /work/marker' })
  assert.equal(read.data.stdout.trim(), 'kept', read.text)

  const thrown = await run({ command: 'mkdir -p /work && echo gone > /work/marker', disposable: true })
  assert.equal(thrown.data.result_image_uuid ?? null, null, 'a disposable run saves no image')
  const fresh = await run({ command: 'test ! -e /work/marker && echo absent' })
  assert.equal(fresh.data.stdout.trim(), 'absent', 'the base image never sees a disposable change')
})
