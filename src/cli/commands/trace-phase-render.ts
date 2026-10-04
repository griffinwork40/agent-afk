/**
 * `session_phase` event rendering for `afk trace show`.
 *
 * Extracted from `trace.ts` (which is past the 350-line file-size ceiling and
 * may not grow) to keep `renderEvent` under the 200-line function ceiling.
 * All output format, label strings, and filtering logic are preserved verbatim
 * — this is a pure structural extraction, not a behaviour change.
 *
 * @module cli/commands/trace-phase-render
 */

import type { SessionPhasePayload } from '../../agent/trace/index.js';
import { fmtDuration } from './trace-format.js';

/**
 * Render a `session_phase` event.
 *
 * Returns a formatted line string, or `null` when the phase is a low-signal
 * latency waterfall marker that should be omitted from the default view
 * (`showAll` false).
 *
 * `line(kind, detail)` is the same column-formatting closure used by the
 * parent `renderEvent` function — passed in so the timestamp stays consistent
 * and no external import of `fmtTime`/`label` is needed here.
 */
export function renderSessionPhase(
  p: SessionPhasePayload,
  showAll: boolean,
  line: (kind: string, detail: string) => string,
): string | null {
  // `rate_limit` is HIGH-signal: it explains an otherwise-invisible stall
  // (the SDK's silent 429/503/529 retry-after backoff surfaces only as an
  // abnormally long model_ttfb). Render it in the DEFAULT view — unlike the
  // other phases, which are low-signal latency-waterfall markers shown only
  // with --all. Placed before the showAll gate below on purpose.
  if (p.phase === 'rate_limit') {
    const md = p.metadata ?? {};
    const reason = md['reason'];
    const status = md['status'];
    const source = md['source'];
    const wait =
      p.durationMs !== undefined ? `  retry-after ${fmtDuration(p.durationMs)}` : '';
    const statusBit = status !== undefined ? `  ${status}` : '';
    const srcBit = source !== undefined ? `  (${source})` : '';
    const head = reason !== undefined ? String(reason) : 'throttled';
    return line('throttle', `${head}${statusBit}${wait}${srcBit}`);
  }
  // `ttfb_timeout` is HIGH-signal for the same reason as `rate_limit` — it
  // explains a multi-minute gap — but it is OUR watchdog, not a throttle:
  // `durationMs` is dead wait we chose to spend, not a server retry-after.
  // Rendered in the DEFAULT view with its own label so the two stop being
  // read as one thing.
  if (p.phase === 'ttfb_timeout') {
    const src = p.metadata?.['source'];
    const srcBit = src !== undefined ? `  (${String(src)})` : '';
    const waited =
      p.durationMs !== undefined ? ` after ${fmtDuration(p.durationMs)}` : '';
    // `attempt` is the 1-based index of the re-drive being served, so it
    // distinguishes the 1st stall from the 2nd within one round. Omitted
    // (not defaulted) when absent: traces written before the counted budget
    // carry no `attempt`, and inventing "#1" would assert a fact the event
    // does not record.
    const nth = p.metadata?.['attempt'];
    const nthBit = nth !== undefined ? ` #${String(nth)}` : '';
    return line('ttfb-stall', `no first token${waited} — request re-driven${nthBit}${srcBit}`);
  }
  // Usage-limit park/unpark is the highest-signal stall of all — a
  // multi-hour subscription pause, not a per-minute backoff. Render in the
  // DEFAULT view (before the showAll gate) so the trace explains the gap.
  if (p.phase === 'usage_limit_pause') {
    const md = p.metadata ?? {};
    const resetsAt = md['resetsAt'];
    const resetBit = resetsAt !== undefined ? `  resets ${resetsAt}` : '  no reset ts';
    return line('paused', `usage-limit${resetBit}`);
  }
  if (p.phase === 'usage_limit_resume') {
    const md = p.metadata ?? {};
    const parked = p.durationMs !== undefined ? `  parked ${fmtDuration(p.durationMs)}` : '';
    const hotSwap = md['hotSwapped'] === true ? '  (hot-swap)' : '';
    return line('resumed', `usage-limit${parked}${hotSwap}`);
  }
  // Overload park/unpark (#762) is the same class of gap as the usage-limit
  // park above — up to a 10-minute silence with no other trace signal — so it
  // renders in the DEFAULT view too. A 529 carries no reset timestamp, so the
  // ceiling is what bounds it; show that instead of a deadline.
  if (p.phase === 'overload_pause') {
    const md = p.metadata ?? {};
    const ceiling = md['ceilingMs'];
    const ceilBit =
      typeof ceiling === 'number' ? `  ceiling ${fmtDuration(ceiling)}` : '  no ceiling';
    const surface = md['surface'];
    const surfaceBit = surface !== undefined ? `  ${String(surface)}` : '';
    return line('paused', `overloaded (529)${ceilBit}${surfaceBit}`);
  }
  if (p.phase === 'overload_resume') {
    const md = p.metadata ?? {};
    const parked = p.durationMs !== undefined ? `  parked ${fmtDuration(p.durationMs)}` : '';
    const outcome = md['outcome'];
    const outcomeBit = outcome !== undefined ? `  ${String(outcome)}` : '';
    return line('resumed', `overloaded${parked}${outcomeBit}`);
  }
  // A per-session compaction disable is high-signal for the same reason as
  // the stalls above: it explains an otherwise-invisible future failure (the
  // session can no longer shed context, so it will eventually overflow the
  // window). Rendered in the DEFAULT view, before the showAll gate.
  if (p.phase === 'compaction_disabled') {
    const md = p.metadata ?? {};
    const wire = md['wire'];
    const status = md['status'];
    const errMsg = md['error'];
    const wireBit = wire !== undefined ? ` (${wire} wire)` : '';
    const statusBit = status !== undefined ? `  ${status}` : '';
    const causeBit = errMsg !== undefined ? `  ${errMsg}` : '';
    return line('compact', `DISABLED for session${wireBit}${statusBit}${causeBit}`);
  }
  // A boot_warning is a SAFETY signal, not a latency marker: it means a
  // user-owned file under ~/.afk/agents/ (or an MCP config entry) shadowed
  // or overrode something a bundled skill implicitly trusted — e.g. a
  // read-only verifier agent silently becoming write-capable machine-wide
  // (#739, #754). Rendered in the DEFAULT view, before the showAll gate,
  // for the same reason as rate_limit above: hiding it behind --all makes
  // exactly the bug class the issue describes (ships green, invisible).
  if (p.phase === 'boot_warning') {
    const md = p.metadata ?? {};
    const message = md['message'];
    // `producer` is preserved in metadata for programmatic filtering
    // (`afk trace show --json | jq 'select(.payload.metadata.producer=="mcp")'`)
    // but is NOT rendered as a visible prefix here: the message strings
    // already self-identify ("[mcp] …", "[afk] agents: …"), so prepending
    // `[producer]` would double the prefix for MCP events (#984).
    return line('boot-warn', `${message !== undefined ? String(message) : '(no message)'}`);
  }
  if (!showAll) return null; // latency waterfall — low signal by default
  const dur = p.durationMs !== undefined ? `  ${fmtDuration(p.durationMs)}` : '';
  // Prefer the operator alias (session_init_start); fall back to the
  // resolved wire id (model_ttfb carries only that).
  const modelStr = p.model ?? p.resolvedModel;
  const modelBit = modelStr !== undefined ? `  ${modelStr}` : '';
  return line('phase', `${p.phase}${dur}${modelBit}`);
}
