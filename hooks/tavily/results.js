export const SEARCH_TOOL = 'mcp__tavily__tavily_search'
export const MAX_RECORD_BYTES = 12000
const secretName = /api[-_]?key|token|secret|password|authorization|credential|signature|^key$|^auth$|^sig$|^code$|cookie/i

function redactTokens(value) {
  return value
    .replace(/\b(?:tvly|sk)-(?:[a-z0-9_-]+)/gi, '[redacted]')
    .replace(/\b(?:gh[pousr]_[a-z0-9]+|github_pat_[a-z0-9_]+|AKIA[A-Z0-9]{16})\b/gi, '[redacted]')
    .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+/gi, '[redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s"',;]+/gi, '[redacted]')
    .replace(/((?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|authorization|credential|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1[redacted]')
}

export function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 8000) return ''
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    url.username = ''
    url.password = ''
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      const val = url.searchParams.get(key) ?? ''
      if (secretName.test(key) || redactTokens(val) !== val || /https?:\/\//i.test(val)) url.searchParams.delete(key)
    }
    const clean = redactTokens(decodeURI(url.href))
    if (clean !== decodeURI(url.href) || clean.length > 2000) return ''
    return url.href
  } catch { return '' }
}

export function safeText(value, limit = 1000) {
  if (typeof value !== 'string') return ''
  return redactTokens(value.replace(/https?:\/\/[^\s<>"']+/gi, match => safeUrl(match)))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, limit)
}

const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const object = value => value && typeof value === 'object' && !Array.isArray(value)

export function searchData(answer) {
  const raw = answer?.result ?? answer
  const candidates = [raw?.structuredContent, answer?.structuredContent]
  const texts = [...(Array.isArray(raw?.content) ? raw.content : []), ...(typeof answer?.text === 'string' ? [{ type: 'text', text: answer.text }] : [])]
  if (typeof raw === 'string') texts.push({ type: 'text', text: raw })
  for (const block of texts) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    try { candidates.push(JSON.parse(block.text)) } catch {}
  }
  candidates.push(raw)
  const data = {}
  for (const candidate of candidates) {
    const value = object(candidate?.result) ? candidate.result : candidate
    if (!object(value)) continue
    for (const key of ['query', 'answer', 'results', 'usage', 'error', 'total_results', 'code', 'message']) {
      if (data[key] === undefined && value[key] !== undefined) data[key] = value[key]
    }
  }
  return data
}

export function byteSize(value) {
  let bytes = 0
  for (const char of JSON.stringify(value)) {
    const code = char.codePointAt(0)
    bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4
  }
  return bytes
}

export function boundedRecord(value) {
  const record = {
    id: safeText(value.id, 100), epoch: safeText(value.epoch, 100), startedAt: number(value.startedAt) ?? 0,
    durationMs: number(value.durationMs), status: ['pending', 'error', 'success'].includes(value.status) ? value.status : 'error',
    query: safeText(value.query, 600), answer: safeText(value.answer, 3000), error: safeText(value.error, 1000),
    total: number(value.total), credits: number(value.credits),
    results: (Array.isArray(value.results) ? value.results : []).slice(0, 10).map(row => ({ title: safeText(row?.title, 200), url: safeUrl(row?.url), content: safeText(row?.content, 1000) })),
  }
  while (byteSize(record) > MAX_RECORD_BYTES && record.results.length) record.results.pop()
  while (byteSize(record) > MAX_RECORD_BYTES && record.answer) record.answer = record.answer.slice(0, Math.floor(record.answer.length / 2))
  return record
}

export function completeRecord(start, answer, failure, finishedAt) {
  const data = searchData(answer)
  const applicationError = !Array.isArray(data.results) && typeof data.code === 'string' && data.code.trim() !== '' && typeof data.message === 'string' && data.message.trim() !== ''
  const failed = failure !== undefined || answer?.deny !== undefined || answer?.isError === true || answer?.result?.isError === true || !!data.error || applicationError
  const raw = answer?.result ?? answer
  const errorText = failure instanceof Error ? failure.message : typeof failure === 'string' ? failure : answer?.deny ?? data.error?.message ?? data.error ?? (applicationError ? data.message : undefined)
  const contentText = Array.isArray(raw?.content) ? raw.content.filter(block => block?.type === 'text').map(block => block.text).join('\n') : ''
  return boundedRecord({
    ...start, status: failed ? 'error' : 'success', durationMs: Math.max(0, finishedAt - start.startedAt),
    query: start.query || data.query, answer: data.answer,
    error: failed ? (typeof errorText === 'string' ? errorText : contentText || answer?.text || '') : '',
    results: data.results, total: number(data.total_results) ?? (Array.isArray(data.results) ? data.results.length : null),
    credits: number(data.usage?.credits),
  })
}
