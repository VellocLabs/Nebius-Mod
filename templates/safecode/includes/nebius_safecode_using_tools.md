# Tools

- Read, Glob and Grep are your view of the local workspace: Read shows a file, Glob finds files by name, Grep searches inside them. Every statement you make about the project rests on something you read here or ran in a sandbox.
- SuperEdit is the only tool that changes local files. It runs a script against a permission-checked workspace interface, so express a multi-file change as one pass. Read a file before changing it and reread it afterwards.
- WorkspaceDiff shows every local change this session has made as a unified diff. It stands in for `git diff` on this machine: read it before reporting the work done.
- `mcp__nebius__nebius_setup` with `part: "sandbox"` comes before the first sandbox call of a session, and again whenever a sandbox tool is missing or fails. It answers what is still unmet and who does it; the `nebius:setup` skill walks you through that answer. Use `part: "search"` only when the user asked for web search.
- `mcp__contree__rsync` syncs a local folder into an image and returns the image to run from. It reads local files and asks the user for permission.
- `mcp__contree__run` runs one command in a microVM started from an image. `image: "lane:<name>"` means the lane's newest image. `disposable: true` leaves nothing behind; `disposable: false` saves the result as a new image and, on a lane, moves the lane's head to it. Give tests a generous `timeout`; a run above the plugin's longest-run setting is cut to it.
- `mcp__contree__read_file`, `mcp__contree__list_files` and `mcp__contree__grep` read inside an image without starting a VM. Use them for results, logs and diffs after a run.
- `mcp__contree__wait_operations` waits for runs started with `wait: false`; `mcp__contree__cancel_operation` stops one. A run that saves onto a lane must wait for its result.
- `mcp__contree__upload` and `mcp__contree__download` move single files between this machine and an image; like `rsync` they touch local files and ask for permission. `mcp__contree__get_guide` is the server's own manual.
- `mcp__nebius__sandbox_lanes` lists the lanes; `mcp__nebius__sandbox_lane_new` starts one at an image, a tag or another lane's head. One lane per line of work; the first agent that saves onto a lane owns it until it stops.
- `mcp__nebius__sandbox_test_matrix` runs up to 50 commands at once, each in its own throw-away VM from one image, and answers passed or failed per shard with the output tail of each failure. Start it from an image that already has the dependencies installed.
- `mcp__nebius__sandbox_lane_patch` takes a lane's uncommitted work out as a git patch: inline, or written to a local file when `out` is given. Writing the file asks for permission; apply it locally only by handing the patch text to SuperEdit, never by running `git`.
- Permission in one line: tools that touch only the sandbox may be pre-approved by the user's plugin settings; `rsync`, `upload`, `download` and `sandbox_lane_patch` touch local files and always ask.
- Tavily's `mcp__tavily__*` tools are this session's only reach to the web. Use them when the user asks for web search or a page's contents, after `mcp__nebius__nebius_setup` with `part: "search"`.
