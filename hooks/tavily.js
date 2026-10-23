import { loadTexts } from './sandbox/texts.js'
import { SEARCH_TOOL, boundedRecord, completeRecord, safeText } from './tavily/results.js'
import { clearHistory, currentRecord, readHistory, saveRecord, uniqueId, watermark } from './tavily/storage.js'
import { tavilyTree } from './tavily/view.js'

/** `setup($)`: whether the Tavily key is saved (`true`/`false`), `null` when it cannot tell. */
export function registerTavily(on, { setup } = {}) {
  let root
  let t = key => key
  let view = { rows: [], pending: [], selected: null, draft: '', error: null, submitting: false, historySelection: 0, expanded: [] }
  let mark = { epoch: '', clearedAt: -1 }
  let revision = 0
  let draft = ''
  let opening
  let paneOpen = false
  let publishing = Promise.resolve()
  const ref = $ => ({ plugin: $.plugin.name, key: 'tavily-view' })

  async function quietly(action) {
    try { return await action() } catch { return undefined }
  }

  async function publish($) {
    const snapshot = view
    publishing = publishing.catch(() => undefined).then(() => $.state.set(ref($), snapshot))
    await publishing
  }

  function acceptMark(next) {
    if (mark.epoch === next.epoch) return
    mark = next
    revision++
    view = { ...view, rows: view.rows.filter(row => currentRecord(row, mark)), pending: view.pending.filter(row => currentRecord(row, mark)), selected: null, expanded: [], error: null }
  }

  async function refresh($) {
    const version = ++revision
    const history = await readHistory($.store)
    if (version !== revision) return
    const latest = await watermark($.store)
    if (version !== revision || latest.epoch !== history.mark.epoch) return
    acceptMark(history.mark)
    view = { ...view, rows: history.rows, error: null }
    await publish($)
  }

  /** Marks the panel when the Tavily key is known to be missing. */
  async function checkKey($) {
    if (!setup) return
    const saved = await quietly(() => setup($))
    view = { ...view, missingKey: saved === false }
    await quietly(() => publish($))
  }

  async function open($, focus = false) {
    if (paneOpen && !focus) return
    if (opening) return opening
    opening = (async () => {
      const result = await $.ui.open({ id: 'tavily', title: t('tavily.title'), ...(focus ? { focus: true } : {}) })
      paneOpen = result?.isPlaced === true
    })()
    try { await opening } finally { opening = null }
  }

  async function trackSearch($, e, run) {
    let record
    const startedAt = Date.now()
    await quietly(async () => {
      acceptMark(await watermark($.store))
      record = boundedRecord({ id: uniqueId(), epoch: mark.epoch, startedAt, status: 'pending', query: e.query })
      revision++
      view = { ...view, pending: [...view.pending, record].slice(-50), selected: null, historySelection: view.historySelection + 1, expanded: [], error: null }
      await publish($)
    })
    await quietly(() => open($, true))
    let answer
    let failure
    try {
      answer = await run()
      return answer
    } catch (error) {
      failure = error
      throw error
    } finally {
      const finishedAt = Date.now()
      await quietly(async () => {
        if (!record) return
        revision++
        view = { ...view, pending: view.pending.filter(row => row.id !== record.id) }
        const completed = completeRecord(record, answer, failure, finishedAt)
        acceptMark(await watermark($.store))
        if (currentRecord(completed, mark)) {
          view = { ...view, rows: [completed, ...view.rows.filter(row => row.id !== completed.id)].sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id)).slice(0, 50) }
          await publish($)
          await saveRecord($.store, completed)
        }
        await refresh($)
      })
    }
  }

  let panelCall = null

  const actions = {
    toggleResult: async key => {
      view = { ...view, expanded: view.expanded.includes(key) ? view.expanded.filter(value => value !== key) : [...view.expanded, key] }
      await quietly(() => publish(root))
    },
    input: async value => {
      draft = typeof value === 'string' ? value.slice(0, 2000) : ''
      view = { ...view, draft: safeText(draft, 2000) }
      await quietly(() => publish(root))
    },
    search: async value => {
      const query = (typeof value === 'string' ? value : draft).trim()
      if (!query || view.submitting) return
      view = { ...view, submitting: true, error: null }
      await quietly(() => publish(root))
      try {
        const input = { tool: SEARCH_TOOL, query }
        const result = await trackSearch(root, input, async () => {
          panelCall = { observed: false }
          try { return await root.tool.call(input) } finally { panelCall = null }
        })
        if (result?.deny !== undefined) view = { ...view, error: safeText(result.deny) || t('tavily.failed') }
      } catch (error) {
        view = { ...view, error: safeText(error instanceof Error ? error.message : String(error)) || t('tavily.failed') }
      } finally {
        if (view.error) await checkKey(root)
        view = { ...view, submitting: false }
        await quietly(() => publish(root))
      }
    },
    select: async id => {
      if (id === 'clear-history') {
        await actions.clear()
        view = { ...view, historySelection: view.historySelection + 1 }
        await quietly(() => publish(root))
        return
      }
      revision++
      acceptMark(await watermark(root.store))
      if (id === 'latest' || [...view.rows, ...view.pending].some(row => row.id === id)) view = { ...view, selected: id === 'latest' ? null : id, expanded: [] }
      await quietly(() => publish(root))
    },
    clear: async () => {
      const answer = await quietly(() => root.ui.ask(t('tavily.confirmClear'), [t('tavily.clear'), t('tavily.keep')]))
      if (answer !== t('tavily.clear')) return
      revision++
      try {
        const next = await clearHistory(root.store)
        acceptMark(next)
        view = { ...view, rows: [], pending: [], selected: null, expanded: [], error: null }
        await refresh(root)
      } catch { view = { ...view, error: t('tavily.historyError') } }
      await quietly(() => publish(root))
    },
  }

  on('session.start', async ($, e, next) => {
    root = $
    t = await loadTexts($)
    await $.command.register({ name: 'tavily', description: t('tavily.command') })
    await quietly(() => refresh($))
    return next(e)
  })

  on('tool.call', { tool: SEARCH_TOOL }, async ($, e, next) => {
    // The host may re-enter this observer from a UI action, or skip it entirely.
    if (panelCall && !panelCall.observed && next.origin?.plugin === $.plugin.name) {
      panelCall.observed = true
      return next(e)
    }
    return trackSearch($, e, () => next(e))
  })

  on('command.run', { command: 'tavily' }, async ($) => {
    await quietly(() => refresh($))
    await checkKey($)
    await open($, true)
    return {}
  })

  on('ui.close', { id: 'tavily' }, async ($, e, next) => {
    const result = await next(e)
    if (result?.deny === undefined) paneOpen = false
    return result
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== 'tavily') return next(e)
    paneOpen = true
    await quietly(() => $.state.get(ref($)))
    await quietly(async () => acceptMark(await watermark($.store)))
    return tavilyTree(await $.ui.resolve(e), view, t, actions, e.props?.bodyColumns)
  })
}
