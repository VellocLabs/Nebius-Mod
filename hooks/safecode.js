/**
 * Security: SafeCode's folder guard. In a `nebius:safecode` session a tool
 * call naming a local path outside the session folder is refused at
 * `tool.check`, memory and scratchpad excepted; SuperEdit's per-file steps
 * reach it as Read / Write. A path is judged as written and by its real path
 * where the host resolves one. The band above the prompt says what was
 * refused until dismissed. Other session types are left alone.
 */

import { GUARDED_TOOLS, SAFECODE_TYPE, checkPaths, localPathsOf, normalize } from './safecode/paths.js'
import { loadTexts } from './sandbox/texts.js'

const BAND_KEY = 'safecode-blocked'

/** The real path the host resolves `path` to, or undefined. Never throws. */
async function realPathOf($, path) {
  try {
    const stat = await $.fs.stat(path, { resolve: true })
    return typeof stat?.realPath === 'string' ? stat.realPath : undefined
  } catch {
    return undefined
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

  /** The session's guard, read once: `{ active }`, and the folders when active. */
  function guardOf($) {
    guard ??= (async () => {
      const type = await quiet(() => $.session.type())
      if (type !== SAFECODE_TYPE) return { active: false }
      // Folders that cannot be read stay empty, so every path is refused.
      const [cwd, root, memory, scratch] = await Promise.all([
        quiet(() => $.session.cwd()),
        quiet(() => $.session.root()),
        quiet(() => $.session.memoryDir()),
        quiet(() => $.session.scratchpadDir()),
      ])
      t = await loadTexts($)
      tEn = await loadTexts($, 'en')
      const folders = { work: [cwd, root].filter(Boolean), memory, scratch }
      // The same folders by their real paths, for a path judged by its own.
      const real = await Promise.all([cwd, root, memory, scratch].map(dir => (dir ? realPathOf($, dir) : undefined)))
      const realFolders = {
        work: [real[0] ?? cwd, real[1] ?? root].filter(Boolean),
        memory: memory ? real[2] ?? memory : null,
        scratch: scratch ? real[3] ?? scratch : null,
      }
      return { active: true, folders, realFolders }
    })()
    return guard
  }

  /** The first path of the call outside the folders, or undefined. */
  async function outsidePath($, paths, current) {
    const literal = checkPaths(paths, current.folders)
    if (!literal.allowed) return literal.path
    for (const path of paths) {
      const placed = normalize(path, current.folders.work[0])
      const real = placed ? await realPathOf($, placed) : undefined
      if (real && !checkPaths([real], current.realFolders).allowed) return path
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
    const path = await outsidePath($, paths, current)
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
