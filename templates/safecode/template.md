---
type: nebius:safecode
description: Edit locally with SuperEdit, run everything in Nebius sandboxes.
# The boundary of this session type:
#   local read   -> Read / Glob / Grep
#   local write  -> SuperEdit only (permission-gated per path), reviewed with
#                   WorkspaceDiff from the per-turn file snapshots
#   execution    -> none on this computer: no shell, exec or webfetch group;
#                   everything that runs, runs in a Nebius sandbox
#   sub-agents   -> Velloc's built-in ones only, each started on this same
#                   template: no shell, the same sandbox servers. The main
#                   agent decides whether and how to use them.
#   MCP          -> this plugin's servers only (`mcp: plugin`): contree and
#                   Tavily, plus the mod's own `mcp__nebius__*` tools
#   skills       -> the exact list below; a skill body's inline `!` shell
#                   expansion is not performed in a `mcp: plugin` session
# `rsync`, `upload`, `download` and `sandbox_lane_patch` read or write local
# files and keep asking the user for permission; the plugin's MCP server is
# the one local process this session relies on.
tools: [read, plan, superedit, skills, ask, todo, subagent]
mcp: plugin
fileSnapshots: true
skills: [plugin:nebius:setup]
agents: [Explore, Plan, general-purpose]
---

## prompt

!nebius_safecode_intro
!nebius_safecode_using_tools
!tool_call_parallelism
!delivering_work
!autonomy
$mcp_servers
$environment
$memory

## begin
