/**
 * Bounded next-turn delivery for Ctrl+B tool results (#2932, #2542).
 *
 * Subscribes to {@link DetachableToolRegistry}'s `settled` event and buffers
 * each result for injection into the next user message, mirroring the
 * {@link BgResultNotifier} contract for background subagents.
 *
 * Additionally tracks live {@link ToolEvent} objects (via {@link observe}) so
 * the `incomplete`/`incompleteReason`/`partialNodeCount` metadata carried on
 * the {@link DetachedToolResult} is patched back onto the original event
 * record before the session sidecar is written — closing the
 * `compose_partial_nodes` undercounting gap for detached compose calls.
 *
 * @module cli/commands/interactive/detached-tool-notifier
 */

import type { DetachableToolRegistry, DetachedToolResult } from '../../../agent/tools/detach-registry.js';
import type { ToolEvent } from '../../slash/types.js';
import { escapeXmlAttr } from './process-job-notifier.js';

const MAX_PENDING = 25;
const MAX_TRACKED = 1000;
const MAX_OUTPUT_BYTES = 16 * 1024;

/**
 * Strip a trailing partial XML entity from an already-escaped string that has
 * been byte-truncated. Truncation may cut `&lt;`, `&amp;`, etc. mid-sequence;
 * remove the orphaned fragment so the model never receives a malformed entity.
 */
function stripTrailingPartialEntity(s: string): string {
  // An XML entity starts with '&' and ends with ';'. If the last '&' in the
  // string has no matching ';' after it, the entity was cut — drop everything
  // from that '&' onward.
  const lastAmp = s.lastIndexOf('&');
  if (lastAmp === -1) return s;
  const lastSemi = s.lastIndexOf(';');
  if (lastSemi >= lastAmp) return s; // complete entity — nothing to strip
  return s.slice(0, lastAmp);
}

/**
 * Build the model-context injection envelope for a settled detached tool call.
 * Escape before capping so adversarial `<` output does not expand past the budget.
 */
export function buildDetachedToolInjection(result: DetachedToolResult): string {
  // Strip control chars from toolUseId before it reaches XML attributes
  // (defence in depth — SDK-generated, but sanitise at the boundary).
  // eslint-disable-next-line no-control-regex
  const safeToolUseId = result.toolUseId.replace(/[^\x20-\x7e]/g, '');
  const escaped = escapeXmlAttr(result.output);
  let output: string;
  if (Buffer.byteLength(escaped) > MAX_OUTPUT_BYTES) {
    const truncated = Buffer.from(escaped).subarray(0, MAX_OUTPUT_BYTES).toString('utf8');
    output = stripTrailingPartialEntity(truncated) + '\n… [detached output truncated]';
  } else {
    output = escaped;
  }
  const attrs: Array<[string, string]> = [
    ['toolUseId', safeToolUseId], ['status', result.status],
    ['duration_ms', String(result.durationMs)],
  ];
  if (result.exitCode !== undefined) attrs.push(['exit_code', String(result.exitCode)]);
  if (result.incomplete !== undefined) attrs.push(['incomplete', String(result.incomplete)]);
  if (result.incompleteReason !== undefined) attrs.push(['incompleteReason', result.incompleteReason]);
  if (result.partialNodeCount !== undefined) attrs.push(['partialNodeCount', String(result.partialNodeCount)]);
  return (
    `<detached-tool-result ${attrs.map(([k, v]) => `${k}="${escapeXmlAttr(v)}"`).join(' ')}>\n` +
    `<output>${output}</output>\n</detached-tool-result>`
  );
}

/**
 * Cap a string to at most `maxBytes` UTF-8 bytes, appending a truncation
 * marker when trimmed. Mirrors the injection-path cap so `ToolEvent.result`
 * written to the session sidecar on every autosave never holds >16 KiB of
 * raw detached-tool output (carried-over finding from #3155).
 */
function capOutput(raw: string, maxBytes: number): string {
  if (Buffer.byteLength(raw, 'utf8') <= maxBytes) return raw;
  const buf = Buffer.from(raw, 'utf8');
  // Walk back from `maxBytes` to find a valid UTF-8 start byte so the
  // decode never emits a U+FFFD replacement character mid-codepoint.
  // UTF-8 continuation bytes are 0x80–0xBF; start bytes are 0x00–0x7F,
  // 0xC0–0xFF.  Walking back at most 3 bytes covers the widest code point.
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8') + '\n… [detached output truncated]';
}

/** Patch partial-compose metadata from a settled result back onto a ToolEvent. */
function applyResult(event: ToolEvent, result: DetachedToolResult): void {
  event.result = capOutput(result.output, MAX_OUTPUT_BYTES);
  event.isError = result.status === 'failed';
  if (result.incomplete !== undefined) event.incomplete = result.incomplete;
  if (result.incompleteReason !== undefined) event.incompleteReason = result.incompleteReason;
  if (result.partialNodeCount !== undefined) event.partialNodeCount = result.partialNodeCount;
}

/**
 * Manages in-flight tracking of detachable tool events and queues model-context
 * injections when they settle. One instance per REPL session, wired into
 * {@link BgResultNotifier} so the existing drain/reset/dispose lifecycle applies.
 */
export class DetachedToolNotifier {
  private readonly tracked = new Map<
    string,
    { event: ToolEvent; sawPlaceholder: boolean; result?: DetachedToolResult }
  >();
  /** Buffered result for tools that settled BEFORE observe() was called. */
  private readonly earlySettled = new Map<string, DetachedToolResult>();
  private injections: string[] = [];
  private notices: string[] = [];

  /**
   * Optional wake hook — fired after an injectable result is buffered. Wired
   * by {@link BgResultNotifier} to its own `onInjectable` so the REPL can
   * auto-resume on Ctrl+B delivery even when background subagent auto-delivery
   * is disabled.
   */
  onInjectable: (() => void) | null = null;

  private readonly onSettled = (result: DetachedToolResult): void => {
    const entry = this.tracked.get(result.toolUseId);
    if (!entry) {
      // observe() has not been called yet for this id. Buffer the result so
      // observe() can pick it up when the placeholder chunk arrives later.
      // Unknown ids (outgoing-session calls after /resume) will never get an
      // observe() call and are evicted by reset()/dispose().
      // Guard against unbounded growth (mirrors the tracked guard below).
      if (this.earlySettled.size >= MAX_TRACKED) return;
      this.earlySettled.set(result.toolUseId, result);
      return;
    }
    this._deliver(entry, result);
  };

  /** Apply a settled result to a tracked entry and queue the injection. */
  private _deliver(
    entry: { event: ToolEvent; sawPlaceholder: boolean; result?: DetachedToolResult },
    result: DetachedToolResult,
  ): void {
    entry.result = result;
    applyResult(entry.event, result);
    if (entry.sawPlaceholder) this.tracked.delete(result.toolUseId);
    this.injections.push(buildDetachedToolInjection(result));
    if (this.injections.length > MAX_PENDING) {
      // Oldest injection dropped — log so operators can diagnose silent loss.
      process.stderr.write(
        `[afk] detached-tool-notifier: MAX_PENDING (${MAX_PENDING}) exceeded; ` +
        `dropping oldest buffered injection.\n`,
      );
      this.injections.shift();
    }
    // Sanitise id: strip all non-printable-ASCII chars (defence in depth).
    const safeId = result.toolUseId.replace(/[^\x20-\x7e]/g, '');
    this.notices.push(`  Detached tool ${safeId}: ${result.status}`);
    if (this.notices.length > MAX_PENDING) this.notices.shift();
    // Invariant: populate buffers BEFORE waking the idle prompt.
    this.onInjectable?.();
  }

  constructor(private readonly registry: DetachableToolRegistry) {
    registry.on('settled', this.onSettled);
  }

  /**
   * Observe a tool event as it is emitted by the turn handler.
   *
   * Called on both `tool_use_start` (no result yet) and `tool_result` (result
   * present). Tracks detachable tools and patches back settled metadata if
   * delivery raced ahead of the placeholder chunk.
   *
   * Only bash and compose are detachable; all other tool names are ignored.
   */
  observe(event: ToolEvent): void {
    if (event.toolName !== 'bash' && event.toolName !== 'compose') return;
    const entry = this.tracked.get(event.toolUseId);
    // A fast completion may precede the detached placeholder chunk. Reapply it.
    if (entry?.result) {
      applyResult(event, entry.result);
      this.tracked.delete(event.toolUseId);
      return;
    }
    if (event.result !== undefined) {
      // Once the result is visible, check whether it is the detach placeholder.
      let detached = false;
      try {
        detached = (JSON.parse(event.result) as { status?: string }).status === 'detached';
      } catch { /* normal (non-JSON) output — not the placeholder */ }
      if (!detached) {
        this.tracked.delete(event.toolUseId);
      } else if (entry) {
        entry.sawPlaceholder = true;
      } else {
        // First observe() call for this id carries the detached placeholder.
        // Check whether settled already fired; if so, deliver immediately.
        const early = this.earlySettled.get(event.toolUseId);
        if (early) {
          this.earlySettled.delete(event.toolUseId);
          const newEntry = { event, sawPlaceholder: true };
          this.tracked.set(event.toolUseId, newEntry);
          this._deliver(newEntry, early);
          // _deliver sets sawPlaceholder check, clean up now
          this.tracked.delete(event.toolUseId);
        } else {
          // placeholder arrived first — track so settled can deliver later
          this.tracked.set(event.toolUseId, { event, sawPlaceholder: true });
        }
      }
      return;
    }
    // No result yet — check for early settlement, then track for later.
    const early = this.earlySettled.get(event.toolUseId);
    if (early) {
      // Settled fired before observe() — apply immediately and skip tracking.
      this.earlySettled.delete(event.toolUseId);
      applyResult(event, early);
      // Injection was already queued by onSettled? No — onSettled returned early
      // when !entry. We must queue it now.
      this.injections.push(buildDetachedToolInjection(early));
      if (this.injections.length > MAX_PENDING) {
        process.stderr.write(
          `[afk] detached-tool-notifier: MAX_PENDING (${MAX_PENDING}) exceeded; ` +
          `dropping oldest buffered injection.\n`,
        );
        this.injections.shift();
      }
      const safeId = early.toolUseId.replace(/[^\x20-\x7e]/g, '');
      this.notices.push(`  Detached tool ${safeId}: ${early.status}`);
      if (this.notices.length > MAX_PENDING) this.notices.shift();
      this.onInjectable?.();
      return;
    }
    this.tracked.set(event.toolUseId, { event, sawPlaceholder: false });
    if (this.tracked.size > MAX_TRACKED) this.tracked.delete(this.tracked.keys().next().value!);
  }

  hasPendingInjections(): boolean { return this.injections.length > 0; }

  drainInjections(): string {
    const out = this.injections.join('\n');
    this.injections = [];
    return out ? out + '\n' : '';
  }

  drainNotices(): string[] {
    const out = this.notices;
    this.notices = [];
    return out;
  }

  /**
   * Mark that the buffered injection for this tool call was delivered into the
   * model's context for the current turn. Today this is a no-op beyond the
   * drainInjections() call that consumed it, but the hook exists so callers
   * can emit a witness trace event analogous to
   * {@link BackgroundAgentRegistry.markDelivered} if a trace sink is added
   * here in the future. The detach registry does not carry a trace writer
   * today, so no witness event is emitted — that gap is documented and
   * intentionally deferred.
   */
  markDelivered(_toolUseId: string): void {
    // No witness sink wired to the DetachableToolRegistry today.
    // When a TraceSink is threaded through (future work), emit a
    // 'detached_tool.delivered' event here analogous to
    // background_agent.delivered in BackgroundAgentRegistry.
  }

  reset(): void {
    this.tracked.clear();
    this.earlySettled.clear();
    this.injections = [];
    this.notices = [];
  }

  dispose(): void {
    this.registry.off('settled', this.onSettled);
    this.onInjectable = null;
    this.reset();
  }
}
