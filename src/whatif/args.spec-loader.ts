/**
 * ChangeSpec loading and title utilities for `src/whatif/args.ts`.
 *
 * Extracted from args.ts to keep that file within the 350-code-line ceiling.
 * Re-exported from args.ts; callers should import from `./args.js`.
 *
 * @module whatif/args.spec-loader
 */

import { readFileSync } from 'node:fs';
import type { Change, ChangeSpec } from './types.js';
import { AnyChangeSchema, SpecOutputSchema } from './compile.js';

/**
 * Build a ChangeSpec title from the flag changes, falling back to the
 * plain-text description.
 */
export function buildFlagSpecTitle(flagChanges: Change[], text?: string): string {
  if (flagChanges.length === 0 && text) return text.slice(0, 80);
  if (flagChanges.length === 1) {
    // A one-line title suffices; describeChange is called in surface.ts
    return `${flagChanges.length} change`;
  }
  return `${flagChanges.length} changes`;
}

/**
 * Parse and validate a ChangeSpec JSON file from disk.
 * Applies the same SpecOutputSchema + per-entry AnyChangeSchema validation
 * that compileChangeSpec uses, so malformed spec files are rejected early.
 * Throws on I/O, JSON parse error, or schema validation failure.
 */
export function loadSpecFile(filePath: string): ChangeSpec {
  let raw: string;
  try { raw = readFileSync(filePath, 'utf8'); }
  catch { throw new Error(`whatif: cannot read spec file: ${filePath}`); }

  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`whatif: spec file is not valid JSON: ${filePath}`); }

  // Validate top-level shape.
  const outer = SpecOutputSchema.safeParse(parsed);
  if (!outer.success) {
    throw new Error(
      `whatif: spec file has invalid structure: ${filePath}\n` +
        outer.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'),
    );
  }

  // Validate each change entry; drop invalid ones (matching compile path).
  const valid: Change[] = [];
  for (const entry of outer.data.changes) {
    const result = AnyChangeSchema.safeParse(entry);
    if (result.success) valid.push(result.data);
  }

  if (valid.length === 0 && outer.data.changes.length > 0) {
    throw new Error(
      `whatif: spec file contains no valid changes (${outer.data.changes.length} entries failed schema validation): ${filePath}`,
    );
  }

  return { title: outer.data.title, changes: valid };
}
