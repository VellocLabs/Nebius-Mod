---
name: sandbox-swe-env
description: Find and use a ready-made Nebius sandbox environment (prebuilt images for common languages and for SWE-style task repositories) instead of building one — when a task needs a specific toolchain, a known repository at a known commit, or the person asks for a prepared environment.
---

# Ready-made sandbox environments

Building an image takes minutes; a prepared one is a lookup.

1. **Search by tag.** `list_images` with `tag_prefix`: a language
   (`python`, `node`, `golang`, `rust`), or a repository or task name. Ask
   for a `limit` of 20–50 and read the tags; they name the toolchain and
   version, or the repository and commit.
2. **Check it.** `get_image` with `tag:<tag>` gives the UUID;
   `list_files` / `read_file` look inside without starting a VM (find the
   repository folder, a `README`, the test command).
3. **Start from it.** Pass the UUID (or `tag:<tag>`) as `image`, or start a
   lane on it (`mcp__nebius__sandbox_lane_new` `from: "tag:<tag>"`) when the
   work will save changes.
4. **Nothing fits:** import a public image (`import_image`,
   `registry_url: "docker://<image>:<tag>"`), install what is missing in one
   `run` with `disposable: false`, and tag the result so the next session finds
   it: `set_tag` with a tag like `velloc/<project>/<toolchain>:v1`.

Tags are shared by everyone in the project: do not move a tag someone else
made; make your own.
