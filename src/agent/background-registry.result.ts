/**
 * Result-body extraction for background job persistence.
 *
 * Extracted from `background-registry.ts` to keep that file within the
 * 350-LOC ceiling. Contains the `extractOutputText` helper that synthesizes
 * the human-readable output string from a terminal `SubagentResult` — the
 * same string surfaced by `bg-result-notifier.ts`'s `extractOutput()` but
 * located in the agent layer so `markTerminal()` can persist it without
 * importing from `cli/`.
 *
 * @module agent/background-registry.result
 */

import type { SubagentResult } from './subagent.js';
import type { BackgroundJobStatus } from './background-registry.types.js';
import { annotateIfIncomplete } from './subagent/result.js';
import type { BgJobResult } from './bg-job-log.js';
import type { BgJobLogWriter } from './bg-job-log.js';

/**
 * Persist the synthesized result body for completed/failed jobs.
 *
 * Called from `markTerminal()` via this helper so the call site in
 * `background-registry.ts` stays within the 350-LOC baseline. Cancelled jobs
 * carry no meaningful output and are deliberately excluded.
 */
export function persistResultBody(
  writer: BgJobLogWriter,
  jobId: string,
  status: BackgroundJobStatus,
  result: SubagentResult,
): void {
  if (status !== 'completed' && status !== 'failed') return;
  const jobResult: BgJobResult = {
    jobId,
    status,
    outputText: extractOutputText(result, status),
    schemaVersion: 1,
  };
  void writer.writeResult(jobResult);
}

/**
 * Extract the synthesized output text from a terminal SubagentResult.
 *
 * Single source for both the persisted `result.json` body and the REPL
 * auto-delivery path (`bg-result-notifier.ts` delegates here), so the two can
 * never drift. Lives in the agent layer so `markTerminal()` need not import `cli/`.
 *
 * Returns `''` when the result carries no extractable content — callers
 * that read `result.json` treat an empty string as "no output" rather than
 * a missing file, which is the correct semantic for a job that produced no
 * assistant text.
 */
export function extractOutputText(result: SubagentResult, status: BackgroundJobStatus): string {
  if (status === 'failed') {
    const errText = result.error
      ? `${result.error.name}: ${result.error.message}`
      : 'unknown error';
    const partial =
      typeof result.partialOutput === 'string' && result.partialOutput.length > 0
        ? `\n\nPartial output before failure:\n${result.partialOutput}`
        : '';
    return `Subagent failed — ${errText}${partial}`;
  }
  const raw = result.message?.content;
  if (typeof raw === 'string') return annotateIfIncomplete(raw, result.stopReason);
  if (raw !== undefined) return JSON.stringify(raw);
  return '';
}
