/**
 * Helpers for tracking files touched by a background job via `edit_file` /
 * `write_file` tool calls.
 *
 * Extracted from background-registry.ts to satisfy the file-size ceiling.
 * The list is used by `cancelAll()` to surface a recovery checklist when a
 * drain timeout fires mid-edit so the operator knows which files to inspect
 * for half-applied changes.
 *
 * @module agent/background-registry.touched-files
 */

/**
 * Parse a tool-input JSON string and, if it carries a non-empty `file_path`
 * field, push that path onto `touchedFiles` (deduplicating by identity).
 * Silent no-op on parse errors — this is a best-effort diagnostics feature.
 *
 * Called from the `onProgress` handler in `register()` for every non-pending
 * `tool_use_detail` chunk whose `toolName` is `edit_file` or `write_file`.
 */
export function recordTouchedFile(touchedFiles: string[], toolInputJson: string): void {
  try {
    const parsed: unknown = JSON.parse(toolInputJson);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'file_path' in parsed &&
      typeof (parsed as Record<string, unknown>)['file_path'] === 'string'
    ) {
      const fp = (parsed as Record<string, unknown>)['file_path'] as string;
      if (fp && !touchedFiles.includes(fp)) {
        touchedFiles.push(fp);
      }
    }
  } catch {
    // Malformed JSON — skip silently; this is a best-effort diagnostics feature.
  }
}
