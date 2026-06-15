import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ensureTranscriptsMigrated, getTranscriptsDir } from '../../../paths.js';

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
  /**
   * Persist the user's message immediately at submission time — before the
   * model responds. Opens a turn on disk; the matching `appendTurn()` call
   * (same `userInput`) closes it with the assistant block only. Without
   * this, a crash, ESC soft-stop, or backgrounded turn loses the user's
   * message entirely (appendTurn only fires on completed turns).
   * Best-effort — errors swallowed.
   */
  appendUser(userInput: string): Promise<void>;
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
  // Relocate any pre-3.x flat ~/.afk/transcripts/ into the state tier before
  // resolving the (now state-scoped) target dir, so a returning user's old
  // transcripts and new ones live in one place.
  ensureTranscriptsMigrated();
  const dir = getTranscriptsDir();
  let current = await startTranscript(dir, getModel());
  // The user text of the turn currently "open" on disk: appendUser() wrote
  // its `## User` block but no `## Assistant` block has closed it yet.
  // null when the file sits at a turn boundary (trailing `---`).
  let openUser: string | null = null;

  // S2 fix: mode 0o600 on appendFile guards the create-if-not-exists path.
  const append = (text: string) =>
    fs.appendFile(current, text, { mode: 0o600 })
      .catch(() => { /* transcript best-effort */ });

  const closeDanglingTurn = async () => {
    if (openUser === null) return;
    openUser = null;
    await append(`## Assistant\n\n_(no response recorded)_\n\n---\n\n`);
  };

  return {
    path: () => current,
    async appendUser(userInput) {
      // Self-heal: the previous turn never completed (soft-stop, stream
      // error, or it was backgrounded). Close it so headings stay paired;
      // a backgrounded turn that completes later writes a full
      // self-contained pair via appendTurn's mismatch path below.
      await closeDanglingTurn();
      openUser = userInput;
      await append(
        `_${new Date().toISOString()} · model: ${getModel()}_\n\n## User\n\n${userInput}\n\n`,
      );
    },
    async appendTurn(userInput, assistantText) {
      if (openUser === userInput) {
        // The user block is already on disk (appendUser) — close the open
        // turn with the assistant block only, never re-writing the user text.
        openUser = null;
        await append(
          `## Assistant\n\n${assistantText || '_(no text response)_'}\n\n---\n\n`,
        );
        return;
      }
      // No matching open turn: the skill-dispatch path, or a backgrounded
      // turn completing after later turns were appended. Write the legacy
      // self-contained pair so the response is never orphaned from its
      // prompt.
      if (!assistantText) return;
      await append(
        `_${new Date().toISOString()} · model: ${getModel()}_\n\n## User\n\n${userInput}\n\n## Assistant\n\n${assistantText}\n\n---\n\n`,
      );
    },
    async rotateOnClear() {
      await closeDanglingTurn();
      await append(`\n_cleared_\n`);
      current = await startTranscript(dir, getModel(), true);
    },
    async appendEnded() {
      await closeDanglingTurn();
      await append(`\n_ended: ${new Date().toISOString()}_\n`);
    },
  };
}
