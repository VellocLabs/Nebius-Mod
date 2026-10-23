/** Global, independent records: sessions never overwrite a shared history array. */
import { isActive } from './replies.js'
export const HISTORY_CLEAR_PREFIX = 'sandbox-history-clear/'
export const HISTORY_PREFIX = 'sandbox-task/'
export const HISTORY_MARK = 'sandbox-history-generation'
export const HISTORY_LIMIT = 50
export const HISTORY_RECORD_BYTES = 16 * 1024
const CLEARED = 'history-cleared-before'
const secretKey = /api[\W_]*key|access[\W_]*key|private[\W_]*key|token|password|passwd|secret|credential|authorization|cookie|^env$/i
const encoder = new TextEncoder()
let sequence = 0
const unique = () => `${Date.now().toString(36)}-${String(++sequence).padStart(8, '0')}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`

/** Sanitize before truncating, including quoted JSON/CLI credentials and HTTP URL credentials. */
export function historyDetail(value) {
  const secrets = new Set()
  const seen = new WeakSet()
  function collect(v, sensitive = false, depth = 0) {
    if (depth > 12) return
    if (typeof v === 'string' && sensitive && v) secrets.add(v)
    if (!v || typeof v !== 'object' || seen.has(v)) return
    seen.add(v)
    for (const [key, item] of Object.entries(v)) collect(item, sensitive || (key.toLowerCase() !== 'env' && secretKey.test(key)), depth + 1)
  }
  collect(value)
  const scrub = text => {
    for (const secret of secrets) text = text.split(secret).join('[redacted]')
    return text
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted]')
      .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>]+/gi, '[redacted]')
      .replace(/((?:[\w.-]*(?:api[_-]?key|access[_-]?key|private[_-]?key|token|password|passwd|secret|credential|authorization|cookie)[\w.-]*)["']?\s*(?:[=:]\s*|\s+))(?:("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|[^\s,;}&]+)/gi, '$1[redacted]')
      .replace(/\b(?:sk-[\w-]{12,}|tvly-[\w-]{12,}|gh[pousr]_[\w]{12,}|AKIA[A-Z0-9]{16}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[redacted]')
      .replace(/https?:\/\/[^\s"'<>]+/gi, raw => {
        try {
          const url = new URL(raw)
          if (url.username || url.password) { url.username = ''; url.password = '' }
          if (url.search) url.search = '?[redacted]'
          if (url.hash) url.hash = '#[redacted]'
          return url.toString()
        } catch { return '[redacted URL]' }
      })
      .replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  }
  let nodes = 0
  function clean(v, depth = 0) {
    if (typeof v === 'string') return scrub(v).slice(0, 3000)
    if (v && typeof v === 'object' && (++nodes > 160 || depth > 7)) return '[truncated]'
    if (Array.isArray(v)) return v.slice(0, 30).map(item => clean(item, depth + 1))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 40).map(([key, item]) => [scrub(key).slice(0, 100), secretKey.test(key) ? '[redacted]' : clean(item, depth + 1)]))
    return typeof v === 'number' && Number.isFinite(v) || typeof v === 'boolean' || v === null ? v : undefined
  }
  return clean(value)
}

export function sanitizeTask(record) {
  // Internal identifiers never participate in payload secret discovery/substitution.
  const metadata = ['recordId', 'generation', 'callId', 'id']
  const fields = ['method', 'startedAt', 'finishedAt', 'callSeconds', 'pending', 'async', 'remote', 'failed', 'timeout', 'disposable', 'laneAdvanced', 'summary', 'kind', 'args', 'value', 'error']
  const safe = historyDetail(Object.fromEntries(fields.filter(field => record[field] !== undefined).map(field => [field, record[field]])))
  for (const field of metadata) {
    if (typeof record[field] === 'string' && record[field].length <= 512 && /^[\w:./%-]*$/.test(record[field])) safe[field] = record[field]
  }
  return safe
}

function bounded(record) {
  const safe = sanitizeTask(record)
  for (const field of ['value', 'args', 'error']) {
    if (encoder.encode(JSON.stringify(safe)).length <= HISTORY_RECORD_BYTES) break
    safe[field] = { output: '[truncated]' }
  }
  // Even malformed metadata cannot exceed the per-record quota.
  for (const field of Object.keys(safe).reverse()) {
    if (encoder.encode(JSON.stringify(safe)).length <= HISTORY_RECORD_BYTES) break
    if (!['recordId', 'generation', 'startedAt'].includes(field)) delete safe[field]
  }
  return safe
}

export function historyRows(records, remote = []) {
  const rows = new Map(remote.map(row => [row.id, row]))
  for (const task of records) {
    const id = task.id || task.recordId
    if (rows.has(id) && rows.get(id).local) continue
    const result = task.value?.metadata?.result?.state ?? task.value ?? {}
    const failed = task.failed || task.error || result.timed_out || (Number.isFinite(result.exit_code) && result.exit_code !== 0)
    rows.set(id, { id, local: true, remote: task.remote === true && !!task.id, interrupted: task.interrupted === true, kind: task.kind ?? task.method?.split('__').at(-1) ?? 'operation', createdAt: task.startedAt,
      state: task.interrupted ? 'UNKNOWN' : failed ? 'FAILED' : task.pending || task.async ? 'RUNNING' : String(task.value?.status ?? task.value?.state ?? 'SUCCESS').toUpperCase() })
  }
  return [...rows.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, HISTORY_LIMIT)
}

export function createTaskHistory(store) {
  let queue = Promise.resolve()
  const serial = fn => { const work = queue.then(fn); queue = work.catch(() => undefined); return work }
  async function marker() {
    const legacy = await store.get(HISTORY_MARK)
    const before = Math.max(Number(legacy?.before) || 0, Number(await store.get(CLEARED)) || 0)
    // Retry a snapshot whose entries were compacted concurrently; its successor may
    // have been published after keys() and must be included before choosing a winner.
    for (;;) {
      const keys = (await store.keys()).filter(key => key.startsWith(HISTORY_CLEAR_PREFIX))
      const entries = await Promise.all(keys.map(async key => ({ key, mark: await store.get(key) })))
      if (entries.some(entry => !entry.mark)) continue
      const marks = entries.filter(entry => typeof entry.mark.generation === 'string' && Number.isFinite(entry.mark.before))
      marks.sort((a, b) => b.mark.before - a.mark.before || b.mark.generation.localeCompare(a.mark.generation))
      const winner = marks[0]?.mark
      return { generation: winner?.generation ?? (typeof legacy?.generation === 'string' ? legacy.generation : ''), before: Math.max(before, winner?.before ?? 0), entries: marks }
    }
  }
  async function scan(mark) {
    const records = []
    for (const key of await store.keys()) {
      if (!key.startsWith(HISTORY_PREFIX)) continue
      const record = await store.get(key)
      if (!record || record.generation !== mark.generation || !record.recordId || !Number.isFinite(record.startedAt)) {
        if ((await marker()).generation === mark.generation) await store.delete(key)
        continue
      }
      records.push(record)
    }
    records.sort((a, b) => b.startedAt - a.startedAt || b.recordId.localeCompare(a.recordId))
    for (const record of records.slice(HISTORY_LIMIT)) await store.delete(HISTORY_PREFIX + record.recordId)
    return records.slice(0, HISTORY_LIMIT)
  }
  return {
    begin: async task => {
      try { const mark = await marker(); return bounded({ ...task, recordId: unique(), generation: mark.generation }) } catch { return null }
    },
    load: () => serial(async () => {
      try {
        let mark = await marker()
        let records = await scan(mark)
        const after = await marker()
        if (after.generation !== mark.generation) { mark = after; records = await scan(mark) }
        return { ...mark, records }
      } catch { return null }
    }),
    save: task => serial(async () => {
      if (!task || typeof task.recordId !== 'string' || typeof task.generation !== 'string') return false
      try {
        const mark = await marker()
        if (task.generation !== mark.generation) return false
        const key = HISTORY_PREFIX + task.recordId
        const previous = await store.get(key)
        if (previous && !previous.summary && task.summary) return true
        const active = record => record.value?.status || record.value?.state ? isActive(record.value) : record.pending || record.async
        if (previous && !previous.summary && !active(previous) && active(task)) return true
        await store.set(key, bounded(task))
        const after = await marker()
        if (after.generation !== task.generation) { await store.delete(key); return false }
        await scan(after)
        return true
      } catch { return false } // History must never change the tool's result or exception.
    }),
    summaries: (operations, generation) => serial(async () => {
      try {
        const mark = await marker()
        if (mark.generation !== generation) return
        const records = await scan(mark)
        for (const op of operations) {
          if (!op.id || !Number.isFinite(op.createdAt) || op.createdAt <= mark.before) continue
          const previous = records.find(record => record.id === op.id)
          if (previous && !previous.summary) continue
          const task = bounded({ ...previous, recordId: previous?.recordId ?? `remote:${encodeURIComponent(op.id).slice(0, 400)}`, generation,
            id: op.id, remote: true, summary: true, kind: op.kind, startedAt: op.createdAt, pending: false,
            async: isActive(op), value: { status: op.state } })
          const key = HISTORY_PREFIX + task.recordId
          // Recheck the key: a detail fetch may have finished while scanning.
          const current = await store.get(key)
          if (current?.generation === generation && !current.summary) continue
          await store.set(key, task)
          if ((await marker()).generation !== generation) { await store.delete(key); break }
        }
        await scan(await marker())
      } catch { /* Best-effort summary cache, just like detailed task writes. */ }
    }),
    clear: () => serial(async () => {
      const previous = await marker()
      const mark = { generation: unique(), before: Math.max(Date.now(), previous.before + 1) }
      // Immutable tombstones make concurrent clears commutative: maximum timestamp,
      // then generation, wins regardless of write order. Never overwrite a watermark.
      await store.set(HISTORY_CLEAR_PREFIX + mark.generation, mark)
      const effective = await marker()
      // Compact ONLY observed, dominated markers. A concurrently published unseen
      // marker is untouched. Any concurrent removal of the winner retains a successor.
      for (const entry of effective.entries.slice(1)) await store.delete(entry.key)
      await scan(await marker())
      return effective
    }),
  }
}
