import { localTime } from '../sandbox/details.js'

export function tavilyTree(ui, view, t, actions, bodyColumns = 48) {
  const labelWidth = Math.max(8, Math.floor((bodyColumns - 18) * 0.75))
  const historyLabel = value => {
    const chars = Array.from(value.replace(/\s+/g, ' ').trim())
    let width = 0
    let end = 0
    for (const char of chars) {
      width += /[^\u0000-\u00ff]/.test(char) ? 2 : 1
      if (width > labelWidth) break
      end++
    }
    return end < chars.length ? `${chars.slice(0, Math.max(0, end - 3)).join('')}...` : chars.join('')
  }
  const { Box, Text, Input, Button, Select, Link } = ui
  const text = (value, props = {}) => Text({ size: 'caption', wrap: 'wrap', ...props, children: [value] })
  const heading = key => text(t(key), { weight: 'semibold', size: 'body' })
  const row = children => Box({ flexDirection: 'row', gap: 1, flexWrap: 'wrap', alignItems: 'center', children })
  const card = (key, children) => Box({ key, flexDirection: 'column', gap: 0.5, borderStyle: 'round', borderDimColor: true, padding: 1, children })
  const records = [...view.pending, ...view.rows].sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id))
  const selected = records.find(record => record.id === view.selected) ?? records[0]
  const preview = (key, value, limit) => {
    const compact = value.replace(/\s+/g, ' ').trim()
    const expanded = view.expanded?.includes(key)
    return [text(expanded ? value : compact.length > limit ? `${compact.slice(0, limit)}…` : compact),
      ...(compact.length > limit ? [Button({ key: `tavily-expand-${key}`, plain: true, label: t(expanded ? 'tavily.collapse' : 'tavily.expand'), onPress: () => actions.toggleResult(key) })] : [])]
  }
  const children = [
    Box({ key: 'tavily-search-section', flexDirection: 'column', gap: 1, children: [
      heading('tavily.title'),
      row([
        Box({ flexGrow: 1, children: [Input({ key: 'tavily-query', value: view.draft, placeholder: t('tavily.query'), onInput: actions.input, onSubmit: actions.search })] }),
        Button({ key: 'tavily-search', label: t(view.submitting ? 'tavily.pending' : 'tavily.search'), dimColor: view.submitting || !view.draft.trim(), onPress: () => actions.search() }),
      ]),
    ] }),
  ]
  if (view.missingKey) children.push(text(`${t('setup.tavily.label')}: ${t('setup.tavily.missing')}`, { key: 'tavily-setup', color: 'yellow' }))
  if (view.error) children.push(text(view.error, { color: 'red' }))
  if (!selected) children.push(card('tavily-results-section', [heading('tavily.results'), text(t('tavily.empty'), { dimColor: true })]))
  else {
    const meta = [t(`tavily.${selected.status}`)]
    if (selected.status !== 'pending') {
      if (Number.isFinite(selected.total)) meta.push(t('tavily.resultCount', { n: selected.total }))
      if (Number.isFinite(selected.durationMs)) meta.push(`${(selected.durationMs / 1000).toFixed(2)} s`)
      if (Number.isFinite(selected.credits)) meta.push(t('tavily.creditCount', { n: selected.credits }))
    }
    const results = [text(t('tavily.queryLabel', { query: selected.query }), { weight: 'semibold' }),
      heading('tavily.results'),
      text(meta.join(' · '), { dimColor: selected.status !== 'error', color: selected.status === 'error' ? 'red' : undefined })]
    if (selected.error) results.push(text(selected.error, { color: 'red' }))
    if (selected.answer) results.push(card('tavily-answer', [heading('tavily.answer'), ...preview(`${selected.id}-answer`, selected.answer, 240)]))
    selected.results.forEach((result, index) => {
      let domain = ''
      try { domain = new URL(result.url).hostname.replace(/^www\./, '') } catch {}
      results.push(card(`tavily-result-${index}`, [
        text(String(index + 1), { dimColor: true }),
        ...(result.url ? [Link({ href: result.url, label: result.title || domain }), text(domain, { dimColor: true })] : [text(result.title, { weight: 'semibold' })]),
        ...(result.content ? preview(`${selected.id}-${index}`, result.content, 180) : []),
      ]))
    })
    if (!selected.results.length && selected.status === 'success') results.push(text(t('tavily.noResults'), { dimColor: true }))
    if (selected.total > selected.results.length) results.push(text(t('tavily.truncated'), { dimColor: true }))
    children.push(Box({ key: 'tavily-results-section', flexDirection: 'column', gap: 1, children: results }))
  }
  const history = Select({
    key: 'tavily-history', label: t('tavily.history'), value: selected?.id ?? 'empty',
    options: [
      { value: 'clear-history', label: t('tavily.clear') },
      ...(!records.length ? [{ value: 'empty', label: t('tavily.empty') }] : []),
      ...records.map(record => ({ value: record.id, label: historyLabel(`${localTime(record.startedAt)} · ${record.query || t('tavily.search')}`) })),
    ],
    onSelect: actions.select,
  })
  // The host's uncontrolled Select needs remounting to reset an action selection.
  children.push(Box({ width: '100%', minWidth: 0, overflow: 'hidden', children: view.historySelection % 2 ? [Box({ width: '100%', minWidth: 0, overflow: 'hidden', children: [history] })] : [history] }))
  return Box({ flexDirection: 'column', gap: 2, paddingX: 1, children })
}
