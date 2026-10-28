/**
 * Security: SafeCode's folder guard. In a `nebius:safecode` session a tool
 * call naming a local path outside the session folder is refused at
 * `tool.check`, memory and scratchpad excepted; SuperEdit's per-file steps
 * reach it as Read / Write. A path is judged as written and by its real path:
 * a path not yet made, by the real path of its nearest existing ancestor; one
 * whose real path cannot be had, refused. The folders are read on each check.
 * The band above the prompt says what was refused until dismissed. Other
 * session types are left alone, and so is a session whose type cannot be read.
 */

import { GUARDED_TOOLS, SAFECODE_TYPE, checkPaths, localPathsOf, normalize, splitLast } from './safecode/paths.js'
import { loadTexts } from './sandbox/texts.js'

const BAND_KEY = 'safecode-blocked'

/**
 * What the host's real path of `path` is: `{ real }`, `{ missing: true }` when
 * nothing is there, or `{}` when something is there but cannot be resolved
 * (a link leading nowhere). Never throws.
 */
async function resolveOne($, path) {
  let stat
  try {
    stat = await $.fs.stat(path, { resolve: true })
  } catch {
    return { missing: true }
  }
  return typeof stat?.realPath === 'string' ? { real: stat.realPath } : {}
}

/**
 * The real path of normalized `path`; a path not yet made takes its nearest
 * existing ancestor's, with the rest appended. Undefined when none resolves.
 */
async function realPathNear($, path) {
  const rest = []
  for (let at = path; ; ) {
    const found = await resolveOne($, at)
    if (found.real !== undefined) return rest.length === 0 ? found.real : `${found.real}/${rest.join('/')}`
    if (!found.missing) return undefined
    const split = splitLast(at)
    if (!split) return undefined
    rest.unshift(split[1])
    at = split[0]
  }
}

/** What `read()` resolves to, or null when it throws or rejects. */
async function quiet(read) {
  try {
    return (await read()) ?? null
  } catch {
    return null
  }
}

function isEngineTree(tree) {
  return !tree || (typeof tree === 'object' && tree.type === 'engine')
}

export function registerSafeCode(on) {
  let guard
  let root
  let t = key => key
  let tEn = key => key
  const ref = $ => ({ plugin: $.plugin.name, key: BAND_KEY })

  /** Whether the session is guarded, read once; the texts with it. */
  function guardOf($) {
    guard ??= (async () => {
      const type = await quiet(() => $.session.type())
      if (type !== SAFECODE_TYPE) return { active: false }
      t = await loadTexts($)
      tEn = await loadTexts($, 'en')
      return { active: true }
    })()
    return guard
  }

  /** The session's folders as written and by their real paths. Unreadable ones stay empty. */
  async function foldersOf($) {
    const [cwd, root, memory, scratch] = await Promise.all([
      quiet(() => $.session.cwd()),
      quiet(() => $.session.root()),
      quiet(() => $.session.memoryDir()),
      quiet(() => $.session.scratchpadDir()),
    ])
    const real = await Promise.all(
      [cwd, root, memory, scratch].map(dir => {
        const placed = typeof dir === 'string' ? normalize(dir) : undefined
        return placed ? realPathNear($, placed) : undefined
      }),
    )
    return {
      literal: { work: [cwd, root].filter(Boolean), memory, scratch },
      real: { work: real.slice(0, 2).filter(Boolean), memory: real[2] ?? null, scratch: real[3] ?? null },
    }
  }

  /** The first path of the call outside the folders, or undefined. */
  async function outsidePath($, paths) {
    const folders = await foldersOf($)
    const literal = checkPaths(paths, folders.literal)
    if (!literal.allowed) return literal.path
    for (const path of paths) {
      const placed = normalize(path, folders.literal.work[0])
      const real = placed ? await realPathNear($, placed) : undefined
      if (real === undefined || !checkPaths([real], folders.real).allowed) return path
    }
    return undefined
  }

  async function showBlock($, block) {
    const read = await $.state.get(ref($)).catch(() => null)
    const count = (read?.value?.count ?? 0) + 1
    await $.state.set(ref($), { ...block, count }).catch(() => undefined)
  }

  on('session.start', async ($, e, next) => {
    root = $
    await guardOf($)
    return next(e)
  })

  on('tool.check', { tool: [...GUARDED_TOOLS] }, async ($, e, next) => {
    const current = await guardOf($)
    if (!current.active) return next(e)
    const paths = localPathsOf(e.tool, e.input)
    if (paths.length === 0) return next(e)
    const path = await outsidePath($, paths)
    if (path === undefined) return next(e)
    await showBlock($, { tool: e.tool, path })
    return { decision: 'deny', reason: tEn('safecode.denied', { tool: e.tool, path }) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const read = await $.state.get(ref($)).catch(() => null)
    const block = read?.value
    if (!block) return below
    const { Box, Text, Button } = $.ui.resolve(e)
    const band = Box({
      key: 'safecode-blocked',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 1,
      children: [
        Text({
          size: 'caption',
          color: 'yellow',
          wrap: 'wrap',
          children: [t(block.count > 1 ? 'safecode.bandMany' : 'safecode.band', { tool: block.tool, path: block.path, count: block.count })],
        }),
        Button({
          key: 'safecode-dismiss',
          label: t('safecode.dismiss'),
          plain: true,
          // A press is not part of the drawing: the session's `$` writes.
          onPress: () => (root ?? $).state.set(ref(root ?? $), null).catch(() => undefined),
        }),
      ],
    })
    return isEngineTree(below) ? band : Box({ flexDirection: 'column', children: [band, below] })
  })
}
