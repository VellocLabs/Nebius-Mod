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
/** The tools that can run an installer on this computer; a SafeCode session has neither. */
const SHELL_TOOLS = Object.freeze(['Bash', 'PowerShell'])
/** Velloc's answer when a plugin server failed earlier in the session and will not be launched again in it. */
const STALE_SERVER = /another MCP server's name in this session/

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

/**
 * Whether this session can run an installer: `true` with a shell tool,
 * `false` without one, `null` when the session's tools cannot be listed.
 */
async function probeShell($) {
  const tools = await quietly(() => $.tools.list())
  if (!Array.isArray(tools)) return null
  return tools.some(tool => SHELL_TOOLS.includes(tool?.name))
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
    shell: await probeShell($),
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
 * Without a shell (`facts.shell === false`) installing uv is the user's: in a
 * terminal, or by an Agent or Code session. A server Velloc will not launch
 * again in this session is the user's too: a new session starts it.
 * `mcp` is the contree connection as the pane holds it; `defaultImage` the option.
 */
export function setupChecks(facts, { mcp = null, defaultImage = '', parts = PARTS } = {}) {
  const checks = []
  const add = (id, state, by, vars) => checks.push({ id, state, by, ...(vars ? { vars } : {}) })
  if (parts.includes('sandbox')) {
    const uv = facts.uv?.state ?? 'unknown'
    if (uv !== 'ok' && mcp?.isConnected) add('uv', 'ok', 'agent', { via: 'server' })
    else if (uv === 'ok') add('uv', 'ok', 'agent', { version: facts.uv.version })
    else if (uv === 'offPath') add('uv', 'failed', 'user')
    else if (facts.shell === false) add('uv', uv, 'user', { noShell: true })
    else add('uv', uv, 'agent')
    const credential = (value, id) => add(id, value === true ? 'ok' : facts.authFile ? 'ok' : value === false ? 'missing' : 'unknown', 'user', value !== true && facts.authFile ? { via: 'auth.ini' } : undefined)
    credential(facts.key, 'key')
    credential(facts.project, 'project')
    const prerequisiteUnmet = checks.some(check => check.state === 'missing' || check.state === 'failed')
    if (prerequisiteUnmet && !mcp?.isConnected) add('server', 'waiting', 'agent')
    else if (!mcp) add('server', 'unknown', 'user')
    else if (!mcp.isConnected) {
      const reason = String(mcp.reason ?? mcp.message ?? '')
      add('server', 'failed', 'user', STALE_SERVER.test(reason) ? { reason, stale: true } : { reason })
    }
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

/**
 * The text key a row reads as: `setup.<id>.<state>`, `.offPath` for uv installed off PATH,
 * `.noShell` for uv this session cannot install, `.stale` for a server not launched again
 * in this session, `.viaServer` / `.viaFile` for a row met another way.
 */
export function checkTextKey(check) {
  if (check.id === 'uv' && check.state === 'failed') return 'setup.uv.offPath'
  if (check.id === 'uv' && check.vars?.noShell) return 'setup.uv.noShell'
  if (check.id === 'server' && check.vars?.stale) return 'setup.server.stale'
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
