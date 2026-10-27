/**
 * Folders synced from Windows. Pure.
 *
 * contree-mcp names each synced file `<destination>/<path relative to the
 * source>` with the host's separator, so a folder synced from Windows arrives
 * as flat files whose names hold backslashes (`/app/src\pkg\mod.py`).
 * `withRelayout` puts a POSIX step in front of a run's command that moves
 * those files into their folders before the command starts.
 */

import { shellQuote } from './patch.js'

/** True for a Windows source path: a drive (`C:\`, `C:/`) or a UNC share. */
export function isWindowsSource(source) {
  return typeof source === 'string' && (/^[A-Za-z]:[\\/]/.test(source) || source.startsWith('\\\\'))
}

/** The rsync destination as the run sees it: no trailing slash, `/` for the root. */
export function normalizeDestination(destination) {
  if (typeof destination !== 'string' || destination === '') return null
  const trimmed = destination.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

/** The POSIX step that moves `<dir>/a\b\c` to `<dir>/a/b/c`; quiet, never fails the run. */
export function relayoutStep(destination) {
  const dir = shellQuote(destination)
  return `( find ${dir} -maxdepth 1 -name '*\\\\*' | while IFS= read -r f; do n=$(printf '%s' "$f" | tr '\\\\' '/'); mkdir -p "\${n%/*}" && mv -f "$f" "$n"; done ) >/dev/null 2>&1`
}

/**
 * The run's arguments with the relayout step in front of its command, when
 * its `directory_state_id` came from a Windows source. `layouts` maps a
 * directory state to its destination. A run with `shell: false` is left alone:
 * its command is not a shell line.
 */
export function withRelayout(args, layouts) {
  const id = args?.directory_state_id
  if (id === undefined || id === null || !layouts.has(id)) return args
  if (args.shell === false || typeof args.command !== 'string') return args
  return { ...args, command: `${relayoutStep(layouts.get(id))}; ${args.command}` }
}
