---
name: sandbox-parallel-dev
description: Split a coding task into independent parts and have several background agents build them at the same time, each in its own Nebius sandbox lane, then merge their patches here — when the person asks for parallel development, several approaches at once, or a large change that splits cleanly.
---

# Parallel development in sandbox lanes

Agents working at the same time must not edit the same local files. So each
one works **remotely**, on its own lane (a chain of sandbox images), and only
this conversation writes the local folder: it takes each lane's patch and
applies it.

## Steps

1. **Base image.** Sync the project (`rsync`, `.git` included — the patch
   step needs git in the image: leave `.git` out of `exclude`) and bake it in:
   `run` with `command: "true"`, the `directory_state_id`, `disposable: false`.
   The `result_image` is the base. If the image has no git, install it in
   the same run (`apt-get install -y git` / `apk add git`).
2. **One lane per part.** `mcp__nebius__sandbox_lane_new` with
   `name: "auth-fix"`, `from: "<base uuid>"`; the same for each part. Lanes
   start free; the first agent that saves onto one owns it.
3. **Start the agents** with the Agent tool, in the background, type
   `nebius:sandbox-dev`, one per lane. The prompt names the lane, the
   folder inside the image (`/app`), the part to build, and how to test it:

   > Lane `auth-fix`, project at `/app`. Make login refuse expired tokens
   > (src/auth/session.py) and add a test. Test: `cd /app && pytest -q
   > tests/auth`. Finish with a summary of what changed.

4. **Watch** in the Sandbox pane (`/sandbox`): lanes, their heads, running
   operations.
5. **Merge, one lane at a time.** When an agent finishes,
   `mcp__nebius__sandbox_lane_patch` with `name`, `path: "/app"`,
   `out: ".sandbox/auth-fix.patch"`, then `git apply --index
   .sandbox/auth-fix.patch` here. A conflict: resolve it here, by hand; do not
   send it back to the agent's lane.
6. **Test the merged result** (sync again, then the `sandbox-parallel-test`
   skill), and drop the lanes you no longer need
   (`mcp__nebius__sandbox_lane_drop`).

## Rules

- Parts must be independent: different files or modules. Two agents on one
  file make a merge conflict you will resolve by hand.
- Agents never write local files and never push; this conversation does.
- No credentials go into any sandbox.
- Background agents cannot ask permission: the contree and lane tools must
  be allowed — the plugin's *Approve remote-only sandbox tools* setting, or
  allow rules for `mcp__contree` and `mcp__nebius`.
