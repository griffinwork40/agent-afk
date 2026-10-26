/**
 * Shared predicate for the file-picker Enter submit decision.
 *
 * A candidate should trigger submit (rather than directory navigation) when
 * it is NOT a directory — i.e. its value does not end with a trailing `/`.
 * Both the reader-keypress path and the terminal-compositor Enter handler
 * consult this predicate so the two surfaces cannot drift.
 */
export function shouldFilePickerSubmit(candidate: string | undefined): boolean {
  return !candidate?.endsWith('/');
}
