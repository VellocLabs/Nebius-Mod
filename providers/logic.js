// The pure half of the Nebius Token Factory provider mod: no `$`, no network,
// no clock. Everything here is a function of its arguments and of
// `config.js`, which is why it is unit-tested directly
// (`tests/nebius-mod.test.mjs` at the repository root).
//
//   buildModels        the verbose listing + the catalog records -> the rows
//                      `provider.models` answers (limits, tiers, wire, badges)
//   effortPatch        a thinking tier -> the `reasoning_effort` body edit
//   baseUrlFromListing the listing request's final URL -> the base URL in force
//   makerOf            a model id -> the organisation that publishes it

import {
  ACTIVE_STATUS,
  DEFAULTS,
  DESCRIPTION_MAX,
  FAST_SUFFIX,
  FEATURE,
  LISTING_PATH,
  REASONING_REPLAY_FIELD,
  REASONING_REPLAY_FIELDS,
  TAGS,
  TIER_LABELS,
  TIER_TO_WIRE,
  WIRE_COMPAT,
} from './config.js'

/** The runtime's thinking-tier vocabulary, lowest effort first. A mod cannot add a name. */
export const TIER_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'extra-high', 'max']

const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const positive = value => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined)
const strings = value => (Array.isArray(value) ? value.filter(item => typeof item === 'string') : [])

// ── base URL ────────────────────────────────────────────────────────────────

/**
 * The base URL in force, read back from where the listing request went: the
 * event's `baseUrl` may be absent, and the final URL is `<base URL> +
 * LISTING_PATH` (plus the query). Falls back to `fallback`.
 */
export function baseUrlFromListing(finalUrl, fallback) {
  try {
    const url = new URL(finalUrl)
    if (!url.pathname.endsWith(LISTING_PATH)) return fallback
    return `${url.origin}${url.pathname.slice(0, url.pathname.length - LISTING_PATH.length)}`
  } catch {
    return fallback
  }
}

// ── listing fields ──────────────────────────────────────────────────────────

/** A per-token USD price (a decimal string or number) -> USD per million tokens, or undefined. */
export function perMillion(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return undefined
  // Rounded to strip float noise (0.0000001 * 1e6 = 0.09999999999999999).
  return Math.round(n * 1e12) / 1e6
}

/** `architecture.modality` (`text+image->text`) as input and output kinds, or undefined. */
export function modalityOf(row) {
  const modality = isRecord(row?.architecture) ? row.architecture.modality : undefined
  if (typeof modality !== 'string') return undefined
  const parts = modality.toLowerCase().split('->')
  if (parts.length !== 2) return undefined
  const split = side => side.split('+').map(kind => kind.trim()).filter(Boolean)
  return { inputs: split(parts[0]), outputs: split(parts[1]) }
}

/** The lower-cased `supported_features`, or undefined when the row states none. */
export function featuresOf(row) {
  return Array.isArray(row?.supported_features) ? strings(row.supported_features).map(f => f.trim().toLowerCase()) : undefined
}

/** The organisation half of a `maker/model` id, lower case (`zai-org`), or '' for a bare id. */
export function makerOf(id) {
  const at = String(id).indexOf('/')
  return at > 0 ? String(id).slice(0, at).toLowerCase() : ''
}

/** Whether a listing row is offered at all: a chat model (text out) the server serves now. */
export function isOffered(row) {
  if (row.status !== undefined && row.status !== null && row.status !== ACTIVE_STATUS) return false
  const modality = modalityOf(row)
  return modality === undefined || modality.outputs.includes('text')
}

// ── tiers and limits ────────────────────────────────────────────────────────

/** A vendor effort spelling -> the runtime's tier name, or undefined. */
function tierName(value) {
  if (typeof value !== 'string') return undefined
  const lower = value.trim().toLowerCase()
  const named = lower === 'xhigh' || lower === 'x-high' || lower === 'extra_high' ? 'extra-high' : lower
  return TIER_ORDER.includes(named) ? named : undefined
}

/** The tiers a catalog record's `reasoningEfforts` state (lowest first), or undefined. */
function statedTiers(efforts) {
  if (!Array.isArray(efforts)) return undefined
  const found = efforts.map(tierName)
  const tiers = TIER_ORDER.filter(tier => found.includes(tier))
  return tiers.length > 0 ? tiers : undefined
}

/** Thinking-tier fields of a model that reasons; `{}` for one that does not. */
function tierFacts(reasons, record) {
  if (!reasons) return {}
  const thinkingTiers = statedTiers(record?.reasoningEfforts) ?? [...DEFAULTS.reasoningTiers]
  const defaultThinkingTier = thinkingTiers.includes(DEFAULTS.reasoningDefaultTier)
    ? DEFAULTS.reasoningDefaultTier
    : thinkingTiers.find(tier => tier !== 'none') ?? thinkingTiers[0]
  const thinkingTierLabels = {}
  for (const tier of thinkingTiers) if (TIER_LABELS[tier]) thinkingTierLabels[tier] = TIER_LABELS[tier]
  return {
    thinkingTiers,
    defaultThinkingTier,
    ...(Object.keys(thinkingTierLabels).length > 0 ? { thinkingTierLabels } : {}),
  }
}

/**
 * The output cap: the catalog's, unless it is missing or would fill the whole
 * context (the server refuses prompt + `max_tokens` over the context); then
 * the default, held to a share of the context.
 */
export function outputCapOf(stated, contextWindow) {
  const cap = positive(stated)
  if (cap !== undefined && cap < contextWindow) return cap
  return Math.max(1, Math.min(DEFAULTS.maxOutputTokens, Math.floor(contextWindow / DEFAULTS.outputShareOfContext)))
}

/** The wire of a model: the shared compat switches, plus reasoning replay for a model that reasons. */
export function wireOf(reasons, record) {
  const compat = { ...WIRE_COMPAT }
  if (reasons) {
    const field = record?.interleavedField
    compat.reasoningReplay = typeof field === 'string' && REASONING_REPLAY_FIELDS.includes(field) ? field : REASONING_REPLAY_FIELD
  }
  return { format: 'openai-chat', compat }
}

// ── the model list ──────────────────────────────────────────────────────────

/**
 * The rows `provider.models` answers.
 *
 * The listing is the authority on WHAT is served and how it is billed (id,
 * name, context, modality, price, tools, reasoning); the catalog record fills
 * only what it leaves out (output cap, reasoning efforts, the replay field)
 * and stands in for a row that states no features.
 *
 * @param {Object} input
 * @param {unknown} input.listing  the verbose listing body: `{ data: [...] }`
 * @param {unknown} input.catalog  catalog records (`modelId -> record`), or undefined
 */
export function buildModels({ listing, catalog }) {
  if (!isRecord(listing) || !Array.isArray(listing.data)) throw new Error('the model listing has no "data" list')
  const records = isRecord(catalog) ? catalog : {}
  const seen = new Set()
  const rows = []
  for (const item of listing.data) {
    const id = isRecord(item) && typeof item.id === 'string' ? item.id.trim() : ''
    if (id === '' || seen.has(id) || !isOffered(item)) continue
    seen.add(id)
    const record = Object.hasOwn(records, id) && isRecord(records[id]) ? records[id] : undefined
    const features = featuresOf(item)
    const supportsTools = features ? features.includes(FEATURE.tools) : record?.toolCall === true
    const reasons = features ? features.includes(FEATURE.reasoning) : record?.reasoning === true
    const modality = modalityOf(item)
    const inputs = modality?.inputs ?? strings(record?.inputModalities)
    const contextWindow = positive(item.context_length) ?? positive(record?.contextWindow) ?? DEFAULTS.contextWindow
    const vision = inputs.includes('image')

    const row = {
      id,
      name: typeof item.name === 'string' && item.name.trim() !== ''
        ? item.name.trim()
        : typeof record?.name === 'string' && record.name.trim() !== '' ? record.name.trim() : id,
      supportsTools,
      contextWindow,
      maxOutputTokens: outputCapOf(record?.maxOutput, contextWindow),
      supportsImageInput: vision,
      supportsPdfInput: false,
      ...tierFacts(reasons, record),
      wire: wireOf(reasons, record),
    }

    const pricing = isRecord(item.pricing) ? item.pricing : undefined
    const input = perMillion(pricing?.prompt)
    const output = perMillion(pricing?.completion)
    // A listing price of 0 is the schema's default, not a free model: only
    // the catalog's own `free` (never a borrowed record's) marks one free.
    if (input !== undefined && output !== undefined && input > 0 && output > 0) row.price = { input, output }
    else if (record?.match !== 'borrowed' && record?.free === true) row.free = true

    const tags = []
    if (id.toLowerCase().endsWith(FAST_SUFFIX)) tags.push(TAGS.fast)
    if (reasons) tags.push(TAGS.reasoning)
    if (vision) tags.push(TAGS.vision)
    if (tags.length > 0) row.tags = tags

    const description = typeof item.description === 'string' ? item.description.trim() : ''
    if (description !== '') row.description = description.length > DESCRIPTION_MAX ? `${description.slice(0, DESCRIPTION_MAX - 1)}…` : description

    rows.push(row)
  }
  return rows
}

/** The listed ids the catalog's own entry lacks, to be asked for one by one. */
export function idsMissingFrom(listing, records) {
  if (!isRecord(listing) || !Array.isArray(listing.data)) return []
  const known = isRecord(records) ? records : {}
  const ids = listing.data
    .filter(item => isRecord(item) && typeof item.id === 'string' && item.id.trim() !== '' && isOffered(item))
    .map(item => item.id.trim())
  return [...new Set(ids)].filter(id => !Object.hasOwn(known, id))
}

// ── the request ─────────────────────────────────────────────────────────────

/**
 * The body edit that gives one request its thinking tier: the top-level
 * `reasoning_effort` word. [] when the request carries no known tier (the
 * model then thinks at its own default). The platform writes no reasoning
 * field for a mod provider, so a model offered with tiers needs this.
 *
 * @param {string | undefined} tier `e.effort` (runtime vocabulary)
 */
export function effortPatch(tier) {
  if (typeof tier !== 'string' || !Object.hasOwn(TIER_TO_WIRE, tier)) return []
  return [{ op: 'set', path: '/reasoning_effort', value: TIER_TO_WIRE[tier] }]
}
