import type { DiffPayload } from '../../utils/diff.js';
import type { DiffContent } from './acp.wire.js';
import { inputRecord, resolveDisplayPath } from './acp.translate.paths.js';

/** Render-only hunk snapshots, never instructions for a client to apply. */
export function translateDiff(diff: DiffPayload, input: unknown, cwd: string): DiffContent[] {
  const fallback = resolveDisplayPath(inputRecord(input)['file_path'], cwd);
  return diff.hunks.flatMap(hunk => {
    const path = resolveDisplayPath(hunk.filePath, cwd) ?? fallback;
    if (path === undefined) return [];
    const oldText = hunk.lines.filter(line => line.kind !== '+').map(line => line.text).join('\n');
    const newText = hunk.lines.filter(line => line.kind !== '-').map(line => line.text).join('\n');
    return [{ type: 'diff' as const, path, ...(hunk.oldLines === 0 ? {} : { oldText }), newText }];
  });
}
