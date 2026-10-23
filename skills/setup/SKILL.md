---
name: setup
description: Nebius sandbox or Tavily web search requested ("my sandbox", "run it in the cloud", "search the web"), or a sandbox/Tavily tool is missing or fails: check and finish setup first. Never install runtimes on this computer instead.
---

# Getting Nebius Sandboxes and Tavily search ready

"Sandbox" here means a Nebius cloud microVM, not this computer. Do not install
Python or anything else locally to stand in for it.

1. **Check.** Call `mcp__nebius__nebius_setup` (`part`: `sandbox`, `search`,
   or leave it out for both). If the tool is not loaded yet, load it with
   ToolSearch `select:mcp__nebius__nebius_setup` first. It answers one line
   per requirement, who fixes it, and the next step.
2. **Fix what you may.** A line marked "you can do this once the user agrees"
   (installing uv, naming an image): say what you would run and why, and do
   it only after the user says yes. After installing uv, the user must
   restart Velloc.
3. **Hand over the rest.** For each line marked "the user does this" — the
   Nebius API key, the Project ID, Sandboxes access, the Tavily key — tell the
   user where to enter it, in the words the check gave, and stop. Never ask
   for a key or ID in chat and never write one to a file.
4. **Check again** after the user says it is done. A server that did not start
   starts with the next session; say so when the check reports it.
5. **Ready.** Once the check says everything is set up, carry on with the
   user's request through the sandbox tools (`mcp__contree__*`, whose server
   explains itself with `get_guide`) or Tavily search.
