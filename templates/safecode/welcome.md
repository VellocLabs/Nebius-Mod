---
# Welcome chips for the `nebius:safecode` type (SafeCode). Every chip stays
# inside the type's boundary: read and edit locally, run only in a sandbox.
# No chip asks for anything to run on this computer.
# `welcome-<locale>.md` siblings carry the other languages.
greeting: What would you like to work on?
suggestions:
  - title: Check my sandbox is ready
    description: What is still missing, and who does it.
    prompt: Check whether my Nebius sandbox is ready to use. Run the setup check, tell me what is still missing and who has to do each step, and do your part once I agree.
  - title: Sync and run the tests
    description: Sync the workspace into a sandbox and run the test suite there.
    prompt: Sync this workspace into a Nebius sandbox, run the project's test suite there, and report what passed and what failed with the relevant output. Do not run anything on this computer.
  - title: Fix a bug, verify in a sandbox
    description: Read here, edit here, run the relevant tests in a sandbox.
    prompt: Investigate this bug by reading the code, find the root cause, and make the smallest reliable fix with SuperEdit. Then sync the workspace into a sandbox and run the tests that cover the change there. Tell me what the sandbox showed and what you could not verify.
  - title: Look it up on the web
    description: Documentation, an error message, a changelog — through Tavily.
    prompt: Search the web for what this needs — the library's documentation, the exact error message, or the changelog of the version in use — read the relevant pages, and tell me what applies here with the sources. Then propose the change, if one follows.
  - title: Understand this codebase
    description: Explore the architecture, modules, and important flows.
    prompt: Help me understand this codebase by reading it. Identify the main components, important entry points, data flow, and the parts I should read first.
  - title: Review code
    description: Find bugs, risks, and opportunities to improve.
    prompt: Review this code by reading it, for correctness, bugs, regressions, security risks, performance issues, and maintainability. Prioritize the most important findings. If a finding needs a run to confirm, say so and offer to confirm it in a sandbox.
---

# SafeCode (Nebius) welcome

Prompt-starter chips for a new `nebius:safecode` session. Edit the `suggestions`
list in the frontmatter above; add `welcome-<locale>.md` siblings for other
languages. Keep every chip inside the boundary: read and edit locally, run in a
sandbox only, never on this computer.
