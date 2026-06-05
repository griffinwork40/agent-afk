import { promises as fs } from 'node:fs';
import { env } from '../../../config/env.js';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Create a new transcript file under `dir` and write the markdown header.
 * Returns the absolute path. Filename is an ISO timestamp with `:` / `.`
 * replaced by `-` so millisecond precision survives in a plain filename
 * (and `ls` sorts chronologically). Millisecond precision makes a collision
 * suffix unnecessary.
 */
export async function startTranscript(dir: string, model: string, continued = false): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const p = path.join(dir, `${stamp}.md`);
  const title = continued ? ' (continued)' : '';
  // S2 fix: transcript files contain full conversation content (including any
  // pasted secret). Mode 0o600 ensures only the owner can read the file.
  // Constraint: POSIX file-mode — mode must be set at creation time to avoid
  // a TOCTOU window between create-with-default-umask and a subsequent chmod.
  await fs.writeFile(
    p,
    `# Session — ${new Date().toISOString()}${title}\n\n- model: ${model}\n\n---\n\n`,
    { mode: 0o600 },
  );
  return p;
}

export interface TranscriptHandle {
  path(): string;
  /** Append a completed turn. Best-effort — errors swallowed. */
  appendTurn(userInput: string, assistantText: string): Promise<void>;
  /** `/clear` flow: mark old file `_cleared_` and start a new one. */
  rotateOnClear(): Promise<void>;
  /** Shutdown marker. Best-effort — errors swallowed. */
  appendEnded(): Promise<void>;
}

/**
 * Autosaved markdown transcript handle. Path is mutable across `/clear`
 * rotations; callers read it via `handle.path()` rather than caching.
 * `getModel` is a getter closure so the model-at-turn is honored (the
 * user may `/model …` mid-session).
 */
export async function initTranscript(getModel: () => string): Promise<TranscriptHandle> {
  const dir = path.join(
    env.AFK_STATE_DIR ?? path.join(os.homedir(), '.afk'),
    'transcripts',
  );
  let current = await startTranscript(dir, getModel());

  return {
    path: () => current,
    async appendTurn(userInput, assistantText) {
      if (!assistantText) return;
      // S2 fix: mode 0o600 on appendFile guards the create-if-not-exists path.
      await fs.appendFile(
        current,
        `_${new Date().toISOString()} · model: ${getModel()}_\n\n## User\n\n${userInput}\n\n## Assistant\n\n${assistantText}\n\n---\n\n`,
        { mode: 0o600 },
      ).catch(() => { /* transcript best-effort */ });
    },
    async rotateOnClear() {
      await fs.appendFile(current, `\n_cleared_\n`, { mode: 0o600 }).catch(() => { /* best-effort */ });
      current = await startTranscript(dir, getModel(), true);
    },
    async appendEnded() {
      await fs.appendFile(
        current,
        `\n_ended: ${new Date().toISOString()}_\n`,
        { mode: 0o600 },
      ).catch(() => { /* transcript best-effort */ });
    },
  };
}
