// Unit tests for the Nebius Token Factory provider mod.
// No browser, no network, no platform: the pure logic is called directly and
// the hooks are run against a hand-made `$`. Run:
//   node --test tests/nebius-mod.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CATALOG_KEY, DEFAULT_BASE_URL, DEFAULTS, LISTING_PATH, MAKER_CATALOG_KEYS } from '../providers/config.js'
import {
  baseUrlFromListing,
  buildModels,
  effortPatch,
  idsMissingFrom,
  isOffered,
  makerOf,
  modalityOf,
  outputCapOf,
  perMillion,
} from '../providers/logic.js'
import { register } from '../providers/nebius.js'

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'))
const provider = manifest.providers['token-factory']

// The shape of the verbose listing (`GET /v1/models?verbose=true`).
const LISTING = {
  object: 'list',
  data: [
    {
      id: 'zai-org/GLM-5.3', name: 'GLM-5.3', description: 'Flagship GLM model', context_length: 1024000,
      architecture: { modality: 'text->text', tokenizer: 'Other' },
      pricing: { prompt: '0.0000014', completion: '0.0000044', image: '0', request: '0' },
      supported_features: ['tools', 'reasoning'], status: 'active',
    },
    {
      id: 'Qwen/Qwen3-30B-A3B-Instruct-2507-fast', name: 'Qwen3-30B-A3B-Instruct-2507 (fast)', context_length: 262144,
      architecture: { modality: 'text->text' }, pricing: { prompt: '0.0000001', completion: '0.0000003' },
      supported_features: ['tools'],
    },
    {
      id: 'google/gemma-3-27b-it', name: 'Gemma-3-27b-it', context_length: 110000,
      architecture: { modality: 'text+image->text' }, pricing: { prompt: '0.0000001', completion: '0.0000003' },
      supported_features: ['TOOLS'],
    },
    {
      id: 'meta-llama/Llama-3.3-70B-Instruct', name: 'Llama-3.3-70B-Instruct', context_length: 131072,
      architecture: { modality: 'text->text' }, pricing: { prompt: '0.00000013', completion: '0.0000004' },
      supported_features: [],
    },
    { id: 'Qwen/Qwen3-Embedding-8B', name: 'Qwen3-Embedding-8B', context_length: 40960, architecture: { modality: 'text->embedding' }, pricing: {} },
    { id: 'black-forest-labs/flux-dev', name: 'FLUX dev', context_length: 77, architecture: { modality: 'text->image' }, pricing: {} },
    { id: 'retired/model', name: 'Retired', context_length: 8192, architecture: { modality: 'text->text' }, supported_features: ['tools'], status: 'deleted' },
    { id: 'moonshotai/Kimi-K3', context_length: 1048576, supported_features: null, pricing: { prompt: '0', completion: '0' } },
    { id: 'zai-org/GLM-5.3', name: 'duplicate' },
    { object: 'model' },
  ],
}

// The platform catalog's records (normalized: modelId -> record).
const CATALOG = {
  'zai-org/GLM-5.3': {
    name: 'GLM-5.3', reasoning: true, reasoningEfforts: ['low', 'high', 'max'], toolCall: true, interleavedField: 'reasoning_content',
    contextWindow: 1024000, maxOutput: 1024000, inputModalities: ['text'], cost: { input: 1.4, output: 4.4 }, free: false, match: 'exact',
  },
  'google/gemma-3-27b-it': { name: 'Gemma 3 27B', toolCall: true, contextWindow: 110000, maxOutput: 8192, inputModalities: ['text', 'image'], match: 'exact' },
  'moonshotai/Kimi-K3': { name: 'Kimi K3', toolCall: true, reasoning: true, contextWindow: 1048576, maxOutput: 8000, match: 'borrowed', from: 'moonshotai' },
}

const byId = rows => Object.fromEntries(rows.map(row => [row.id, row]))

test('manifest: the empty-list text tells the person a key is needed', () => {
  assert.match(provider.modelsUi.empty.en, /API key/)
})

test('manifest: one openai-chat provider on the Token Factory host, with the icon and starter models', () => {
  assert.equal(manifest.name, 'nebius')
  assert.equal(provider.providerApi, 1)
  assert.equal(provider.defaultBaseUrl, DEFAULT_BASE_URL)
  assert.equal(provider.format, 'openai-chat')
  assert.deepEqual(provider.credentials.methods, ['apiKey'])
  assert.ok(provider.domains.some(domain => new URL(DEFAULT_BASE_URL).hostname.endsWith(`.${domain}`)))
  assert.ok(provider.modelsUi.starterModels.length > 0 && provider.modelsUi.starterModels.length <= 8)
  for (const id of provider.modelsUi.starterModels) assert.match(id, /^[^/]+\/[^/]+$/)
  assert.deepEqual(Object.keys(provider.modelsUi.tierModels).sort(), ['balanced', 'best', 'fast'])
  for (const id of Object.values(provider.modelsUi.tierModels)) {
    assert.ok(provider.modelsUi.starterModels.includes(id), `tier model ${id} is a starter model`)
  }
  for (const tag of provider.modelsUi.filters) assert.ok(provider.modelsUi.tags[tag], `filter ${tag} has a label`)
})

test('manifest: every text is given in the same seven languages', () => {
  const languages = ['en', 'zh-CN', 'ja', 'ko', 'es', 'fr', 'de']
  const texts = []
  const walk = (value, path) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (typeof value.en === 'string') return texts.push([path, value])
      for (const [key, inner] of Object.entries(value)) walk(inner, `${path}.${key}`)
    } else if (Array.isArray(value)) value.forEach((inner, i) => walk(inner, `${path}[${i}]`))
  }
  walk(provider.credentials, 'credentials')
  walk(provider.settings, 'settings')
  walk(provider.modelsUi, 'modelsUi')
  assert.ok(texts.length > 0)
  for (const [path, text] of texts) assert.deepEqual(Object.keys(text).sort(), [...languages].sort(), path)
})

test('icon: the colored mark, with a viewBox so it scales, and nothing a page would refuse', () => {
  const svg = readFileSync(join(pluginDir, 'icon.svg'), 'utf8')
  assert.match(svg, /^<svg[\s>]/)
  assert.match(svg, /viewBox="0 0 32 32"/)
  assert.match(svg, /fill="#052B42"/)
  assert.match(svg, /fill="#E0FF4F"/)
  assert.doesNotMatch(svg, /currentColor|<script|<style|<use|<image|href=|url\(|\bon[a-z]+=/i)
  assert.ok(Buffer.byteLength(svg) < 64 * 1024)
})

// The frontmatter of a template or welcome file: `key: value` lines between
// the `---` fences, `#` comment lines dropped, `[a, b]` read as a list.
function frontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  assert.ok(match, 'the file opens with a frontmatter block')
  const out = {}
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#') || /^\s/.test(line)) continue
    const [, key, value] = line.match(/^([A-Za-z_-]+):\s*(.*)$/) ?? []
    if (!key) continue
    const list = value.match(/^\[(.*)\]$/)
    out[key] = list ? list[1].split(',').map(entry => entry.trim()).filter(Boolean) : value
  }
  return out
}

const templateDir = join(pluginDir, 'templates', 'safecode')
const read = (...parts) => readFileSync(join(templateDir, ...parts), 'utf8')

test('manifest: the plugin waits for the Nebius provider and for the template MCP scope feature', () => {
  assert.ok(manifest.requires.providers.includes('token-factory'))
  assert.ok(Object.keys(manifest.providers).includes('token-factory'), 'the required provider is one the plugin ships')
  assert.ok(manifest.requires.features.includes('template-mcp-scope'))
})

test('manifest: the SafeCode template is declared, titled by its brand word, with its four files present', () => {
  const template = manifest.templates.safecode
  assert.deepEqual(template.title, { en: 'SafeCode', 'zh-CN': 'SafeCode' })
  assert.match(template.description.en, /Nothing you ask for runs on this computer/)
  assert.ok(template.description['zh-CN'].length > 0)
  assert.equal(template.icon, './icon.svg')
  assert.equal(template.launcher, 'both')
  for (const file of ['template.md', 'welcome.md', 'welcome-zh.md', join('includes', 'nebius_safecode_intro.md'), join('includes', 'nebius_safecode_using_tools.md'), join('includes', 'nebius_safecode_working.md')]) {
    assert.ok(read(file).length > 0, `${file} is present`)
  }
})

test('template: SafeCode takes MCP from this plugin only, names its skills exactly, and carries no way to run here', () => {
  const fm = frontmatter(read('template.md'))
  assert.equal(fm.type, 'nebius:safecode')
  assert.equal(fm.mcp, 'plugin')
  assert.equal(fm.fileSnapshots, 'true')
  assert.deepEqual(fm.skills, ['plugin:nebius:setup'])
  assert.deepEqual(fm.tools, ['read', 'plan', 'superedit', 'skills', 'ask', 'todo', 'subagent'])
  for (const group of ['shell', 'exec', 'webfetch', 'edit']) assert.ok(!fm.tools.includes(group), `no ${group} group`)
  // Built-ins only, by their bare names; the plugin's own sandbox agents are not offered here.
  assert.deepEqual(fm.agents, ['Explore', 'Plan', 'general-purpose'])
  assert.equal(fm.noExecution, undefined, 'mcp: plugin and noExecution exclude each other')
  const body = read('template.md')
  for (const holder of ['!nebius_safecode_intro', '!nebius_safecode_using_tools', '!nebius_safecode_working', '!tool_call_parallelism', '!delivering_work', '!autonomy', '$mcp_servers', '$environment', '$memory']) {
    assert.ok(body.includes(`\n${holder}\n`), `prompt skeleton has ${holder}`)
  }
  assert.match(body, /\n## begin\s*$/)
})

test('template: the intro opens on the local boundary, speaks as the agent name, and closes on the four-part rule', () => {
  const tools = read('includes', 'nebius_safecode_using_tools.md')
  assert.ok(/mcp__tavily__\*.*whenever the work needs/.test(tools), 'Tavily is for whatever the work needs from the web, not only on request')
  assert.ok(tools.includes('do not ask for the key again'), 'a missing Tavily key is said once')
  const working = read('includes', 'nebius_safecode_working.md')
  for (const fact of ['SuperEdit', 'lane:<name>', 'disposable: true', 'disposable: false', 'WorkspaceDiff']) {
    assert.ok(working.includes(fact), `the working loop names ${fact}`)
  }
  assert.ok(!/sub-?agent|test_matrix/i.test(working), 'the working loop steers toward neither sub-agents nor the matrix')
  const intro = read('includes', 'nebius_safecode_intro.md')
  assert.match(intro, /^Nothing runs on this computer\./)
  assert.match(intro, /\{\{AGENT_NAME\}\}/)
  assert.match(intro, /Read locally\. Change locally\. Run in the sandbox\. Never run here\.\s*$/)
  for (const tool of ['mcp__contree__rsync', 'mcp__contree__upload', 'mcp__contree__download', 'mcp__nebius__sandbox_lane_patch']) {
    assert.ok(intro.includes(tool), `${tool} is named as a tool that touches local files`)
  }
})

test('template: the welcome chips come in English and Chinese, seven each, and none asks to run anything here', () => {
  for (const file of ['welcome.md', 'welcome-zh.md']) {
    const text = read(file)
    assert.ok(frontmatter(text).greeting.length > 0, `${file} has a greeting`)
    const chips = text.match(/^\s+- title: /gm) ?? []
    assert.equal(chips.length, 7, `${file} has seven chips`)
    assert.equal((text.match(/^\s+prompt: /gm) ?? []).length, 7, `${file} gives every chip a prompt`)
  }
  const prompts = read('welcome.md').split('\n').filter(line => /^\s+prompt: /.test(line)).join('\n')
  assert.doesNotMatch(prompts, /run (it|them|the tests|the suite) (here|locally|on this (computer|machine))/i)
})

test('listing: keeps active text-out models once, drops embeddings, image models and retired rows', () => {
  const rows = buildModels({ listing: LISTING, catalog: CATALOG })
  assert.deepEqual(rows.map(row => row.id), [
    'zai-org/GLM-5.3',
    'Qwen/Qwen3-30B-A3B-Instruct-2507-fast',
    'google/gemma-3-27b-it',
    'meta-llama/Llama-3.3-70B-Instruct',
    'moonshotai/Kimi-K3',
  ])
  assert.equal(rows[0].name, 'GLM-5.3')
})

test('listing: concise Nemotron names preserve IDs and model capabilities', () => {
  const models = [
    ['nvidia/Nemotron-3.5-Super-VL', 'Nemotron 3.5 Super VL'],
    ['nvidia/Nemotron-3_5-Lightning', 'Nemotron 3.5 Lightning'],
    ['nvidia/Nemotron-3-Nano-30B-A3B', 'Nemotron 3 Nano'],
    ['nvidia/nemotron-3-super-120b-a12b', 'Nemotron 3 Super'],
    ['nvidia/Nemotron-3-Ultra-550b-a55b', 'Nemotron 3 Ultra'],
  ]
  for (const [id, name] of models) {
    for (const listingName of ['Vendor name', ' ', undefined]) {
      const item = { ...LISTING.data[0], id, name: listingName }
      const record = CATALOG['zai-org/GLM-5.3']
      const [row] = buildModels({ listing: { data: [item] }, catalog: { [id]: record } })
      const [original] = buildModels({ listing: { data: [{ ...item, id: 'other/model' }] }, catalog: { 'other/model': record } })
      assert.deepEqual(row, { ...original, id, name })
      assert.equal(item.name, listingName)
    }
    const uppercaseId = id.toUpperCase()
    const [row] = buildModels({ listing: { data: [{ id: uppercaseId }] } })
    assert.equal(row.name, name)
    assert.equal(row.id, uppercaseId)
  }
})

test('listing: unlisted names keep vendor, catalog, then ID fallback without shortening variants', () => {
  const items = [
    { id: 'deepseek-ai/DeepSeek-V4.1-Flash', name: ' DeepSeek V4.1 Flash ' },
    { id: 'nvidia/nemotron-3-super-120b-a12b-fast', name: 'Nemotron 3 Super 120B A12B Fast' },
    { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', name: 'Nemotron 3 Nano Omni' },
    { id: 'other/catalog', name: ' ' },
    { id: 'other/unnamed' },
    { id: 'toString' },
  ]
  const rows = buildModels({ listing: { data: items }, catalog: {
    [items[0].id]: { name: 'Catalog name' },
    'other/catalog': { name: ' Catalog fallback ' },
  } })
  assert.deepEqual(rows.map(row => [row.id, row.name]), [
    [items[0].id, 'DeepSeek V4.1 Flash'],
    [items[1].id, items[1].name],
    [items[2].id, items[2].name],
    ['other/catalog', 'Catalog fallback'],
    ['other/unnamed', 'other/unnamed'],
    ['toString', 'toString'],
  ])
})

test('listing: tools and reasoning come from supported_features; the catalog stands in when the row states none', () => {
  const rows = byId(buildModels({ listing: LISTING, catalog: CATALOG }))
  assert.equal(rows['zai-org/GLM-5.3'].supportsTools, true)
  assert.equal(rows['google/gemma-3-27b-it'].supportsTools, true, 'feature words are compared case-blind')
  assert.equal(rows['meta-llama/Llama-3.3-70B-Instruct'].supportsTools, false, 'an empty feature list is a statement')
  assert.equal(rows['moonshotai/Kimi-K3'].supportsTools, true, 'features null: the catalog toolCall decides')
  assert.equal(rows['Qwen/Qwen3-30B-A3B-Instruct-2507-fast'].thinkingTiers, undefined)
  assert.ok(rows['moonshotai/Kimi-K3'].thinkingTiers, 'features null: the catalog reasoning flag decides')
})

test('listing: tiers follow the catalog efforts, else low/medium/high, and reasoning models replay their thinking', () => {
  const rows = byId(buildModels({ listing: LISTING, catalog: CATALOG }))
  const glm = rows['zai-org/GLM-5.3']
  assert.deepEqual(glm.thinkingTiers, ['low', 'high', 'max'])
  assert.equal(glm.defaultThinkingTier, 'low')
  assert.deepEqual(glm.wire, { format: 'openai-chat', compat: { maxTokensField: 'max_tokens', developerRole: false, reasoningReplay: 'reasoning_content' } })
  const kimi = rows['moonshotai/Kimi-K3']
  assert.deepEqual(kimi.thinkingTiers, DEFAULTS.reasoningTiers)
  assert.equal(kimi.defaultThinkingTier, 'medium')
  assert.equal(kimi.wire.compat.reasoningReplay, 'reasoning_content')
  assert.deepEqual(rows['Qwen/Qwen3-30B-A3B-Instruct-2507-fast'].wire, { format: 'openai-chat', compat: { maxTokensField: 'max_tokens', developerRole: false } })
})

test('listing: context from the listing; an output cap that fills the context is replaced', () => {
  const rows = byId(buildModels({ listing: LISTING, catalog: CATALOG }))
  assert.equal(rows['zai-org/GLM-5.3'].contextWindow, 1024000)
  assert.equal(rows['zai-org/GLM-5.3'].maxOutputTokens, DEFAULTS.maxOutputTokens, 'catalog states output = context')
  assert.equal(rows['google/gemma-3-27b-it'].maxOutputTokens, 8192)
  assert.equal(rows['moonshotai/Kimi-K3'].maxOutputTokens, 8000)
  assert.equal(outputCapOf(undefined, 16384), 4096, 'held to a quarter of a small context')
  assert.equal(outputCapOf(200000, 131072), DEFAULTS.maxOutputTokens)
})

test('listing: image input from the modality, prices per million, no free flag from a zero listing price', () => {
  const rows = byId(buildModels({ listing: LISTING, catalog: CATALOG }))
  assert.equal(rows['google/gemma-3-27b-it'].supportsImageInput, true)
  assert.equal(rows['zai-org/GLM-5.3'].supportsImageInput, false)
  assert.deepEqual(rows['zai-org/GLM-5.3'].price, { input: 1.4, output: 4.4 })
  assert.deepEqual(rows['Qwen/Qwen3-30B-A3B-Instruct-2507-fast'].price, { input: 0.1, output: 0.3 })
  assert.equal(rows['moonshotai/Kimi-K3'].price, undefined)
  assert.equal(rows['moonshotai/Kimi-K3'].free, undefined, 'a borrowed record never makes a model free')
  assert.equal(perMillion('0.00000003'), 0.03)
  assert.equal(perMillion('-1'), undefined)
})

test('listing: badges and descriptions', () => {
  const rows = byId(buildModels({ listing: LISTING, catalog: CATALOG }))
  assert.deepEqual(rows['zai-org/GLM-5.3'].tags, ['reasoning'])
  assert.deepEqual(rows['Qwen/Qwen3-30B-A3B-Instruct-2507-fast'].tags, ['fast'])
  assert.deepEqual(rows['google/gemma-3-27b-it'].tags, ['vision'])
  assert.equal(rows['meta-llama/Llama-3.3-70B-Instruct'].tags, undefined)
  assert.equal(rows['zai-org/GLM-5.3'].description, 'Flagship GLM model')
  const long = buildModels({ listing: { data: [{ id: 'a/b', description: 'x'.repeat(400), supported_features: ['tools'] }] } })
  assert.equal(long[0].description.length, 300)
})

test('listing: works with no catalog at all, and refuses a document without data', () => {
  const rows = byId(buildModels({ listing: LISTING, catalog: undefined }))
  assert.equal(rows['moonshotai/Kimi-K3'].supportsTools, false)
  assert.equal(rows['zai-org/GLM-5.3'].maxOutputTokens, DEFAULTS.maxOutputTokens)
  assert.deepEqual(rows['zai-org/GLM-5.3'].thinkingTiers, DEFAULTS.reasoningTiers)
  assert.throws(() => buildModels({ listing: { detail: 'nope' } }), /no "data" list/)
})

test('helpers: modality, offer rule, maker, missing ids, base URL', () => {
  assert.deepEqual(modalityOf({ architecture: { modality: 'text+image->text' } }), { inputs: ['text', 'image'], outputs: ['text'] })
  assert.equal(modalityOf({ architecture: {} }), undefined)
  assert.equal(isOffered({ id: 'x', status: 'validating' }), false)
  assert.equal(isOffered({ id: 'x', status: null }), true)
  assert.equal(makerOf('Qwen/Qwen3-8B'), 'qwen')
  assert.equal(makerOf('bare-id'), '')
  assert.deepEqual(idsMissingFrom(LISTING, CATALOG), ['Qwen/Qwen3-30B-A3B-Instruct-2507-fast', 'meta-llama/Llama-3.3-70B-Instruct'])
  assert.equal(baseUrlFromListing('https://api.tokenfactory.us-central1.nebius.com/v1/models?verbose=true', DEFAULT_BASE_URL), 'https://api.tokenfactory.us-central1.nebius.com/v1')
  assert.equal(baseUrlFromListing('not a url', DEFAULT_BASE_URL), DEFAULT_BASE_URL)
  for (const keys of Object.values(MAKER_CATALOG_KEYS)) assert.ok(keys.length > 0)
})

test('effortPatch: the tier as the top-level reasoning_effort word', () => {
  assert.deepEqual(effortPatch('medium'), [{ op: 'set', path: '/reasoning_effort', value: 'medium' }])
  assert.deepEqual(effortPatch('extra-high'), [{ op: 'set', path: '/reasoning_effort', value: 'xhigh' }])
  assert.deepEqual(effortPatch('none'), [{ op: 'set', path: '/reasoning_effort', value: 'none' }])
  assert.deepEqual(effortPatch(undefined), [])
  assert.deepEqual(effortPatch('turbo'), [])
})

// ── the hooks, against a hand-made `$` ──────────────────────────────────────

function hooks() {
  const registered = {}
  register((event, hook) => { registered[event] = hook })
  return registered
}

function fakeDollar({ status = 200, body = LISTING, catalog = CATALOG, borrowed = {} } = {}) {
  const calls = { fetch: [], model: [], warn: [] }
  const $ = {
    provider: {
      async fetch(path, init) {
        calls.fetch.push({ path, init })
        return {
          status, ok: status >= 200 && status < 300,
          url: `${DEFAULT_BASE_URL}${path}?verbose=true`,
          json: async () => body,
        }
      },
    },
    catalog: {
      async models(key) { assert.equal(key, CATALOG_KEY); return catalog },
      async model(key, id, options) { calls.model.push({ key, id, options }); return borrowed[id] },
    },
    log: { debug() {}, warn(message) { calls.warn.push(message) } },
  }
  return { $, calls }
}

test('hooks: only provider.models and provider.request are registered', () => {
  assert.deepEqual(Object.keys(hooks()).sort(), ['provider.models', 'provider.request'])
})

test('provider.models: fetches the verbose listing with the key, and borrows facts for ids the catalog lacks', async () => {
  const { $, calls } = fakeDollar({ borrowed: { 'meta-llama/Llama-3.3-70B-Instruct': { toolCall: true, maxOutput: 4096, match: 'borrowed', from: 'llama' } } })
  const rows = byId(await hooks()['provider.models']($, { provider: 'mod.nebius.token-factory', locale: 'en' }))
  assert.equal(calls.fetch.length, 1)
  assert.equal(calls.fetch[0].path, LISTING_PATH)
  assert.deepEqual(calls.fetch[0].init.query, { verbose: 'true' })
  assert.equal(calls.fetch[0].init.headers.authorization, 'Bearer {{secret:api_key}}')
  assert.deepEqual(calls.model.map(call => [call.id, call.options.alsoTry]), [
    ['Qwen/Qwen3-30B-A3B-Instruct-2507-fast', ['alibaba']],
    ['meta-llama/Llama-3.3-70B-Instruct', ['llama']],
  ])
  assert.equal(rows['meta-llama/Llama-3.3-70B-Instruct'].maxOutputTokens, 4096)
  assert.equal(rows['meta-llama/Llama-3.3-70B-Instruct'].supportsTools, false, 'the listing still decides tools')
})

test('provider.models: a refused listing throws (the platform keeps its cached list)', async () => {
  const { $ } = fakeDollar({ status: 401, body: { detail: "Couldn't authenticate" } })
  await assert.rejects(hooks()['provider.models']($, { provider: 'mod.nebius.token-factory' }), /answered 401/)
})

test('provider.models: a failing catalog leaves the listing alone', async () => {
  const { $, calls } = fakeDollar()
  $.catalog.models = async () => { throw new Error('offline') }
  const rows = await hooks()['provider.models']($, { provider: 'mod.nebius.token-factory' })
  assert.equal(rows.length, 5)
  assert.equal(calls.warn.length, 1)
})

test('provider.request: patches reasoning_effort for a tier, answers nothing to change otherwise', async () => {
  const request = hooks()['provider.request']
  assert.deepEqual(await request({}, { effort: 'high', format: 'openai-chat' }), { patch: [{ op: 'set', path: '/reasoning_effort', value: 'high' }] })
  assert.deepEqual(await request({}, { format: 'openai-chat' }), {})
})

test('provider.models before a key is saved: no request, no models (nothing from the local catalog)', async () => {
  const { $, calls } = fakeDollar()
  let catalogRead = false
  $.catalog.models = async () => { catalogRead = true; return CATALOG }
  const rows = await hooks()['provider.models']($, { provider: 'mod.nebius.token-factory', connected: false })
  assert.deepEqual(rows, [])
  assert.equal(calls.fetch.length, 0)
  assert.equal(catalogRead, false)
})

test('provider.models with a key still answers from the server, even when connected is not stated', async () => {
  const { $, calls } = fakeDollar()
  await hooks()['provider.models']($, { provider: 'mod.nebius.token-factory', connected: true })
  await hooks()['provider.models']($, { provider: 'mod.nebius.token-factory' })
  assert.equal(calls.fetch.length, 2)
})
