/**
 * Shared FS error → tool result helper for tool handlers.
 *
 * Converts well-known Node.js filesystem error codes (`ENOENT`, `EACCES`,
 * `ENOTDIR`) into structured tool-result objects. Returns `undefined` for
 * unrecognised errors so the caller can rethrow or apply its own fallback.
 *
 * @module agent/tools/handlers/_fs-error
 */

/**
 * Translate a filesystem error into a tool-result object, or return
 * `undefined` when the error code is not one this helper recognises.
 *
 * Contract:
 *   - `err` is the raw caught value (may be anything).
 *   - `path` is the resolved filesystem path the operation targeted.
 *   - `entityType` qualifies the noun used in ENOENT messages
 *     ('File', 'Directory', 'Path', …). Defaults to `'Path'`.
 *   - Returns `undefined` for unrecognised errors — the caller is
 *     responsible for rethrowing or producing a generic error result.
 */
export function fsErrorToToolResult(
  err: unknown,
  path: string,
  entityType: string = 'Path',
): { content: string; isError: true } | undefined {
  if (!(err instanceof Error)) return undefined;

  const code = (err as Error & { code?: string }).code;

  if (code === 'ENOENT') {
    return { content: `${entityType} not found: ${path}`, isError: true };
  }

  if (code === 'EACCES') {
    return { content: `Permission denied: ${path}`, isError: true };
  }

  if (code === 'ENOTDIR') {
    return { content: `Not a directory: ${path}`, isError: true };
  }

  return undefined;
}
