// ════════════════════════════════════════════════════════════════════════════
//  THE CONFIGURATION BLOCK — everything this mod knows about Nebius Token Factory.
// ════════════════════════════════════════════════════════════════════════════
//
// Facts come from the vendor's public API reference
// (https://docs.tokenfactory.nebius.com/api-reference). Where a value is
// repeated in `.claude-plugin/plugin.json` (base URL, starter models), the
// manifest is what the Settings page and the consent screen show; this file
// is what the code uses. Keep them equal.

/** Shown in log lines only; the Settings page shows the manifest's `displayName`. */
export const DISPLAY_NAME = 'Nebius Token Factory'

/**
 * The server root every request path is relative to (the manifest's
 * `defaultBaseUrl`, the eu-north1 region). Only the FALLBACK: the base URL the
 * person set (a regional `api.tokenfactory.<region>.nebius.com` host, say) is
 * read back from the listing request (`baseUrlFromListing`).
 */
export const DEFAULT_BASE_URL = 'https://api.tokenfactory.nebius.com/v1'

/**
 * The model listing, relative to the base URL. It needs the key; `verbose`
 * adds the rich fields: `name`, `context_length`, `architecture.modality`
 * (`text+image->text`), `pricing` (USD per token, decimal strings),
 * `supported_features` (`tools`, `reasoning`) and `status`.
 */
export const LISTING_PATH = '/models'
export const LISTING_QUERY = { verbose: 'true' }

/** The request header that carries the key; `{{secret:api_key}}` is filled in host-side. */
export const AUTH_HEADER = { name: 'authorization', value: 'Bearer {{secret:api_key}}' }

/** The `supported_features` words this mod reads (compared lower-case). */
export const FEATURE = { tools: 'tools', reasoning: 'reasoning' }

/** A listed `status` the model is offered in; a row with no status is offered too. */
export const ACTIVE_STATUS = 'active'

/**
 * The catalog provider whose records fill what the listing leaves out (the
 * output cap, reasoning efforts, which field replays reasoning). The values
 * are provider ids of the public models.dev database.
 */
export const CATALOG_KEY = 'nebius'

export const MODEL_NAMES = {
  'nvidia/nemotron-3.5-super-vl': 'Nemotron 3.5 Super VL',
  'nvidia/nemotron-3_5-lightning': 'Nemotron 3.5 Lightning',
  'nvidia/nemotron-3-nano-30b-a3b': 'Nemotron 3 Nano',
  'nvidia/nemotron-3-super-120b-a12b': 'Nemotron 3 Super',
  'nvidia/nemotron-3-ultra-550b-a55b': 'Nemotron 3 Ultra',
}

/**
 * Where to look when the `nebius` catalog entry lacks a listed model: the
 * model maker's own entry, by the organisation half of the id
 * (`zai-org/GLM-5.3` -> `zai-org`, compared lower-case). A borrowed record
 * gives model facts only, never a price.
 */
export const MAKER_CATALOG_KEYS = {
  'deepseek-ai': ['deepseek'],
  'zai-org': ['zai'],
  moonshotai: ['moonshotai'],
  qwen: ['alibaba'],
  minimaxai: ['minimax'],
  openai: ['openai'],
  google: ['google'],
  nvidia: ['nvidia'],
  mistralai: ['mistral'],
  'meta-llama': ['llama'],
}

/**
 * The wire every model speaks: the platform's `openai-chat` codec at
 * `<base>/chat/completions`, with
 *   - `max_tokens` (the field the server documents first and every engine behind it reads),
 *   - the `system` role (open-weight chat templates do not all know `developer`).
 * `reasoningReplay` is added per model (see `REASONING_REPLAY_FIELD`).
 */
export const WIRE_COMPAT = { maxTokensField: 'max_tokens', developerRole: false }

/**
 * The assistant-message field that carries earlier reasoning back to the
 * server, for a model that reasons: the catalog's `interleavedField` when it
 * names one of these, else `reasoning_content` (the field the API reference
 * accepts on an assistant message).
 */
export const REASONING_REPLAY_FIELDS = ['reasoning_content', 'reasoning']
export const REASONING_REPLAY_FIELD = 'reasoning_content'

/** What a model gets when neither the listing nor the catalog says. */
export const DEFAULTS = {
  contextWindow: 131072,
  // The server refuses a request whose prompt plus `max_tokens` exceeds the
  // context, so an output cap the catalog states as the whole context (or
  // none at all) is replaced by this, held to a quarter of the context.
  maxOutputTokens: 32768,
  outputShareOfContext: 4,
  // Tiers offered to a reasoning model whose catalog record lists no efforts.
  reasoningTiers: ['low', 'medium', 'high'],
  reasoningDefaultTier: 'medium',
}

/** The runtime's tier names -> the server's `reasoning_effort` words. */
export const TIER_TO_WIRE = {
  none: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  'extra-high': 'xhigh',
  max: 'max',
}

/** The vendor's own names for the tiers, shown next to the runtime's (display only). */
export const TIER_LABELS = { 'extra-high': 'xhigh' }

/** Badges on the Add models page (names the manifest's `modelsUi.tags` labels). */
export const TAGS = { fast: 'fast', reasoning: 'reasoning', vision: 'vision' }

/** A model id ending in this is the vendor's faster-serving variant of a model. */
export const FAST_SUFFIX = '-fast'

/** A row's `description` is cut to this many characters (the platform's cap). */
export const DESCRIPTION_MAX = 300
