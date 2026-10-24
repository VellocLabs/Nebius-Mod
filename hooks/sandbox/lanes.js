/**
 * Lanes: named image chains in a Nebius sandbox, one per line of work.
 *
 * A lane starts at a base image and moves its head each time a run that keeps
 * its changes (`disposable: false`) returns a new image. The model writes
 * `image: "lane:<name>"`; the hook puts the lane's head in its place, so
 * several agents can work side by side without passing UUIDs around.
 *
 * Pure: no `$`, no clock. Every function takes the table and returns a new one.
 */

/** The server's contree tools, as the model sees them. */
export const CONTREE_SERVER = 'contree'
export const CONTREE_PREFIX = `mcp__${CONTREE_SERVER}__`

/** Who a call came from when it carries no `agentId`: the session's own loop. */
export const MAIN_LOOP = 'main'

/** Tools that touch only the sandbox, never a local file. */
export const REMOTE_ONLY_TOOLS = Object.freeze([
  'run', 'import_image', 'list_images', 'get_image', 'set_tag', 'list_files', 'read_file', 'grep',
  'get_operation', 'list_operations', 'wait_operations', 'cancel_operation', 'get_guide', 'whoami',
])

export { parseReply, resultImageOf } from './replies.js'

/** Tools whose `image` argument names an image (a lane reference is resolved there). */
const IMAGE_ARG_TOOLS = Object.freeze(['run', 'get_image', 'list_files', 'read_file', 'grep', 'download'])

const LANE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/
const LANE_REF = /^lane:(.+)$/
const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE|SESSION)/i
const HISTORY_KEPT = 20

export function isLaneName(name) {
  return typeof name === 'string' && LANE_NAME.test(name)
}

/** The lane a `lane:<name>` reference names, else null. */
export function laneRefName(image) {
  if (typeof image !== 'string') return null
  const match = image.match(LANE_REF)
  return match ? match[1] : null
}

/** The contree tool a full tool name is, else null: `mcp__contree__run` -> `run`. */
export function contreeToolOf(fullName) {
  return typeof fullName === 'string' && fullName.startsWith(CONTREE_PREFIX) ? fullName.slice(CONTREE_PREFIX.length) : null
}

export function contreeToolNames(tools) {
  return tools.map(tool => CONTREE_PREFIX + tool)
}

/**
 * What an image argument stands for: `lane:<name>` is that lane's head, an empty
 * one is the default image, anything else is passed on as written.
 * Returns `{ image, lane? }` or `{ error }`.
 */
export function resolveImage(image, lanes, defaultImage) {
  if (image === undefined || image === null || image === '') {
    if (typeof defaultImage === 'string' && defaultImage !== '') return { image: defaultImage }
    return { error: 'no image was named and the plugin has no default image; name an image UUID, tag:<name> or lane:<name>' }
  }
  if (typeof image !== 'string') return { error: 'image must be a string' }
  const name = laneRefName(image)
  if (name === null) return { image }
  const lane = lanes[name]
  if (!lane) {
    const known = Object.keys(lanes)
    return { error: `there is no lane "${name}"${known.length ? `; lanes: ${known.join(', ')}` : '; create one with sandbox_lane_new'}` }
  }
  return { image: lane.head, lane: name }
}

/** Environment variable names that look like credentials. */
export function secretLikeEnvNames(env) {
  if (!env || typeof env !== 'object') return []
  return Object.keys(env).filter(name => SECRET_ENV_NAME.test(name))
}

/**
 * `run` arguments with `env` as an object: a missing, null or non-object `env`
 * becomes `{}`, since the contree service answers HTTP 400 for anything but a
 * dictionary. Other tools' arguments are returned as they are.
 */
export function withRunEnv(tool, args) {
  if (tool !== 'run') return args
  const env = args?.env
  if (env && typeof env === 'object' && !Array.isArray(env)) return args
  return { ...args, env: {} }
}

/**
 * The guard and rewrite for one contree call.
 *
 * Returns `{ args, lane?, saves? }` to run with, or `{ deny }`:
 * - a lane reference in `image` becomes the lane's head;
 * - an empty `image` on `run` becomes the default image;
 * - environment variables named like credentials are refused (keep keys out of the sandbox);
 * - a run that saves onto a lane must wait, and must come from the lane's owner;
 * - a timeout over the limit is cut to it.
 */
export function guardCall(tool, args, { lanes, agentId, defaultImage, maxRunSeconds }) {
  const next = { ...args }
  let lane
  if (IMAGE_ARG_TOOLS.includes(tool) && (tool === 'run' || next.image !== undefined)) {
    const resolved = resolveImage(next.image, lanes, tool === 'run' ? defaultImage : undefined)
    if (resolved.error) return { deny: resolved.error }
    next.image = resolved.image
    lane = resolved.lane
  }
  if (tool === 'set_tag' && laneRefName(next.image_uuid) !== null) {
    const resolved = resolveImage(next.image_uuid, lanes)
    if (resolved.error) return { deny: resolved.error }
    next.image_uuid = resolved.image
  }
  if (tool !== 'run') return lane ? { args: next, lane } : { args: next }

  next.env = withRunEnv(tool, next).env
  const secrets = secretLikeEnvNames(next.env)
  if (secrets.length > 0) {
    const named = secrets.length === 1 ? `${secrets[0]} looks like a credential` : `${secrets.join(', ')} look like credentials`
    return { deny: `refused: ${named}; the sandbox must not receive keys or tokens. Run the step that needs them locally.` }
  }
  if (typeof maxRunSeconds === 'number' && maxRunSeconds > 0) {
    const asked = typeof next.timeout === 'number' ? next.timeout : undefined
    if (asked !== undefined && asked > maxRunSeconds) next.timeout = maxRunSeconds
  }
  const saves = next.disposable === false
  if (lane && saves) {
    if (next.wait === false) {
      return { deny: `a run that saves onto lane "${lane}" must wait for its result (the lane's head moves when it ends); drop wait:false, or pass disposable:true for a run whose changes are not kept` }
    }
    const owner = lanes[lane].owner
    const caller = agentId ?? MAIN_LOOP
    if (owner && owner !== caller) {
      return { deny: `lane "${lane}" belongs to ${owner === MAIN_LOOP ? 'the main conversation' : `agent ${owner}`}; save onto your own lane (sandbox_lane_new) or run with disposable:true` }
    }
  }
  return { args: next, ...(lane ? { lane } : {}), ...(saves ? { saves: true } : {}) }
}

/** A new lane at `image`. Returns `{ lanes }` or `{ error }`. */
export function createLane(lanes, { name, image, owner, now }) {
  if (!isLaneName(name)) return { error: `"${name}" is not a lane name: letters, digits, ".", "_", "-", up to 48` }
  if (lanes[name]) return { error: `lane "${name}" exists; drop it first or pick another name` }
  const lane = { name, base: image, head: image, owner: owner ?? null, history: [image], runs: 0, createdAt: now, updatedAt: now }
  return { lanes: { ...lanes, [name]: lane } }
}

/** The lane moved to `image`, made by `agentId`; the first saving caller owns an unowned lane. */
export function advanceLane(lanes, name, image, agentId, now) {
  const lane = lanes[name]
  if (!lane || typeof image !== 'string' || image === '' || image === lane.head) return lanes
  const history = [...lane.history, image].slice(-HISTORY_KEPT)
  const owner = lane.owner ?? agentId ?? MAIN_LOOP
  return { ...lanes, [name]: { ...lane, head: image, snapshotTimes: { ...lane.snapshotTimes, [image]: now }, history, owner, runs: lane.runs + 1, updatedAt: now } }
}

export function dropLane(lanes, name) {
  if (!lanes[name]) return lanes
  const { [name]: _dropped, ...rest } = lanes
  return rest
}

/** The lane set free when the agent that owned it stops; its head is kept. */
export function releaseOwner(lanes, agentId, now) {
  let changed = false
  const next = {}
  for (const [name, lane] of Object.entries(lanes)) {
    if (agentId && lane.owner === agentId) {
      next[name] = { ...lane, owner: null, finishedBy: agentId, updatedAt: now }
      changed = true
    } else {
      next[name] = lane
    }
  }
  return changed ? next : lanes
}

/** One line per lane, for the model. */
export function describeLanes(lanes) {
  const rows = Object.values(lanes)
  if (rows.length === 0) return 'No lanes yet. Create one with sandbox_lane_new.'
  return rows
    .map(lane => {
      const owner = lane.owner ? (lane.owner === MAIN_LOOP ? 'main' : `agent ${lane.owner}`) : 'free'
      const finished = lane.finishedBy ? `, finished by agent ${lane.finishedBy}` : ''
      return `- ${lane.name}: head ${lane.head} (base ${lane.base}, ${lane.runs} saved run${lane.runs === 1 ? '' : 's'}, ${owner}${finished})`
    })
    .join('\n')
}
