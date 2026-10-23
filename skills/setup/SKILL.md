---
name: setup
description: Nebius sandbox or Tavily web search requested ("my sandbox", "run it in the cloud", "search the web"), or a sandbox/Tavily tool is missing or fails: check and finish setup first. Never install runtimes on this computer instead.
---

# Getting a Nebius Sandbox or Tavily search ready

"Sandbox" here means a Nebius cloud microVM, not this computer. Do not install
Python or anything else locally to stand in for it.

1. **Check only what the request needs.** Call `mcp__nebius__nebius_setup`
   with `part: "sandbox"` to run code in the cloud, or `part: "search"` only
   when the user asked to search the web. If the tool is not loaded yet, load
   it with ToolSearch `select:mcp__nebius__nebius_setup` first. Bring up
   nothing the check did not mark ✗ or ?: a sandbox request never mentions
   the Tavily key, and an unset default image is not a step.
2. **Do your part, with permission.** Lines marked "you do this once the user
   agrees" (installing uv) are yours, not the user's. Ask once with
   AskUserQuestion, naming the exact command, and if the user still has lines
   of their own, tell them those in the same question. On yes, run it
   yourself, then check again: the check reconnects the sandbox server.
3. **Tell the user their part.** Lines marked "the user does this" (the
   Nebius API key, the Project ID, Sandboxes access) go to the user in a
   short list, with where to enter each, in the words the check gave. Never
   ask for a key or ID in chat and never write one to a file. Then wait.
4. **Check again** when the user says it is done. Only if a just-installed
   tool is still not found, ask the user to fully quit Velloc (tray icon
   included) and reopen it.
5. **Carry on.** Once the check says everything is set up, go straight back
   to the user's original request through the sandbox tools
   (`mcp__contree__*`, whose server explains itself with `get_guide`) or
   Tavily search. Do not ask the user what to do next.
