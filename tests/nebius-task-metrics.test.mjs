import test from 'node:test'
import assert from 'node:assert/strict'
import { tasksTree, taskOutcome, persistenceOf } from '../hooks/sandbox/tasks.js'

const allowed = {
  Box: ['key', 'flexDirection', 'justifyContent', 'alignItems', 'gap', 'width', 'flexShrink', 'borderStyle', 'borderDimColor', 'padding'],
  Text: ['size', 'wrap', 'dimColor', 'weight', 'color', 'mono', 'underline'],
  Button: ['key', 'plain', 'label', 'onPress'],
  Code: ['source', 'language', 'wrap'],
}
const ui = Object.fromEntries(Object.entries(allowed).map(([type, keys]) => [type, ({ children = [], ...props }) => {
  for (const key of Object.keys(props)) assert.ok(keys.includes(key), `Unsafe ${type} prop: ${key}`)
  return { type, props, children }
}]))
const flatten = node => typeof node === 'object' && node !== null ? [node, ...node.children.flatMap(flatten)] : []
const strings = node => typeof node === 'string' ? node : node.children.map(strings).join(' ')
const find = (tree, key) => flatten(tree).find(node => node.props.key === key)
const metric = (tree, key) => {
  const node = find(tree, `task-metric-${key}`)
  return node ? strings(node.children[1]) : undefined
}
const t = key => ({ 'taskMetrics.true': 'true', 'taskMetrics.false': 'false' })[key] ?? key
function render(task, view = {}, actions = {}, translate = t) {
  return tasksTree(ui, { latestTask: task, ops: [], ...view }, translate, {
    togglePanel() {}, clearHistory() {}, backLatest() {}, selectImage() {}, inspectOperation() {}, cancel() {}, toggleTaskDetail() {}, ...actions,
  }, 0)
}

const raw = {
  status: 'SUCCESS', duration: 1.25, consumed_cpu: 0.024075, consumed_memory: 10888,
  image_uuid: 'source-image', result_image_uuid: 'result-image',
  metadata: { result: {
    resources: { elapsed_time: 0.446, system_cpu_time: 0, user_cpu_time: 0.024075, max_rss: 10888 },
    state: { exit_code: 0, timed_out: false },
  } },
}

test('raw REST summary converts seconds and peak RSS to explicit decimal units', () => {
  const tree = render({ value: raw })
  assert.equal(metric(tree, 'executionTime'), '446 ms')
  assert.equal(metric(tree, 'operationDuration'), undefined)
  assert.equal(metric(tree, 'systemCpu'), '0 ms')
  assert.equal(metric(tree, 'consumedCpu'), '24 ms')
  assert.equal(metric(tree, 'userCpu'), '24 ms')
  assert.equal(metric(tree, 'peakRam'), '11.15 MB')
  assert.equal(metric(tree, 'imageSize'), '—')
  assert.equal(metric(tree, 'exitCode'), '0')
  assert.equal(metric(tree, 'timedOut'), 'false')
  assert.equal(metric(tree, 'status'), 'tasks.success')
  assert.equal(find(tree, 'task-metrics').props.flexDirection, 'column')
  for (const node of flatten(tree).filter(node => node.props.key?.startsWith('task-metric-'))) {
    assert.equal(node.props.justifyContent, 'space-between')
    assert.equal(node.children.length, 2)
  }
})

test('flattened MCP result uses operation duration and does not fabricate system/user CPU', () => {
  const tree = render({ value: { status: 'SUCCESS', duration: 0.446, consumed_cpu: 0.024075, consumed_memory: 10888, exit_code: 0, timed_out: false } })
  assert.equal(metric(tree, 'operationDuration'), '446 ms')
  assert.equal(metric(tree, 'executionTime'), undefined)
  assert.equal(metric(tree, 'consumedCpu'), '24 ms')
  assert.equal(metric(tree, 'peakRam'), '11.15 MB')
  assert.equal(metric(tree, 'systemCpu'), '—')
  assert.equal(metric(tree, 'userCpu'), '—')
  assert.equal(metric(tree, 'exitCode'), '0')
  assert.equal(metric(tree, 'timedOut'), 'false')
})

test('missing, nonnumeric and nonfinite metrics remain distinct from zero', () => {
  for (const absent of [undefined, null, NaN, Infinity, '0']) {
    const tree = render({ value: { duration: absent, consumed_cpu: absent, consumed_memory: absent, image_size: absent, exit_code: absent, timed_out: absent } })
    for (const key of ['operationDuration', 'consumedCpu', 'peakRam', 'imageSize', 'exitCode', 'timedOut', 'sourceImage', 'resultImage']) assert.equal(metric(tree, key), '—')
  }
  const tree = render({ value: { duration: 0, consumed_cpu: 0, consumed_memory: 0, image_size: 0, exit_code: 0, timed_out: false } })
  assert.equal(metric(tree, 'operationDuration'), '0 ms')
  assert.equal(metric(tree, 'consumedCpu'), '0 ms')
  assert.equal(metric(tree, 'peakRam'), '0 B')
  assert.equal(metric(tree, 'imageSize'), '0 B')
  assert.equal(metric(tree, 'exitCode'), '0')
  assert.equal(metric(tree, 'timedOut'), 'false')
})

test('nested zero metrics take precedence over flattened fallback values', () => {
  const tree = render({ value: { ...raw, metadata: { result: { resources: { elapsed_time: 0, max_rss: 0, system_cpu_time: 0, user_cpu_time: 0 }, state: { exit_code: 0, timed_out: false } } } } })
  assert.equal(metric(tree, 'executionTime'), '0 ms')
  assert.equal(metric(tree, 'peakRam'), '0 B')
  assert.equal(metric(tree, 'userCpu'), '0 ms')
})

test('seconds and image bytes scale to appropriate explicit units', () => {
  for (const [size, expected] of [[999, '999 B'], [1000, '1 KB'], [1234567, '1.23 MB'], [1234567890, '1.23 GB']]) {
    const tree = render({ value: { duration: 1.25, image_size: size } })
    assert.equal(metric(tree, 'imageSize'), expected)
    assert.equal(metric(tree, 'operationDuration'), '1.25 s')
  }
  assert.equal(metric(render({ value: { duration: 1 } }), 'operationDuration'), '1 s')
})

test('API latency has its own row and never supplies execution or operation duration', () => {
  const tree = render({ value: {}, callSeconds: 0.446 })
  assert.equal(metric(tree, 'apiTime'), '446 ms')
  assert.equal(metric(tree, 'operationDuration'), '—')
  assert.equal(metric(tree, 'executionTime'), undefined)
  assert.equal(metric(render({ value: raw, callSeconds: 2.5 }), 'apiTime'), '2.5 s')
  assert.equal(metric(render({ value: {}, callSeconds: 0 }), 'apiTime'), '0 ms')
})

test('status retains process, platform, asynchronous and API outcome semantics', () => {
  const cases = [
    [{ value: raw }, 'success'],
    [{ value: { status: 'SUCCESS', exit_code: 2 } }, 'commandFailed'],
    [{ value: { status: 'SUCCESS' } }, 'unknown'],
    [{ value: { status: 'SUCCESS', metadata: { result: { state: { timed_out: true, exit_code: 0 } } } } }, 'timeout'],
    [{ value: { status: 'CANCELLED' } }, 'cancelled'],
    [{ value: { status: 'FAILED' } }, 'platform'],
    [{ value: { signal: 9 } }, 'terminated'],
    [{ failed: true }, 'apiFailed'],
    [{ value: { isError: true } }, 'apiFailed'],
    [{ error: 'network failed' }, 'apiFailed'],
    [{ value: { status: 'EXECUTING' } }, 'running'],
    [{ pending: true }, 'running'],
    [{ async: true }, 'submitted'],
    [{ value: {} }, 'returned'],
  ]
  for (const [task, outcome] of cases) {
    assert.equal(taskOutcome(task), outcome)
    assert.equal(metric(render(task), 'status'), `tasks.${outcome}`)
  }
  assert.equal(persistenceOf({ value: raw }), 'saved')
  assert.equal(persistenceOf({ disposable: true }), 'temporary')
})

test('image links preserve keys, navigation and historical/latest selection', () => {
  const selected = []
  const latestTask = { callId: 'new-call', value: { image_uuid: 'latest-source' } }
  const history = { id: 'remote-op', remote: true, value: raw }
  const tree = render(latestTask, { showHistory: true, operationDetail: history }, { selectImage: id => selected.push(id) })
  for (const key of ['task-source-image', 'task-result-image']) {
    const button = find(tree, key)
    assert.equal(button.children[0].props.underline, true)
    button.props.onPress()
  }
  assert.deepEqual(selected, ['source-image', 'result-image'])
  assert.equal(metric(tree, 'operation'), 'remote-op')
  assert.ok(find(tree, 'task-back-latest'))
  assert.equal(find(render(latestTask, { showHistory: false, operationDetail: history }), 'task-source-image').props.label, 'latest-source')
  for (const result of [{ result_image: 'saved' }, { result: { image: 'saved' } }]) assert.equal(find(render({ value: result }), 'task-result-image').props.label, 'saved')
})

test('request and full response stay collapsed and disclosures use the selected task key', () => {
  const task = { callId: 'call-1', method: 'run', args: { command: 'true' }, value: raw }
  const toggles = []
  const tree = render(task, {}, { toggleTaskDetail: (...args) => toggles.push(args) })
  assert.equal(flatten(tree).filter(node => node.type === 'Code').length, 0)
  find(tree, 'task-request').props.onPress()
  find(tree, 'task-raw').props.onPress()
  assert.deepEqual(toggles, [['latest:call-1', 'request'], ['latest:call-1', 'raw']])
  const expanded = render(task, { taskDisclosure: { key: 'latest:call-1', request: true, raw: true } })
  assert.equal(flatten(expanded).filter(node => node.type === 'Code').length, 3)
  const history = render(task, { showHistory: true, operationDetail: { id: 'op-1', value: raw }, taskDisclosure: { key: 'latest:call-1', raw: true } }, { toggleTaskDetail: (...args) => toggles.push(args) })
  assert.equal(flatten(history).filter(node => node.type === 'Code').length, 0)
  find(history, 'task-raw').props.onPress()
  assert.deepEqual(toggles.at(-1), ['history:op-1', 'raw'])
})

test('metric headings, labels and boolean values use taskMetrics translations', () => {
  const keys = []
  const tree = render({ value: raw }, {}, {}, key => { keys.push(key); return `translated:${key}` })
  for (const key of ['summary', 'resources', 'status', 'executionTime', 'sourceImage', 'resultImage', 'systemCpu', 'consumedCpu', 'userCpu', 'peakRam', 'imageSize', 'exitCode', 'timedOut', 'false']) assert.ok(keys.includes(`taskMetrics.${key}`))
  assert.equal(metric(tree, 'timedOut'), 'translated:taskMetrics.false')
  assert.equal(metric(render({ value: { timed_out: true } }), 'timedOut'), 'true')
})

test('local-only pending history never exposes a remote cancellation action', () => {
  const tree = render(null, { showHistory: true, ops: [
    { id: 'local-call', remote: false, state: 'PENDING' },
    { id: 'offline-call', local: true, state: 'EXECUTING' },
    { state: 'PENDING' },
    { id: 'remote-op', state: 'EXECUTING' },
  ] })
  assert.equal(find(tree, 'cancel:local-call'), undefined)
  assert.equal(find(tree, 'cancel:offline-call'), undefined)
  assert.equal(find(tree, 'cancel:undefined'), undefined)
  assert.ok(find(tree, 'cancel:remote-op'))
})

test('restored interrupted tasks show unknown and saved cloud tasks retain cancellation', () => {
  assert.equal(taskOutcome({ interrupted: true, pending: false, value: { status: 'RUNNING' } }), 'unknown')
  const tree = render(null, { showHistory: true, ops: [{ id: 'cloud-op', local: true, remote: true, state: 'PENDING' }] })
  assert.ok(find(tree, 'cancel:cloud-op'))
  assert.equal(metric(render(null, { showHistory: true, operationDetail: { recordId: 'local', remote: false, value: {} } }), 'operation'), undefined)
})

test('Summary starts with the full tool name for latest and saved tasks', () => {
  const latest = { method: 'mcp__contree__run', value: raw }
  const tree = render(latest)
  const summary = find(tree, 'task-metrics').children[0]
  assert.equal(summary.children[1].props.key, 'task-metric-tool')
  assert.equal(summary.children[2].props.key, 'task-metric-status')
  assert.equal(metric(tree, 'tool'), 'mcp__contree__run')
  const historical = render(latest, { showHistory: true, operationDetail: { method: 'mcp__contree__list_files', value: {} } })
  assert.equal(metric(historical, 'tool'), 'mcp__contree__list_files')
  assert.equal(metric(render({ value: raw }), 'tool'), '—')
})
