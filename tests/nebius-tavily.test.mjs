import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { registerTavily } from '../hooks/tavily.js'
import { tavilyTree } from '../hooks/tavily/view.js'
import { SEARCH_TOOL, MAX_RECORD_BYTES, boundedRecord, byteSize, completeRecord, safeText, safeUrl, searchData } from '../hooks/tavily/results.js'
import { MAX_RECORDS, RECORD_PREFIX, WATERMARK_KEY, clearHistory, readHistory, saveRecord, watermark } from '../hooks/tavily/storage.js'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
function sharedStore() {
  const data = new Map()
  return { data, keys: async () => [...data.keys()], get: async key => structuredClone(data.get(key)), set: async (key, value) => { data.set(key, structuredClone(value)) }, delete: async key => { data.delete(key) } }
}
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...(tree.children ?? []).flatMap(nodes)]
const find = (tree, key) => nodes(tree).find(node => node.key === key)
const base = (id, startedAt = Date.now()) => boundedRecord({ id, startedAt, epoch: '', status: 'pending', query: 'test' })

function harness(store = sharedStore(), { reenter = false, setup } = {}) {
  const hooks = []
  const opened = [], commands = [], states = [], calls = []
  let confirm = 'tavily.clear'
  let core = async () => ({ result: { structuredContent: { results: [] } } })
  const ui = Object.fromEntries(['Box', 'Text', 'Input', 'Button', 'Select', 'Link'].map(type => [type, props => ({ type, ...props })]))
  const $ = {
    plugin: { name: 'nebius', locale: 'en', root: '/plugin' },
    fs: { read: async () => '{}' }, store,
    state: { set: async (ref, value) => { states.push({ ref, value: structuredClone(value) }) }, get: async () => ({ value: { rows: [base('stale')] } }) },
    command: { register: async spec => { commands.push(spec) } },
    ui: { open: async spec => { opened.push(spec); return { isPlaced: true } }, ask: async () => confirm, resolve: async () => ui },
    tool: { call: async input => {
      calls.push(input)
      if (!reenter) return core(input)
      const next = value => core(value)
      next.origin = { plugin: $.plugin.name, tier: 'normal' }
      return dispatch('tool.call', { ...structuredClone(input), tool_use_id: `modtool_${calls.length}` }, next)
    } },
  }
  registerTavily((event, filter, handler) => { hooks.push({ event, filter: typeof filter === 'function' ? {} : filter, handler: handler ?? filter }) }, { setup })
  async function dispatch(event, input = {}, next = async () => ({})) {
    const hook = hooks.find(hook => hook.event === event && Object.entries(hook.filter).every(([key, value]) => input[key] === value))
    return hook ? hook.handler($, input, next) : next(input)
  }
  return { $, store, hooks, opened, commands, states, calls, dispatch, start: () => dispatch('session.start'), render: () => dispatch('ui.render', { component: 'Pane', requestId: 'tavily' }), confirm: value => { confirm = value }, core: value => { core = value } }
}

test('normalizes structured content and JSON text blocks without inventing credits', () => {
  const data = { query: 'hello', answer: 'answer', results: [{ title: 'one', url: 'https://example.com', content: 'snippet' }], usage: { credits: 0 } }
  assert.deepEqual(searchData({ result: { structuredContent: data } }), data)
  assert.deepEqual(searchData({ result: { content: [{ type: 'text', text: 'not json' }, { type: 'text', text: JSON.stringify(data) }] } }), data)
  assert.deepEqual(searchData({ structuredContent: { result: data } }), data)
  const result = completeRecord(base('1', 100), { result: { structuredContent: data } }, undefined, 1250)
  assert.equal(result.durationMs, 1150)
  assert.equal(result.credits, 0)
  assert.equal(result.total, 1)
  assert.equal(result.answer, 'answer')
  for (const credits of [undefined, '2', -1, Infinity, null]) {
    assert.equal(completeRecord(base('1'), { result: { structuredContent: { usage: { credits }, credits: 100, cost: 1 } } }, undefined, Date.now()).credits, null)
  }
})

test('redacts secret patterns in every text field and strips URL credentials', () => {
  const raw = 'tvly-dev-Abc_123 sk-testSecret Bearer abc.def api_key="hide me" token=private ghp_abcdefgh'
  const safe = safeText(raw)
  for (const secret of ['Abc_123', 'testSecret', 'abc.def', 'hide me', 'private', 'ghp_']) assert.ok(!safe.includes(secret))
  assert.equal(safeUrl('https://user:password@example.com/path?q=ok&api_key=secret&access_token=abc#token=hide'), 'https://example.com/path?q=ok')
  assert.equal(safeUrl('https://example.com/?key=abc&signature=xyz&x=tvly-dev-secret&redirect=https%3A%2F%2Fu%3Ap%40a.com'), 'https://example.com/')
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/plain,hello', '/relative', 'not a url']) assert.equal(safeUrl(url), '')
  assert.equal(safeText('link https://u:p@example.com/?token=secret#hidden'), 'link https://example.com/')
  const record = boundedRecord({ ...base('1'), query: raw, answer: raw, error: raw, api_key: 'must not persist', results: [{ title: raw, content: raw, url: 'https://u:p@example.com/?token=private', raw_content: 'must not persist' }] })
  assert.doesNotMatch(JSON.stringify(record), /private|must not persist|hide me|Abc_123/)
})

test('bounds multilingual payload bytes and retains total result count', () => {
  const data = { answer: '😀'.repeat(10000), total_results: 800, results: Array.from({ length: 800 }, () => ({ title: '字'.repeat(1000), content: '\u0001😀'.repeat(10000), url: 'https://example.com' })) }
  const record = completeRecord({ ...base('1'), query: '😀'.repeat(10000) }, { result: { structuredContent: data } }, undefined, Date.now())
  assert.ok(byteSize(record) <= MAX_RECORD_BYTES)
  assert.ok(Buffer.byteLength(JSON.stringify(record)) <= MAX_RECORD_BYTES)
  assert.equal(record.total, 800)
  assert.ok(record.results.length <= 10)
})

test('registers only the exact search observer and local pane command', async () => {
  const h = harness(); await h.start()
  assert.equal(h.commands[0].name, 'tavily')
  assert.equal(h.hooks.find(hook => hook.event === 'tool.call').filter.tool, SEARCH_TOOL)
  assert.ok(!h.hooks.some(hook => hook.event === 'tool.check'))
  await h.dispatch('command.run', { command: 'tavily', args: 'ignore optional arguments' })
  assert.equal(h.opened[0].focus, true)
  assert.equal(h.calls.length, 0)
  assert.equal(h.states.at(-1).ref.key, 'tavily-view')
  await h.dispatch('tool.call', { tool: 'mcp__evil__tavily_search' }, async () => ({}))
  assert.equal((await readHistory(h.store)).rows.length, 0)
})

test('observer auto opens, presents pending, preserves exact result and restores across sessions', async () => {
  const h = harness(); await h.start()
  const gate = deferred(), entered = deferred()
  const answer = { result: { structuredContent: { answer: 'found', results: [{ title: 'Title', url: 'https://example.com', content: 'Snippet' }], usage: { credits: 2 } } } }
  const event = { tool: SEARCH_TOOL, query: 'search', api_key: 'hidden', agentId: 'agent' }
  const call = h.dispatch('tool.call', event, async input => { assert.strictEqual(input, event); entered.resolve(); await gate.promise; return answer })
  await entered.promise
  assert.equal(h.opened[0].id, 'tavily')
  assert.equal(h.opened[0].focus, true)
  assert.ok(JSON.stringify(await h.render()).includes('tavily.pending'))
  gate.resolve(); assert.strictEqual(await call, answer)
  assert.equal((await readHistory(h.store)).rows[0].credits, 2)
  assert.doesNotMatch(JSON.stringify([...h.store.data.values()]), /hidden|api_key/)
  const restored = harness(h.store); await restored.start()
  const tree = await restored.render()
  assert.ok(nodes(tree).some(node => node.type === 'Link' && node.label === 'Title'))
  assert.ok(find(tree, 'tavily-history'))
  assert.ok(JSON.stringify(tree).includes('found'))
  assert.ok(!JSON.stringify(tree).includes('stale'))
})

test('each search reveals the pane even when its dock was dismissed', async () => {
  const h = harness(); await h.start()
  await h.dispatch('tool.call', { tool: SEARCH_TOOL, query: 'first' })
  await h.dispatch('tool.call', { tool: SEARCH_TOOL, query: 'second' })
  assert.equal(h.opened.length, 2)
  assert.ok(h.opened.every(open => open.focus === true))
  await h.dispatch('ui.close', { id: 'tavily' })
  await h.dispatch('tool.call', { tool: SEARCH_TOOL, query: 'third' })
  assert.equal(h.opened.length, 3)
  assert.equal(h.opened[2].focus, true)
})

test('exceptions, denials and MCP errors are preserved, sanitized and recorded', async () => {
  const h = harness(); await h.start()
  const failure = new Error('denied token=private')
  await assert.rejects(h.dispatch('tool.call', { tool: SEARCH_TOOL }, async () => { throw failure }), error => error === failure)
  const denial = { deny: 'Permission denied' }
  assert.strictEqual(await h.dispatch('tool.call', { tool: SEARCH_TOOL }, async () => denial), denial)
  const mcpError = { result: { isError: true, content: [{ type: 'text', text: 'server tvly-dev-secret' }] } }
  assert.strictEqual(await h.dispatch('tool.call', { tool: SEARCH_TOOL }, async () => mcpError), mcpError)
  const history = await readHistory(h.store)
  assert.equal(history.rows.length, 3)
  assert.ok(history.rows.every(row => row.status === 'error'))
  assert.doesNotMatch(JSON.stringify(history), /private|tvly-dev-secret/)
})

test('storage and UI failures cannot break a search or replace its exception', async () => {
  const h = harness(); await h.start()
  h.$.store.get = async () => { throw new Error('private store failure') }
  h.$.state.set = async () => { throw new Error('private UI failure') }
  h.$.ui.open = async () => { throw new Error('private UI failure') }
  const answer = { result: 'ok' }
  assert.strictEqual(await h.dispatch('tool.call', { tool: SEARCH_TOOL }, async () => answer), answer)
  const error = new Error('core failed')
  await assert.rejects(h.dispatch('tool.call', { tool: SEARCH_TOOL }, async () => { throw error }), value => value === error)
})

test('renders working input, permission-respecting search, history selection and refresh buttons', async () => {
  const h = harness(); await h.start()
  let tree = await h.render()
  assert.ok(JSON.stringify(tree).includes('tavily.empty'))
  assert.ok(find(tree, 'tavily-search').dimColor)
  await find(tree, 'tavily-query').onInput('a search')
  tree = await h.render()
  assert.equal(find(tree, 'tavily-search').dimColor, false)
  await find(tree, 'tavily-search').onPress()
  assert.deepEqual(h.calls, [{ tool: SEARCH_TOOL, query: 'a search' }])
  tree = await h.render()
  assert.ok(find(tree, 'tavily-history'))
  tree = await h.render()
  const selector = find(tree, 'tavily-history')
  assert.equal(selector.options.length, 2)
  await selector.onSelect(selector.options[1].value)
  assert.equal(find(await h.render(), 'tavily-history').value, selector.options[1].value)
  await h.dispatch('command.run', { command: 'tavily' })
  h.core(async () => { throw new Error('permission denied') })
  await find(tree, 'tavily-query').onSubmit('blocked')
  assert.ok(JSON.stringify(await h.render()).includes('permission denied'))
})

test('per-call keys preserve concurrent sessions; pruning keeps at most 50 bounded records', async () => {
  const store = sharedStore()
  await Promise.all(Array.from({ length: 65 }, (_, index) => saveRecord(store, { ...base(`id-${index}`, 1000 + index), status: 'success', answer: '😀'.repeat(10000) })))
  const history = await readHistory(store)
  assert.equal(history.rows.length, MAX_RECORDS)
  assert.equal(history.rows[0].id, 'id-64')
  assert.equal([...store.data.keys()].filter(key => key.startsWith(RECORD_PREFIX)).length, 50)
  assert.ok([...store.data.values()].every(value => byteSize(value) <= MAX_RECORD_BYTES))
  assert.ok(Buffer.byteLength(JSON.stringify([...store.data])) < 4 * 1024 * 1024)
  const h1 = harness(store), h2 = harness(store)
  await Promise.all([h1.start(), h2.start()])
  await Promise.all([h1.dispatch('tool.call', { tool: SEARCH_TOOL, query: 'session one' }, async () => ({})), h2.dispatch('tool.call', { tool: SEARCH_TOOL, query: 'session two' }, async () => ({}))])
  const queries = (await readHistory(store)).rows.map(row => row.query)
  assert.ok(queries.includes('session one'))
  assert.ok(queries.includes('session two'))
})

test('clear asks confirmation and suppresses in-flight calls across shared-store instances', async () => {
  const store = sharedStore(), a = harness(store), b = harness(store)
  await Promise.all([a.start(), b.start()])
  await a.dispatch('tool.call', { tool: SEARCH_TOOL, query: 'old' }, async () => ({}))
  const entered = deferred(), gate = deferred()
  const pending = b.dispatch('tool.call', { tool: SEARCH_TOOL, query: 'in flight' }, async () => { entered.resolve(); return gate.promise })
  await entered.promise
  a.confirm('tavily.keep')
  await find(await a.render(), 'tavily-history').onSelect('clear-history')
  assert.equal((await readHistory(store)).rows.length, 1)
  a.confirm('tavily.clear')
  await find(await a.render(), 'tavily-history').onSelect('clear-history')
  assert.ok(await store.get(WATERMARK_KEY))
  assert.ok(!JSON.stringify(await b.render()).includes('in flight'))
  gate.resolve({ result: { structuredContent: { answer: 'too late', results: [] } } }); await pending
  assert.equal((await readHistory(store)).rows.length, 0)
  assert.ok(!JSON.stringify(await a.render()).includes('too late'))
  assert.ok(!JSON.stringify(await b.render()).includes('too late'))
  const c = harness(store); await c.start()
  assert.ok(JSON.stringify(await c.render()).includes('tavily.empty'))
})

test('clear wins a write racing after its first watermark check', async () => {
  const store = sharedStore(), entered = deferred(), gate = deferred()
  const originalSet = store.set
  store.set = async (key, value) => { if (key.startsWith(RECORD_PREFIX)) { entered.resolve(); await gate.promise } await originalSet(key, value) }
  const writing = saveRecord(store, { ...base('racing'), status: 'success' })
  await entered.promise
  await clearHistory(store)
  gate.resolve()
  assert.equal(await writing, false)
  assert.deepEqual((await readHistory(store)).rows, [])
  assert.equal([...store.data.keys()].filter(key => key.startsWith(RECORD_PREFIX)).length, 0)
})

test('stale asynchronous refresh cannot restore cleared results in the pane', async () => {
  const store = sharedStore(), h = harness(store)
  await h.start()
  await h.dispatch('tool.call', { tool: SEARCH_TOOL, query: 'do not restore' }, async () => ({}))
  const tree = await h.render(), entered = deferred(), gate = deferred()
  const originalGet = store.get
  let blocked = false
  store.get = async key => {
    const value = await originalGet(key)
    if (!blocked && key.startsWith(RECORD_PREFIX)) { blocked = true; entered.resolve(); await gate.promise }
    return value
  }
  const refreshing = h.dispatch('command.run', { command: 'tavily' })
  await entered.promise
  await find(tree, 'tavily-history').onSelect('clear-history')
  gate.resolve(); await refreshing
  assert.ok(!JSON.stringify(await h.render()).includes('do not restore'))
  assert.deepEqual((await readHistory(store)).rows, [])
})

test('post-clear records use the persisted epoch and history controls survive unavailable tools', async () => {
  const store = sharedStore()
  await clearHistory(store)
  const mark = await watermark(store)
  assert.equal(await saveRecord(store, { ...base('old', mark.clearedAt), epoch: '', status: 'success' }), false)
  assert.equal(await saveRecord(store, { ...base('new', mark.clearedAt), epoch: mark.epoch, status: 'success' }), true)
  assert.equal((await readHistory(store)).rows[0].id, 'new')
  const h = harness(store); await h.start()
  h.$.tool.call = async () => { throw new Error('Tool unavailable') }
  await find(await h.render(), 'tavily-query').onSubmit('query')
  assert.ok(JSON.stringify(await h.render()).includes('Tool unavailable'))
  assert.ok(find(await h.render(), 'tavily-history'))
  await h.dispatch('ui.close', { id: 'tavily' })
  await h.dispatch('tool.call', { tool: SEARCH_TOOL }, async () => ({}))
  assert.ok(h.opened.length > 0)
  await tick()
})

for (const reenter of [false, true]) {
  test(`pane search tracks exactly once when own observer ${reenter ? 're-enters' : 'is skipped'}`, async () => {
    const h = harness(sharedStore(), { reenter }); await h.start()
    const gate = deferred(), entered = deferred()
    const data = { answer: 'pane result', results: [{ title: 'Source', url: 'https://example.com', content: 'body' }], usage: { credits: 3 } }
    const answer = { ref: 1, result: { content: [{ type: 'text', text: JSON.stringify(data) }] }, text: JSON.stringify(data), isReadOnly: false }
    h.core(async () => { entered.resolve(); await gate.promise; return answer })
    const tree = await h.render()
    await h.dispatch('ui.close', { id: 'tavily' })
    const searching = find(tree, 'tavily-query').onSubmit('same query')
    await entered.promise
    assert.equal(h.opened.length, 1)
    assert.equal(h.states.at(-1).value.pending.length, 1)
    assert.ok(JSON.stringify(await h.render()).includes('tavily.pending'))
    await h.dispatch('tool.call', { tool: SEARCH_TOOL, query: 'same query', tool_use_id: 'model-call' }, async () => ({ result: { results: [], answer: 'independent model call' } }))
    gate.resolve(); await searching
    const history = (await readHistory(h.store)).rows
    assert.equal(history.length, 2)
    assert.equal(history.filter(row => row.answer === 'pane result').length, 1)
    assert.equal(history.filter(row => row.answer === 'independent model call').length, 1)
    assert.equal(history.find(row => row.answer === 'pane result').credits, 3)
    assert.equal(h.states.at(-1).value.pending.length, 0)
    await find(await h.render(), 'tavily-history').onSelect(history.find(row => row.answer === 'pane result').id)
    assert.ok(JSON.stringify(await h.render()).includes('pane result'))
    assert.deepEqual(h.calls, [{ tool: SEARCH_TOOL, query: 'same query' }])
  })

  test(`pane errors are recorded without observer dependence (reentry ${reenter})`, async () => {
    const h = harness(sharedStore(), { reenter }); await h.start()
    for (const outcome of [new Error('denied token=secret'), { deny: 'permission denied' }, { ref: 1, result: undefined, text: 'tool failed', isError: true }]) {
      h.core(async () => { if (outcome instanceof Error) throw outcome; return outcome })
      await find(await h.render(), 'tavily-query').onSubmit('failure')
    }
    const history = (await readHistory(h.store)).rows
    assert.equal(history.length, 3)
    assert.ok(history.every(row => row.status === 'error'))
    assert.doesNotMatch(JSON.stringify(history), /token=secret/)
    assert.ok(history.some(row => row.error === 'tool failed'))
  })
}

test('clearing another instance suppresses a pane-initiated in-flight search with no observer', async () => {
  const store = sharedStore(), h = harness(store), other = harness(store)
  await Promise.all([h.start(), other.start()])
  const gate = deferred(), entered = deferred()
  h.core(async () => { entered.resolve(); return gate.promise })
  const searching = find(await h.render(), 'tavily-query').onSubmit('pending pane call')
  await entered.promise
  await find(await other.render(), 'tavily-history').onSelect('clear-history')
  gate.resolve({ ref: 1, result: { answer: 'must stay cleared', results: [] } }); await searching
  assert.deepEqual((await readHistory(store)).rows, [])
  assert.ok(!JSON.stringify(await h.render()).includes('must stay cleared'))
})

test('URL sanitizer runs with the hardened worker globals and needs no TextEncoder', () => {
  const source = readFileSync(new URL('../hooks/tavily/results.js', import.meta.url), 'utf8').replaceAll('export ', '')
  const result = runInNewContext(`${source}\n({ url: safeUrl('https://u:p@example.com/?api_key=private&q=ok#secret'), bytes: byteSize({ text: '😀' }) })`, { URL, TextEncoder: undefined, fetch: undefined })
  assert.equal(result.url, 'https://example.com/?q=ok')
  assert.equal(result.bytes, Buffer.byteLength(JSON.stringify({ text: '😀' })))
  assert.equal(runInNewContext(`${source}\nsafeUrl('https://example.com')`, { URL: undefined }), '')
})

test('application rate-limit, auth and quota envelopes are errors even with isError false', async () => {
  for (const code of ['ip_rate_limit_exceeded', 'unauthorized', 'quota_exceeded']) {
    const data = { code, message: 'Too many keyless requests token=private tvly-dev-secret', retry_after_seconds: 60, auth_mode: 'keyless' }
    for (const structured of [true, false]) {
      const reply = { ref: 1, result: { isError: false, ...(structured ? { structuredContent: data } : {}), content: [{ type: 'text', text: JSON.stringify(data) }] } }
      const record = completeRecord(base('error'), reply, undefined, Date.now())
      assert.equal(record.status, 'error')
      assert.equal(record.credits, null)
      assert.equal(record.total, null)
      assert.match(record.error, /^Too many keyless requests/)
      assert.doesNotMatch(record.error, /private|tvly-dev-secret|retry_after_seconds/)
      const h = harness(); await h.start()
      h.core(async () => reply)
      await find(await h.render(), 'tavily-query').onSubmit('search')
      assert.equal(h.calls.length, 1, 'application errors do not trigger retries')
      assert.equal((await readHistory(h.store)).rows[0].status, 'error')
      assert.ok(JSON.stringify(await h.render()).includes('Too many keyless requests'))
    }
  }
  const success = completeRecord(base('empty'), { result: { structuredContent: { code: 'ok', message: 'No matches', results: [] } } }, undefined, Date.now())
  assert.equal(success.status, 'success')
})

test('compact results hide history and unknown usage, expand previews without another request', async () => {
  const h = harness(); await h.start()
  const content = 'Long result text. '.repeat(40) + 'END OF PREVIEW'
  await h.dispatch('tool.call', { tool: SEARCH_TOOL, query: 'layout' }, async () => ({ result: { results: [{ title: 'Docs', url: 'https://www.example.com/deep/path?q=long', content }] } }))
  let tree = await h.render()
  assert.ok(find(tree, 'tavily-search-section'))
  assert.ok(find(tree, 'tavily-results-section'))
  assert.ok(find(tree, 'tavily-history'))
  assert.equal(find(tree, 'tavily-clear'), undefined)
  assert.ok(!JSON.stringify(tree).includes('tavily.unknown'))
  assert.ok(!JSON.stringify(tree).includes('tavily.usageNote'))
  assert.ok(!JSON.stringify(tree).includes('END OF PREVIEW'))
  assert.ok(nodes(tree).some(node => node.type === 'Text' && node.children.includes('example.com')))
  const expand = nodes(tree).find(node => node.key?.startsWith('tavily-expand-'))
  await expand.onPress()
  assert.ok(JSON.stringify(await h.render()).includes('END OF PREVIEW'))
  await find(await h.render(), expand.key).onPress()
  assert.ok(!JSON.stringify(await h.render()).includes('END OF PREVIEW'))
  assert.equal(h.calls.length, 0)
  tree = await h.render()
  assert.equal(find(tree, 'tavily-history').options[0].value, 'clear-history')
  assert.equal(nodes(tree).filter(node => node.type === 'Select').length, 1)
  await h.dispatch('tool.call', { tool: SEARCH_TOOL, query: 'zero credits' }, async () => ({ result: { results: [], usage: { credits: 0 } } }))
  assert.ok(JSON.stringify(await h.render()).includes('tavily.creditCount'))
})

test('history first option clears with confirmation and cancellation preserves selection', async () => {
  const h = harness(); await h.start()
  for (const query of ['first', 'second']) await h.dispatch('tool.call', { tool: SEARCH_TOOL, query }, async () => ({ result: { results: [] } }))
  let select = find(await h.render(), 'tavily-history')
  assert.equal(select.options[0].value, 'clear-history')
  const chosen = select.options[2].value
  await select.onSelect(chosen)
  h.confirm('tavily.keep')
  await find(await h.render(), 'tavily-history').onSelect('clear-history')
  assert.equal(find(await h.render(), 'tavily-history').value, chosen)
  assert.equal((await readHistory(h.store)).rows.length, 2)
  h.confirm('tavily.clear')
  await find(await h.render(), 'tavily-history').onSelect('clear-history')
  select = find(await h.render(), 'tavily-history')
  assert.equal(select.value, 'empty')
  assert.equal(select.options[0].value, 'clear-history')
  assert.equal((await readHistory(h.store)).rows.length, 0)
})

test('query precedes results and history labels shrink with pane width', () => {
  const ui = Object.fromEntries(['Box', 'Text', 'Input', 'Button', 'Select', 'Link'].map(type => [type, props => ({ type, ...props })]))
  const query = '中文搜索标题非常长'.repeat(30)
  const view = { rows: [boundedRecord({ id: 'long', query, status: 'success', startedAt: 1000 })], pending: [], draft: '', expanded: [] }
  const narrow = tavilyTree(ui, view, key => key, {}, 40)
  const wide = tavilyTree(ui, view, key => key, {}, 100)
  const results = find(narrow, 'tavily-results-section')
  assert.equal(results.children[0].children[0], 'tavily.queryLabel')
  assert.equal(results.children[1].children[0], 'tavily.results')
  const label = tree => find(tree, 'tavily-history').options[1].label
  assert.ok(label(narrow).endsWith('...'))
  assert.ok(label(narrow).length < label(wide).length)
  assert.equal(find(narrow, 'tavily-history').options[1].value, 'long')
  assert.equal(view.rows[0].query, query)
})

test('a missing Tavily key is named in the panel on /tavily and after a failed search; a saved one is not', async () => {
  let saved = false
  const h = harness(sharedStore(), { setup: async () => saved })
  await h.start()
  await h.dispatch('command.run', { command: 'tavily' })
  const notice = tree => nodes(tree).some(node => node.key === 'tavily-setup')
  assert.ok(notice(await h.render()))
  assert.ok(nodes(await h.render()).some(node => node.children?.some(child => typeof child === 'string' && child.startsWith('setup.tavily.label: setup.tavily.missing'))))
  saved = true
  await h.dispatch('command.run', { command: 'tavily' })
  assert.ok(!notice(await h.render()))
  saved = false
  h.core(async () => { throw new Error('tool mcp__tavily__tavily_search is not available') })
  const search = nodes(await h.render()).find(node => node.key === 'tavily-search')
  await h.dispatch('ui.render', { component: 'Pane', requestId: 'tavily' })
  const input = nodes(await h.render()).find(node => node.key === 'tavily-query')
  await input.onInput('news')
  await search.onPress()
  assert.ok(notice(await h.render()))
})
