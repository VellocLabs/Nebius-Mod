/**
 * The test matrix: one image, N commands, each in its own throw-away microVM,
 * started together and read back as one summary.
 *
 * Pure: `planMatrix` turns the tool's input into run arguments, `summarize`
 * turns what `wait_operations` answered into the text the model reads.
 */

import { isActive, statusOf } from './replies.js'

/** Runs a project may have going at once. */
export const MAX_SHARDS = 50
const OUTPUT_TAIL = 1500
const SHARD_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/

/** The tool's input schema, as registered. */
export const MATRIX_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    image: { type: 'string', description: 'Image UUID, tag:<name> or lane:<name>. Defaults to the plugin\'s default image.' },
    shards: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_SHARDS,
      description: 'One entry per run: a shell command, or { name, command }.',
      items: {
        anyOf: [
          { type: 'string' },
          { type: 'object', properties: { name: { type: 'string' }, command: { type: 'string' } }, required: ['command'] },
        ],
      },
    },
    directory_state_id: { type: 'integer', description: 'Files from rsync, mounted in every run.' },
    cwd: { type: 'string', description: 'Working directory in every run.' },
    env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Environment variables for every run (no credentials).' },
    timeout: { type: 'integer', description: 'Seconds each run may take.' },
  },
  required: ['shards'],
})

/**
 * The runs to start. Returns `{ shards: [{ name, args }] }` or `{ error }`;
 * `image` is already resolved by the caller.
 */
export function planMatrix(input, image) {
  const shards = Array.isArray(input?.shards) ? input.shards : null
  if (!shards || shards.length === 0) return { error: 'shards must list at least one command' }
  if (shards.length > MAX_SHARDS) return { error: `at most ${MAX_SHARDS} shards run at once; split the matrix` }
  const seen = new Set()
  const planned = []
  for (const [index, shard] of shards.entries()) {
    const command = typeof shard === 'string' ? shard : shard?.command
    if (typeof command !== 'string' || command.trim() === '') return { error: `shard ${index + 1} has no command` }
    const name = typeof shard === 'object' && typeof shard.name === 'string' && shard.name !== '' ? shard.name : `shard-${index + 1}`
    if (!SHARD_NAME.test(name)) return { error: `shard name "${name}" is not a short plain name` }
    if (seen.has(name)) return { error: `two shards are named "${name}"` }
    seen.add(name)
    const args = { command, image, disposable: true, wait: false }
    if (input.directory_state_id !== undefined) args.directory_state_id = input.directory_state_id
    if (typeof input.cwd === 'string') args.cwd = input.cwd
    if (input.env && typeof input.env === 'object') args.env = input.env
    if (typeof input.timeout === 'number') args.timeout = input.timeout
    planned.push({ name, args })
  }
  return { shards: planned }
}

export { operationIdOf } from './replies.js'

function tail(text) {
  if (typeof text !== 'string' || text === '') return ''
  return text.length > OUTPUT_TAIL ? `…${text.slice(-OUTPUT_TAIL)}` : text
}

/** How one shard ended: `passed`, `failed`, `timed out`, `cancelled`, `not started`, `still running`. */
export function outcomeOf(result, { isCancelled, isStarted }) {
  if (!isStarted) return 'not started'
  if (isCancelled) return 'cancelled'
  if (!result) return 'still running'
  if (result.timed_out === true) return 'timed out'
  const status = statusOf(result)
  if (isActive(result)) return 'still running'
  if (status === 'SUCCESS' && result.exit_code === 0) return 'passed'
  if (status === 'CANCELLED' || status === 'CANCELED') return 'cancelled'
  return 'failed'
}

/**
 * The summary the model reads: counts, one line per shard, then the output
 * tail of each shard that did not pass.
 *
 * `started` is `[{ name, command, operationId?, error? }]`; `waited` is what
 * `wait_operations` answered (or null when it was not reached).
 */
export function summarize(image, started, waited) {
  const results = waited && typeof waited.results === 'object' && waited.results ? waited.results : {}
  const cancelled = new Set(Array.isArray(waited?.cancelled) ? waited.cancelled : [])
  const rows = started.map(shard => {
    const result = shard.operationId ? results[shard.operationId] : undefined
    const outcome = shard.error
      ? 'not started'
      : outcomeOf(result, { isCancelled: cancelled.has(shard.operationId), isStarted: Boolean(shard.operationId) })
    return { ...shard, result, outcome }
  })
  const count = outcome => rows.filter(row => row.outcome === outcome).length
  const passed = count('passed')
  const lines = [
    `Test matrix on ${image}: ${passed}/${rows.length} passed` +
      (rows.length - passed > 0 ? ` (${rows.length - passed} did not: ${['failed', 'timed out', 'cancelled', 'not started', 'still running'].filter(o => count(o) > 0).map(o => `${count(o)} ${o}`).join(', ')})` : '') +
      (waited?.timed_out === true ? '. The wait timed out; read the rest with get_operation.' : '.'),
    '',
    '| shard | outcome | exit | operation |',
    '|---|---|---|---|',
    ...rows.map(row => `| ${row.name} | ${row.outcome} | ${row.result?.exit_code ?? ''} | ${row.operationId ?? ''} |`),
  ]
  for (const row of rows) {
    if (row.outcome === 'passed') continue
    lines.push('', `### ${row.name}: ${row.outcome}`, `$ ${row.command}`)
    if (row.error) lines.push(row.error)
    const out = tail(row.result?.stdout)
    const err = tail(row.result?.stderr)
    if (out) lines.push('stdout:', '```', out, '```')
    if (err) lines.push('stderr:', '```', err, '```')
  }
  return { text: lines.join('\n'), passed, total: rows.length }
}
