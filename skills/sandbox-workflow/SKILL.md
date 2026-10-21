---
name: sandbox-workflow
description: Run, build or test code in a Nebius sandbox (an isolated cloud microVM with immutable images) through the contree tools — when the person asks to run something in a sandbox, in the cloud, in isolation, on Linux, or where it cannot harm this machine.
---

# Working in a Nebius sandbox

The contree tools (`mcp__contree__*`) run commands in throw-away microVMs.
Every image is an immutable snapshot: a run starts from an image and, when
asked to keep its changes, ends in a new one. Nothing a run does touches this
machine.

## The loop

1. **Pick an image.** `list_images` (with `tag_prefix`) or `get_image`
   (`tag:python:3.12`). None fits: `import_image` with
   `registry_url: "docker://python:3.12-slim"` (it takes a minute; keep the
   UUID it answers).
2. **Bring the files.** `rsync` with `source` (a local folder),
   `destination` (`/app`) and `exclude`
   (`[".git", "node_modules", ".venv", "__pycache__", "*.log"]`). It answers
   a `directory_state_id`. Sync again only when local files changed.
3. **Run.** `run` with `command`, `image`, `directory_state_id`, `cwd`
   (`/app`), and a `timeout` that fits (the default is 30 s; a test suite needs
   more).
   - `disposable: true` (the default) throws the changes away: use it for
     tests and anything you only want the output of.
   - `disposable: false` keeps them: the answer has `result_image`, the new
     snapshot. Install dependencies this way once, then run from that image.
4. **Read the result.** `state: SUCCESS` with `exit_code: 0` passed;
   `SUCCESS` with another exit code is a failed command; `timed_out: true`
   needs a longer `timeout`. Output is cut at `truncate_output_at` bytes;
   `read_file` / `grep` / `list_files` read an image without starting a VM.
5. **Fix and repeat.** Edit locally, `rsync` again, run again.

## Lanes — keep your place without UUIDs

When work goes on over many saved runs, start a lane:
`mcp__nebius__sandbox_lane_new` with `name` and `from` (an image or
`tag:`). Then pass `image: "lane:<name>"` to `run` with `disposable: false`:
the lane's head moves to each new image by itself, and every later
`lane:<name>` means the newest one. `mcp__nebius__sandbox_lanes` lists them.

## Rules

- **Never put a key, token or password into the sandbox** — not in `env`,
  not in a command, not in a file you sync. The plugin refuses `env` names
  that look like credentials. Push, publish or call private APIs from this
  machine instead.
- A run that saves onto a lane must wait (`wait: true`, the default).
- The person sees runs and lanes in the Sandbox pane (`/sandbox`).
- Many independent commands at once: use the `sandbox-parallel-test` skill.
