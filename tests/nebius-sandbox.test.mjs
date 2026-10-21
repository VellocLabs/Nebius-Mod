// Unit tests for the Nebius sandbox part of the plugin: the pure lane,
// matrix, patch, text and view logic, and the session mod's hooks run against a
// hand-made `$` and a scripted contree server. No browser, no network. Run:
//   node --test tests/nebius-sandbox.test.mjs
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  advanceLane,
  createLane,
  describeLanes,
  dropLane,
  guardCall,
  MAIN_LOOP,
  parseReply,
  releaseOwner,
  resolveImage,
  resultImageOf,
  secretLikeEnvNames,
} from '../hooks/sandbox/lanes.js'
import { MAX_SHARDS, operationIdOf, outcomeOf, planMatrix, summarize } from '../hooks/sandbox/matrix.js'
import { patchCommand, shellQuote } from '../hooks/sandbox/patch.js'
import { candidateTags, fill, translator } from '../hooks/sandbox/texts.js'
import { normalizeOperations, paneTree } from '../hooks/sandbox/view.js'
import { migrateLanes, readGlobalLanes, writeLaneChanges } from '../hooks/sandbox/storage.js'
import { createFileBrowser, entriesOf, fileTree } from '../hooks/sandbox/files.js'
import { imageRows, createImageCatalog } from '../hooks/sandbox/images.js'
import { localTime, safeDetail } from '../hooks/sandbox/details.js'
import { taskOutcome, persistenceOf } from '../hooks/sandbox/tasks.js'
import { register } from '../hooks/sandbox.js'
import { isActive, missingPermissions, operationIdOf as opIdOf, replyOf, resultImageOf as imageOf, statusOf } from '../hooks/sandbox/replies.js'

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = path => JSON.parse(readFileSync(join(pluginDir, path), 'utf8'))
const manifest = readJson('.claude-plugin/plugin.json')
const EN = readJson('locales/en.json')
const ZH = readJson('locales/zh.json')
const t = translator([EN])

const NOW = 1_700_000_000_000
const laneTable = () => createLane({}, { name: 'auth', image: 'img-0', owner: null, now: NOW }).lanes

// ── lanes ──

test('resolveImage: a lane is its head, empty is the default image, anything else passes', () => {
  const lanes = laneTable()
  assert.deepEqual(resolveImage('lane:auth', lanes, 'tag:py'), { image: 'img-0', lane: 'auth' })
  assert.deepEqual(resolveImage(undefined, lanes, 'tag:py'), { image: 'tag:py' })
  assert.deepEqual(resolveImage('tag:node:22', lanes, 'tag:py'), { image: 'tag:node:22' })
  assert.match(resolveImage('lane:nope', lanes).error, /no lane "nope"; lanes: auth/)
  assert.match(resolveImage('', {}, '').error, /no default image/)
})

test('guardCall: run on a lane becomes its head; the default image fills an empty one', () => {
  const lanes = laneTable()
  assert.deepEqual(guardCall('run', { command: 'ls', image: 'lane:auth' }, { lanes, defaultImage: '' }), {
    args: { command: 'ls', image: 'img-0' },
    lane: 'auth',
  })
  assert.deepEqual(guardCall('run', { command: 'ls' }, { lanes, defaultImage: 'tag:py' }), { args: { command: 'ls', image: 'tag:py' } })
  assert.deepEqual(guardCall('read_file', { image: 'lane:auth', path: '/a' }, { lanes }), { args: { image: 'img-0', path: '/a' }, lane: 'auth' })
  assert.deepEqual(guardCall('set_tag', { image_uuid: 'lane:auth', tag: 'x' }, { lanes }), { args: { image_uuid: 'img-0', tag: 'x' } })
  assert.deepEqual(guardCall('list_images', { tag_prefix: 'py' }, { lanes }), { args: { tag_prefix: 'py' } })
})

test('guardCall: credentials in env are refused, a long timeout is cut', () => {
  const lanes = laneTable()
  const denied = guardCall('run', { command: 'x', image: 'i', env: { GITHUB_TOKEN: 'x', MODE: 'ci' } }, { lanes })
  assert.match(denied.deny, /^refused: GITHUB_TOKEN looks like a credential;/)
  assert.match(guardCall('run', { command: 'x', image: 'i', env: { API_KEY: 'x', DB_PASSWORD: 'y' } }, { lanes }).deny, /^refused: API_KEY, DB_PASSWORD look like credentials;/)
  assert.deepEqual(secretLikeEnvNames({ API_KEY: 1, aws_secret_access: 1, PATH: 1, PASSWORD: 1 }), ['API_KEY', 'aws_secret_access', 'PASSWORD'])
  assert.equal(guardCall('run', { command: 'x', image: 'i', timeout: 9999 }, { lanes, maxRunSeconds: 600 }).args.timeout, 600)
  assert.equal(guardCall('run', { command: 'x', image: 'i', timeout: 60 }, { lanes, maxRunSeconds: 600 }).args.timeout, 60)
})

test('guardCall: a save onto a lane must wait and must come from its owner', () => {
  let lanes = laneTable()
  assert.match(guardCall('run', { command: 'x', image: 'lane:auth', disposable: false, wait: false }, { lanes }).deny, /must wait/)
  assert.equal(guardCall('run', { command: 'x', image: 'lane:auth', disposable: false }, { lanes, agentId: 'a1' }).saves, true)
  lanes = advanceLane(lanes, 'auth', 'img-1', 'a1', NOW + 1)
  assert.equal(lanes.auth.owner, 'a1')
  assert.match(guardCall('run', { command: 'x', image: 'lane:auth', disposable: false }, { lanes, agentId: 'a2' }).deny, /belongs to agent a1/)
  assert.match(guardCall('run', { command: 'x', image: 'lane:auth', disposable: false }, { lanes }).deny, /belongs to agent a1/)
  assert.ok(guardCall('run', { command: 'x', image: 'lane:auth', disposable: true }, { lanes, agentId: 'a2' }).args, 'a throw-away run on any lane is fine')
})

test('lanes: advance keeps a short history; release frees an agent\'s lanes; drop forgets', () => {
  let lanes = laneTable()
  assert.equal(advanceLane(lanes, 'auth', 'img-0', 'a1', NOW), lanes, 'the same head changes nothing')
  for (let i = 1; i <= 25; i += 1) lanes = advanceLane(lanes, 'auth', `img-${i}`, undefined, NOW + i)
  assert.equal(lanes.auth.head, 'img-25')
  assert.equal(lanes.auth.history.length, 20)
  assert.equal(lanes.auth.owner, MAIN_LOOP)
  assert.equal(lanes.auth.runs, 25)
  const owned = advanceLane(laneTable(), 'auth', 'img-9', 'a7', NOW)
  const freed = releaseOwner(owned, 'a7', NOW + 5)
  assert.equal(freed.auth.owner, null)
  assert.equal(freed.auth.finishedBy, 'a7')
  assert.equal(releaseOwner(owned, 'other', NOW), owned)
  assert.deepEqual(dropLane(owned, 'auth'), {})
  assert.match(createLane(owned, { name: 'auth', image: 'i', now: NOW }).error, /exists/)
  assert.match(createLane({}, { name: 'bad name', image: 'i', now: NOW }).error, /not a lane name/)
  assert.match(describeLanes(freed), /auth: head img-9 .*free, finished by agent a7/)
  assert.match(describeLanes({}), /No lanes yet/)
})

test('replies: JSON text is read, a result image found under either spelling', () => {
  assert.deepEqual(parseReply(' {"exit_code":0} '), { exit_code: 0 })
  assert.equal(parseReply('42'), 42)
  assert.equal(parseReply('not json'), null)
  assert.equal(resultImageOf({ result_image: 'a' }), 'a')
  assert.equal(resultImageOf({ result_image_uuid: 'b' }), 'b')
  assert.equal(resultImageOf({ result_image: null }), null)
})

test('replies: real server shapes — structured content wrapped as { result }, status not state, the sentence an async run answers', () => {
  const op = { uuid: 'u1', status: 'SUCCESS', exit_code: 0, stdout: 'hi', result_image_uuid: null, result: { image: 'img-9' } }
  assert.deepEqual(replyOf({ structured: { result: op }, text: 'ignored' }), op)
  assert.deepEqual(replyOf({ text: JSON.stringify(op) }), op)
  assert.equal(replyOf({ structured: { result: 'Started operation 0f8fad5b-d9cb-469f-a165-70867728950e' } }), 'Started operation 0f8fad5b-d9cb-469f-a165-70867728950e')
  assert.equal(opIdOf('Started operation 0f8fad5b-d9cb-469f-a165-70867728950e; poll it'), '0f8fad5b-d9cb-469f-a165-70867728950e')
  assert.equal(imageOf(op), 'img-9')
  assert.equal(imageOf({ result_image_uuid: 'img-1', result: { image: 'img-2' } }), 'img-1')
  assert.equal(statusOf({ status: 'executing' }), 'EXECUTING')
  assert.equal(isActive({ status: 'EXECUTING' }), true)
  assert.equal(isActive({ status: 'ASSIGNED' }), true, 'a status that is not an end is still going')
  assert.equal(isActive({ status: 'FAILED' }), false)
  assert.equal(isActive({}), false)
  assert.equal(outcomeOf({ status: 'SUCCESS', exit_code: 0 }, { isStarted: true }), 'passed')
  assert.equal(outcomeOf({ status: 'SUCCESS', exit_code: 3 }, { isStarted: true }), 'failed')
  assert.equal(outcomeOf({ status: 'PENDING' }, { isStarted: true }), 'still running')
})

// ── matrix ──

test('planMatrix: strings and named shards, throw-away async runs with the shared options', () => {
  const plan = planMatrix({ shards: ['pytest a', { name: 'b', command: 'pytest b' }], cwd: '/app', directory_state_id: 7, timeout: 99 }, 'img')
  assert.deepEqual(plan.shards, [
    { name: 'shard-1', args: { command: 'pytest a', image: 'img', disposable: true, wait: false, directory_state_id: 7, cwd: '/app', timeout: 99 } },
    { name: 'b', args: { command: 'pytest b', image: 'img', disposable: true, wait: false, directory_state_id: 7, cwd: '/app', timeout: 99 } },
  ])
  assert.match(planMatrix({ shards: [] }, 'i').error, /at least one/)
  assert.match(planMatrix({ shards: Array(MAX_SHARDS + 1).fill('x') }, 'i').error, /at most 50/)
  assert.match(planMatrix({ shards: [{ name: 'a', command: 'x' }, { name: 'a', command: 'y' }] }, 'i').error, /two shards/)
  assert.match(planMatrix({ shards: [{ command: ' ' }] }, 'i').error, /no command/)
})

test('summarize: counts, one row per shard, the tails of those that did not pass', () => {
  const started = [
    { name: 'ok', command: 'true', operationId: 'op1' },
    { name: 'bad', command: 'false', operationId: 'op2' },
    { name: 'slow', command: 'sleep 9', operationId: 'op3' },
    { name: 'lost', command: 'x', error: 'server down' },
  ]
  const waited = {
    results: {
      op1: { state: 'SUCCESS', exit_code: 0, stdout: 'fine' },
      op2: { state: 'SUCCESS', exit_code: 1, stdout: 'E assert 1 == 2', stderr: 'trace' },
      op3: { state: 'SUCCESS', exit_code: 0, timed_out: true },
    },
    cancelled: [],
    timed_out: false,
  }
  const summary = summarize('img', started, waited)
  assert.equal(summary.passed, 1)
  assert.equal(summary.total, 4)
  assert.match(summary.text, /^Test matrix on img: 1\/4 passed \(3 did not: 1 failed, 1 timed out, 1 not started\)\./)
  assert.match(summary.text, /\| bad \| failed \| 1 \| op2 \|/)
  assert.match(summary.text, /### bad: failed\n\$ false\nstdout:\n```\nE assert 1 == 2\n```\nstderr:/)
  assert.match(summary.text, /### lost: not started\n\$ x\nserver down/)
  assert.doesNotMatch(summary.text, /### ok/)
  assert.equal(outcomeOf({ state: 'EXECUTING' }, { isStarted: true }), 'still running')
  assert.equal(outcomeOf(undefined, { isStarted: true, isCancelled: true }), 'cancelled')
  assert.equal(operationIdOf({ operation_id: 'op-9' }), 'op-9')
})

// ── patch ──

test('patchCommand: stages everything and diffs against a plain revision, every word quoted', () => {
  assert.equal(
    patchCommand("/app/it's", undefined).text,
    "git -C '/app/it'\\''s' add -A >/dev/null && git -C '/app/it'\\''s' -c core.quotepath=off diff --cached --binary 'HEAD'",
  )
  assert.match(patchCommand('/app', 'main~2').text, /--binary 'main~2'$/)
  assert.match(patchCommand('app', undefined).error, /absolute/)
  assert.match(patchCommand('/app', 'a;rm -rf /').error, /plain git revision/)
  assert.match(patchCommand('/app', 'a..b').error, /plain git revision/)
  assert.equal(shellQuote('a b'), "'a b'")
})

// ── texts ──

test('texts: the tag, its language, then English; placeholders filled; a missing key reads as itself', () => {
  assert.deepEqual(candidateTags('zh-CN'), ['zh-CN', 'zh', 'en'])
  assert.deepEqual(candidateTags(undefined), ['en'])
  const tr = translator([undefined, { a: '你好 {name}' }, { a: 'hi {name}', b: 'bye' }])
  assert.equal(tr('a', { name: 'x' }), '你好 x')
  assert.equal(tr('b'), 'bye')
  assert.equal(tr('c'), 'c')
  assert.equal(fill('{a}{b}', { a: 1 }), '1{b}')
})

test('locales: every language has every English key, and the same placeholders', () => {
  const files = readdirSync(join(pluginDir, 'locales'))
  assert.ok(files.includes('en.json') && files.includes('zh.json'))
  for (const file of files) {
    const table = readJson(`locales/${file}`)
    for (const [key, text] of Object.entries(EN)) {
      assert.equal(typeof table[key], 'string', `${file} lacks ${key}`)
      const holes = value => [...value.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
      assert.deepEqual(holes(table[key]), holes(text), `${file} ${key}`)
    }
  }
  assert.equal(typeof ZH['plugin.description'], 'string')
})

// ── view ──

const elements = {
  Box: props => ({ type: 'Box', props: { ...props, children: undefined }, children: props.children ?? [] }),
  Text: props => ({ type: 'Text', props: { ...props, children: undefined }, children: props.children ?? [] }),
  Code: props => ({ type: 'Code', props }),
  Svg: props => ({ type: 'Svg', props }),
  Select: ({ onSelect, ...props }) => { assert.equal(typeof onSelect, 'function'); return { type: 'Select', props, onSelect } },
  Input: ({ onInput, onSubmit, ...props }) => { assert.equal(typeof onSubmit, 'function'); return { type: 'Input', props, onInput, onSubmit } },
  Button: ({ onPress, children, ...props }) => {
    assert.equal(typeof onPress, 'function')
    assert.equal(typeof props.key, 'string')
    return { type: 'Button', props, children: children ?? [], onPress }
  },
}

function flatten(node, out = []) {
  if (typeof node === 'string') out.push(node)
  else if (node) {
    out.push(node)
    for (const child of node.children ?? []) flatten(child, out)
  }
  return out
}

const textsOf = tree => flatten(tree).filter(node => typeof node === 'string')
const buttonsOf = tree => flatten(tree).filter(node => node.type === 'Button')

test('view: operations newest first, tracked ones carry their lane', () => {
  const ops = normalizeOperations(
    { operations: [
      { uuid: 'op-old', kind: 'instance', state: 'success', created_at: '2026-01-01T00:00:00Z' },
      { uuid: 'op-new', kind: 'instance', state: 'EXECUTING', created_at: '2026-01-02T00:00:00Z' },
      { kind: 'no id' },
    ] },
    new Map([['op-new', { lane: 'auth' }]]),
  )
  assert.deepEqual(ops.map(op => [op.id, op.state, op.lane]), [['op-new', 'EXECUTING', 'auth'], ['op-old', 'SUCCESS', undefined]])
})

test('view: the pane lists the server, lanes and operations, with a button for each action', () => {
  const lanes = advanceLane(laneTable(), 'auth', 'img-123456789abcdef', 'agent-xyz-123456', NOW)
  const view = {
    mcp: { isConnected: true },
    lanes: Object.values(lanes),
    ops: [
      { id: 'op-1', kind: 'instance', state: 'EXECUTING', createdAt: NOW - 90_000, lane: 'auth' },
      { id: 'op-2', kind: 'instance', state: 'SUCCESS', createdAt: NOW - 7_200_000 },
    ],
    selectedLane: 'auth', section: 'lanes', showHistory: true,
    updatedAt: NOW - 5000,
    error: null,
  }
  const pressed = []
  const actions = { refresh: () => pressed.push('refresh'), reconnect() {}, cancel: id => pressed.push(`cancel ${id}`), selectLane: name => pressed.push(name), showSection() {}, selectSnapshot() {}, copyImage() {}, togglePanel() {} }
  const tree = paneTree(elements, view, t, actions, NOW)
  const texts = textsOf(tree)
  assert.ok(texts.some(text => text === 'Connected'))
  assert.ok(flatten(tree).some(node => node.type === 'Select' && node.props.options.some(option => option.value === 'img-123456789abcdef')))
  view.section = 'tasks'
  const history = paneTree(elements, view, t, { ...actions, clearHistory() {}, inspectOperation() {} }, NOW)
  const buttons = buttonsOf(history)
  assert.ok(buttons.some(b => b.props.key === 'cancel:op-1'))
  assert.ok(!buttons.some(b => b.props.key === 'cancel:op-2'))
  buttons.find(b => b.props.key === 'cancel:op-1').onPress()
  assert.deepEqual(pressed, ['cancel op-1'])
})

test('view: a server that is down says why and offers Reconnect; the status line is empty with nothing to tell', () => {
  const view = { mcp: { isConnected: false, reason: 'failed' }, lanes: [], ops: [], updatedAt: null, error: 'boom' }
  const tree = paneTree(elements, view, t, { refresh() {}, reconnect() {}, cancel() {}, drop() {} }, NOW)
  assert.ok(textsOf(tree).some(text => text === 'Connection issue'))
  assert.ok(textsOf(tree).includes('Last refresh failed: boom'))
  assert.ok(buttonsOf(tree).some(b => b.props.key === 'reconnect'))
})

test('replies: the permissions whoami says a key lacks, of those sandboxes need', () => {
  const none = { list: false, import: false, spawn: false, spawn_disposable: false, cancel: false, set_image_tag: false }
  assert.deepEqual(missingPermissions({ token_uuid: 'u', permissions: none }), ['list', 'spawn_disposable'])
  assert.deepEqual(missingPermissions({ permissions: { ...none, list: true, spawn_disposable: true } }), [])
  assert.deepEqual(missingPermissions({ permissions: { ...none, list: true, spawn: true } }), [], 'spawn covers a throw-away run')
  assert.deepEqual(missingPermissions({ token_uuid: 'u' }), [], 'no permissions stated: nothing known to be missing')
  assert.deepEqual(missingPermissions('text'), [])
})

test('view: a key without sandbox permissions says which are missing and offers Reconnect', () => {
  const view = { mcp: { isConnected: true, missing: ['list', 'spawn_disposable'] }, lanes: [], ops: [], updatedAt: null }
  const tree = paneTree(elements, view, t, { refresh() {}, reconnect() {}, cancel() {}, drop() {} }, NOW)
  assert.ok(textsOf(tree).some(text => text.includes('list, spawn_disposable')))
  assert.ok(!textsOf(tree).some(text => text === 'Connected'))
  assert.ok(buttonsOf(tree).some(b => b.props.key === 'reconnect'))
})

test('mod: a key without sandbox permissions is shown as such, and operations are not polled until it has them', async () => {
  let granted = false
  const calls = []
  const mod = loadMod({
    server: tool => {
      calls.push(tool)
      if (tool === 'whoami') return { token_uuid: 'u', permissions: { list: granted, spawn_disposable: granted } }
      if (tool === 'list_operations') return { operations: [] }
      return {}
    },
  })
  await mod.fire('session.start', {})
  await mod.settle()
  assert.deepEqual(mod.record.state.get('view').mcp.missing, ['list', 'spawn_disposable'])
  await mod.fire('command.run', { command: 'sandbox', args: '' })
  for (let i = 0; i < 10; i++) await mod.record.timers[0].fn()
  await mod.settle()
  assert.ok(!calls.includes('list_operations'), 'no polling while the key lacks permissions')
  granted = true
  for (let i = 0; i < 10; i++) await mod.record.timers[0].fn()
  await mod.settle()
  assert.equal(mod.record.state.get('view').mcp.missing, undefined)
  assert.ok(calls.includes('list_operations'))
})

test('view: a server that is up but refuses the key says so and offers Reconnect', () => {
  const view = { mcp: { isConnected: true, authError: 'Missing "Project" header' }, lanes: [], ops: [], updatedAt: null }
  const tree = paneTree(elements, view, t, { refresh() {}, reconnect() {}, cancel() {}, drop() {} }, NOW)
  assert.ok(textsOf(tree).includes('Missing "Project" header'))
  assert.ok(!textsOf(tree).some(text => text === 'Connected'))
  assert.ok(buttonsOf(tree).some(b => b.props.key === 'reconnect'))
})

test('mod: a whoami the API refuses marks the server refused, and the next refresh checks again', async () => {
  let refuse = true
  const mod = loadMod({ server: tool => (tool === 'whoami' && refuse ? new Error('401 Unauthorized') : tool === 'list_operations' ? { operations: [] } : {}) })
  await mod.fire('session.start', {})
  await mod.settle()
  assert.match(mod.record.state.get('view').mcp.authError, /401/)
  refuse = false
  await mod.fire('command.run', { command: 'sandbox', args: '' })
  for (let i = 0; i < 10; i++) await mod.record.timers[0].fn()
  await mod.settle()
  assert.equal(mod.record.state.get('view').mcp.authError, undefined)
  assert.equal(mod.record.state.get('view').mcp.isConnected, true)
})

// ── the mod, against a fake $ ──

function matches(matcher, e) {
  if (!matcher) return true
  return Object.entries(matcher).every(([key, want]) => (Array.isArray(want) ? want.includes(e[key]) : e[key] === want))
}

/**
 * The mod loaded with `options`, a fake `$` and a scripted contree server.
 * `server(tool, args)` answers each `$.mcp.call` with the reply object (sent as
 * JSON text) or throws.
 */
function loadMod({ options = {}, server = () => ({}), store = new Map(), locale = 'en' } = {}) {
  const hooks = []
  register((event, matcherOrFn, maybeFn) => {
    const fn = typeof matcherOrFn === 'function' ? matcherOrFn : maybeFn
    const matcher = typeof matcherOrFn === 'function' ? undefined : matcherOrFn
    hooks.push({ event, matcher, fn })
  }, Object.freeze(options))
  const calls = []
  const record = { tools: [], commands: [], status: [], toasts: [], opened: [], timers: [], state: new Map() }
  const $ = {
    plugin: Object.freeze({ name: 'nebius', root: pluginDir, locale }),
    fs: {
      read: async path => readFileSync(path, 'utf8'),
      write: async (path, text) => record.written = { path, text },
    },
    session: { id: async () => 'session-1' },
    store: {
      get: async key => store.get(key),
      set: async (key, value) => void store.set(key, JSON.parse(JSON.stringify(value))),
      delete: async key => void store.delete(key),
      keys: async () => [...store.keys()],
    },
    state: {
      get: async ref => ({ value: record.state.get(ref.key), version: 1 }),
      set: async (ref, value) => (record.state.set(ref.key, JSON.parse(JSON.stringify(value))), { isSet: true, version: 2 }),
    },
    ui: {
      status: async text => void record.status.push(text),
      toast: async text => void record.toasts.push(text),
      log: async () => {},
      open: async pane => (record.opened.push(pane), { isPlaced: true }),
      resolve: () => elements,
    },
    tool: { register: async spec => (record.tools.push(spec), { tool: `mcp__nebius__${spec.name}` }) },
    command: { register: async spec => void record.commands.push(spec) },
    clock: { every: (ms, fn) => (record.timers.push({ ms, fn }), { cancel() {} }) },
    mcp: {
      connect: async server => ({ isConnected: true, server }),
      call: async (serverName, tool, args) => {
        assert.equal(serverName, 'contree')
        calls.push({ tool, args })
        const reply = await server(tool, args)
        if (reply instanceof Error) return { content: [{ type: 'text', text: reply.message }], isError: true }
        const text = typeof reply === 'string' ? reply : JSON.stringify(reply)
        return { content: [{ type: 'text', text }], structuredContent: { result: reply }, isError: false }
      },
    },
  }
  const fire = async (event, e, core = async () => ({})) => {
    const chain = hooks.filter(hook => hook.event === event && matches(hook.matcher, e))
    const run = (index, value) => (index < chain.length ? chain[index].fn($, value, next => run(index + 1, next)) : core(value))
    return run(0, e)
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  return { hooks, fire, $, calls, record, store, settle }
}

test('mod: session.start registers the six tools and /sandbox, starts one poller, reads its texts', async () => {
  const mod = loadMod({ locale: 'zh-CN' })
  await mod.fire('session.start', { locale: 'zh-CN' })
  assert.deepEqual(mod.record.tools.map(spec => spec.name), [
    'sandbox_lanes', 'sandbox_lane_new', 'sandbox_lane_release', 'sandbox_lane_drop', 'sandbox_lane_patch', 'sandbox_test_matrix',
  ])
  for (const spec of mod.record.tools) {
    assert.equal(spec.inputSchema.type, 'object')
    assert.ok(spec.description.length > 20)
  }
  assert.deepEqual(mod.record.commands, [{ name: 'sandbox', description: '打开 Nebius 沙箱面板', argumentHint: '[lanes]' }])
  assert.equal(mod.record.timers.length, 1)
  assert.equal(mod.hooks.some(hook => hook.event === 'tool.check'), false, 'nothing is approved unless the option says so')
})

test('mod: a lane whose base image cannot be looked up is refused with the reason the server gave', async () => {
  const mod = loadMod({ server: tool => (tool === 'get_image' ? new Error('HTTP 403: Insufficient permissions: list and spawn') : {}) })
  await mod.fire('session.start', {})
  const made = await mod.fire('tool.call', { tool: 'mcp__nebius__sandbox_lane_new', tool_use_id: 't', name: 'demo', from: 'tag:python:3.12' })
  assert.equal(made.deny, 'could not look up image tag:python:3.12: HTTP 403: Insufficient permissions: list and spawn')
  assert.deepEqual(mod.record.state.get('view')?.lanes ?? [], [])
})

test('mod: a saving run on a lane runs on its head, moves the head and tells the model', async () => {
  const mod = loadMod({ options: { default_image: 'tag:py' }, server: tool => (tool === 'get_image' ? { uuid: 'img-base' } : {}) })
  await mod.fire('session.start', {})
  const made = await mod.fire('tool.call', { tool: 'mcp__nebius__sandbox_lane_new', tool_use_id: 't1', name: 'auth' })
  assert.match(made.result, /Lane auth starts at img-base/)
  assert.deepEqual(mod.calls.find(call => call.tool === 'get_image'), { tool: 'get_image', args: { image: 'tag:py' } })

  let ranWith
  const ran = await mod.fire(
    'tool.call',
    { tool: 'mcp__contree__run', tool_use_id: 't2', agentId: 'a1', command: 'make', image: 'lane:auth', disposable: false },
    async e => ((ranWith = e), { ref: 1, result: 'raw', text: JSON.stringify({ uuid: 'op', status: 'SUCCESS', exit_code: 0, result_image_uuid: 'img-1', result: { image: 'img-1' } }) }),
  )
  assert.equal(ranWith.image, 'img-base')
  assert.deepEqual(ran.context, ['Lane auth now ends at img-1; keep using image "lane:auth".'])
  assert.equal(ran.ref, 1, 'the run\'s own result is kept')
  const saved = mod.store.get('global-lane/auth')
  assert.equal(saved.head, 'img-1')
  assert.equal(saved.owner, 'a1')

  const other = await mod.fire('tool.call', { tool: 'mcp__contree__run', tool_use_id: 't3', agentId: 'a2', command: 'x', image: 'lane:auth', disposable: false })
  assert.match(other.deny, /belongs to agent a1/)
  await mod.fire('classic.SubagentStop', { agent_id: 'a1' })
  assert.equal(mod.store.get('global-lane/auth').owner, null)
})

test('mod: a refused call never reaches the server; other tools pass through untouched', async () => {
  const mod = loadMod()
  await mod.fire('session.start', {})
  let reached = false
  const denied = await mod.fire('tool.call', { tool: 'mcp__contree__run', tool_use_id: 't', command: 'x', image: 'i', env: { NPM_TOKEN: 'x' } }, async () => {
    reached = true
    return {}
  })
  assert.match(denied.deny, /NPM_TOKEN/)
  assert.equal(reached, false)
  const passed = await mod.fire('tool.call', { tool: 'mcp__contree__rsync', tool_use_id: 't', source: '/p', destination: '/app' }, async e => ({ ref: 2, text: '42', e }))
  assert.equal(passed.ref, 2)
  assert.equal(passed.e.source, '/p')
})

test('mod: an async run is tracked for the pane until it ends', async () => {
  let state = 'EXECUTING'
  const mod = loadMod({ server: tool => (tool === 'list_operations' ? { operations: [{ uuid: '7d444840-9dc0-11d1-b245-5ffdce74fad2', kind: 'instance', status: state, created_at: '2026-10-16T00:00:00Z' }] } : {}) })
  await mod.fire('session.start', {})
  await mod.fire('tool.call', { tool: 'mcp__contree__run', tool_use_id: 't', command: 'x', image: 'i', wait: false }, async () => ({ ref: 1, text: 'Operation 7d444840-9dc0-11d1-b245-5ffdce74fad2 started' }))
  await mod.settle()
  assert.equal(mod.record.state.get('view').ops[0].id, '7d444840-9dc0-11d1-b245-5ffdce74fad2')
  assert.equal(mod.record.status.at(-1), undefined)
  state = 'SUCCESS'
  await mod.record.timers[0].fn()
  await mod.settle()
  assert.equal(mod.record.status.at(-1), undefined, 'nothing running and no lanes: the status line clears')
})

test('mod: the test matrix starts every shard, waits for them and answers one summary', async () => {
  let n = 0
  const mod = loadMod({
    options: { max_run_seconds: 600 },
    server: (tool, args) => {
      if (tool === 'run') return `Operation started: 00000000-0000-4000-8000-00000000000${++n}`
      if (tool === 'wait_operations') {
        return {
          results: Object.fromEntries(args.operation_ids.map(id => [id, id.endsWith('2') ? { status: 'SUCCESS', exit_code: 2, stdout: 'FAILED test_b' } : { status: 'SUCCESS', exit_code: 0 }])),
          completed: args.operation_ids,
          cancelled: [],
          timed_out: false,
        }
      }
      return { operations: [] }
    },
  })
  await mod.fire('session.start', {})
  const answer = await mod.fire('tool.call', {
    tool: 'mcp__nebius__sandbox_test_matrix',
    tool_use_id: 't',
    image: 'img',
    timeout: 5000,
    shards: ['pytest a', 'pytest b', 'pytest c'],
  })
  const runs = mod.calls.filter(call => call.tool === 'run')
  assert.equal(runs.length, 3)
  assert.deepEqual(runs[0].args, { command: 'pytest a', image: 'img', disposable: true, wait: false, timeout: 600 })
  const wait = mod.calls.find(call => call.tool === 'wait_operations')
  assert.deepEqual(wait.args, { operation_ids: [1, 2, 3].map(i => `00000000-0000-4000-8000-00000000000${i}`), mode: 'all', timeout: 240 })
  assert.match(answer.result, /^Test matrix on img: 2\/3 passed/)
  assert.match(answer.result, /### shard-2: failed\n\$ pytest b\nstdout:\n```\nFAILED test_b/)
  const refused = await mod.fire('tool.call', { tool: 'mcp__nebius__sandbox_test_matrix', tool_use_id: 't', image: 'img', env: { API_KEY: 'x' }, shards: ['x'] })
  assert.match(refused.deny, /API_KEY/)
})

test('mod: a lane\'s patch is answered inline, or written to the file asked for', async () => {
  const patch = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n'
  const mod = loadMod({ server: tool => (tool === 'get_image' ? { uuid: 'img-0' } : tool === 'run' ? { exit_code: 0, stdout: patch } : {}) })
  await mod.fire('session.start', {})
  await mod.fire('tool.call', { tool: 'mcp__nebius__sandbox_lane_new', tool_use_id: 't', name: 'ui', from: 'img-0' })
  const inline = await mod.fire('tool.call', { tool: 'mcp__nebius__sandbox_lane_patch', tool_use_id: 't', name: 'ui', path: '/app' })
  assert.equal(inline.result, patch)
  const run = mod.calls.findLast(call => call.tool === 'run')
  assert.equal(run.args.image, 'img-0')
  assert.equal(run.args.disposable, true)
  const written = await mod.fire('tool.call', { tool: 'mcp__nebius__sandbox_lane_patch', tool_use_id: 't', name: 'ui', path: '/app', out: '.sandbox/ui.patch' })
  assert.match(written.result, /Wrote the patch of lane ui \(1 files, \d+ bytes\) to \.sandbox\/ui\.patch/)
  assert.deepEqual(mod.record.written, { path: '.sandbox/ui.patch', text: patch })
  const missing = await mod.fire('tool.call', { tool: 'mcp__nebius__sandbox_lane_patch', tool_use_id: 't', name: 'nope', path: '/app' })
  assert.match(missing.deny, /no lane "nope"/)
})

test('mod: lanes survive a new session start of the same session; stale sessions\' lanes are pruned', async () => {
  const store = new Map([
    ['lanes/session-1', { updatedAt: Date.now(), lanes: laneTable() }],
    ['lanes/old', { updatedAt: Date.now() - 40 * 24 * 3600 * 1000, lanes: {} }],
    ['other', 1],
  ])
  const mod = loadMod({ store })
  await mod.fire('session.start', {})
  const listed = await mod.fire('tool.call', { tool: 'mcp__nebius__sandbox_lanes', tool_use_id: 't' })
  assert.match(listed.result, /- auth: head img-0/)
  assert.ok(store.has('global-lane/auth'))
  assert.ok(store.has('lanes/old'), 'legacy metadata is retained, not silently pruned')
})

test('mod: with auto-approve, a remote-only tool\'s ask becomes allow; a deny stands; local-file tools still ask', async () => {
  const mod = loadMod({ options: { auto_approve_remote: true } })
  const ask = async () => ({ decision: 'ask' })
  assert.equal((await mod.fire('tool.check', { tool: 'mcp__contree__run', input: {} }, ask)).decision, 'allow')
  assert.equal((await mod.fire('tool.check', { tool: 'mcp__nebius__sandbox_test_matrix', input: {} }, ask)).decision, 'allow')
  assert.equal((await mod.fire('tool.check', { tool: 'mcp__contree__run', input: {} }, async () => ({ decision: 'deny', reason: 'rule' }))).decision, 'deny')
  for (const tool of ['mcp__contree__rsync', 'mcp__contree__upload', 'mcp__contree__download', 'mcp__nebius__sandbox_lane_patch']) {
    assert.equal((await mod.fire('tool.check', { tool, input: {} }, ask)).decision, 'ask', tool)
  }
})

test('mod: /sandbox opens the pane, /sandbox lanes prints them; the pane draws only its own id', async () => {
  const mod = loadMod({ server: () => ({ operations: [] }) })
  await mod.fire('session.start', {})
  assert.deepEqual(await mod.fire('command.run', { command: 'sandbox', args: '' }), {})
  assert.deepEqual(mod.record.opened, [{ id: 'sandbox', title: 'Sandbox', focus: true }])
  const lanes = await mod.fire('command.run', { command: 'sandbox', args: ' lanes ' })
  assert.match(lanes.text, /^Lanes:\nNo lanes yet/)
  await mod.settle()
  const tree = await mod.fire('ui.render', { surface: 'desktop', component: 'Pane', requestId: 'sandbox', props: {} })
  assert.equal(tree.type, 'Box')
  assert.ok(textsOf(tree).some(text => text === 'Connected'))
  const theirs = await mod.fire('ui.render', { surface: 'desktop', component: 'Pane', requestId: 'diff', props: {} }, async () => 'engine')
  assert.equal(theirs, 'engine')
})

// ── lazy sidebar ──

test('file browser: lazy reads, reload on expansion, head invalidation and stale replies', async () => {
  const calls = []
  let release
  const browser = createFileBrowser(async (image, path) => {
    calls.push([image, path])
    if (path === '/slow') return new Promise(resolve => { release = resolve })
    return { files: [{ name: 'src', type: 'directory' }, { name: 'a.txt', type: 'file', size: 7 }] }
  }, async () => {})
  await browser.select('a', 'image-a')
  assert.deepEqual(calls, [['image-a', '/']])
  await browser.toggle('/src')
  await browser.toggle('/src')
  await browser.toggle('/src')
  assert.equal(calls.filter(([, path]) => path === '/src').length, 2)
  const slow = browser.toggle('/slow')
  await new Promise(resolve => setTimeout(resolve, 0))
  await browser.select('b', 'image-b')
  release({ files: [{ name: 'wrong', type: 'file' }] })
  await slow
  assert.equal(browser.snapshot().dirs['/slow'], undefined)
  assert.equal(browser.snapshot().image, 'image-b')
  await browser.select('b', 'image-b2')
  assert.deepEqual(calls.at(-1), ['image-b2', '/'])
  assert.deepEqual(entriesOf({ files: [{ name: '..' }, { name: 'a/b' }, { name: 'valid', type: 'file', size: 10 }] }, '/src'), [{ name: 'valid', path: '/src/valid', type: 'file', size: 10, target: undefined }])
})

test('sidebar: auto opens without stealing focus, selects lane, renders lazy tree and persists count', async () => {
  const store = new Map()
  const mod = loadMod({ store, server: (tool, args) => {
    if (tool === 'whoami') return { limits: { instance_max_concurrency: 12 }, operations_stat: { running_instances: 2 } }
    if (tool === 'get_image') return { uuid: args.image }
    if (tool === 'list_files') return { files: args.path === '/' ? [{ name: 'src', type: 'directory' }] : [{ name: 'main.py', type: 'file', size: 123 }] }
    return { operations: [] }
  } })
  await mod.fire('session.start', {})
  await mod.settle()
  assert.equal(mod.record.opened.length, 0)
  await mod.fire('tool.call', { tool: 'mcp__nebius__sandbox_lane_new', tool_use_id: 'new', name: 'demo', from: 'image-demo' })
  await mod.settle()
  assert.deepEqual(mod.record.opened, [{ id: 'sandbox', title: 'Sandbox' }])
  assert.equal(mod.record.state.get('view').selectedLane, 'demo')
  assert.equal(mod.record.state.get('view').totalCalls, 1)
  let tree = await mod.fire('ui.render', { component: 'Pane', requestId: 'sandbox' })
  await buttonsOf(tree).find(b => b.props.key === 'section:lanes').onPress()
  tree = await mod.fire('ui.render', { component: 'Pane', requestId: 'sandbox' })
  assert.ok(flatten(tree).some(node => node.type === 'Select' && node.props.value === 'demo'))
  await buttonsOf(tree).find(button => button.props.key === 'file:/src').onPress()
  tree = await mod.fire('ui.render', { component: 'Pane', requestId: 'sandbox' })
  assert.ok(buttonsOf(tree).some(button => button.props.key === 'file:/src/main.py'))
  assert.equal(mod.record.state.get('view').totalCalls, 1, 'browser MCP reads do not inflate user tool count')
  assert.equal(store.get('monitor/session-1').totalCalls, 1)
  assert.equal(mod.hooks.some(hook => hook.matcher?.component === 'AbovePrompt'), false)
  const restored = loadMod({ store })
  await restored.fire('session.start', {})
  assert.equal(restored.record.state.get('view').totalCalls, 1)
})

test('sidebar: overlapping tools remain visible independently and errors are not success', async () => {
  const mod = loadMod()
  await mod.fire('session.start', {})
  let release
  const first = mod.fire('tool.call', { tool: 'mcp__contree__run', tool_use_id: 'first', image: 'image' }, () => new Promise(resolve => { release = resolve }))
  await mod.settle()
  await mod.fire('tool.call', { tool: 'mcp__contree__list_images', tool_use_id: 'second' }, async () => ({ result: { content: [{ type: 'text', text: 'failed' }], isError: true } }))
  assert.equal(mod.record.state.get('view').calls.length, 1)
  assert.equal(mod.record.state.get('view').lastCall.failed, true)
  release({ result: { structuredContent: { result: { status: 'SUCCESS', exit_code: 1, duration: 3, consumed_cpu: 2, consumed_memory: 100 } } } })
  await first
  assert.equal(mod.record.state.get('view').calls.length, 0)
  assert.equal(mod.record.state.get('view').lastCall.cpu, 2)
  assert.equal(mod.record.state.get('view').lastCall.failed, true)
})

test('directory retries once on 500, preserves cached files, offers manual retry; no retry on 404', async () => {
  let failing = false, requests = 0, waits = 0
  const browser = createFileBrowser(async () => {
    requests++
    if (failing) throw new Error('HTTP 500: Internal Server Error')
    return { files: [{ name: 'saved.txt', type: 'file', size: 12 }] }
  }, async () => {}, { sleep: async () => { waits++ } })
  await browser.select('x', 'img')
  failing = true
  await browser.refresh()
  assert.equal(requests, 3)
  assert.equal(waits, 1)
  assert.equal(browser.snapshot().dirs['/'].entries[0].name, 'saved.txt')
  let retried
  const tree = fileTree(elements, browser.snapshot(), t, { refreshFiles() {}, retryDirectory: path => { retried = path } })
  await buttonsOf(tree).find(button => button.props.key === 'retry:/').onPress()
  assert.equal(retried, '/')
  failing = false
  await browser.retry('/')
  assert.equal(browser.snapshot().dirs['/'].error, null)
  let notFound = 0
  const missing = createFileBrowser(async () => { notFound++; throw new Error('HTTP 404: missing') }, async () => {}, { sleep: async () => assert.fail('must not retry') })
  await missing.select('x', 'img')
  assert.equal(notFound, 1)
})

test('global lanes migrate all sessions, preserve conflicts, and do not resurrect dropped records', async () => {
  const data = new Map([
    ['lanes/old-a', { lanes: laneTable() }],
    ['lanes/old-b', { lanes: { auth: { ...laneTable().auth, head: 'different' } } }],
  ])
  const store = { keys: async () => [...data.keys()], get: async key => data.get(key), set: async (key, value) => { data.set(key, value) }, delete: async key => data.delete(key) }
  const lanes = await migrateLanes(store)
  assert.equal(lanes.auth.head, 'img-0')
  assert.equal(lanes['auth-import-1'].head, 'different')
  await writeLaneChanges(store, lanes, { 'auth-import-1': lanes['auth-import-1'] })
  assert.equal((await migrateLanes(store)).auth, undefined)
  await writeLaneChanges(store, {}, { fresh: { name: 'fresh', head: 'new' } })
  assert.equal(Object.keys(await readGlobalLanes(store)).length, 2)
  const modA = loadMod({ store: data })
  const modB = loadMod({ store: data })
  modB.$.session.id = async () => 'other-session'
  await modA.fire('session.start', {})
  await modB.fire('session.start', {})
  assert.deepEqual(modA.record.state.get('view').lanes, modB.record.state.get('view').lanes)
})

test('images: deduplicate snapshots, discover unbound saved results, paginate and retain on failure', async () => {
  const rows = imageRows([{ uuid: 'base', tag: 'python' }], [{ uuid: 'op', result_image_uuid: 'saved' }], [{ name: 'home', head: 'saved', history: ['base', 'saved'] }])
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.find(row => row.uuid === 'saved').heads, ['home'])
  let snapshot, fail = false
  const requests = []
  const catalog = createImageCatalog(async (tool, args) => {
    requests.push([tool, args])
    if (fail) throw new Error('HTTP 500')
    if (tool === 'list_operations') return { operations: [{ uuid: 'old', result_image_uuid: 'unbound' }] }
    return { images: args.offset === 0 ? Array.from({ length: 50 }, (_, i) => ({ uuid: `base-${i}` })) : [] }
  }, async value => { snapshot = value })
  await catalog.fetch(true)
  assert.ok(snapshot.rows.some(row => row.uuid === 'unbound'))
  await catalog.fetch(false)
  assert.equal(requests.at(-1)[1].offset, 50)
  assert.equal(snapshot.more, false)
  fail = true
  await catalog.fetch(true)
  assert.ok(snapshot.rows.some(row => row.uuid === 'unbound'))
  assert.match(snapshot.error, /500/)
})

test('load more images adds ten distinct matches across filtered pages and handles the remainder', async () => {
  const data = [
    ...Array.from({ length: 50 }, (_, i) => ({ uuid: `base-${i}` })),
    { uuid: 'saved-0', operation_uuid: 'op-0', tag: 'target' },
    { uuid: 'saved-0', operation_uuid: 'op-0', tag: 'target' },
    ...Array.from({ length: 12 }, (_, i) => [
      { uuid: `other-${i}`, operation_uuid: `other-op-${i}`, tag: 'excluded' },
      { uuid: `saved-${i + 1}`, operation_uuid: `op-${i + 1}`, tag: 'target' },
    ]).flat(),
  ]
  let snapshot
  const requests = []
  const catalog = createImageCatalog(async (tool, args) => {
    if (tool === 'list_operations') return { operations: [] }
    requests.push(args)
    return { images: data.slice(args.offset, args.offset + args.limit) }
  }, async value => { snapshot = value })
  await catalog.fetch(true)
  await catalog.fetch(false, { filter: 'saved', query: 'TARGET' })
  assert.equal(snapshot.rows.filter(row => row.tag === 'target').length, 10)
  assert.ok(requests.length > 2, 'continues past duplicates and filtered-out rows')
  assert.equal(snapshot.more, true)
  await catalog.fetch(false, { filter: 'saved', query: 'target' })
  assert.equal(snapshot.rows.filter(row => row.tag === 'target').length, 13)
  assert.equal(snapshot.more, false)
  assert.equal(snapshot.error, null)
})

test('sidebar: image tab browses unbound result without changing lane head', async () => {
  const store = new Map([['global-lane/auth', laneTable().auth]])
  const mod = loadMod({ store, server: (tool, args) => {
    if (tool === 'list_images') return { images: [{ uuid: 'base', tag: 'python' }] }
    if (tool === 'list_operations') return { operations: [{ uuid: 'op', result_image_uuid: 'saved-unbound' }] }
    if (tool === 'list_files') return { files: [{ name: 'bigfile.bin', type: 'file', size: 1073741824 }] }
    return {}
  } })
  await mod.fire('session.start', {})
  let tree = await mod.fire('ui.render', { component: 'Pane', requestId: 'sandbox' })
  await buttonsOf(tree).find(b => b.props.key === 'section:images').onPress()
  tree = await mod.fire('ui.render', { component: 'Pane', requestId: 'sandbox' })
  await buttonsOf(tree).find(b => b.props.key === 'image:saved-unbound').onPress()
  assert.equal(mod.record.state.get('view').browser.image, 'saved-unbound')
  assert.equal(store.get('global-lane/auth').head, 'img-0')
  tree = await mod.fire('ui.render', { component: 'Pane', requestId: 'sandbox' })
  assert.ok(buttonsOf(tree).some(b => b.props.key === 'file:/bigfile.bin'))
  await buttonsOf(tree).find(b => b.props.key === 'section:lanes').onPress()
  assert.equal(mod.record.state.get('view').browser.image, 'img-0')
})

test('compact pane: resources/history folded by default; SVG files and functional controls', async () => {
  const mod = loadMod({ store: new Map([['global-lane/auth', laneTable().auth]]), server: tool => tool === 'list_files' ? { files: [{ name: 'main.py', type: 'file', size: 2048 }, { name: 'src', type: 'directory' }] } : { operations: [] } })
  mod.$.ui.copy = async ({ text }) => { mod.record.copied = text; return { isCopied: true } }
  await mod.fire('session.start', {})
  await mod.fire('command.run', { command: 'sandbox', args: '' })
  await mod.settle()
  await mod.fire('tool.call', { tool: 'mcp__contree__run', image: 'lane:auth' }, async () => ({ result: { duration: 0.4, consumed_cpu: 0.02, consumed_memory: 100, exit_code: 0 } }))
  let tree = await mod.fire('ui.render', { component: 'Pane', requestId: 'sandbox' })
  await buttonsOf(tree).find(b => b.props.key === 'section:lanes').onPress()
  tree = await mod.fire('ui.render', { component: 'Pane', requestId: 'sandbox' })
  assert.ok(!textsOf(tree).some(text => text.includes('consumed_memory')))
  const icons = flatten(tree).filter(node => node.type === 'Svg')
  assert.equal(icons.length, 2)
  assert.ok(icons.every(node => node.props.width === 16 && node.props.source.startsWith('<svg')))
  assert.ok(icons.every(node => !/<script|https?:\/\/(?!www.w3.org)/.test(node.props.source)))
  await buttonsOf(tree).find(b => b.props.key === 'copy-image').onPress()
  assert.equal(mod.record.copied, 'img-0')
  assert.ok(!buttonsOf(tree).some(b => b.props.key === 'toggle-details'))
  await buttonsOf(tree).find(b => b.props.key === 'section:tasks').onPress()
  tree = await mod.fire('ui.render', { component: 'Pane', requestId: 'sandbox' })
  assert.ok(!buttonsOf(tree).some(b => b.props.key === 'toggle-details'))
  assert.ok(!buttonsOf(tree).some(b => b.props.key === 'clear-history'))
  await buttonsOf(tree).find(b => b.props.key === 'more-tasks').onPress()
  tree = await mod.fire('ui.render', { component: 'Pane', requestId: 'sandbox' })
  const footer = flatten(tree).find(n => n.type === 'Box' && n.children?.[0]?.props?.key === 'clear-history')
  assert.equal(footer.props.justifyContent, 'flex-end')
  assert.equal(footer.props.width, '100%')
  assert.equal(footer.children[0].props.key, 'clear-history')
  assert.equal(footer.children[0].children[0].props.color, 'red')
  await buttonsOf(tree).find(b => b.props.key === 'section:lanes').onPress()
  tree = await mod.fire('ui.render', { component: 'Pane', requestId: 'sandbox' })
  await buttonsOf(tree).find(b => b.props.key === 'file:/main.py').onPress()
  tree = await mod.fire('ui.render', { component: 'Pane', requestId: 'sandbox' })
  assert.ok(textsOf(tree).some(text => text.includes('2.0 KiB')))
})

test('empty folders show a gray inline suffix only after successful expansion', () => {
  const browser = { image: 'img', dirs: { '/': { entries: [{ name: 'boot', path: '/boot', type: 'directory' }] } }, expanded: { '/': true, '/boot': true } }
  const draw = () => fileTree(elements, browser, t, { refreshFiles() {}, toggleDirectory() {}, retryDirectory() {} })
  for (const state of [undefined, { loading: true, entries: [] }, { error: 'HTTP 500', entries: [] }, { entries: [{ name: 'x', path: '/boot/x', type: 'file' }] }]) {
    browser.dirs['/boot'] = state
    assert.ok(!flatten(draw()).some(node => node.type === 'Text' && node.children.includes(' (0)')))
  }
  browser.dirs['/boot'] = { entries: [], loading: false, error: null }
  const tree = draw()
  const folder = buttonsOf(tree).find(button => button.props.key === 'file:/boot')
  assert.ok(flatten(folder).some(node => node.type === 'Text' && node.props.color === 'gray' && node.children.includes(' (0)')))
  assert.ok(!textsOf(tree).includes('Empty directory'))
  browser.expanded['/boot'] = false
  assert.ok(!flatten(draw()).some(node => node.type === 'Text' && node.children.includes(' (0)')))
})

test('snapshot picker browses history without moving head and follows latest on request', async () => {
  const lane = advanceLane(laneTable(), 'auth', 'img-1', undefined, NOW)
  const store = new Map([['global-lane/auth', lane.auth]])
  const mod = loadMod({ store, server: tool => tool === 'list_files' ? { files: [] } : { operations: [] } })
  await mod.fire('session.start', {})
  await mod.fire('command.run', { command: 'sandbox', args: '' })
  await mod.settle()
  const draw = () => mod.fire('ui.render', { component: 'Pane', requestId: 'sandbox' })
  let tree = await draw()
  await buttonsOf(tree).find(b => b.props.key === 'section:lanes').onPress()
  tree = await draw()
  let picker = flatten(tree).find(node => node.type === 'Select' && node.props.label === 'Snapshot')
  assert.deepEqual(picker.props.options.map(o => o.value), ['img-1', 'img-0'])
  await picker.onSelect('img-0')
  assert.equal(mod.record.state.get('view').browser.image, 'img-0')
  assert.equal(store.get('global-lane/auth').head, 'img-1')
  store.set('global-lane/auth', { ...lane.auth, head: 'img-2', history: ['img-0', 'img-1', 'img-2'] })
  await mod.fire('command.run', { command: 'sandbox', args: '' })
  await mod.settle()
  assert.equal(mod.record.state.get('view').browser.image, 'img-0')
  tree = await draw()
  await buttonsOf(tree).find(b => b.props.key === 'section:lanes').onPress()
  tree = await draw()
  picker = flatten(tree).find(node => node.type === 'Select' && node.props.label === 'Snapshot')
  await picker.onSelect('img-2')
  assert.equal(mod.record.state.get('view').browser.image, 'img-2')
  await picker.onSelect('not-in-lane')
  assert.equal(mod.record.state.get('view').browser.image, 'img-2')
})

test('local dates and preview: local fields, binary guard, size cap and stale response isolation', async () => {
  const date = new Date(2026, 9, 20, 13, 5, 9)
  assert.equal(localTime(date.getTime()), '10-20-13:05:09')
  assert.equal(localTime(null), '—')
  assert.equal(safeDetail({ token: 'secret', env: { KEY: 'x' }, ok: 1 }).token, '[redacted]')
  let reads=0, release
  const browser = createFileBrowser(async()=>({files:[]}),async()=>{}, {read:async(image,path)=>{
    reads++
    if(path==='/slow') return new Promise(resolve=>{release=resolve})
    return path==='/binary'?{encoding:'base64',content:'AAEC'}:{encoding:'utf-8',content:'hello'}
  }})
  await browser.select('a','image-a')
  await browser.selectFile({path:'/text',type:'file',size:5})
  assert.equal(browser.snapshot().preview.content,'hello')
  await browser.selectFile({path:'/binary',type:'file',size:3})
  assert.equal(browser.snapshot().preview.skipped,true)
  await browser.selectFile({path:'/large',type:'file',size:999999})
  assert.equal(reads,2)
  const pending=browser.selectFile({path:'/slow',type:'file',size:5})
  await new Promise(resolve=>setTimeout(resolve,0))
  await browser.select('b','image-b')
  release({content:'old'})
  await pending
  assert.equal(browser.snapshot().preview,undefined)
})

test('history details and confirmed clear; lane deletion is local reference only', async () => {
  const store = new Map([['global-lane/auth', laneTable().auth]])
  const op={uuid:'op-history',kind:'instance',status:'SUCCESS',created_at:'2026-01-01T00:00:00Z'}
  const mod=loadMod({store,server:tool=>tool==='list_operations'?{operations:[op]}:tool==='get_operation'?{...op,stdout:'hello',stderr:'',exit_code:0}:tool==='list_files'?{files:[]}:{}})
  let confirm=false
  mod.$.ui.ask=async(q,options)=>options[confirm?0:1]
  await mod.fire('session.start',{})
  await mod.fire('command.run',{command:'sandbox',args:''})
  await mod.settle()
  const draw=()=>mod.fire('ui.render',{component:'Pane',requestId:'sandbox'})
  let tree=await draw()
  await buttonsOf(tree).find(b=>b.props.key==='section:tasks').onPress()
  tree=await draw()
  await buttonsOf(tree).find(b=>b.props.key==='more-tasks').onPress()
  tree=await draw()
  await buttonsOf(tree).find(b=>b.props.key==='operation:op-history').onPress()
  assert.equal(mod.record.state.get('view').operationDetail.value.stdout,'hello')
  await buttonsOf(tree).find(b=>b.props.key==='clear-history').onPress()
  assert.equal(mod.record.state.get('view').ops.length,1)
  confirm=true
  await buttonsOf(tree).find(b=>b.props.key==='clear-history').onPress()
  assert.equal(mod.record.state.get('view').ops.length,0)
  await mod.fire('command.run',{command:'sandbox',args:''})
  await mod.settle()
  assert.equal(mod.record.state.get('view').ops.length,0)
  tree=await draw()
  await buttonsOf(tree).find(b=>b.props.key==='section:lanes').onPress()
  tree=await draw()
  await buttonsOf(tree).find(b=>b.props.key==='drop-lane').onPress()
  assert.equal(store.has('global-lane/auth'),false)
  assert.ok(!mod.calls.some(call=>call.tool==='cancel_operation'||call.tool==='set_tag'))
})

test('pane styling: colored connection, red clear button, no detail blocks outside history', () => {
  const actions = { showSection() {}, refresh() {}, reconnect() {}, clearHistory() {}, inspectOperation() {}, togglePanel() {}, backLatest() {}, backImages() {}, copyImage() {} }
  const base = { mcp: { isConnected: true }, lanes: [], ops: [], quota: { running: 0, max: 50 }, lastCall: { tool: 'run', callSeconds: 1 }, operationDetail: { value: { stdout: 'private detail' } } }
  for (const section of ['lanes', 'images']) {
    const tree = paneTree(elements, { ...base, section, selectedImage: 'uuid' }, t, actions, NOW)
    assert.ok(!buttonsOf(tree).some(b => b.props.key === 'toggle-details'))
    assert.ok(!flatten(tree).some(n => n.type === 'Code'))
    assert.ok(flatten(tree).some(n => n.type === 'Text' && n.props.color === 'green' && n.children.includes('Connected')))
  }
  const tr = translator([ZH])
  const tree = paneTree(elements, { ...base, section: 'tasks', showHistory: true, mcp: { isConnected: false } }, tr, actions, NOW)
  assert.ok(flatten(tree).some(n => n.type === 'Text' && n.props.color === 'red' && n.children.includes('连接异常')))
  const clear = buttonsOf(tree).find(b => b.props.key === 'clear-history')
  assert.equal(clear.props.label, 'Clear')
  assert.equal(clear.children[0].props.color, 'red')
  assert.equal(buttonsOf(tree).find(b => b.props.key === 'section:tasks').props.label, 'Tasks (0)')
})

test('preview normalizes Windows line endings, enforces read cap and renders a separate card', async () => {
  let reads = 0
  const browser = createFileBrowser(async () => ({ files: [] }), async () => {}, { read: async () => {
    reads++
    return { encoding: 'utf-8', bytes_size: 510, content: "version: '3'\r\nservices:\r\n  app: {}\r" }
  } })
  await browser.select('auth', 'img')
  for (const size of [262145, undefined, Infinity]) {
    await browser.selectFile({ name: 'large.yml', path: '/large.yml', type: 'file', size })
    assert.equal(browser.snapshot().preview.skipped, true)
  }
  assert.equal(reads, 0)
  await browser.selectFile({ name: 'docker-compose.yml', path: '/docker-compose.yml', type: 'file', size: 262144 })
  assert.equal(reads, 1)
  assert.equal(browser.snapshot().preview.content, "version: '3'\nservices:\n  app: {}\n")
  const tree = fileTree(elements, browser.snapshot(), t, { refreshFiles() {} })
  const card = flatten(tree).find(n => n.props?.key === 'file-preview')
  assert.equal(card.props.borderStyle, 'round')
  assert.equal(card.props.marginTop, 1)
  assert.ok(textsOf(card).includes('File preview'))
  const code = flatten(card).find(n => n.type === 'Code')
  assert.equal(code.props.language, 'yaml')
  assert.doesNotMatch(code.props.source, /[\x00-\x08\x0b-\x1f\x7f]/)
})

test('lane deletion sits on selector row, right aligned with red label', () => {
  const tree = paneTree(elements, { mcp: null, section: 'lanes', lanes: Object.values(laneTable()), selectedLane: 'auth', ops: [] }, t, {
    showSection() {}, refresh() {}, selectLane() {}, selectSnapshot() {}, drop() {}, copyImage() {},
  }, NOW)
  const row = tree.children.find(node => node.children?.some(child => child.props?.key === 'drop-lane'))
  assert.equal(row.props.justifyContent, 'space-between')
  assert.equal(row.children[0].type, 'Select')
  assert.equal(row.children.at(-1).props.key, 'drop-lane')
  assert.equal(row.children.at(-1).children[0].props.color, 'red')
})

test('Tasks outcome separates platform completion from command success and persistence', () => {
  assert.equal(taskOutcome({remote:true,value:{status:'SUCCESS'}}),'unknown')
  assert.equal(taskOutcome({value:{status:'SUCCESS',exit_code:2}}),'commandFailed')
  assert.equal(taskOutcome({value:{status:'SUCCESS',exit_code:0,timed_out:true}}),'timeout')
  assert.equal(taskOutcome({value:{status:'FAILED'}}),'platform')
  assert.equal(taskOutcome({value:{status:'CANCELLED'}}),'cancelled')
  assert.equal(taskOutcome({value:{status:'SUCCESS',exit_code:0}}),'success')
  assert.equal(persistenceOf({disposable:true,value:{}}),'temporary')
  assert.equal(persistenceOf({disposable:false,value:{}}),'noSnapshot')
  assert.equal(persistenceOf({value:{result_image_uuid:'saved'}}),'saved')
})

test('Tasks defaults to latest remote outcome, expiry is row two and history expands on demand', async () => {
  const op={uuid:'recent',kind:'instance',status:'SUCCESS',created_at:new Date(NOW).toISOString(),exit_code:1,stdout:'out',stderr:'failure',duration:2,consumed_memory:123}
  const mod=loadMod({server:tool=>tool==='whoami'?{token_expiration:1900000000,limits:{instance_max_concurrency:50}}:tool==='list_operations'?{operations:[op]}:tool==='get_operation'?op:{}})
  await mod.fire('session.start',{})
  await mod.fire('command.run',{command:'sandbox',args:''})
  await mod.settle()
  assert.equal(mod.record.state.get('view').section,'tasks')
  assert.equal(mod.record.state.get('view').latestTask.value.exit_code,1)
  let tree=await mod.fire('ui.render',{component:'Pane',requestId:'sandbox'})
  assert.match(textsOf(tree.children[1]).join(''),/Token expires:/)
  assert.deepEqual(buttonsOf(tree.children[2]).slice(0,3).map(b=>b.props.key),['section:tasks','section:lanes','section:images'])
  assert.ok(textsOf(tree).includes('Command failed (nonzero exit)'))
  assert.ok(!buttonsOf(tree).some(b=>b.props.key==='clear-history'))
  await buttonsOf(tree).find(b=>b.props.key==='more-tasks').onPress()
  tree=await mod.fire('ui.render',{component:'Pane',requestId:'sandbox'})
  assert.ok(buttonsOf(tree).some(b=>b.props.key==='clear-history'))
})

test('Tasks captures live API timing, redacts inputs and does not let older completion replace newer call', async () => {
  const mod=loadMod()
  await mod.fire('session.start',{})
  let resolve
  const pending=mod.fire('tool.call',{tool:'mcp__contree__run',tool_use_id:'slow',image:'img',timeout:60},()=>new Promise(r=>{resolve=r}))
  await mod.settle()
  assert.equal(mod.record.state.get('view').latestTask.pending,true)
  await mod.fire('tool.call',{tool:'mcp__contree__get_image',tool_use_id:'newer',image:'img'},async()=>({result:{uuid:'img'}}))
  resolve({result:{status:'SUCCESS',exit_code:0}})
  await pending
  assert.equal(mod.record.state.get('view').latestTask.method,'mcp__contree__get_image')
  assert.equal(typeof mod.record.state.get('view').latestTask.callSeconds,'number')
})

test('Tasks concise metrics and image link navigate to the selected snapshot file tree', async () => {
  const mod = loadMod({ server: tool => tool === 'list_files' ? { files: [{ name: 'result.txt', type: 'file', size: 2 }] } : { operations: [] } })
  await mod.fire('session.start', {})
  for (const saved of [true, false]) {
    const value = { uuid: 'operation-1', status: 'SUCCESS', exit_code: 0, duration: 0.446, consumed_cpu: 0.024075, consumed_memory: 10888, image_uuid: 'source-image', result_image_uuid: saved ? 'result-image' : null }
    await mod.fire('tool.call', { tool: 'mcp__contree__run', image: 'source-image' }, async () => ({ result: value }))
    await mod.fire('command.run', { command: 'sandbox', args: '' })
    await mod.settle()
    let tree = await mod.fire('ui.render', { component: 'Pane', requestId: 'sandbox' })
    const texts = textsOf(tree)
    for (const metric of ['Duration: 0.446', 'CPU: 0.024075', 'Memory: 10888']) assert.ok(texts.includes(metric))
    assert.ok(texts.indexOf('Image:') < texts.indexOf('Operation:'))
    const source = buttonsOf(tree).find(b => b.props.key === 'task-source-image')
    const result = buttonsOf(tree).find(b => b.props.key === 'task-result-image')
    assert.equal(source.props.label, 'source-image')
    assert.equal(!!result, saved)
    assert.equal(texts.includes('Result Image:'), saved)
    if (saved) {
      assert.equal(result.props.label, 'result-image')
      assert.ok(texts.indexOf('Result Image:') < texts.indexOf('Operation:'))
    }
    for (const link of [source, result].filter(Boolean)) {
      assert.equal(link.children[0].props.underline, true)
      await link.onPress()
      assert.equal(mod.record.state.get('view').section, 'images')
      assert.equal(mod.record.state.get('view').browser.image, link.props.label)
      tree = await mod.fire('ui.render', { component: 'Pane', requestId: 'sandbox' })
      assert.ok(buttonsOf(tree).some(b => b.props.key === 'file:/result.txt'))
    }
  }
})

test('Tasks compact presentation folds raw/request, omits empty stderr, and reuses summary for history', async () => {
  const historical = { uuid: 'old-op', status: 'SUCCESS', exit_code: 0, stdout: 'old-output', stderr: '' }
  const mod=loadMod({server:tool=>tool==='get_operation'?historical:tool==='list_operations'?{operations:[{...historical,kind:'instance',created_at:new Date(NOW).toISOString()}]}:{}})
  await mod.fire('session.start',{})
  await mod.fire('tool.call',{tool:'mcp__contree__run',image:'img',command:'echo hello'},async()=>({result:{uuid:'op',status:'SUCCESS',exit_code:0,stdout:'hello',stderr:'',duration:1,consumed_cpu:0.1,consumed_memory:5}}))
  const draw=()=>mod.fire('ui.render',{component:'Pane',requestId:'sandbox'})
  let tree=await draw()
  assert.equal(flatten(tree).filter(n=>n.type==='Code').length,1)
  assert.ok(!textsOf(tree).includes('stderr'))
  assert.ok(!textsOf(tree).includes('instance'))
  const metrics=flatten(tree).find(n=>n.props?.key==='task-metrics')
  assert.equal(metrics.props.flexWrap,'wrap')
  assert.equal(metrics.children.length,4)
  await buttonsOf(tree).find(b=>b.props.key==='task-raw').onPress()
  tree=await draw()
  assert.equal(flatten(tree).filter(n=>n.type==='Code').length,2)
  await buttonsOf(tree).find(b=>b.props.key==='task-request').onPress()
  tree=await draw()
  assert.ok(textsOf(tree).includes('Call method / command'))
  await buttonsOf(tree).find(b=>b.props.key==='more-tasks').onPress()
  // History selection uses the same summary, not a second output panel.
  await mod.fire('command.run',{command:'sandbox',args:''})
  await mod.settle()
  tree=await draw()
  await buttonsOf(tree).find(b=>b.props.key==='operation:old-op').onPress()
  tree=await draw()
  assert.equal(flatten(tree).filter(n=>n.type==='Code').length,1)
  assert.equal(flatten(tree).find(n=>n.type==='Code').props.source,'old-output')
  assert.ok(!buttonsOf(tree).some(b=>b.props.key==='task-request'))
  await buttonsOf(tree).find(b=>b.props.key==='task-back-latest').onPress()
  tree=await draw()
  assert.equal(flatten(tree).find(n=>n.type==='Code').props.source,'hello')
})

test('project root controls are removed and old preferences are ignored', async () => {
  const store = new Map([['global-lane/auth', laneTable().auth], ['browser-root/auth', '/old-project']])
  const mod = loadMod({store,server:tool=>tool==='list_files'?{files:[{name:'app',type:'directory'}]}:{operations:[]}})
  await mod.fire('session.start',{})
  let tree=await mod.fire('ui.render',{component:'Pane',requestId:'sandbox'})
  await buttonsOf(tree).find(b=>b.props.key==='section:lanes').onPress()
  tree=await mod.fire('ui.render',{component:'Pane',requestId:'sandbox'})
  assert.ok(mod.calls.some(call=>call.tool==='list_files' && call.args.path==='/'))
  assert.ok(!mod.calls.some(call=>call.args.path==='/old-project'))
  assert.ok(!buttonsOf(tree).some(b=>b.props.key.startsWith('project:') || ['browse-root','browse-project','forget-project'].includes(b.props.key)))
  assert.ok(mod.record.status.every(value=>value===undefined),'composer status remains cleared')
})

test('image order is chronological regardless of lane association', () => {
  const rows=imageRows([{uuid:'older',created_at:'2026-01-01T00:00:00Z'},{uuid:'newer',created_at:'2026-02-01T00:00:00Z'}],[],[{name:'lane',head:'older',history:['older']}])
  assert.deepEqual(rows.map(row=>row.uuid),['newer','older'])
})

// ── the plugin's files ──

test('manifest: userConfig fields as the plugin format holds them; the mod reads only declared keys', () => {
  const fields = manifest.userConfig
  for (const [key, field] of Object.entries(fields)) {
    assert.match(key, /^[A-Za-z_]\w*$/)
    assert.ok(['string', 'number', 'boolean'].includes(field.type), key)
    assert.ok(field.title && field.description, key)
    if (field.sensitive) assert.equal(field.type, 'string')
    if (field.default !== undefined && field.type !== 'string') assert.equal(typeof field.default, field.type, key)
  }
  assert.equal(fields.api_key, undefined, "the key is the provider's: no second entry")
  assert.ok(manifest.providers['token-factory'], 'the provider whose key the sandboxes use')
  const source = readFileSync(join(pluginDir, 'hooks', 'sandbox.js'), 'utf8')
  for (const key of source.matchAll(/options\.(\w+)/g)) assert.ok(fields[key[1]], `options.${key[1]} is declared`)
  assert.match(manifest.version, /^1\.1\.\d+$/)
})

test(".mcp.json: contree over uvx; the provider's key reaches only an env value; every option and provider it names is declared", () => {
  const mcp = readJson('.mcp.json')
  const server = mcp.mcpServers.contree
  assert.equal(server.command, 'uvx')
  assert.deepEqual(server.args, ['--with', 'mcp==1.*', 'contree-mcp'], 'contree-mcp breaks on mcp 2; no "<" (a redirect in a Windows shell)')
  assert.equal(server.env.NEBIUS_API_KEY, '${provider_key.token-factory}')
  assert.equal(server.env.NEBIUS_AI_PROJECT, '${user_config.project_id}')
  const text = JSON.stringify(mcp)
  for (const [, key] of text.matchAll(/\$\{user_config\.(\w+)\}/g)) assert.ok(manifest.userConfig[key], key)
  for (const [, key] of text.matchAll(/\$\{provider_key\.([\w-]+)\}/g)) assert.ok(manifest.providers[key], key)
  assert.doesNotMatch(JSON.stringify({ command: server.command, args: server.args }), /user_config|provider_key/)
  for (const [name, value] of Object.entries(server.env)) {
    if (name !== 'NEBIUS_API_KEY') assert.doesNotMatch(value, /provider_key/, name)
  }
})

test('hooks, skills and agents: present and well-formed', () => {
  assert.deepEqual(readJson('hooks/hooks.json'), { modules: ['./sandbox.js'] })
  const skills = readdirSync(join(pluginDir, 'skills'))
  assert.deepEqual(skills.sort(), ['sandbox-parallel-dev', 'sandbox-parallel-test', 'sandbox-swe-env', 'sandbox-workflow'])
  for (const skill of skills) {
    const text = readFileSync(join(pluginDir, 'skills', skill, 'SKILL.md'), 'utf8')
    assert.match(text, new RegExp(`^---\\nname: ${skill}\\ndescription: .{40,}\\n---\\n`), skill)
  }
  for (const agent of ['sandbox-dev', 'sandbox-tester']) {
    const path = join(pluginDir, 'agents', `${agent}.md`)
    assert.ok(existsSync(path))
    const head = readFileSync(path, 'utf8').split('\n---\n')[0]
    assert.match(head, new RegExp(`^---\\nname: ${agent}\\n`))
    const tools = head.match(/^tools: (.+)$/m)?.[1]
    assert.ok(tools, `${agent} lists its tools on one line (the agent loader reads one line per key)`)
    assert.ok(!tools.split(', ').some(tool => /^(Write|Edit|Bash|mcp__contree__(rsync|upload|download))$/.test(tool)), `${agent} cannot touch local files`)
  }
})
