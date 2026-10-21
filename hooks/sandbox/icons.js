/** Small, local-only SVG glyphs; no user text or external resources in markup. */
export function fileIcon(entry, open = false) {
  let color = '#8190a5', label = '', shape = '<path d="M5 2h9l5 5v15H5z M14 2v6h5"/>'
  if (entry.type === 'directory') {
    color = '#6499db'
    shape = open ? '<path d="M3 8V5h7l2 3h9v3 M3 11h19l-3 10H3z"/>' : '<path d="M3 5h7l2 3h9v13H3z"/>'
  } else if (entry.type === 'symlink') {
    shape = '<path d="M9 15l6-6 M8 17l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0 M16 7l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>'
  } else {
    const ext = entry.name.split('.').at(-1).toLowerCase()
    const types = { py: ['PY','#6499db'], js: ['JS','#bf9b35'], ts: ['TS','#6499db'], tsx: ['TS','#6499db'], jsx: ['JS','#bf9b35'], json: ['{}','#bf9b35'], yml: ['Y','#a18bd2'], yaml: ['Y','#a18bd2'], sh: ['>_','#60a887'], html: ['<>','#c68a66'], css: ['#','#a18bd2'], md: ['M','#8190a5'], txt: ['T','#8190a5'], csv: ['=','#60a887'] }
    ;[label, color] = types[ext] ?? ['', color]
    if (['png','jpg','jpeg','svg','webp','gif'].includes(ext)) { color='#a18bd2'; shape='<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m3 19 6-6 4 4 4-6 4 6"/>' }
  }
  const text = label ? `<text x="12" y="17" text-anchor="middle" font-family="monospace" font-size="7" fill="${color}" stroke="none">${label.replaceAll('<','&lt;').replaceAll('>','&gt;')}</text>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${shape}${text}</svg>`
}
export function bytesLabel(value) {
  if (!Number.isFinite(value)) return '—'
  if (value < 1024) return `${value} B`
  const unit = value < 1048576 ? 'KiB' : value < 1073741824 ? 'MiB' : 'GiB'
  const divisor = unit === 'KiB' ? 1024 : unit === 'MiB' ? 1048576 : 1073741824
  return `${(value/divisor).toFixed(1)} ${unit}`
}
