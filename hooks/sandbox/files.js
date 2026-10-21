import { fileIcon, bytesLabel } from './icons.js'

/** Lazy, immutable-image file browser. No guest VM or file content downloads. */
export function entriesOf(reply, parent) {
  if (!Array.isArray(reply?.files)) throw new Error('list_files returned no files array')
  return reply.files.flatMap(entry => {
    const name = entry.name ?? entry.path?.split('/').filter(Boolean).at(-1)
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) return []
    return [{ name, path: `${parent === '/' ? '' : parent}/${name}`, type: entry.type, size: entry.size, target: entry.target }]
  }).sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name))
}

export function isTransientDirectoryError(error) {
  const status = Number(error?.status ?? error?.statusCode)
  if ([500, 502, 503, 504].includes(status)) return true
  return /\bHTTP\s*:?\s*(500|502|503|504)\b/i.test(String(error?.message ?? error))
}

export function createFileBrowser(load, changed, { sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), retryDelayMs = 800, read } = {}) {
  let state = { lane: null, image: null, dirs: {}, expanded: {}, selectedFile: null }
  let generation = 0
  let previewSeq = 0
  const pending = new Map()
  const publish = () => changed({ ...state, dirs: { ...state.dirs }, expanded: { ...state.expanded } })
  async function directory(path) {
    const epoch = generation
    const key = `${epoch}:${path}`
    if (pending.has(key)) return pending.get(key)
    const image = state.image
    if (!image) return
    const task = (async () => {
      state.dirs[path] = { ...state.dirs[path], loading: true, retrying: false, error: null }
      await publish()
      try {
        let reply
        try {
          reply = await load(image, path)
        } catch (error) {
          if (generation !== epoch) return
          if (!isTransientDirectoryError(error)) throw error
          state.dirs[path] = { ...state.dirs[path], retrying: true }
          await publish()
          await sleep(retryDelayMs)
          if (generation !== epoch || !state.expanded[path]) return
          reply = await load(image, path) // Read-only request: one retry, never an infinite loop.
        }
        const entries = entriesOf(reply, path)
        if (generation === epoch) state.dirs[path] = { entries, loading: false, retrying: false, error: null }
      } catch (error) {
        if (generation === epoch) state.dirs[path] = { ...state.dirs[path], loading: false, retrying: false, error: String(error?.message ?? error), missing: /\bHTTP\s*:?\s*404\b|ENOENT|no such file/i.test(String(error?.message ?? error)) }
      } finally {
        pending.delete(key)
        if (generation === epoch) {
          state.dirs[path] = { ...state.dirs[path], loading: false, retrying: false }
          await publish()
        }
      }
    })()
    pending.set(key, task)
    return task
  }
  return {
    snapshot: () => state,
    async select(lane, image) {
      if (state.lane === lane && state.image === image) return
      generation += 1
      state = { lane, image, dirs: {}, expanded: { '/': true }, selectedFile: null }
      await publish()
      if (image) await directory('/')
    },
    async toggle(path) {
      state.expanded[path] = !state.expanded[path]
      await publish()
      if (state.expanded[path]) await directory(path)
    },
    async selectFile(entry) {
      const epoch = generation, seq = ++previewSeq, image = state.image
      state.selectedFile = entry
      state.preview = { loading: true }
      await publish()
      if (!read || entry.type !== 'file' || !Number.isFinite(entry.size) || entry.size > 262144) {
        state.preview = { skipped: true }
        await publish()
        return
      }
      try {
        const result = await read(image, entry.path)
        if (epoch !== generation || seq !== previewSeq) return
        const content = typeof result?.content === 'string' ? result.content.replace(/\r\n?/g, '\n') : result?.content
        state.preview = result?.is_text === false || result?.encoding === 'base64' || typeof content !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)
          ? { skipped: true }
          : { content: content.slice(0, 8000), truncated: content.length > 8000 }
      } catch (error) {
        if (epoch !== generation || seq !== previewSeq) return
        state.preview = { error: String(error?.message ?? error) }
      }
      await publish()
    },
    retry: path => directory(path),
    async refresh() {
      await Promise.all(Object.keys(state.expanded).filter(path => state.expanded[path]).map(directory))
    },
  }
}

export function fileTree(ui, browser, t, actions) {
  const { Box, Text, Button, Svg } = ui
  const rows = []
  let count = 0
  function visit(path, depth) {
    const dir = browser.dirs[path]
    if (!dir) return
    if (dir.loading) rows.push(Text({ dimColor: true, children: [t(dir.retrying ? 'files.retrying' : 'files.loading')] }))
    if (dir.error) {
      rows.push(Text({ color: 'red', wrap: 'wrap', children: [dir.missing ? t('browse.missing', { path }) : `${path}\n${dir.error}`] }))
      if (dir.entries?.length) rows.push(Text({ dimColor: true, children: [t('files.cached')] }))
      rows.push(Button({ key: `retry:${path}`, label: t('files.retry'), onPress: () => actions.retryDirectory(path) }))
    }
    if (path === '/' && !dir.loading && !dir.error && dir.entries?.length === 0) rows.push(Text({ dimColor: true, children: [t('files.empty')] }))
    for (const entry of dir.entries ?? []) {
      if (++count > 400) return
      const folder = entry.type === 'directory'
      const open = !!browser.expanded[entry.path]
      const selected = browser.selectedFile?.path === entry.path
      const childDir = browser.dirs[entry.path]
      const empty = folder && open && childDir && !childDir.loading && !childDir.error && childDir.entries?.length === 0
      rows.push(Box({ key: entry.path, flexDirection: 'row', alignItems: 'center', gap: 1, paddingLeft: Math.min(depth, 20) * 2, paddingY: 0.03, backgroundColor: selected ? 'accent' : undefined, children: [
        Box({ width: 1, flexShrink: 0, children: [Text({ dimColor: true, children: [folder ? (open ? '▾' : '▸') : ' '] })] }),
        Svg({ source: fileIcon(entry, open), alt: entry.type === 'directory' ? t('compact.folder') : entry.type === 'symlink' ? t('compact.symlink') : t('compact.file'), width: 16, height: 16 }),
        Box({ flexGrow: 1, overflow: 'hidden', children: [Button({
          key: `file:${entry.path}`, plain: true, label: entry.path,
          children: [Text({ wrap: 'truncate-end', weight: selected ? 'semibold' : 'regular', children: [entry.name, ...(empty ? [Text({ color: 'gray', children: [' (0)'] })] : [])] })],
          onPress: () => folder ? actions.toggleDirectory(entry.path) : actions.selectFile(entry),
        })] }),
      ] }))
      if (folder && browser.expanded[entry.path] && depth < 30) visit(entry.path, depth + 1)
    }
  }
  if (browser.image) {
    rows.push(Box({ justifyContent: 'space-between', alignItems: 'center', children: [Text({ weight: 'semibold', children: [t('compact.files')] }), Button({ key: 'files-refresh', label: t('browse.refreshDirectory'), plain: true, onPress: actions.refreshFiles })] }))
    visit('/', 0)
    if (count > 400) rows.push(Text({ dimColor: true, children: [t('files.limit')] }))
    if (browser.selectedFile) {
      const file = browser.selectedFile
      const previewRows = [
        Text({ weight: 'semibold', children: [t('preview.title')] }),
        Text({ mono: true, wrap: 'wrap', children: [`${file.path}\n${bytesLabel(file.size)}${file.target ? ` → ${file.target}` : ''}`] }),
      ]
      const preview = browser.preview
      if (preview?.loading) previewRows.push(Text({ children: [t('preview.loading')] }))
      if (preview?.skipped) previewRows.push(Text({ dimColor: true, wrap: 'wrap', children: [t('preview.skipped')] }))
      if (preview?.error) previewRows.push(Text({ color: 'red', wrap: 'wrap', children: [preview.error] }))
      if (typeof preview?.content === 'string') previewRows.push(ui.Code({ source: preview.content, language: /\.ya?ml$/i.test(file.name) ? 'yaml' : 'text', wrap: 'wrap' }))
      if (preview?.truncated) previewRows.push(Text({ dimColor: true, children: [t('detail.truncated')] }))
      rows.push(Box({ key: 'file-preview', flexDirection: 'column', gap: 0.5, marginTop: 1, padding: 1, borderStyle: 'round', borderColor: 'gray', children: previewRows }))
    }
  }
  return Box({ flexDirection: 'column', children: rows })
}
