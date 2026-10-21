# Nebius Token Factory plugin

Two parts, one plugin:

- **A model provider** (below): Nebius Token Factory on Velloc's Models page.
- **Sandboxes** ([further down](#sandboxes)): isolated cloud microVMs with
  immutable images, as MCP tools, with a status pane, lanes for parallel
  development and a parallel test matrix.

## Model provider

Adds **Nebius Token Factory** to Velloc's Models page: open-weight models
(DeepSeek, Qwen, GLM, Kimi, MiniMax, Llama, Gemma, Nemotron and more) behind
one API key, on an OpenAI-compatible API.

| Registered id | Name | Base URL | Credential |
|---|---|---|---|
| `mod.nebius.token-factory` | Nebius Token Factory | `https://api.tokenfactory.nebius.com/v1` | API key |

Create a key at [tokenfactory.nebius.com](https://tokenfactory.nebius.com/)
under **API keys**. The base URL can be changed to a regional host
(`https://api.tokenfactory.us-central1.nebius.com/v1`); every host under
`nebius.com` is allowed.

### What it does

- **Lists the models** (`provider.models`): `GET /models?verbose=true` with the
  key. Only models the server serves now (`status` active or unstated) with a
  text output are kept: embedding and image models are left out. From each
  row:

  | Listing field | Model fact |
  |---|---|
  | `name`, `description` | the name, and a line under it |
  | `context_length` | the context window |
  | `architecture.modality` (`text+image->text`) | image input |
  | `supported_features` contains `tools` | offered at all (the agent needs tool calls) |
  | `supported_features` contains `reasoning` | thinking tiers |
  | `pricing.prompt` / `pricing.completion` (USD per token) | the price per million tokens |

  The listing needs the key: before one is saved the mod asks nothing and
  lists no models (the page says to enter a key).

  The platform's model catalog (`nebius` entry, then the model maker's own
  entry for an id it lacks) fills what the listing leaves out: the output cap,
  the reasoning efforts a model takes, and which field replays reasoning.
  A row that states no features is decided by the catalog. No catalog at all
  still gives a working list.
- **Caps the output safely.** The server refuses a request whose prompt plus
  `max_tokens` exceeds the context, so an output cap that is missing or as
  large as the context becomes 32 768 tokens (at most a quarter of the
  context).
- **Speaks one wire**: `openai-chat` at `<base>/chat/completions`, with
  `max_tokens`, the `system` role, and `reasoning_content` replayed on
  assistant messages of reasoning models.
- **Maps reasoning** (`provider.request`): the picked tier is written as the
  top-level `reasoning_effort` (`extra-high` is sent as `xhigh`). Tiers come
  from the catalog's efforts, else `low / medium / high`.
- **Badges** on the Add models page: *Reasoning*, *Vision*, and *Fast* for the
  vendor's `-fast` serving variants; each is also a filter chip.

It has no `provider.verify` hook: the listing itself needs the key, so the
platform's default probe already tells a good key from a bad one. It has no
`provider.usage` hook: the API exposes no balance or usage endpoint.

## Sandboxes

Nebius Sandboxes run commands in throw-away microVMs. Every image is an
immutable snapshot: a run starts from one and, when asked to keep its changes,
ends in a new one. Nothing a run does touches this machine.

### Setup

1. Install [uv](https://docs.astral.sh/uv/): the MCP server runs as
   `uvx --with mcp==1.* contree-mcp` (the server does not start against the
   2.x MCP library).
2. The key: the one saved for **Nebius Token Factory** on the Models page
   (above) — it needs access to Sandboxes. There is no second key to enter:
   `.mcp.json` names it as `${provider_key.token-factory}`, and Velloc fills
   it into the MCP server's environment (`NEBIUS_API_KEY`) only, sealed until
   the server starts; the model, the mod and the transcript never see it.
   Saving, replacing or removing that key restarts the server with it.
3. Settings → Plugins & Mods → **nebius**: the **Project ID**. With the key or
   the project missing the server reads `~/.config/contree/auth.ini` instead
   (written by `contree auth`).
4. Optional: a **Default image** (`tag:python:3.12`, or a UUID), the
   **Longest run**, and **Approve remote-only sandbox tools**.

Needs a Velloc build that fills `${user_config.*}` and `${provider_key.*}`
in a plugin's MCP server configuration; an older one passes the placeholder
through as text and the server cannot authenticate.

### What it adds

| Part | What it does |
|---|---|
| `.mcp.json` — server `contree` | The contree tools: `run`, `rsync`, `upload`, `download`, `import_image`, `list_images`, `get_image`, `set_tag`, `list_files`, `read_file`, `grep`, `get_operation`, `list_operations`, `wait_operations`, `cancel_operation`, `get_guide` (as `mcp__contree__*`) |
| Session mod `hooks/sandbox.js` | Lanes, guards, the plugin's own tools, the Sandbox pane and status line (below) |
| Skills | `sandbox-workflow`, `sandbox-parallel-test`, `sandbox-parallel-dev`, `sandbox-swe-env` |
| Agents | `nebius:sandbox-dev` (builds one part in its own lane, never writes local files), `nebius:sandbox-tester` (runs tests only) |

**Lanes.** A lane is a named chain of images. `image: "lane:<name>"` in any
contree tool means the lane's newest image; a run with `disposable: false`
on a lane moves the lane to the image it produced. The first agent that
saves onto a free lane owns it until it stops; another agent's save onto it is
refused, so parallel agents never overwrite each other. Lanes are kept per
session in the mod's store.

**Guards** on every contree call, the main conversation's and every
sub-agent's:

- `env` names that look like credentials (`*KEY*`, `*TOKEN*`, `*SECRET*`,
  `*PASSW*`, …) are refused: keys stay out of the sandbox;
- a `timeout` above *Longest run* is cut to it;
- a save onto a lane must wait for its result (`wait: false` is refused there).

**The plugin's tools** (`mcp__nebius__*`):

| Tool | Does |
|---|---|
| `sandbox_lanes` | lists the lanes |
| `sandbox_lane_new` | starts a lane at an image, a tag or another lane's head |
| `sandbox_lane_release` | frees a lane from its owner |
| `sandbox_lane_drop` | forgets a lane (its images stay in the account) |
| `sandbox_lane_patch` | `git add -A && git diff --cached --binary <since>` in the lane's head (a throw-away run): the patch inline, or written to a local file (`out`) |
| `sandbox_test_matrix` | up to 50 commands at once, each in its own throw-away run from one image; waits for all; answers passed/failed per shard and the output tail of each failure |

**Pane and status line.** `/sandbox` opens the Sandbox pane: the server's
state (with Reconnect; once connected, a `whoami` call tells a working key from
one the API refuses or one Nebius has not yet given the Sandboxes permissions
`list` and `spawn_disposable`, which the pane names and stops polling for), the lanes (Drop), recent operations (Cancel for a
running one) and Refresh. It polls `list_operations` every 3 s while
something runs and every 30 s while the pane is open and idle. The status line
reads *Sandbox: N lanes · M running* while there is something to say.
`/sandbox lanes` prints the lanes.

**Approve remote-only sandbox tools** (off by default) answers the permission
check of the tools that touch only the sandbox (`run`, the image, file-read
and operation tools, and the plugin's own tools except `sandbox_lane_patch`)
with *allow*. `rsync`, `upload`, `download` and `sandbox_lane_patch` read or
write local files and still ask. Background sub-agents cannot ask, so they
need this setting (or allow rules for `mcp__contree` and `mcp__nebius`).

### Parallel work

- **Tests:** `sandbox_test_matrix` on one image (see the
  `sandbox-parallel-test` skill).
- **Development:** one lane and one `nebius:sandbox-dev` background agent per
  independent part; the main conversation alone writes local files, merging
  each lane with `sandbox_lane_patch` and `git apply` (see the
  `sandbox-parallel-dev` skill).

## Files

```
.claude-plugin/plugin.json   the manifest: provider, userConfig
icon.svg                     the Token Factory mark (the favicon tokenfactory.nebius.com serves)
providers/config.js          every fact about the model server
providers/logic.js           the pure logic: listing -> rows, tier -> body edit
providers/nebius.js          the provider hooks
.mcp.json                    the contree MCP server
hooks/hooks.json             the session mod's entry
hooks/sandbox.js             the session mod: hooks and the plugin's tools
hooks/sandbox/lanes.js       lanes and guards (pure)
hooks/sandbox/matrix.js      the test matrix plan and summary (pure)
hooks/sandbox/patch.js       the patch command (pure)
hooks/sandbox/view.js        the pane and the status line (pure)
hooks/sandbox/replies.js     the server's reply shapes: unwrapping, status, ids (pure)
hooks/sandbox/texts.js       the per-language text loader
locales/*.json               the mod's text, English first
skills/*/SKILL.md            the four skills
agents/*.md                  the two agent types
```

The unit tests are `tests/nebius-mod.test.mjs` (the provider) and
`tests/nebius-sandbox.test.mjs` (the sandbox part) at the repository root
(`npm test`).

## Releasing

This repository is the plugin: Velloc's built-in marketplace pins it to a
commit and ships its
root, without `.github/`, `tests/` and the npm files, as `plugins/nebius/`.

1. Bump `version` in `.claude-plugin/plugin.json`. A client upgrades an
   installed plugin only to a higher version.
2. Push to `main`. The pin workflow opens (or moves) one pull request on the
   marketplace that pins this commit; merging it publishes the build, and
   clients pick it up within a day.

The pin workflow needs the repository variable `MARKETPLACE_REPO` (the
marketplace's owner/name) and the secret `MARKETPLACE_TOKEN` (a fine-grained
token on the marketplace with Contents and Pull requests read/write).
Without either the workflow does nothing.

To try a change in Velloc before release, link this folder as
`~/.velloc/plugins/nebius` and restart Velloc.
