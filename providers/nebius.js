// Nebius Token Factory provider mod — the hooks. One provider
// (`mod.nebius.token-factory`), one module.
//
// How a provider module runs (the contract this module relies on):
//   - `register(on)` is called once when the worker starts; `on(event, hook)`
//     adds a hook. A hook is `($, e) => answer`, sync or async.
//   - `$` offers `$.provider`, `$.catalog`, `$.log` and `$.fs.read` of the
//     plugin's own files; nothing of the session.
//   - A hook has a time budget per event (listing 30 s, request 2 s). A hook
//     that throws, or answers something of the wrong kind, has no answer: the
//     platform keeps its cached listing, and refuses to send a request whose
//     hook failed.
//   - The worker exits after ten idle minutes; this module keeps no state.
//
// No `provider.verify` hook: the listing needs the key, so the platform's
// default probe (a GET of the model list with the stored key) already tells a
// good key from a bad one. No `provider.usage` hook: the API has no balance
// or usage endpoint.
//
// All server-specific facts are in `config.js`; the logic is in `logic.js`.

import {
  AUTH_HEADER,
  CATALOG_KEY,
  DEFAULT_BASE_URL,
  DISPLAY_NAME,
  LISTING_PATH,
  LISTING_QUERY,
  MAKER_CATALOG_KEYS,
} from './config.js'
import { baseUrlFromListing, buildModels, effortPatch, idsMissingFrom, makerOf } from './logic.js'

export function register(on) {
  // ── provider.models ───────────────────────────────────────────────────────
  // Raised when the person connects, on Refresh, and now and then in the
  // background. The platform caches the answer on disk.
  on('provider.models', async ($, e) => {
    // The listing needs the key: before one is saved there is nothing to ask
    // for, and the page shows its "enter a key" text.
    if (e.connected === false) return []
    const response = await $.provider.fetch(LISTING_PATH, {
      provider: e.provider,
      query: LISTING_QUERY,
      headers: { [AUTH_HEADER.name]: AUTH_HEADER.value },
    })
    if (!response.ok) throw new Error(`${DISPLAY_NAME}: the model list answered ${response.status}`)
    const listing = await response.json()
    $.log.debug(`${DISPLAY_NAME}: listing from ${baseUrlFromListing(response.url, DEFAULT_BASE_URL)}`)
    const catalog = await readCatalog($, listing)
    return buildModels({ listing, catalog })
  })

  // ── provider.request ──────────────────────────────────────────────────────
  // Raised for every request just before it is sent. `e` carries the small
  // facts only (model, format, effort, ...), never the conversation. The one
  // edit: the person's thinking tier as `reasoning_effort`.
  on('provider.request', (_$, e) => {
    const patch = effortPatch(e.effort)
    return patch.length > 0 ? { patch } : {}
  })
}

/**
 * The catalog records for the listed models (`modelId -> record`), or
 * undefined when the catalog has none or cannot be asked. The provider's own
 * entry answers first; a listed id it lacks is asked for with its maker's
 * entry as `alsoTry` (a borrowed record: model facts only).
 */
async function readCatalog($, listing) {
  try {
    const own = await $.catalog?.models(CATALOG_KEY)
    let records = own && typeof own === 'object' ? { ...own } : undefined
    if (typeof $.catalog?.model !== 'function') return records
    for (const id of idsMissingFrom(listing, records)) {
      const alsoTry = MAKER_CATALOG_KEYS[makerOf(id)]
      if (!alsoTry) continue
      const found = await $.catalog.model(CATALOG_KEY, id, { alsoTry })
      if (found && typeof found === 'object') (records ??= {})[id] = found
    }
    return records
  } catch (error) {
    $.log.warn(`model catalog unavailable (${error instanceof Error ? error.message : String(error)}); using the listing alone`)
    return undefined
  }
}
