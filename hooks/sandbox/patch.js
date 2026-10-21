/**
 * The command that takes a lane's changes out as a git patch. Pure.
 */

/** Bytes the patch run may print before the server cuts it. */
export const PATCH_OUTPUT_LIMIT = 2_000_000
/** Bytes a patch may be to be answered inline rather than written to a file. */
export const PATCH_INLINE_LIMIT = 60_000

const REF = /^[A-Za-z0-9][A-Za-z0-9._/~^@{}-]{0,127}$/

/** A word for a POSIX shell, single-quoted. */
export function shellQuote(word) {
  return `'${String(word).replace(/'/g, `'\\''`)}'`
}

/**
 * `{ text }` to run inside the image, or `{ error }`: stage everything under
 * `path` (untracked files included) and print the staged diff against `since`.
 */
export function patchCommand(path, since) {
  if (typeof path !== 'string' || !path.startsWith('/')) return { error: 'path must be an absolute directory inside the sandbox, e.g. /app' }
  if (/[\0\n\r]/.test(path)) return { error: 'path has a control character' }
  const ref = since === undefined || since === '' ? 'HEAD' : since
  if (typeof ref !== 'string' || !REF.test(ref) || ref.includes('..')) return { error: `since "${since}" is not a plain git revision` }
  const dir = shellQuote(path)
  return {
    text: `git -C ${dir} add -A >/dev/null && git -C ${dir} -c core.quotepath=off diff --cached --binary ${shellQuote(ref)}`,
  }
}
