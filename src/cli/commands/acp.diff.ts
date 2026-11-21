import type { DiffPayload } from '../../utils/diff.js';
import type { DiffContent } from './acp.wire.js';
import { inputRecord, resolveDisplayPath } from './acp.translate.paths.js';
import { escapeInvisible } from './acp.tool-title.js';

/** Render-only hunk snapshots, never instructions for a client to apply. */
export function translateDiff(diff: DiffPayload, input: unknown, cwd: string): DiffContent[] {
  const fallback = resolveDisplayPath(inputRecord(input)['file_path'], cwd);
  return diff.hunks.flatMap(hunk => {
    const path = resolveDisplayPath(hunk.filePath, cwd) ?? fallback;
    if (path === undefined) return [];
    const oldText = hunk.lines.filter(line => line.kind !== '+').map(line => line.text).join('\n');
    const newText = hunk.lines.filter(line => line.kind !== '-').map(line => line.text).join('\n');
    // The path is a file header a client shows; hidden and direction-control
    // characters become visible escapes. The exact path stays in rawInput.
    const shown = escapeInvisible(path.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' '));
    return [{ type: 'diff' as const, path: shown, ...(hunk.oldLines === 0 ? {} : { oldText }), newText }];
  });
}
