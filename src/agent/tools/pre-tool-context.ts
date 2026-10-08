import type { ToolCall, ToolResult } from '../providers/anthropic-direct/types.js';
import { emitHookDecision } from '../trace/emit.js';
import type { TraceSink } from '../trace/index.js';

/** Hook context is additive: preserve tool output and append the hook's note.
 * This is tool-result delivery, not a replacement system-prompt overlay.
 * Weak keys isolate concurrent calls and release abandoned calls automatically.
 */
export class PreToolContext {
  private readonly pending = new WeakMap<ToolCall, string>();

  capture(call: ToolCall, context: string): void {
    if (context.length > 0) this.pending.set(call, context);
  }

  /** Append after output capping; consume once even on the batch fast path. */
  async deliver(call: ToolCall, result: ToolResult, writer?: TraceSink): Promise<ToolResult> {
    const context = this.pending.get(call);
    this.pending.delete(call);
    if (context === undefined) return result;
    result.content += `\n\n[PreToolUse context]\n${context}`;
    if (writer) {
      await emitHookDecision(writer, {
        hookEvent: 'PreToolUse',
        injectedContextBytes: Buffer.byteLength(context, 'utf8'),
      });
    }
    return result;
  }
}
