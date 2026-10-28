/**
 * SafeCode's folder guard, the pure half: the local paths a tool call names,
 * and whether each lies inside the session's folders. Separators become `/`,
 * `.` and `..` collapse, a relative path is taken against the session folder,
 * a drive-letter path compares without case; a path that cannot be placed
 * (`~/…`, a UNC share, empty) is outside.
 */

/** The session type the guard applies to. */
export const SAFECODE_TYPE = 'nebius:safecode'

/** Tool → the arguments of a call that name a local path, read or written. */
const LOCAL_PATH_ARGS = Object.freeze({
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['path'],
  Grep: ['path'],
  SuperEdit: ['path'],
  mcp__contree__rsync: ['source'],
  mcp__contree__upload: ['path'],
  mcp__contree__download: ['destination'],
  mcp__nebius__sandbox_lane_patch: ['out'],
})

/** The tools the guard checks, for a `tool.check` matcher. */
export const GUARDED_TOOLS = Object.freeze(Object.keys(LOCAL_PATH_ARGS))

const GLOB_CHARS = /[*?[\]{}]/

/** The local paths `input` names for `tool`; a Glob pattern counts by its fixed prefix. */
export function localPathsOf(tool, input) {
  const args = input && typeof input === 'object' ? input : {}
  const paths = (LOCAL_PATH_ARGS[tool] ?? [])
    .map(name => args[name])
    .filter(value => typeof value === 'string' && value !== '')
  if (tool === 'Glob' && typeof args.pattern === 'string' && args.pattern !== '') {
    const prefix = fixedPrefix(args.pattern)
    if (isAbsolute(prefix)) {
      paths.push(prefix)
    } else if (prefix.split('/').includes('..')) {
      // A relative pattern climbing out of its search folder is placed under it.
      const under = typeof args.path === 'string' && args.path !== '' ? toSlashes(args.path).replace(/\/+$/, '') : '.'
      paths.push(`${under}/${prefix}`)
    }
  }
  return paths
}

/** The leading run of a glob pattern's segments that hold no glob character. */
export function fixedPrefix(pattern) {
  const segments = toSlashes(pattern).split('/')
  const cut = segments.findIndex(segment => GLOB_CHARS.test(segment))
  const kept = cut === -1 ? segments : segments.slice(0, cut)
  const joined = kept.join('/')
  return joined === '' || /^[A-Za-z]:$/.test(joined) ? `${joined}/` : joined
}

function toSlashes(path) {
  return path.replace(/\\/g, '/')
}

function hasDrive(path) {
  return /^[A-Za-z]:\//.test(path)
}

export function isAbsolute(path) {
  const p = toSlashes(path)
  return p.startsWith('/') || hasDrive(p)
}

/**
 * `path` as an absolute, collapsed path with `/` separators, taken against
 * `base` when relative; undefined for a path that cannot be placed.
 */
export function normalize(path, base) {
  if (typeof path !== 'string' || path === '' || path.includes('\0')) return undefined
  let p = toSlashes(path)
  if (p.startsWith('//') || p.startsWith('~')) return undefined
  if (!isAbsolute(p)) {
    if (typeof base !== 'string' || !isAbsolute(base)) return undefined
    p = `${toSlashes(base).replace(/\/+$/, '')}/${p}`
  }
  const drive = hasDrive(p) ? p.slice(0, 2).toUpperCase() : ''
  const rest = drive ? p.slice(2) : p
  const out = []
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (out.length === 0) return undefined
      out.pop()
    } else {
      out.push(segment)
    }
  }
  return `${drive}/${out.join('/')}`
}

/** Whether normalized `path` is `root` or lies beneath it. */
export function isWithin(path, root) {
  if (path === undefined || root === undefined) return false
  const fold = hasDrive(path) || hasDrive(root)
  const a = fold ? path.toLowerCase() : path
  const b = (fold ? root.toLowerCase() : root).replace(/\/+$/, '')
  return b === '' ? a.startsWith('/') : a === b || a.startsWith(`${b}/`)
}

/**
 * The verdict for one call: `{ allowed: true }`, or `{ allowed: false, path }`
 * naming the first path outside every folder. `folders.work` are the session
 * folders a path may lie in; `folders.memory` and `folders.scratch` the
 * session's own directories, allowed as well.
 */
export function checkPaths(paths, folders) {
  const base = folders.work[0]
  const roots = [...folders.work, folders.memory, folders.scratch]
    .filter(root => typeof root === 'string' && root !== '')
    .map(root => normalize(root))
    .filter(root => root !== undefined)
  for (const path of paths) {
    const placed = normalize(path, base)
    if (!roots.some(root => isWithin(placed, root))) return { allowed: false, path }
  }
  return { allowed: true }
}
