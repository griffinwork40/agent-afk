/**
 * Consume answered daemon handoff records and re-enqueue the resumed task.
 *
 * When an operator answers a daemon's handoff question via Telegram (or another
 * surface), the HandoffRecord transitions to status 'answered'. This module
 * sweeps those records, builds a context-injected resume command, and
 * re-enqueues the task so the next pull-tick picks it up with the answer
 * threaded into the session prompt.
 *
 * Called fire-and-forget from two scheduler sites:
 *   1. startPullLoop() startup — pick up answers that arrived while the daemon
 *      was down.
 *   2. pullTick() teardown — pick up answers recorded during the completed run.
 *
 * @module agent/daemon/handoff-consume
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { getHandoffsDir } from '../../paths.js';
import { readHandoff, type HandoffRecord } from './handoff-store.js';
import { cleanupHandoff } from './handoff-wiring.js';
import { enqueue } from './queue-store.js';

// ---------------------------------------------------------------------------
// buildHandoffResumeCommand
// ---------------------------------------------------------------------------

/**
 * Build the re-enqueue command string for an answered HandoffRecord.
 *
 * The returned string is sent as the `command` field of a new QueuedTask so
 * the re-spawned session receives the operator's answer in its prompt and
 * can continue the original task without re-asking the question.
 *
 * @param record - An answered HandoffRecord (status must be 'answered').
 * @returns A multi-line command string that threads context into the session.
 * @throws If the record is not in 'answered' status or has no answer.
 */
export function buildHandoffResumeCommand(record: HandoffRecord): string {
  if (record.status !== 'answered') {
    throw new Error(
      `[handoff-consume] buildHandoffResumeCommand: record ${record.taskId} is not answered (status: ${record.status})`,
    );
  }
  if (record.answer === undefined) {
    throw new Error(
      `[handoff-consume] buildHandoffResumeCommand: record ${record.taskId} has no answer`,
    );
  }

  // Extract the human-readable question text. The question field is a
  // serialized ElicitationRequest whose 'message' field is the text shown
  // to the user. Fall back to a JSON summary if the message is absent.
  const questionText: string =
    typeof record.question['message'] === 'string'
      ? record.question['message']
      : JSON.stringify(record.question);

  const answerText = JSON.stringify(record.answer);

  return [
    '[Resumed task — the agent previously asked a question and the operator answered]',
    '',
    `Original task: ${record.originalCommand}`,
    '',
    `Question that was asked: ${questionText}`,
    `Operator's answer: ${answerText}`,
    '',
    'Continue the original task using this answer. Do not re-ask the question.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Internal: list answered handoffs
// ---------------------------------------------------------------------------

/**
 * List all HandoffRecords with status === 'answered' from the handoffs dir.
 * Mirrors listPendingHandoffs but filters for 'answered' status.
 * Skips temp files, lock files, unreadable files, and malformed JSON silently.
 */
async function listAnsweredHandoffs(
  handoffsDir: string,
): Promise<HandoffRecord[]> {
  try {
    mkdirSync(handoffsDir, { recursive: true, mode: 0o700 });
  } catch {
    return [];
  }

  let filenames: string[];
  try {
    filenames = await readdir(handoffsDir);
  } catch {
    return [];
  }

  const answered: HandoffRecord[] = [];
  for (const filename of filenames) {
    if (!filename.endsWith('.json') || filename.startsWith('.tmp-') || filename.endsWith('.lock')) continue;
    try {
      const raw = await readFile(join(handoffsDir, filename), 'utf-8');
      const record = JSON.parse(raw) as HandoffRecord;
      if (record.status === 'answered') answered.push(record);
    } catch {
      // Silently skip unreadable or malformed records.
    }
  }
  return answered;
}

// ---------------------------------------------------------------------------
// processAnsweredHandoffs
// ---------------------------------------------------------------------------

export interface ProcessHandoffsResult {
  /** Number of answered handoffs successfully re-enqueued. */
  requeued: number;
  /** Number of handoff records cleaned up (deleted) after re-enqueue. */
  cleaned: number;
}

/**
 * Sweep the handoffs directory for answered records, re-enqueue each as a
 * resumed task, and delete the handoff record.
 *
 * Individual record failures (bad JSON, re-enqueue error, cleanup error) do
 * NOT abort the loop — they are caught and logged. The function always
 * returns a summary of what succeeded.
 *
 * @param queueDir    - Override the queue directory (defaults to getQueueDir()).
 * @param handoffsDir - Override the handoffs directory (defaults to getHandoffsDir()).
 * @returns Counts of re-queued and cleaned records.
 */
export async function processAnsweredHandoffs(
  queueDir?: string,
  handoffsDir: string = getHandoffsDir(),
): Promise<ProcessHandoffsResult> {
  const answered = await listAnsweredHandoffs(handoffsDir);

  let requeued = 0;
  let cleaned = 0;

  for (const summary of answered) {
    try {
      // Re-read the full record from disk to get the latest answer.
      const record = await readHandoff(summary.taskId, handoffsDir);
      if (record === null || record.status !== 'answered') continue;

      const command = buildHandoffResumeCommand(record);
      enqueue(command, {}, queueDir);
      requeued += 1;

      try {
        await cleanupHandoff(record.taskId, handoffsDir);
        cleaned += 1;
      } catch (cleanErr) {
        const msg = cleanErr instanceof Error ? cleanErr.message : String(cleanErr);
        // eslint-disable-next-line no-console
        console.error(`[daemon] handoff-consume: cleanup failed for ${record.taskId}: ${msg}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[daemon] handoff-consume: failed to process handoff ${summary.taskId}: ${msg}`);
    }
  }

  return { requeued, cleaned };
}
