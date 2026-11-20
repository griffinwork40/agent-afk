import type { DiffPayload } from '../../utils/diff.js';
import type { DiffContent } from './acp.wire.js';

/** Render-only hunk snapshots, never instructions for a client to apply. */
export function translateDiff(_diff: DiffPayload, _input: unknown, _cwd: string): DiffContent[] {
  throw new Error('not implemented');
}
