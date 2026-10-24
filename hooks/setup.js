/**
 * What Sandboxes and Tavily search need before they work: uv, the Nebius key
 * and Project ID, the contree connection and access, a default image, the
 * Tavily key. `probeSetup` reads through `$`; the rest is pure.
 * Security: keys are checked for presence only; a sealed value never reaches
 * a reply, a check or the pane.
 */

export const PROVIDER_ID = 'mod.nebius.token-factory'
export const PARTS = Object.freeze(['sandbox', 'search'])

/** Where uv's installers put `uvx` when it is not on PATH: under home, and WinGet's links under LOCALAPPDATA. */
const UV_HOME_DIRS = Object.freeze(['.local/bin', '.cargo/bin'])
const UV_LOCAL_APP_DATA_DIRS = Object.freeze(['Microsoft/WinGet/Links'])
const UV_NAMES = Object.freeze(['uvx.exe', 'uvx'])
const UV_TIMEOUT_MS = 15_000

async function quietly(action, fallback = null) {
  try { return await action() } catch { return fallback }
}

function filled(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function slashed(path) {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

async function homeOf($) {
  for (const name of ['USERPROFILE', 'HOME']) {
    const value = await quietly(() => $.env.get(name))
    if (filled(value)) return slashed(value)
  }
  return null
}

async function uvDirsOf($, home) {
  const dirs = home ? UV_HOME_DIRS.map(dir => `${home}/${dir}`) : []
  const localAppData = await quietly(() => $.env.get('LOCALAPPDATA'))
  if (filled(localAppData)) dirs.push(...UV_LOCAL_APP_DATA_DIRS.map(dir => `${slashed(localAppData)}/${dir}`))
  return dirs
}

async function exists($, path) {
  return (await quietly(() => $.fs.exists(path), false)) === true
}

/**
 * `uvx` as this computer has it: `ok` with its version when it runs,
 * `offPath` when installed where the running shell's PATH does not reach, else
 * `missing`, or `unknown` when the run itself could not be made.
 */
async function probeUv($, home) {
  let ran = null
  let runFailed = typeof $.process?.run !== 'function'
  if (!runFailed) {
    try {
      ran = await $.process.run(['uvx', '--version'], { timeoutMs: UV_TIMEOUT_MS })
    } catch {
      runFailed = true
    }
  }
  if (ran && ran.exitCode === 0) return { state: 'ok', version: String(ran.stdout ?? '').trim().split(/\r?\n/)[0] }
  for (const dir of await uvDirsOf($, home)) {
    for (const name of UV_NAMES) {
      if (await exists($, `${dir}/${name}`)) return { state: 'offPath' }
    }
  }
  return { state: runFailed ? 'unknown' : 'missing' }
}

/** This plugin's stored options in settings.json, by its config id (`<name>` or `<name>@<source>`). */
function storedOptions(settings, plugin) {
  const configs = settings?.pluginConfigs
  if (!configs || typeof configs !== 'object') return null
  for (const [id, entry] of Object.entries(configs)) {
    if (id === plugin || id.startsWith(`${plugin}@`)) return entry?.options ?? {}
  }
  return null
}

/**
 * The facts the checks read. `true`/`false` where they are known, `null`
 * where the runtime could not tell.
 */
export async function probeSetup($, { parts = PARTS } = {}) {
  const settings = await quietly(() => $.settings.read())
  const provider = settings?.providers?.configs?.[PROVIDER_ID]
  const known = value => (settings ? value : null)
  const facts = {
    key: known(filled(provider?.apiKey)),
    tavilyKey: known(filled(provider?.secrets?.tavily_api_key)),
  }
  if (!parts.includes('sandbox')) return facts
  const home = await homeOf($)
  const stored = storedOptions(settings, $.plugin?.name ?? 'nebius')
  return {
    ...facts,
    uv: await probeUv($, home),
    project: known(filled(stored?.project_id)),
    authFile: home ? await exists($, `${home}/.config/contree/auth.ini`) : false,
  }
}

/**
 * One row per requirement of `parts`, in the order they must be met:
 * `{ id, state: 'ok' | 'missing' | 'failed' | 'unknown' | 'waiting', by: 'user' | 'agent', vars? }`.
 * The server row is `waiting` while uv, the key or the Project ID is unmet: its
 * failure is their consequence, not a step of its own. A connected server
 * started through uvx, so it settles the uv row whatever the probe saw.
 * `mcp` is the contree connection as the pane holds it; `defaultImage` the option.
 */
export function setupChecks(facts, { mcp = null, defaultImage = '', parts = PARTS } = {}) {
  const checks = []
  const add = (id, state, by, vars) => checks.push({ id, state, by, ...(vars ? { vars } : {}) })
  if (parts.includes('sandbox')) {
    const uv = facts.uv?.state ?? 'unknown'
    if (uv !== 'ok' && mcp?.isConnected) add('uv', 'ok', 'agent', { via: 'server' })
    else add('uv', uv === 'ok' ? 'ok' : uv === 'offPath' ? 'failed' : uv, uv === 'offPath' ? 'user' : 'agent', uv === 'ok' ? { version: facts.uv.version } : undefined)
    const credential = (value, id) => add(id, value === true ? 'ok' : facts.authFile ? 'ok' : value === false ? 'missing' : 'unknown', 'user', value !== true && facts.authFile ? { via: 'auth.ini' } : undefined)
    credential(facts.key, 'key')
    credential(facts.project, 'project')
    const prerequisiteUnmet = checks.some(check => check.state === 'missing' || check.state === 'failed')
    if (prerequisiteUnmet && !mcp?.isConnected) add('server', 'waiting', 'agent')
    else if (!mcp) add('server', 'unknown', 'user')
    else if (!mcp.isConnected) add('server', 'failed', 'user', { reason: String(mcp.reason ?? mcp.message ?? '') })
    else add('server', 'ok', 'user')
    if (mcp?.isConnected) {
      if (mcp.authError) add('access', 'failed', 'user', { message: mcp.authError })
      else if (mcp.missing?.length) add('access', 'missing', 'user', { missing: mcp.missing.join(', ') })
      else add('access', 'ok', 'user')
    }
    add('image', filled(defaultImage) ? 'ok' : 'missing', 'agent', filled(defaultImage) ? { image: defaultImage } : undefined)
  }
  if (parts.includes('search')) {
    add('tavily', facts.tavilyKey === true ? 'ok' : facts.tavilyKey === false ? 'missing' : 'unknown', 'user')
  }
  return checks
}

/** A row that is not met and stops the part working: a missing default image only means naming one per call; a waiting server starts by itself. */
function blocks(check) {
  return check.state !== 'ok' && check.state !== 'waiting' && check.id !== 'image'
}

/** The first blocking row, else null. */
export function firstBlocker(checks) {
  return checks.find(blocks) ?? null
}

/** The text key a row reads as: `setup.<id>.<state>`, `.offPath` for uv installed off PATH, `.viaServer` / `.viaFile` for a row met another way. */
export function checkTextKey(check) {
  if (check.id === 'uv' && check.state === 'failed') return 'setup.uv.offPath'
  if (check.state === 'ok' && check.vars?.via === 'server') return `setup.${check.id}.viaServer`
  if (check.state === 'ok' && check.vars?.via) return `setup.${check.id}.viaFile`
  return `setup.${check.id}.${check.state}`
}

/**
 * The model's reading of `checks` (`t` reads English): one line per row, then
 * what the agent does (after asking) and what the user does. The model relays
 * the user's part; it never asks for a key in chat.
 */
export function setupReport(checks, t) {
  const mark = { ok: '✓', missing: '✗', failed: '✗', unknown: '?', waiting: '·' }
  const quiet = check => check.state === 'ok' || check.state === 'waiting'
  const lines = checks.map(check => `${mark[check.state]} ${t(`setup.${check.id}.label`)}: ${t(checkTextKey(check), check.vars)}${quiet(check) ? '' : ` [${t(`setup.by.${check.by}`)}]`}`)
  const pending = checks.filter(blocks)
  const names = by => pending.filter(check => check.by === by).map(check => t(`setup.${check.id}.label`)).join(', ')
  lines.push('')
  if (pending.length === 0) lines.push(t('setup.report.ready'))
  else {
    if (names('agent')) lines.push(t('setup.report.agent', { items: names('agent') }))
    if (names('user')) lines.push(t('setup.report.user', { items: names('user') }))
    lines.push(t('setup.report.scope'))
  }
  return lines.join('\n')
}
