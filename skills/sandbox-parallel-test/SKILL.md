---
name: sandbox-parallel-test
description: Run a test suite split into shards, a version matrix, or repeated runs of a flaky test in parallel Nebius sandboxes — when tests are slow, when the person asks to test in parallel, across versions, or to check whether a test is flaky.
---

# Parallel tests in Nebius sandboxes

One call runs up to 50 commands at once, each in its own throw-away microVM
from the same image: `mcp__nebius__sandbox_test_matrix`.

## Steps

1. **An image with the dependencies installed.** Sync the project (`rsync`)
   and install once with `run` + `disposable: false`; keep the
   `result_image` (or work on a lane, `lane:<name>`). Installing in every
   shard wastes the parallelism.
2. **Split the work.** Pick shards that take about the same time:
   - pytest: `pytest -q tests/unit`, `pytest -q tests/api`, … or
     `pytest -q --splits 8 --group 3` with pytest-split;
   - jest/vitest: `npx vitest run --shard=3/8`;
   - a version matrix: one image per version is clearer than one shard per
     version — run the matrix once per image;
   - a flaky test: the same command N times, named `repeat-1` … `repeat-N`.
3. **Run the matrix.**

   ```json
   {
     "image": "lane:main",
     "directory_state_id": 42,
     "cwd": "/app",
     "timeout": 900,
     "shards": [
       { "name": "unit", "command": "pytest -q tests/unit" },
       { "name": "api", "command": "pytest -q tests/api" }
     ]
   }
   ```

   The answer is one summary: passed/failed per shard and the output tail of
   each shard that did not pass.
4. **Act on failures.** Read the tail; for more, `get_operation` with the
   shard's operation id, or `read_file` on a report the shard wrote (a
   disposable run keeps no files — write reports to stdout, or run that shard
   alone with `disposable: false`).

## Rules

- No credentials in `env` (refused).
- Each shard is disposable: nothing it writes survives.
- 50 runs at once is the account's limit; a larger matrix is two calls.
- The Sandbox pane (`/sandbox`) shows the runs while they go.
