import { expect, vi } from 'vitest';
import type { OutputEvent } from '../../../agent/types/session-types.js';
import type { ResponseMetadata } from '../../../agent/types/message-types.js';
import type { AcpSessionHandle, AcpSessionOptions } from '../acp.session.js';
import type { GoldenScript, ScriptedTool, ScriptStep } from './acp-scripts.js';
import { persistedId } from './acp-scripts.js';

export function isTool(step: ScriptStep): step is ScriptedTool {
  return 'kind' in step && step.kind === 'tool';
}
function detail(tool: ScriptedTool, pending = false): OutputEvent {
  // Exact stream-consumer.ts tool.use.start projection, including the raw JSON.
  return { type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: tool.id,
    toolName: tool.name, toolInput: pending ? ' …' : JSON.stringify(tool.input),
    ...(pending ? { pending: true as const } : { toolInputRaw: JSON.stringify(tool.input) }) } };
}

export class ScriptedSession {
  private aborter = new AbortController();
  private turn = 0;
  private last: ResponseMetadata | null = null;
  readonly close = vi.fn(async () => { this.abort(); });
  readonly abort = vi.fn(() => { this.aborter.abort(); });
  /** Mirrors AgentSession.interrupt: aborts the in-flight provider query (and so the tool signal). */
  readonly interrupt = vi.fn(async () => { this.aborter.abort(); });
  constructor(readonly options: AcpSessionOptions, readonly script: GoldenScript) {}
  getSessionMetadata() { return { sessionId: this.options.sessionId ?? persistedId,
    model: 'claude-sonnet-4-5', cwd: this.options.cwd }; }
  getSessionIdentity() { return { sessionId: this.options.sessionId ?? persistedId,
    configuredSessionId: this.options.sessionId, persistSession: true }; }
  getLastResponseMetadata() { return this.last; }
  async waitForInitialization() { return this.getSessionMetadata(); }
  async supportedModels() { return [{ value: 'claude-sonnet-4-5', displayName: 'Sonnet' }]; }
  async mcpServerStatus() { return []; }

  private async *runTool(tool: ScriptedTool): AsyncGenerator<OutputEvent> {
    yield detail(tool, true);
    yield detail(tool);
    // Permission bridge removed: tools always execute unconditionally.
    this.script.asked.push(tool.id);
    if (this.aborter.signal.aborted) return;
    this.script.executed.push(tool.id);
    if (tool.diff) yield { type: 'chunk', chunk: { type: 'tool_diff', toolUseId: tool.id, diff: tool.diff } };
    yield { type: 'chunk', chunk: { type: 'tool_result', toolUseId: tool.id,
      content: tool.result, isError: tool.isError === true } };
  }

  async *sendMessageStream(prompt: string): AsyncGenerator<OutputEvent> {
    this.aborter = new AbortController();
    const turn = this.script.turns[this.turn++];
    if (!turn) throw new Error(`A6 unexpected prompt ${prompt}`);
    expect(prompt, 'A1 prompt normalization').toBe(turn.prompt);
    for (const step of turn.steps) {
      if (isTool(step)) yield* this.runTool(step);
      else if ('kind' in step) {
        // Block on a real abort signal, not elapsed time, so cancellation cannot race done.
        if (!this.aborter.signal.aborted) await new Promise<void>(resolve => {
          this.aborter.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      } else {
        if (step.type === 'done') this.last = step.metadata ?? null;
        yield step;
      }
    }
  }
}

/** Only this construction boundary is faked; transport, gate, translation and close are real. */
export function fakeHandle(options: AcpSessionOptions, script: GoldenScript): AcpSessionHandle {
  const handle = { session: new ScriptedSession(options, script),
    memoryStore: { close: vi.fn() }, stateStore: { close: vi.fn() } };
  // AgentSession has private internals irrelevant to the construction seam.
  return handle as unknown as AcpSessionHandle;
}
