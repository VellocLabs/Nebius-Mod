/**
 * Nebius Sandboxes in the session: lanes over the contree MCP server's tools,
 * a parallel test matrix, a Sandbox pane and a status line.
 *
 * - `tool.call` on the contree tools: `lane:<name>` becomes the lane's head
 *   image, a saving run moves the head, credential-like env names are refused,
 *   a long timeout is cut (`guardCall`). Sub-agents' calls arrive here too, with
 *   their `agentId`.
 * - Registered tools (`mcp__nebius__sandbox_*`): lanes, a new lane, release,
 *   drop, a patch out of a lane, and the test matrix.
 * - `/sandbox` opens the pane; it polls `list_operations` while it is open or
 *   while something runs.
 * - With `auto_approve_remote` on, `tool.check` allows the contree tools that
 *   touch only the sandbox; the ones that read or write local files still ask.
 * - `nebius_setup` checks what Sandboxes and Tavily search still need; a server
 *   that does not connect is checked the same way for the pane, and the own
 *   tools' failures carry the check's report.
 */

import { registerTavily } from './tavily.js'
import {
  CONTREE_SERVER,
  REMOTE_ONLY_TOOLS,
  advanceLane,
  contreeToolNames,
  contreeToolOf,
  createLane,
  describeLanes,
  dropLane,
  guardCall,
  isLaneName,
  releaseOwner,
  resolveImage,
  secretLikeEnvNames,
} from './sandbox/lanes.js'
import { isActive, missingPermissions, operationIdOf, replyOf, resultImageOf } from './sandbox/replies.js'
import { MATRIX_SCHEMA, planMatrix, summarize } from './sandbox/matrix.js'
import { normalizeOperations, paneTree } from './sandbox/view.js'
import { loadTexts } from './sandbox/texts.js'
import { createTaskHistory, historyDetail, historyRows, sanitizeTask } from './sandbox/history.js'
import { createImageCatalog } from './sandbox/images.js'
import { createFileBrowser } from './sandbox/files.js'
import { migrateLanes, readGlobalLanes, writeLaneChanges } from './sandbox/storage.js'
import { patchCommand, PATCH_OUTPUT_LIMIT, PATCH_INLINE_LIMIT } from './sandbox/patch.js'
import { PARTS, probeSetup, setupChecks, setupReport } from './setup.js'

const PLUGIN = 'nebius'
const PANE_ID = 'sandbox'
const COMMAND = 'sandbox'
const TICK_MS = 3000
const IDLE_TICKS = 10
const WAIT_SLICE_SECONDS = 240
const TRACK_KEEP_MS = 24 * 3600 * 1000
const ALL_CONTREE_TOOLS = [...REMOTE_ONLY_TOOLS, 'rsync', 'upload', 'download']

/** The plugin's own tools; `sandbox_lane_patch` can write a local file, so it is never auto-approved. */
const OWN_TOOLS = {
  nebius_setup: {
    description: 'Check what Nebius Sandboxes (cloud microVMs for running code) or Tavily web search still need before the user\'s request can run. Call it first when the user wants something run in a sandbox or the cloud, or asks to search the web, and whenever a sandbox or Tavily tool is missing or fails. Answers one line per requirement, who does it (you, after the user agrees, or the user), and what to do next. Reads no key.',
    inputSchema: {
      type: 'object',
      properties: { part: { type: 'string', enum: ['sandbox', 'search'], description: 'Only what the request needs: sandbox to run code in the cloud; search only when the user asked for web search.' } },
      required: ['part'],
    },
  },
  sandbox_lanes: {
    description: 'List the global sandbox lanes shared across sessions: each lane is a chain of images; its head is the newest. Use lane:<name> as the image of any contree tool to work on that lane.',
    inputSchema: { type: 'object', properties: {} },
  },
  sandbox_lane_new: {
    description: 'Start a lane: a named line of work whose head image moves each time a run with disposable:false saves onto it. One lane per agent working in parallel; the first agent that saves onto a lane owns it until it stops.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Letters, digits, ".", "_", "-"; up to 48.' },
        from: { type: 'string', description: 'Image UUID, tag:<name> or lane:<name> to start from. Defaults to the plugin\'s default image.' },
      },
      required: ['name'],
    },
  },
  sandbox_lane_release: {
    description: 'Free a lane from the agent that owns it, so another agent (or the main conversation) can save onto it.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  sandbox_lane_drop: {
    description: 'Forget a lane. Its images stay in the sandbox account; only the name and its head are dropped.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  sandbox_lane_patch: {
    description: 'Take the changes of a lane out as a git patch: runs `git add -A` and `git diff --cached --binary <since>` in the lane\'s head (a throw-away run) and returns the patch, or writes it to `out` (a local path) and returns a summary. Apply it locally with `git apply --index`, one lane at a time. The lane\'s image needs git and the project\'s `.git` (sync without excluding `.git`); work left uncommitted in the image is what the patch carries.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The lane.' },
        path: { type: 'string', description: 'The git work tree inside the sandbox, e.g. /app.' },
        since: { type: 'string', description: 'The commit to diff against. Default HEAD (uncommitted work only).' },
        out: { type: 'string', description: 'A local file to write the patch to, relative to the session folder.' },
      },
      required: ['name', 'path'],
    },
  },
  sandbox_test_matrix: {
    description: `Run up to 50 commands at once, each in its own throw-away microVM started from the same image, wait for all of them, and answer one summary: passed/failed per shard and the output tail of every shard that did not pass. Use it for test shards, a version matrix or flaky-test repeats. Start it from an image that already has the dependencies installed (a run with disposable:false, or a lane), so no shard installs them again.`,
    inputSchema: MATRIX_SCHEMA,
  },
}
/** Not connected, cannot start, never started: a failure the setup check explains. */
const SERVER_DOWN = /not connected|did not connect|cannot start|did not start|not built/i

/** The own tools the pane records as sandbox tasks; the setup check is not one. */
const TRACKED_OWN = Object.keys(OWN_TOOLS).filter(name => name !== 'nebius_setup')
const AUTO_APPROVED_OWN = ['sandbox_lanes', 'sandbox_lane_new', 'sandbox_lane_release', 'sandbox_lane_drop', 'sandbox_test_matrix']

/** A registered tool's full name, as the engine lists it. */
function ownToolName(name) {
  return `mcp__${PLUGIN}__${name}`
}

function textOf(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && Array.isArray(value.content)) {
    return value.content.filter(block => block && block.type === 'text').map(block => block.text).join('\n')
  }
  return ''
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function optionString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function optionNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

export function register(on, options = {}) {
  const config = {
    defaultImage: optionString(options.default_image),
    maxRunSeconds: optionNumber(options.max_run_seconds, 1800),
    autoApprove: options.auto_approve_remote === true,
  }
  registerTavily(on, { setup: async $ => (await probeSetup($, { parts: ['search'] })).tavilyKey })

  let root = null
  let t = key => key
  let tEn = key => key
  let lanes = {}
  let view = { section: 'tasks', latestTask: null, mcp: null, lanes: [], ops: [], updatedAt: null, error: null, selectedLane: null, calls: [], totalCalls: 0, lastCall: null, quota: null, browser: null }
  let paneOpen = false
  let opening = null
  let statsKey = null
  let saveStatsQueue = Promise.resolve()
  let callSeq = 0
  let detailSeq = 0
  let clearedBefore = 0
  let history = null
  let historyGeneration = ''
  let historyRecords = []
  let latestSeq = 0

  // Pending is live only when this runtime still owns the actual call. Other
  // sessions/restarts display uncertainty without mutating another owner's record.
  function presentedTask(task) {
    return task?.pending && !view.calls.some(call => call.id === task.callId)
      ? { ...task, pending: false, async: false, interrupted: true }
      : task
  }

  async function reloadHistory() {
    const saved = await history?.load()
    if (!saved) return
    if (saved.generation !== historyGeneration) {
      latestSeq++
      detailSeq++
      tracked.clear()
      view = { ...view, latestTask: null, operationDetail: null, ops: [], taskDisclosure: null }
    }
    historyGeneration = saved.generation
    clearedBefore = saved.before
    historyRecords = saved.records
    callRecords.clear()
    for (const task of historyRecords) {
      const id = task.id || task.recordId
      if (!callRecords.has(id)) callRecords.set(id, task)
    }
    const remote = view.ops.filter(op => !op.local && (op.createdAt ?? 0) > clearedBefore)
    const latest = presentedTask(historyRecords[0])
    view = { ...view, ops: historyRows(historyRecords.map(presentedTask), remote), latestTask: latest && (!view.latestTask || latest.startedAt >= (view.latestTask.startedAt ?? 0)) ? latest : view.latestTask }
  }

  async function saveTask(task) {
    await history?.save(task)
    await reloadHistory()
  }

  async function remoteTask($, id, existing) {
    const seed = existing
    if (!seed || seed.generation !== historyGeneration || (seed.summary && seed.startedAt <= clearedBefore)) return null
    const value = await callContree($, 'get_operation', { operation_id: id })
    const task = { ...seed, id, remote: true, summary: false, pending: false, async: isActive(value), value: historyDetail(value), error: undefined }
    await saveTask(task)
    return task
  }
  async function refreshLatest($, id) {
    const seq = ++latestSeq
    const existing = view.latestTask
    try {
      const task = await remoteTask($, id, callRecords.get(id))
      if (!task || seq !== latestSeq || task.generation !== historyGeneration) return
      if (!view.latestTask || view.latestTask.id === id || view.latestTask === existing) view = { ...view, latestTask: task }
    } catch (error) {
      if (seq === latestSeq && view.latestTask === existing) view = { ...view, latestTask: { ...(existing?.id === id ? existing : {}), id, remote: true, error: historyDetail(messageOf(error)) } }
    }
    await publish($)
  }
  const callRecords = new Map()
  async function inspectOperation(id, force = false) {
    await reloadHistory()
    const cached = callRecords.get(id)
    if (!cached && !view.ops.some(op => op.id === id)) return
    if (!force && cached && !cached.summary && (cached.value !== undefined || cached.error || cached.pending)) {
      detailSeq++
      view = { ...view, operationDetail: presentedTask(cached) }
      await publish(root)
      return
    }
    // Capture the generation before publishing (which can yield to Clear).
    const seed = cached ?? await history?.begin({ id, remote: true, summary: true, startedAt: view.ops.find(op => op.id === id)?.createdAt ?? 0 })
    const seq = ++detailSeq
    view = { ...view, operationDetail: { ...presentedTask(cached), id, loading: true } }
    await publish(root)
    try {
      const task = await remoteTask(root, id, seed)
      if (task && seq === detailSeq && task.generation === historyGeneration) view = { ...view, operationDetail: task }
    } catch (error) {
      if (seq === detailSeq) view = { ...view, operationDetail: { ...presentedTask(cached), id, loading: false, error: historyDetail(messageOf(error)) } }
    }
    if (seq === detailSeq) await publish(root)
  }
  const browser = createFileBrowser(
    (image, path) => callContree(root, 'list_files', { image, path }),
    async snapshot => { view = { ...view, browser: snapshot }; if (root) await publish(root) },
    { sleep: ms => root.clock.sleep(ms), read: (image, path) => callContree(root, 'read_file', { image, path }) },
  )

  const catalog = createImageCatalog(
    (tool, args) => callContree(root, tool, args),
    async images => { view = { ...view, images }; if (root) await publish(root) },
  )

  async function syncBrowser() {
    if (view.section === 'tasks') return
    if (view.section === 'images') {
      await browser.select(null, view.selectedImage ?? null)
      return
    }
    const lane = lanes[view.selectedLane]
    const selected = view.laneSnapshots?.[lane?.name]
    const image = selected && (lane?.history ?? []).includes(selected) ? selected : lane?.head
    await browser.select(lane?.name ?? null, image ?? null)
    if (lane) void Promise.all([...new Set([...(lane.history ?? []), lane.head])].map(id => catalog.inspect(id)))
  }

  async function openPanel($, focus = false) {
    if (paneOpen && !focus) return
    if (opening) return opening
    opening = (async () => {
      const result = await $.ui.open({ id: PANE_ID, title: t('pane.title'), ...(focus ? { focus: true } : {}) })
      paneOpen = result?.isPlaced === true
    })()
    try { await opening } finally { opening = null }
  }

  function laneFor(e) {
    if (e.tool?.startsWith('mcp__nebius__sandbox_lane_') && typeof e.name === 'string') return e.name
    const image = e.image ?? e.image_uuid ?? e.from
    if (typeof image !== 'string') return null
    if (image.startsWith('lane:')) return image.slice(5)
    const matches = Object.values(lanes).filter(lane => lane.head === image)
    return matches.length === 1 ? matches[0].name : null
  }

  function dataOf(answer) {
    const raw = answer?.result
    return replyOf({ structured: raw?.structuredContent ?? (raw && typeof raw === 'object' && !raw.content ? raw : undefined), text: answer?.text || textOf(raw) || (typeof raw === 'string' ? raw : '') })
  }

  function quotaOf(reply) {
    const number = value => Number.isFinite(value) && value >= 0 ? value : null
    return { running: number(reply?.operations_stat?.running_instances), max: number(reply?.limits?.instance_max_concurrency), tokenExpiration: reply?.token_expiration === null ? null : number(reply?.token_expiration) ?? undefined, maxTimeout: number(reply?.limits?.instance_max_timeout), at: Date.now() }
  }
  let poller = null
  let ticks = 0
  let refreshing = false
  const tracked = new Map()

  const now = () => Date.now()
  const viewRef = $ => ({ plugin: $.plugin.name, key: 'view' })

  async function callContree($, tool, args) {
    const result = await $.mcp.call(CONTREE_SERVER, tool, args)
    const text = textOf(result)
    if (result?.isError) throw new Error(text || `${tool} failed`)
    return replyOf({ structured: result?.structuredContent, text })
  }

  async function reloadLanes($) {
    lanes = await readGlobalLanes($.store)
    if (!lanes[view.selectedLane]) view = { ...view, selectedLane: Object.keys(lanes)[0] ?? null }
    await catalog.updateLanes(Object.values(lanes))
    if (paneOpen) void syncBrowser()
  }

  async function publish($) {
    view = { ...view, lanes: Object.values(lanes) }
    await $.state.set(viewRef($), view).catch(() => undefined)
  }

  // One probe at a time per set of parts: the poller re-checks a down server.
  const probing = new Map()
  function probeOnce($, parts) {
    const key = parts.join(',')
    if (!probing.has(key)) probing.set(key, probeSetup($, { parts }).finally(() => probing.delete(key)))
    return probing.get(key)
  }

  /** The setup rows of `parts`, kept in the view for the pane. */
  async function runSetup($, parts = PARTS) {
    const facts = await probeOnce($, parts)
    const checks = setupChecks(facts, { mcp: view.mcp, defaultImage: config.defaultImage, parts })
    if (parts.includes('sandbox')) view = { ...view, setup: checks.filter(check => check.id !== 'tavily') }
    await publish($)
    return checks
  }

  async function setupTool($, e) {
    const parts = e.part === 'search' ? ['search'] : e.part === 'all' ? PARTS : ['sandbox']
    if (parts.includes('sandbox') && !(view.mcp?.isConnected && !view.mcp.authError && !view.mcp.missing)) await checkServer($)
    return { result: setupReport(await runSetup($, parts), tEn) }
  }

  async function checkServer($) {
    try {
      const connected = await $.mcp.connect(CONTREE_SERVER)
      let mcp = { isConnected: connected.isConnected === true, reason: connected.message ?? connected.reason }
      if (mcp.isConnected) {
        try {
          const identity = await callContree($, 'whoami', {})
          view = { ...view, quota: quotaOf(identity) }
          const missing = missingPermissions(identity)
          if (missing.length > 0) mcp = { isConnected: true, missing }
        } catch (error) {
          mcp = { isConnected: true, authError: messageOf(error).slice(0, 300) }
        }
      }
      view = { ...view, mcp }
    } catch (error) {
      view = { ...view, mcp: { isConnected: false, reason: messageOf(error) } }
    }
    const healthy = view.mcp.isConnected && !view.mcp.authError && !view.mcp.missing
    if (healthy) view = { ...view, setup: null }
    await publish($)
    if (!healthy) void runSetup($, ['sandbox']).catch(() => undefined)
  }

  async function refresh($) {
    if (refreshing) return
    refreshing = true
    try {
      await reloadLanes($)
      await reloadHistory()
      const blocked = () => !view.mcp?.isConnected || view.mcp.authError || view.mcp.missing
      if (blocked()) await checkServer($)
      if (blocked()) return
      const identity = await callContree($, 'whoami', {})
      view = { ...view, quota: quotaOf(identity) }
      const listGeneration = historyGeneration
      const reply = await callContree($, 'list_operations', { limit: 20 })
      await reloadHistory()
      const ops = normalizeOperations(reply, tracked, 50).filter(op => (op.createdAt ?? 0) > clearedBefore)
      await history?.summaries(ops, listGeneration)
      await reloadHistory()
      for (const task of historyRecords.filter(task => !task.summary && task.remote && task.id && !task.pending && (task.async || isActive(task.value)))) {
        try { await remoteTask($, task.id, task) } catch { /* Keep the last offline snapshot, retry next poll. */ }
      }
      for (const operation of reply?.operations ?? []) await catalog.observe(operation)
      for (const [id, entry] of tracked) {
        const op = ops.find(each => each.id === id)
        if ((op && !isActive(op)) || now() - entry.startedAt > TRACK_KEEP_MS) tracked.delete(id)
      }
      await reloadHistory()
      view = { ...view, ops: historyRows(historyRecords.map(presentedTask), ops.filter(op => (op.createdAt ?? 0) > clearedBefore)), updatedAt: now(), error: null }
      const latest = view.latestTask
      if (latest?.summary) await refreshLatest($, latest.id)
      else if (!latest && view.ops[0]) await refreshLatest($, view.ops[0].id)
    } catch (error) {
      view = { ...view, updatedAt: now(), error: messageOf(error) }
    } finally {
      refreshing = false
      await publish($)
    }
  }

  function startPoller($) {
    if (poller) return
    poller = $.clock.every(TICK_MS, () => {
      ticks += 1
      const busy = view.calls.length > 0 || tracked.size > 0 || view.ops.some(op => !op.interrupted && isActive(op)) || view.latestTask?.async || isActive(view.latestTask?.value)
      if (!busy && !paneOpen) return
      if (!busy && ticks % IDLE_TICKS !== 0) return
      void refresh(root)
    })
  }

  async function setLanes($, next) {
    if (next === lanes) return
    await writeLaneChanges($.store, lanes, next)
    await reloadLanes($)
  }

  const actions = {
    inspectOperation,
    clearHistory: async () => {
      const answer = await root.ui.ask(t('history.confirm'), [t('history.clear'), t('action.keep')]).catch(() => null)
      if (answer !== t('history.clear')) return
      try { await history.clear() } catch { return }
      latestSeq++
      detailSeq++
      tracked.clear()
      callRecords.clear()
      view = { ...view, latestTask: null, ops: [], operationDetail: null, taskDisclosure: null }
      await reloadHistory()
      await publish(root)
    },
    backLatest: async () => {
      detailSeq++
      view = { ...view, operationDetail: null, taskDisclosure: null }
      await publish(root)
    },
    toggleTaskDetail: async (key, part) => {
      if (!['request','raw'].includes(part)) return
      const held = view.taskDisclosure?.key === key ? view.taskDisclosure : { key }
      view = { ...view, taskDisclosure: { ...held, [part]: !held[part] } }
      await publish(root)
    },
    togglePanel: async key => {
      if (!['showDetails', 'showHistory'].includes(key)) return
      view = { ...view, [key]: !view[key] }
      await publish(root)
    },
    copyImage: uuid => root.ui.copy({ text: uuid }),
    backImages: async () => {
      view = { ...view, selectedImage: null }
      await publish(root)
      await syncBrowser()
    },
    searchImages: async value => { view = { ...view, imageQuery: value }; await publish(root) },
    showSection: async section => {
      view = { ...view, section }
      await catalog.updateLanes(Object.values(lanes))
      await syncBrowser()
      if (section === 'images' && !view.images?.loaded) await catalog.fetch(true)
      if (section === 'tasks') await refresh(root)
    },
    selectImage: async uuid => {
      view = { ...view, section: 'images', selectedImage: uuid, operationDetail: null }
      detailSeq++
      await publish(root)
      await syncBrowser()
    },
    refreshImages: () => catalog.fetch(true),
    moreImages: () => catalog.fetch(false, { filter: view.imageFilter ?? 'saved', query: view.imageQuery ?? '' }),
    selectSnapshot: async value => {
      const lane = lanes[view.selectedLane]
      if (!lane || (value !== lane.head && !(lane.history ?? []).includes(value))) return
      view = { ...view, operationDetail: null, laneSnapshots: { ...view.laneSnapshots, [lane.name]: value === lane.head ? null : value } }
      detailSeq++
      await publish(root)
      await syncBrowser()
    },
    selectLane: async name => {
      if (!lanes[name]) return
      detailSeq++
      view = { ...view, section: 'lanes', selectedLane: name, operationDetail: null, laneSnapshots: { ...view.laneSnapshots, [name]: null } }
      await publish(root)
      await syncBrowser()
    },
    imageFilter: async filter => {
      if (!['saved','catalog'].includes(filter)) return
      view = { ...view, imageFilter: filter }
      await publish(root)
    },
    retryDirectory: path => browser.retry(path),
    toggleDirectory: path => browser.toggle(path),
    selectFile: entry => browser.selectFile(entry),
    refreshFiles: () => browser.refresh(),
    refresh: async () => {
      await refresh(root)
      const selected = view.operationDetail
      if (selected?.id && selected.remote) await inspectOperation(selected.id, true)
      await browser.refresh()
    },
    reconnect: async () => {
      view = { ...view, mcp: null }
      await checkServer(root)
      await refresh(root)
    },
    cancel: async id => {
      try {
        await callContree(root, 'cancel_operation', { operation_id: id })
        await root.ui.toast(t('toast.cancelled', { id }))
      } catch (error) {
        await root.ui.toast(t('toast.cancelFailed', { id, message: messageOf(error) }))
      }
      await refresh(root)
    },
    drop: async name => {
      const answer = await root.ui.ask(t('lane.confirmDrop', { name }), [t('pane.drop'), t('action.keep')]).catch(() => null)
      if (answer !== t('pane.drop')) return
      await reloadLanes(root)
      await setLanes(root, dropLane(lanes, name))
      await root.ui.toast(t('toast.dropped', { name }))
    },
  }

  // ── Own tools ──

  async function laneNew($, e) {
    const resolved = resolveImage(e.from, lanes, config.defaultImage)
    if (resolved.error) return { deny: resolved.error }
    if (!isLaneName(e.name)) return { deny: `"${e.name}" is not a lane name: letters, digits, ".", "_", "-", up to 48` }
    let image = resolved.image
    if (!resolved.lane) {
      try {
        const found = await callContree($, 'get_image', { image })
        if (found && typeof found.uuid === 'string') image = found.uuid
      } catch (error) {
        return { deny: `could not look up image ${image}: ${messageOf(error)}` }
      }
    }
    const made = createLane(lanes, { name: e.name, image, owner: null, now: now() })
    if (made.error) return { deny: made.error }
    await setLanes($, made.lanes)
    return { result: `Lane ${e.name} starts at ${image}. Use image "lane:${e.name}" with disposable:false to save onto it.` }
  }

  async function lanePatch($, e) {
    const lane = lanes[e.name]
    if (!lane) return { deny: `there is no lane "${e.name}"` }
    const command = patchCommand(e.path, e.since)
    if (command.error) return { deny: command.error }
    let reply
    try {
      reply = await callContree($, 'run', {
        command: command.text,
        image: lane.head,
        disposable: true,
        timeout: 300,
        truncate_output_at: PATCH_OUTPUT_LIMIT,
      })
    } catch (error) {
      return { deny: `the patch run failed: ${messageOf(error)}` }
    }
    if (!reply || typeof reply !== 'object') return { deny: 'the patch run answered nothing readable' }
    const patch = typeof reply.stdout === 'string' ? reply.stdout : ''
    if (reply.exit_code !== 0) return { deny: `git failed in ${e.path} (exit ${reply.exit_code}): ${String(reply.stderr ?? patch).slice(0, 2000)}` }
    if (patch.trim() === '') return { result: `Lane ${e.name} has no changes in ${e.path} since ${e.since ?? 'HEAD'}.` }
    const isCut = patch.length >= PATCH_OUTPUT_LIMIT
    const files = (patch.match(/^diff --git /gm) ?? []).length
    if (typeof e.out === 'string' && e.out.trim() !== '') {
      if (isCut) return { deny: `the patch is larger than ${PATCH_OUTPUT_LIMIT} bytes and was cut; take it out in parts (narrow path)` }
      await $.fs.write(e.out, patch)
      return { result: `Wrote the patch of lane ${e.name} (${files} files, ${patch.length} bytes) to ${e.out}. Apply it with: git apply --index ${e.out}` }
    }
    if (isCut || patch.length > PATCH_INLINE_LIMIT) {
      return { deny: `the patch is ${patch.length}${isCut ? '+' : ''} bytes; pass out:<file> to write it to disk instead` }
    }
    return { result: patch }
  }

  async function testMatrix($, e) {
    const resolved = resolveImage(e.image, lanes, config.defaultImage)
    if (resolved.error) return { deny: resolved.error }
    const secrets = secretLikeEnvNames(e.env)
    if (secrets.length > 0) return { deny: `refused: ${secrets.join(', ')} look like credentials; the sandbox must not receive keys or tokens` }
    const input = typeof e.timeout === 'number' && e.timeout > config.maxRunSeconds ? { ...e, timeout: config.maxRunSeconds } : e
    const plan = planMatrix(input, resolved.image)
    if (plan.error) return { deny: plan.error }

    const started = await Promise.all(
      plan.shards.map(async shard => {
        try {
          const reply = await callContree($, 'run', shard.args)
          const operationId = operationIdOf(reply)
          if (!operationId) return { name: shard.name, command: shard.args.command, error: `run answered no operation id: ${JSON.stringify(reply).slice(0, 300)}` }
          tracked.set(operationId, { lane: resolved.lane, agentId: e.agentId, startedAt: now() })
          return { name: shard.name, command: shard.args.command, operationId }
        } catch (error) {
          return { name: shard.name, command: shard.args.command, error: messageOf(error) }
        }
      }),
    )
    void refresh($)

    const pending = new Set(started.map(shard => shard.operationId).filter(Boolean))
    const merged = { results: {}, completed: [], cancelled: [], timed_out: false }
    const deadline = now() + ((typeof input.timeout === 'number' ? input.timeout : config.maxRunSeconds) + 120) * 1000
    while (pending.size > 0) {
      if (now() > deadline) {
        merged.timed_out = true
        break
      }
      let waited
      try {
        waited = await callContree($, 'wait_operations', { operation_ids: [...pending], mode: 'all', timeout: WAIT_SLICE_SECONDS })
      } catch (error) {
        merged.timed_out = true
        merged.error = messageOf(error)
        break
      }
      for (const [id, result] of Object.entries(waited?.results ?? {})) {
        merged.results[id] = result
        if (!isActive(result)) pending.delete(id)
      }
      for (const id of waited?.cancelled ?? []) {
        merged.cancelled.push(id)
        pending.delete(id)
      }
      if (waited?.timed_out !== true && Object.keys(waited?.results ?? {}).length === 0) break
    }
    void refresh($)
    const summary = summarize(resolved.lane ? `lane:${resolved.lane} (${resolved.image})` : resolved.image, started, merged)
    return { result: merged.error ? `${summary.text}\n\nwait_operations failed: ${merged.error}` : summary.text }
  }

  async function ownTool($, e) {
    const name = e.tool.slice(e.tool.lastIndexOf('__') + 2)
    switch (name) {
      case 'nebius_setup':
        return setupTool($, e)
      case 'sandbox_lanes':
        return { result: describeLanes(lanes) }
      case 'sandbox_lane_new':
        return laneNew($, e)
      case 'sandbox_lane_release': {
        const lane = lanes[e.name]
        if (!lane) return { deny: `there is no lane "${e.name}"` }
        await setLanes($, { ...lanes, [e.name]: { ...lane, owner: null, updatedAt: now() } })
        return { result: `Lane ${e.name} is free.` }
      }
      case 'sandbox_lane_drop': {
        if (!lanes[e.name]) return { deny: `there is no lane "${e.name}"` }
        await setLanes($, dropLane(lanes, e.name))
        return { result: `Lane ${e.name} was dropped; its images are still in the account.` }
      }
      case 'sandbox_lane_patch':
        return lanePatch($, e)
      case 'sandbox_test_matrix':
        return testMatrix($, e)
      default:
        return { deny: `unknown tool ${e.tool}` }
    }
  }

  // ── Hooks ──

  on('session.start', async ($, e, next) => {
    root = $
    history = createTaskHistory($.store)
    await reloadHistory()
    // Clear any composer status left by an older plugin version; all status lives in the pane.
    await $.ui.status(undefined).catch(() => undefined)
    t = await loadTexts($)
    tEn = await loadTexts($, 'en')
    lanes = await migrateLanes($.store)
    statsKey = `monitor/${await $.session.id()}`
    const stats = await $.store.get(statsKey).catch(() => null)
    view = { ...view, selectedLane: Object.keys(lanes)[0] ?? null, totalCalls: Number.isSafeInteger(stats?.totalCalls) ? stats.totalCalls : 0 }
    for (const [name, spec] of Object.entries(OWN_TOOLS)) {
      await $.tool.register({ name, ...spec })
    }
    await $.command.register({ name: COMMAND, description: t('command.description'), argumentHint: '[lanes]' })
    startPoller($)
    await publish($)
    void checkServer($)
    return next(e)
  })

  // Outer observer: preserve the existing guards and results; never count our own polling.
  on('tool.call', { tool: [...contreeToolNames(ALL_CONTREE_TOOLS), ...TRACKED_OWN.map(ownToolName)] }, async ($, e, next) => {
    await reloadLanes($)
    await reloadHistory()
    let id = `call:${++callSeq}`
    const started = now()
    const lane = laneFor(e)
    const { tool_use_id, agentId: caller, ...taskInput } = e
    latestSeq++
    let task = await history?.begin({ callId: id, method: e.tool, args: taskInput, startedAt: started, pending: true, timeout: e.tool === 'mcp__contree__run' ? Math.min(e.timeout ?? 30, config.maxRunSeconds) : e.timeout, disposable: e.tool === 'mcp__contree__run' ? e.disposable !== false : undefined })
    if (task) { id = task.recordId; task = { ...task, callId: id } }
    const liveTask = task ?? historyDetail({ callId: id, method: e.tool, args: taskInput, startedAt: started, pending: true })
    view = { ...view, latestTask: liveTask, totalCalls: view.totalCalls + 1, selectedLane: lane && lanes[lane] ? lane : view.selectedLane, calls: [...view.calls, { id, tool: e.tool, lane, started }] }
    if (statsKey) {
      const totalCalls = view.totalCalls
      saveStatsQueue = saveStatsQueue.then(() => $.store.set(statsKey, { totalCalls })).catch(() => undefined)
    }
    await saveTask(task)
    await publish($)
    // Automatic opening never takes keyboard focus from the prompt.
    if (!e.agentId) await openPanel($).catch(() => undefined)
    if (paneOpen) void syncBrowser()
    let answer
    let failure
    try {
      answer = await next(e)
      return answer
    } catch (error) {
      failure = error
      throw error
    } finally {
      const data = dataOf(answer)
      const metric = key => Number.isFinite(data?.[key]) ? data[key] : null
      const failed = !!failure || !!answer?.deny || answer?.isError === true || answer?.result?.isError === true || data?.timed_out === true || (typeof data?.exit_code === 'number' && data.exit_code !== 0) || ['FAILED', 'CANCELLED'].includes(data?.status)
      view = { ...view, calls: view.calls.filter(call => call.id !== id), lastCall: {
        tool: e.tool, callSeconds: (now() - started) / 1000, duration: metric('duration'), cpu: metric('consumed_cpu'), memory: metric('consumed_memory'), exit: metric('exit_code'), failed,
        async: e.wait === false && !failed,
      } }
      const remote = ['mcp__contree__run','mcp__contree__import_image'].includes(e.tool)
      const completed = sanitizeTask({ ...liveTask, args: taskInput, pending: false, failed, async: remote && e.wait === false && !failed, remote, id: remote ? operationIdOf(data) : null, finishedAt: now(), callSeconds: (now()-started)/1000, value: data && typeof data === 'object' ? data : { output: data }, error: failure ? messageOf(failure) : answer?.deny, laneAdvanced: lane && resultImageOf(data) === lanes[lane]?.head ? lane : null })
      if (view.latestTask?.callId === id) view = { ...view, latestTask: completed }
      task = task ? { ...completed, recordId: task.recordId, generation: task.generation } : null
      await saveTask(task)
      if (!failure && !answer?.deny) {
        const results = e.tool === 'mcp__contree__wait_operations' ? data?.results : e.tool === 'mcp__contree__get_operation' ? { [e.operation_id]: data } : null
        for (const [operation, value] of Object.entries(results ?? {})) {
          const previous = callRecords.get(operation)
          if (previous?.remote) await saveTask({ ...previous, value: historyDetail(value), pending: false, async: isActive(value), error: undefined })
        }
      }
      if (e.tool === 'mcp__contree__whoami' && !failed) view = { ...view, quota: quotaOf(data) }
      if (lane && lanes[lane] && !failed) view = { ...view, selectedLane: lane }
      if (data && typeof data === 'object') {
        await catalog.observe(data)
      }
      await publish($)
      if (paneOpen) void syncBrowser()
    }
  })

  on('tool.call', { tool: contreeToolNames(ALL_CONTREE_TOOLS) }, async ($, e, next) => {
    const tool = contreeToolOf(e.tool)
    const { tool: _tool, tool_use_id: _id, agentId, ...args } = e
    const guarded = guardCall(tool, args, { lanes, agentId, defaultImage: config.defaultImage, maxRunSeconds: config.maxRunSeconds })
    if (guarded.deny) return { deny: guarded.deny }
    const ran = await next({ ...e, ...guarded.args })
    if (tool !== 'run' || ran?.isError) return ran

    const reply = dataOf(ran)
    const operationId = guarded.args.wait === false ? operationIdOf(reply) : null
    if (operationId) {
      tracked.set(operationId, { lane: guarded.lane, agentId, startedAt: now() })
      void refresh($)
    }
    if (guarded.lane && guarded.saves) {
      const image = resultImageOf(reply)
      if (image) {
        await setLanes($, advanceLane(lanes, guarded.lane, image, agentId, now()))
        return { ...ran, context: [`Lane ${guarded.lane} now ends at ${image}; keep using image "lane:${guarded.lane}".`] }
      }
    }
    return ran
  })

  /** A refusal caused by setup, with the setup report after it. */
  async function explained($, answer) {
    const reason = answer?.deny
    if (typeof reason !== 'string') return answer
    const image = /no default image/.test(reason)
    if (!image && !SERVER_DOWN.test(reason)) return answer
    const checks = await runSetup($, ['sandbox']).catch(() => null)
    return checks ? { deny: `${reason}\n\n${setupReport(checks, tEn)}` } : answer
  }

  on('tool.call', { tool: Object.keys(OWN_TOOLS).map(ownToolName) }, async ($, e) => {
    try {
      return await explained($, await ownTool($, e))
    } catch (error) {
      return explained($, { deny: `${e.tool} failed: ${messageOf(error)}` })
    }
  })

  on('tool.check', { tool: [...contreeToolNames(ALL_CONTREE_TOOLS), ...TRACKED_OWN.map(ownToolName)] }, async ($, e, next) => {
    const seed = await history?.begin({ method: e.tool, args: e.input ?? {}, startedAt: now(), pending: false, failed: true })
    const verdict = await next(e)
    if (verdict?.decision === 'deny' && seed) {
      const task = sanitizeTask({ ...seed, args: e.input ?? {}, error: verdict.reason ?? 'Denied' })
      await saveTask(task)
      await publish($)
    }
    return verdict
  })

  // A local, read-only check: `uvx --version` and settings presence, never a key.
  on('tool.check', { tool: ownToolName('nebius_setup') }, async () => ({ decision: 'allow', reason: 'nebius: setup check reads no key and changes nothing' }))

  if (config.autoApprove) {
    const approved = [...contreeToolNames(REMOTE_ONLY_TOOLS), ...AUTO_APPROVED_OWN.map(ownToolName)]
    on('tool.check', { tool: approved }, async ($, e, next) => {
      const verdict = await next(e)
      return verdict?.decision === 'ask' ? { decision: 'allow', reason: 'nebius: remote-only sandbox tool, approved in the plugin\'s settings' } : verdict
    })
  }

  on('classic.SubagentStop', async ($, e, next) => {
    const result = await next(e)
    const agentId = typeof e.agent_id === 'string' ? e.agent_id : undefined
    if (agentId && root) await setLanes(root, releaseOwner(lanes, agentId, now()))
    return result
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    await reloadLanes($)
    await reloadHistory()
    if (e.args.trim() === 'lanes') return { text: t('command.lanes', { lanes: describeLanes(lanes) }) }
    view = { ...view, section: 'tasks' }
    await publish($)
    await openPanel($, true)
    void syncBrowser()
    void refresh(root ?? $)
    return {}
  })

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const result = await next(e)
    if (result?.deny === undefined) paneOpen = false
    return result
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    paneOpen = true
    const ui = await $.ui.resolve(e)
    const read = await $.state.get(viewRef($))
    const current = read && read.value && typeof read.value === 'object' ? read.value : view
    return paneTree(ui, current, t, actions, now())
  })
}

