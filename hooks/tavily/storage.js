import { boundedRecord } from './results.js'

export const RECORD_PREFIX = 'tavily-call/'
export const WATERMARK_KEY = 'tavily-cleared'
export const MAX_RECORDS = 50
let sequence = 0
export const uniqueId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${(++sequence).toString(36)}`

export async function watermark(store) {
  const value = await store.get(WATERMARK_KEY)
  return { epoch: typeof value?.epoch === 'string' ? value.epoch : '', clearedAt: Number.isFinite(value?.clearedAt) ? value.clearedAt : -1 }
}

export function currentRecord(record, mark) {
  return record.epoch === mark.epoch && (mark.epoch !== '' || record.startedAt > mark.clearedAt)
}

export async function readHistory(store) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const mark = await watermark(store)
    const entries = []
    for (const key of (await store.keys()).filter(key => key.startsWith(RECORD_PREFIX))) {
      const raw = await store.get(key)
      if (raw?.id && key === RECORD_PREFIX + raw.id) entries.push({ key, record: boundedRecord(raw) })
      else await store.delete(key)
    }
    const latest = await watermark(store)
    if (mark.epoch !== latest.epoch) continue
    const rows = entries.filter(({ record }) => currentRecord(record, mark)).sort((a, b) => b.record.startedAt - a.record.startedAt || b.record.id.localeCompare(a.record.id))
    const keep = new Set(rows.slice(0, MAX_RECORDS).map(entry => entry.key))
    for (const entry of entries) if (!keep.has(entry.key)) await store.delete(entry.key)
    if ((await watermark(store)).epoch !== mark.epoch) continue
    return { mark, rows: rows.slice(0, MAX_RECORDS).map(entry => entry.record) }
  }
  return { mark: await watermark(store), rows: [] }
}

export async function saveRecord(store, value) {
  const record = boundedRecord(value)
  if (!currentRecord(record, await watermark(store))) return false
  const key = RECORD_PREFIX + record.id
  await store.set(key, record)
  // A clear may land between the first check and this per-call write.
  if (!currentRecord(record, await watermark(store))) {
    await store.delete(key)
    return false
  }
  await readHistory(store)
  return true
}

export async function clearHistory(store) {
  const mark = { epoch: uniqueId(), clearedAt: Date.now() }
  await store.set(WATERMARK_KEY, mark)
  await readHistory(store)
  return mark
}
