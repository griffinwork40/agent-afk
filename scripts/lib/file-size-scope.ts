/**
 * Scan scope for the 350-code-line file ceiling (`scripts/check-file-size.ts`).
 *
 * Lives in its own module so the scope rules are importable without side
 * effects: the CLI entry point calls `main()` at module load, so a test cannot
 * import it directly (#2235).
 */

import * as path from 'node:path';

/**
 * Contract: excluded paths are those where a line count does not measure
 * context cost. Test files are a flat list of independent cases an agent greps
 * into, never read start-to-finish (223 exceed the ceiling; including them would
 * triple the baseline for no edit-safety benefit). Fixtures and generated
 * declarations are not authored prose or logic.
 */
const EXCLUDED_SUFFIXES = ['.test.ts', '.spec.ts', '.d.ts'] as const;
/**
 * `web-ui-assets` is the gitignored Vite bundle output (`src/web-ui-assets/`,
 * see .gitignore) — generated, never authored, and never seen by CI. Excluding
 * it keeps a local run clean after `pnpm build` (#2206).
 */
export const EXCLUDED_DIRS = ['__fixtures__', '__test-utils__', 'node_modules', 'dist', 'web-ui-assets'] as const;
const INCLUDED_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js'] as const;

/** Whether a repo-relative path is in scope for the file-size ceiling. Accepts `/` or `\` separators. */
export function isScannable(relPath: string): boolean {
  const base = path.basename(relPath);
  if (!INCLUDED_EXTENSIONS.some((e) => base.endsWith(e))) return false;
  if (EXCLUDED_SUFFIXES.some((s) => base.endsWith(s))) return false;
  return !relPath.replaceAll('\\', '/').split('/').some((seg) => EXCLUDED_DIRS.includes(seg as never));
}
