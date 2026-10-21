/**
 * Reading contree-mcp's replies. Pure.
 *
 * A tool answers one text block (JSON, or a plain sentence for an async run)
 * and, for most tools, structured content; a reply whose type is not an
 * object comes wrapped as `{ result }`. An operation is
 * `{ uuid, status, kind, exit_code, timed_out, stdout, stderr,
 * result_image_uuid, result: { image } }`.
 */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const TERMINAL = Object.freeze([
  'SUCCESS', 'SUCCEEDED', 'COMPLETED', 'DONE', 'FAILED', 'FAILURE', 'ERROR', 'CANCELLED', 'CANCELED', 'TIMEOUT', 'TIMED_OUT',
])

/** The text as JSON, or null. */
export function parseReply(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed === '') return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

/** `{ result: x }` with nothing else is `x`. */
export function unwrapReply(reply) {
  if (reply && typeof reply === 'object' && !Array.isArray(reply)) {
    const keys = Object.keys(reply)
    if (keys.length === 1 && keys[0] === 'result') return reply.result
  }
  return reply
}

/** What a tool answered, as data: the structured content, else the JSON text, else the text itself. */
export function replyOf({ structured, text }) {
  if (structured !== undefined && structured !== null) {
    const value = unwrapReply(structured)
    if (typeof value === 'string') return parseReply(value) ?? value
    return value
  }
  const parsed = parseReply(text)
  return parsed === null ? (typeof text === 'string' ? text : null) : unwrapReply(parsed)
}

/** An operation's status, upper case; '' when it states none. */
export function statusOf(op) {
  return String(op?.status ?? op?.state ?? '').toUpperCase()
}

/** Still pending or running: a status that is stated and is not an end. */
export function isActive(op) {
  const status = statusOf(op)
  return status !== '' && !TERMINAL.includes(status)
}

/** The image a run produced, when it produced one. */
export function resultImageOf(reply) {
  if (!reply || typeof reply !== 'object') return null
  const image = reply.result_image_uuid ?? reply.result_image ?? reply.result?.image
  return typeof image === 'string' && image !== '' ? image : null
}

/** What a key needs to use sandboxes at all: see images and operations, and start a run. */
const NEEDED_PERMISSIONS = Object.freeze(['list', 'spawn_disposable'])

/**
 * The permissions `whoami` says the key lacks, of those it needs; [] when the
 * reply states no permissions (nothing is known to be missing).
 */
export function missingPermissions(whoami) {
  const granted = whoami && typeof whoami === 'object' ? whoami.permissions : null
  if (!granted || typeof granted !== 'object') return []
  return NEEDED_PERMISSIONS.filter(name => granted[name] !== true && !(name === 'spawn_disposable' && granted.spawn === true))
}

/** The operation a `run` with `wait: false` started: a field, or the id in its sentence. */
export function operationIdOf(reply) {
  if (typeof reply === 'string') return reply.match(UUID)?.[0] ?? null
  if (!reply || typeof reply !== 'object') return null
  const id = reply.operation_id ?? reply.uuid
  return typeof id === 'string' && id !== '' ? id : null
}
