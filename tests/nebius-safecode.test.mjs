// Unit tests for SafeCode's folder guard: the pure path checks, and the hooks
// run against a hand-made `$`. Run:
//   node --test tests/nebius-safecode.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { checkPaths, globSearchRoot, localPathsOf, normalize, splitLast } from '../hooks/safecode/paths.js'
import { registerSafeCode } from '../hooks/safecode.js'
import { register } from '../hooks/sandbox.js'

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'))
const EN = JSON.parse(readFileSync(join(pluginDir, 'locales', 'en.json'), 'utf8'))
const ZH = JSON.parse(readFileSync(join(pluginDir, 'locales', 'zh.json'), 'utf8'))

const WORK = 'D:\\code\\app'
const MEMORY = 'C:\\Users\\u\\.velloc\\projects\\D-code-app\\memory\\'
const SCRATCH = 'C:\\Users\\u\\.velloc\\projects\\D-code-app\\sess-1\\scratch'
const FOLDERS = { work: [WORK, WORK], memory: MEMORY, scratch: SCRATCH }

// ── paths ──

test('paths: separators, dots and drive case are normalized; what cannot be placed is undefined', () => {
  assert.equal(normalize('d:\\code\\app\\src\\..\\a.ts'), 'D:/code/app/a.ts')
  assert.equal(normalize('src/./a.ts', WORK), 'D:/code/app/src/a.ts')
  assert.equal(normalize('/home/u/x/../y'), '/home/u/y')
  assert.equal(normalize('../../..', '/a'), undefined, 'climbing above the root')
  assert.equal(normalize('~/notes.md', WORK), undefined)
  assert.equal(normalize('\\\\server\\share\\f', WORK), undefined)
  assert.equal(normalize('rel/a.ts'), undefined, 'relative with no base')
  assert.equal(normalize(''), undefined)
})

test('paths: inside the session folder, memory and scratchpad is allowed; anything else names the path', () => {
  assert.deepEqual(checkPaths(['D:\\code\\app\\src\\a.ts', 'src/b.ts', 'd:/CODE/app'], FOLDERS), { allowed: true })
  assert.deepEqual(checkPaths([`${MEMORY}user_role.md`], FOLDERS), { allowed: true })
  assert.deepEqual(checkPaths([`${SCRATCH}\\draft.txt`], FOLDERS), { allowed: true })
  assert.deepEqual(checkPaths(['D:\\code\\app-other\\a.ts'], FOLDERS), { allowed: false, path: 'D:\\code\\app-other\\a.ts' }, 'a sibling sharing the prefix')
  assert.deepEqual(checkPaths(['src/../../secret.txt'], FOLDERS), { allowed: false, path: 'src/../../secret.txt' })
  assert.deepEqual(checkPaths(['C:\\Users\\u\\.velloc\\settings.json'], FOLDERS), { allowed: false, path: 'C:\\Users\\u\\.velloc\\settings.json' })
  assert.deepEqual(checkPaths(['C:\\Users\\u\\.velloc\\projects\\D-code-app\\sess-1\\transcript.jsonl'], FOLDERS).allowed, false, 'the session directory beside the scratchpad')
  assert.deepEqual(checkPaths(['a.ts'], { work: [], memory: null, scratch: null }).allowed, false, 'no folders: nothing is allowed')
})

test('paths: each guarded tool names its local paths; a Glob pattern counts by the folder it searches', () => {
  assert.deepEqual(localPathsOf('Read', { file_path: 'C:/x.txt', limit: 3 }), ['C:/x.txt'])
  assert.deepEqual(localPathsOf('Grep', { pattern: 'TODO' }), [], 'no path: the session folder')
  assert.deepEqual(localPathsOf('Glob', { pattern: 'C:/Users/**/*.env' }), ['C:/Users'])
  assert.deepEqual(localPathsOf('Glob', { pattern: '../../**/*.env', path: 'src' }), ['src', 'src/../..'])
  assert.deepEqual(localPathsOf('Glob', { pattern: 'src/**/*.ts' }), [])
  assert.deepEqual(localPathsOf('SuperEdit', { code: 'workspace.readFile("a")' }), [])
  assert.deepEqual(localPathsOf('SuperEdit', { path: 'C:/tools/script.js' }), ['C:/tools/script.js'])
  assert.deepEqual(localPathsOf('mcp__contree__rsync', { source: 'C:/', destination: '/app' }), ['C:/'])
  assert.deepEqual(localPathsOf('mcp__contree__upload', { path: 'C:/id_rsa' }), ['C:/id_rsa'])
  assert.deepEqual(localPathsOf('mcp__contree__download', { image: 'i', path: '/app/a', destination: 'C:/Windows/a' }), ['C:/Windows/a'])
  assert.deepEqual(localPathsOf('mcp__nebius__sandbox_lane_patch', { name: 'l', path: '/app', out: '../p.diff' }), ['../p.diff'])
  assert.deepEqual(localPathsOf('TodoWrite', { file_path: 'C:/x' }), [], 'an unguarded tool')
  assert.equal(globSearchRoot('/**/x'), '/')
  assert.equal(globSearchRoot('C:/*'), 'C:/')
  assert.equal(globSearchRoot('C:/x'), 'C:/')
  assert.equal(globSearchRoot('D:\\work\\ab*\\c'), 'D:/work', 'cut back to the last separator before the first glob character')
  assert.equal(globSearchRoot('a*'), '')
  assert.deepEqual(localPathsOf('Glob', { pattern: 'D:/work/proj' }), ['D:/work'], 'a literal pattern searches its dirname')
  assert.deepEqual(splitLast('D:/a/b'), ['D:/a', 'b'])
  assert.deepEqual(splitLast('D:/a'), ['D:/', 'a'])
  assert.deepEqual(splitLast('/a'), ['/', 'a'])
  assert.equal(splitLast('D:/'), undefined)
  assert.equal(splitLast('/'), undefined)
})

// ── the hooks, against a fake $ ──

function matches(matcher, e) {
  if (!matcher) return true
  return Object.entries(matcher).every(([key, want]) => (Array.isArray(want) ? want.includes(e[key]) : e[key] === want))
}

const elements = {
  Box: props => ({ type: 'Box', props, children: props.children ?? [] }),
  Text: props => ({ type: 'Text', props, children: props.children ?? [] }),
  Button: ({ onPress, ...props }) => ({ type: 'Button', props, children: [], onPress }),
}

/**
 * The fake host's stat: a path under one of `missing` is not there (it throws),
 * `realPaths` names a path's real path (null: a link leading nowhere), and
 * anything else is its own real path.
 */
function fakeStat(realPaths, missing) {
  return async path => {
    const key = path.replace(/\\/g, '/')
    if (key in realPaths) return realPaths[key] === null ? { kind: 'other', isLink: true } : { kind: 'file', realPath: realPaths[key] }
    if (missing.some(gone => key === gone || key.startsWith(`${gone}/`))) throw Object.assign(new Error(`ENOENT '${key}'`), { name: 'NotFoundError' })
    return { kind: 'file', realPath: path }
  }
}

function loadGuard({ type = 'nebius:safecode', locale = 'en', memoryDir = MEMORY, scratchpadDir = SCRATCH, realPaths = {}, missing = [], stat, session = {} } = {}) {
  const hooks = []
  registerSafeCode((event, matcherOrFn, maybeFn) => {
    const fn = typeof matcherOrFn === 'function' ? matcherOrFn : maybeFn
    const matcher = typeof matcherOrFn === 'function' ? undefined : matcherOrFn
    hooks.push({ event, matcher, fn })
  })
  const state = new Map()
  const $ = {
    plugin: Object.freeze({ name: 'nebius', root: pluginDir, locale }),
    fs: {
      read: async path => readFileSync(path, 'utf8'),
      stat: stat ?? fakeStat(realPaths, missing),
    },
    session: {
      type: async () => type,
      cwd: async () => WORK,
      root: async () => WORK,
      memoryDir: async () => memoryDir,
      scratchpadDir: async () => scratchpadDir,
      ...session,
    },
    state: {
      get: async ref => ({ value: state.get(ref.key) ?? null, version: 1 }),
      set: async (ref, value) => (state.set(ref.key, value), { isSet: true, version: 2 }),
    },
    ui: { resolve: () => elements },
  }
  const fire = async (event, e, core) => {
    const chain = hooks.filter(hook => hook.event === event && matches(hook.matcher, e))
    const run = (index, value) => (index < chain.length ? chain[index].fn($, value, next => run(index + 1, next)) : core(value))
    return run(0, e)
  }
  const check = (tool, input) => fire('tool.check', { tool, input }, async () => ({ decision: 'allow' }))
  const band = () => fire('ui.render', { component: 'AbovePrompt', requestId: 'band', props: {} }, async () => ({ type: 'engine', ref: 0 }))
  return { fire, check, band, state, hooks }
}

const textsOf = tree => {
  const out = []
  const walk = node => {
    if (typeof node === 'string') out.push(node)
    else if (node) for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  return out
}

test('guard: a SafeCode session refuses a read outside its folder, says so above the prompt, and the model is told why', async () => {
  const guard = loadGuard()
  await guard.fire('session.start', {}, async () => ({}))
  assert.deepEqual(await guard.check('Read', { file_path: 'D:\\code\\app\\src\\a.ts' }), { decision: 'allow' })
  const refused = await guard.check('Read', { file_path: 'C:\\Users\\u\\.ssh\\id_rsa' })
  assert.equal(refused.decision, 'deny')
  assert.equal(refused.reason, EN['safecode.denied'].replace('{tool}', 'Read').replace('{path}', 'C:\\Users\\u\\.ssh\\id_rsa'))
  const band = await guard.band()
  assert.equal(band.type, 'Box')
  assert.deepEqual(textsOf(band), [
    EN['safecode.band'].replace('{tool}', 'Read').replace('{path}', 'C:\\Users\\u\\.ssh\\id_rsa'),
  ])
})

test('guard: SuperEdit steps and writes are judged by path; memory and the scratchpad are allowed', async () => {
  const guard = loadGuard()
  assert.equal((await guard.check('Write', { file_path: `${MEMORY}feedback_tests.md` })).decision, 'allow')
  assert.equal((await guard.check('Read', { file_path: `${MEMORY}MEMORY.md` })).decision, 'allow')
  assert.equal((await guard.check('Write', { file_path: `${SCRATCH}\\notes.txt` })).decision, 'allow')
  assert.equal((await guard.check('Write', { file_path: 'D:\\code\\other\\a.ts' })).decision, 'deny')
  assert.equal((await guard.check('mcp__contree__rsync', { source: 'C:\\Users\\u', destination: '/app' })).decision, 'deny')
  assert.equal((await guard.check('mcp__contree__rsync', { source: 'D:\\code\\app', destination: '/app' })).decision, 'allow')
})

test('guard: memory off leaves its directory outside, like any other folder', async () => {
  const guard = loadGuard({ memoryDir: null })
  assert.equal((await guard.check('Write', { file_path: `${MEMORY}x.md` })).decision, 'deny')
})

test('guard: a path inside whose real path leads outside is refused', async () => {
  const guard = loadGuard({ realPaths: { 'D:/code/app/link/secret': 'C:\\Users\\u\\secret' } })
  assert.equal((await guard.check('Read', { file_path: 'D:\\code\\app\\link\\secret' })).decision, 'deny')
})

test('guard: a file not yet made is judged by its nearest existing ancestor, so a link to outside cannot be written through', async () => {
  const guard = loadGuard({ realPaths: { 'D:/code/app/link': 'C:/Users/u' }, missing: ['D:/code/app/link', 'D:/code/app/src/new'] })
  assert.equal((await guard.check('Write', { file_path: 'link/.ssh/authorized_keys' })).decision, 'deny')
  assert.equal((await guard.check('Write', { file_path: 'D:/code/app/link/new.txt' })).decision, 'deny')
  assert.equal((await guard.check('Write', { file_path: 'D:/code/app/src/new/deep/a.ts' })).decision, 'allow')
  assert.equal((await guard.check('Write', { file_path: `${MEMORY}not-yet.md` })).decision, 'allow')
})

test('guard: a path there but not resolvable, or with no ancestor that resolves, is refused', async () => {
  const dangling = loadGuard({ realPaths: { 'D:/code/app/dangling': null } })
  assert.equal((await dangling.check('Write', { file_path: 'D:/code/app/dangling' })).decision, 'deny', 'a link leading nowhere')
  const nothing = loadGuard({ stat: async path => { throw new Error(`ENOENT '${path}'`) } })
  assert.equal((await nothing.check('Read', { file_path: 'D:/code/app/a.ts' })).decision, 'deny')
})

test('guard: an absolute Glob is judged by the folder the host searches; a literal pattern naming the session folder searches its parent', async () => {
  const guard = loadGuard()
  assert.equal((await guard.check('Glob', { pattern: 'D:/code/app' })).decision, 'deny')
  assert.equal((await guard.check('Glob', { pattern: 'D:/code/app/src' })).decision, 'allow')
  assert.equal((await guard.check('Glob', { pattern: 'D:/code/app/ab*' })).decision, 'allow')
  assert.equal((await guard.check('Glob', { pattern: 'D:/code/ap*/x' })).decision, 'deny')
})

test('guard: the folders are read on each check, so a change of folder mid-session is followed', async () => {
  let cwd = WORK
  const guard = loadGuard({ session: { cwd: async () => cwd, root: async () => cwd } })
  assert.equal((await guard.check('Read', { file_path: 'D:/code/next/a.ts' })).decision, 'deny')
  cwd = 'D:/code/next'
  assert.equal((await guard.check('Read', { file_path: 'D:/code/next/a.ts' })).decision, 'allow')
  assert.equal((await guard.check('Read', { file_path: 'D:/code/app/a.ts' })).decision, 'deny')
})

test('guard: any other session type is left alone and draws nothing', async () => {
  for (const type of ['code', 'safe_code', 'other:safecode']) {
    const guard = loadGuard({ type })
    assert.deepEqual(await guard.check('Read', { file_path: 'C:\\Windows\\win.ini' }), { decision: 'allow' }, type)
    assert.deepEqual(await guard.band(), { type: 'engine', ref: 0 })
  }
})

test('guard: a Velloc without $.session.type leaves the session alone; a SafeCode session whose folders cannot be read refuses every path', async () => {
  const older = loadGuard({ session: { type: undefined } })
  assert.equal((await older.check('Read', { file_path: 'C:\\x' })).decision, 'allow')
  const blind = loadGuard({ session: { cwd: async () => { throw new Error('gone') }, root: () => { throw new Error('gone') } }, memoryDir: null, scratchpadDir: null })
  assert.equal((await blind.check('Read', { file_path: 'D:\\code\\app\\a.ts' })).decision, 'deny')
})

test('guard: the band counts repeated blocks, shows the latest, sits above what other plugins drew, and Dismiss clears it', async () => {
  const guard = loadGuard({ locale: 'zh-CN' })
  await guard.fire('session.start', {}, async () => ({}))
  await guard.check('Read', { file_path: 'C:\\a' })
  await guard.check('Glob', { pattern: 'C:/Users/**/*.env' })
  const other = { type: 'Box', props: {}, children: ['other plugin'] }
  const tree = await guard.fire('ui.render', { component: 'AbovePrompt', requestId: 'band', props: {} }, async () => other)
  assert.equal(tree.props.flexDirection, 'column')
  assert.equal(tree.children[1], other)
  assert.deepEqual(textsOf(tree.children[0]), [
    ZH['safecode.bandMany'].replace('{count}', '2').replace('{path}', 'C:/Users').replace('{tool}', 'Glob'),
  ])
  const dismiss = tree.children[0].children.find(node => node.type === 'Button')
  assert.equal(dismiss.props.label, ZH['safecode.dismiss'])
  await dismiss.onPress()
  assert.deepEqual(await guard.band(), { type: 'engine', ref: 0 })
})

test('manifest and wiring: the guard is registered by the hooks module, and the plugin waits for a Velloc that serves session-type', () => {
  const hooks = []
  register((event, matcher) => hooks.push({ event, matcher }), {})
  assert.ok(hooks.some(hook => hook.event === 'tool.check' && hook.matcher?.tool?.includes('Read') && hook.matcher.tool.includes('mcp__contree__rsync')))
  assert.ok(hooks.some(hook => hook.event === 'ui.render' && hook.matcher?.component === 'AbovePrompt'))
  assert.ok(manifest.requires.features.includes('session-type'))
  for (const key of ['safecode.band', 'safecode.bandMany', 'safecode.dismiss']) assert.equal(typeof ZH[key], 'string', key)
})
