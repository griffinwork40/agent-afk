import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { translateDiff } from './acp.diff.js';
import { checked } from './__test-utils__/acp-schema.js';
import type { DiffPayload } from '../../utils/diff.js';

const cwd = path.resolve('workspace');
const diff: DiffPayload = { addedLines: 1, removedLines: 1, hunks: [{ oldStart: 4, oldLines: 2, newStart: 4, newLines: 2, lines: [{ kind: ' ', text: 'context' }, { kind: '-', text: 'old' }, { kind: '+', text: 'new' }] }] };
function translated(payload: DiffPayload, input: unknown = { file_path: 'a.txt' }) {
  const content = translateDiff(payload, input, cwd);
  checked([{ sessionUpdate: 'tool_call_update', toolCallId: 't', content }]);
  return content;
}
describe('ACP render-only diff snapshots', () => {
  it('joins context/deletions and context/additions without synthetic newline', () => {
    expect(translated(diff)).toEqual([{ type: 'diff', path: path.join(cwd, 'a.txt'), oldText: 'context\nold', newText: 'context\nnew' }]);
  });
  it('prefers each hunk path over the input fallback and preserves order', () => {
    const hunk = diff.hunks[0]!;
    expect(translated({ ...diff, hunks: [{ ...hunk, filePath: 'b.txt' }, { ...hunk, filePath: 'c.txt' }] }).map(item => item.path)).toEqual([path.join(cwd, 'b.txt'), path.join(cwd, 'c.txt')]);
  });
  it('supports new files, deletions and empty hunks', () => {
    expect(translated({ addedLines: 1, removedLines: 0, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: [{ kind: '+', text: 'new' }] }] })).toEqual([{ type: 'diff', path: path.join(cwd, 'a.txt'), newText: 'new' }]);
    expect(translated({ addedLines: 0, removedLines: 1, hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: [{ kind: '-', text: 'old' }] }] })).toEqual([{ type: 'diff', path: path.join(cwd, 'a.txt'), oldText: 'old', newText: '' }]);
    expect(translated({ addedLines: 0, removedLines: 0, hunks: [] })).toEqual([]);
  });
  it('drops hunks without resolvable paths; invalid hunk paths allow input fallback', () => {
    expect(translated(diff, {})).toEqual([]);
    expect(translated(diff, { file_path: 'bad\u0000path' })).toEqual([]);
    expect(translated({ ...diff, hunks: [{ ...diff.hunks[0]!, filePath: '' }] })).toHaveLength(1);
    expect(translateDiff(diff, { file_path: 'a' }, 'relative')).toEqual([]);
  });
});
