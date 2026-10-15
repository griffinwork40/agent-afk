/** Bounded, argument-free evidence for scheduled runs that encounter AFK gates. */
import { parseTerminalState } from '../outcomes/terminal-state.js';
import type { Message } from '../types/message-types.js';
import type { TraceSink, TraceWriter } from '../trace/index.js';
import type { HookTallyAliasedSink } from '../trace/hook-tally.js';

export interface GateBlockCall {
  blockedTool: string;
  /** First subsequent starts, including across later blocks/retries; not proof of success. */
  followingTools: string[];
}

export interface GateRecoveryFields {
  /**
   * Number of tool calls hard-blocked by the AFK gate during this run (#3466).
   * Present only when > 0. A recovered run may still be `success`; see
   * gateRecoveryNote for the declared recovery and gateBlockCalls for context.
   */
  gateBlocks?: number;
  /** Bounded, argument-free observations; subsequent calls are not proof of success. */
  gateBlockCalls?: GateBlockCall[];
  /** One-line declared recovery note, present only for success after gate blocks. */
  gateRecoveryNote?: string;
}

export interface GateBlockCounter {
  count: number;
  /** At most five blocks, each with at most five subsequent tool names. */
  calls?: GateBlockCall[];
}

/** Names only: never retain arguments, refusal reasons, or tool outputs. */
function toolLabel(name: string | undefined): string {
  return name?.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 80) || 'unknown';
}

export function makeGateBlockTraceWriter(
  inner: TraceSink | undefined,
  counter: GateBlockCounter | undefined,
): TraceSink | undefined {
  if (inner === undefined || counter === undefined) return inner;
  const shim: HookTallyAliasedSink = {
    hookTallyKey: inner,
    getTracePath: () => inner.getTracePath(),
    write(event) {
      if (event.kind === 'hook_decision' && event.payload.approvalOutcome === 'hard-block') {
        counter.count += 1;
        counter.calls ??= [];
        if (counter.calls.length < 5) {
          counter.calls.push({ blockedTool: toolLabel(event.payload.blockedTool), followingTools: [] });
        }
      } else if (event.kind === 'tool_call' && event.payload.phase === 'started') {
        for (const call of counter.calls ?? []) {
          if (call.followingTools.length < 5) call.followingTools.push(toolLabel(event.payload.name));
        }
      }
      return inner.write(event);
    },
  };
  return shim;
}

/** Keep the session's owner handle identical to its configured writer (#3442). */
export function makeGateBlockTraceOwner(
  inner: TraceWriter | undefined,
  counter: GateBlockCounter | undefined,
): TraceWriter | undefined {
  const sink = makeGateBlockTraceWriter(inner, counter);
  if (!inner || !sink || sink === inner) return inner;
  // Invariant: only the owner wrapper exposes seal/close; child plumbing remains
  // typed as TraceSink. Both emissions and the seal tally alias the real writer.
  return Object.assign(sink, {
    seal: inner.seal.bind(inner),
    close: inner.close.bind(inner),
  });
}

export function hasRecoveredFromGate(response: Message, aborted: boolean): boolean {
  // Invariant: recovery requires a resolved sendMessage, a non-aborted assistant
  // response with an explicitly normal provider stop (end_turn/stop), no error
  // metadata, and an explicit terminal Done. Missing/ambiguous signals remain
  // blocked; prose claiming success alone is not completion evidence. This is
  // a declared recovery, NOT verification of the work or endorsement of a bypass.
  const metadata = response.metadata;
  return !aborted && response.role === 'assistant'
    && (metadata?.stopReason === 'end_turn' || metadata?.stopReason === 'stop')
    && metadata.isError !== true && !metadata.errors?.length
    && (metadata.resultSubtype === undefined || metadata.resultSubtype === 'success')
    && parseTerminalState(response.content)?.kind === 'done';
}

export function gateRecoveryNote(counter: GateBlockCounter): string {
  return `Recovered after ${counter.count} AFK gate block(s) (declared Done; not verified).`;
}
