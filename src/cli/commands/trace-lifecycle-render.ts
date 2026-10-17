/**
 * `subagent_lifecycle` and `background_agent` event rendering for
 * `afk trace show`.
 *
 * Extracted from `trace.ts` (which is past the 350-line file-size ceiling and
 * may not grow) to keep `renderEvent` under the 200-line function ceiling.
 * All output format, label strings, and transition logic are preserved verbatim
 * — this is a pure structural extraction, not a behaviour change.
 *
 * @module cli/commands/trace-lifecycle-render
 */

import type {
  SubagentLifecyclePayload,
  BackgroundAgentPayload,
} from '../../agent/trace/index.js';
import type { SubagentBillingFields } from '../../agent/trace/events.billing.js';
import { fmtBytes, fmtDuration, fmtUsd, truncate } from './trace-format.js';
import { formatTokens } from '../format-utils.js';

/**
 * Compact billing suffix for a terminal lifecycle row (#3878), e.g.
 * `  [anthropic-direct in 1.2k / cr 30k / cw 2k / out 900]`. Empty when the
 * payload carries no `tokens` (provider reported no usage, or a pre-#3878
 * trace). Plain text like the rest of the line — `line()` owns styling.
 */
export function fmtBillingSuffix(p: SubagentBillingFields): string {
  const t = p.tokens;
  if (t === undefined) return '';
  const who = p.provider !== undefined ? `${p.provider} ` : '';
  return `  [${who}in ${formatTokens(t.uncachedInput)} / cr ${formatTokens(t.cacheRead)} / cw ${formatTokens(t.cacheWrite)} / out ${formatTokens(t.output)}]`;
}

/**
 * Render a `subagent_lifecycle` event.
 *
 * Returns a formatted line string, or `null` for an unrecognized transition
 * (forward-compatible: unknown future transitions are silently dropped rather
 * than crashing the renderer).
 */
export function renderSubagentLifecycle(
  p: SubagentLifecyclePayload,
  line: (kind: string, detail: string) => string,
): string | null {
  switch (p.transition) {
    case 'started': {
      // Prefer the clean registered type; fall back to the render label.
      // A leading `@` marks a resolved registered agent type (vs a label).
      const role = p.resolvedAgentType
        ? `  @${p.resolvedAgentType}`
        : p.agentType
          ? `  ${p.agentType}`
          : '';
      return line('subagent', `started  ${p.model}${role}  [${p.subagentId}]`);
    }
    case 'succeeded': {
      const cost = p.totalCostUsd !== undefined ? `  ${fmtUsd(p.totalCostUsd)}` : '';
      return line(
        'subagent',
        `succeeded  ${fmtDuration(p.durationMs)}  ${p.turnCount} turns  ${fmtBytes(p.outputBytes)}${cost}${fmtBillingSuffix(p)}  [${p.subagentId}]`,
      );
    }
    case 'failed': {
      // `[timeout]` marks a child killed by its own wall-clock budget
      // (failureClass:'timeout') vs an ordinary error — see the subagent
      // lifecycle failed payload.
      const to = p.failureClass === 'timeout' ? '  [timeout]' : '';
      return line(
        'subagent',
        `FAILED  ${p.errorClass}: ${truncate(p.errorMessage, 80)}${to}${fmtBillingSuffix(p)}  [${p.subagentId}]`,
      );
    }
    case 'cancelled': {
      // `(timeout)` marks a cascade that originated from an ancestor's
      // wall-clock budget expiry vs an ordinary parent/explicit cancel.
      const to = p.timeout ? ' (timeout)' : '';
      return line('subagent', `cancelled (${p.source})${to}${fmtBillingSuffix(p)}  [${p.subagentId}]`);
    }
  }
  return null;
}

/**
 * Render a `background_agent` event.
 *
 * Returns a formatted line string, or `null` for an unrecognized transition.
 */
export function renderBackgroundAgent(
  p: BackgroundAgentPayload,
  line: (kind: string, detail: string) => string,
): string | null {
  switch (p.transition) {
    case 'started':
      return line('bg-agent', `started  ${p.model}  ${truncate(p.label, 60)}  [${p.jobId}]`);
    case 'completed':
      return line(
        'bg-agent',
        `completed  ${fmtDuration(p.durationMs)}  ${fmtBytes(p.outputBytes)}  [${p.jobId}]`,
      );
    case 'failed':
      return line(
        'bg-agent',
        `FAILED  ${p.errorClass}: ${truncate(p.errorMessage, 80)}  [${p.jobId}]`,
      );
    case 'cancelled':
      return line('bg-agent', `cancelled (${p.source})  [${p.jobId}]`);
    case 'joined':
      return line('bg-agent', `joined  ${p.jobStatus}  [${p.jobId}]`);
    case 'delivered':
      return line('bg-agent', `delivered  ${p.jobStatus}  [${p.jobId}]`);
  }
  return null;
}
