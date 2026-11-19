import type { OpenAIMessage } from '../messages.js';
import { truncate } from '../../../../utils/truncate.js';

/** Bound historical arguments only when the non-result envelope cannot fit.
 * Calls have already executed; ids, names and result pairing remain intact.
 * The replacement is JSON, not a partial JSON prefix. It is synthesis context,
 * never an input to the tool dispatcher. Full arguments remain in history.
 */
export function boundPressureArguments(turns: OpenAIMessage[], appendedAt: number, budget: number): void {
  const envelope = turns.slice(appendedAt).filter(m => m.role !== 'tool');
  if (Buffer.byteLength(JSON.stringify(envelope)) <= budget) return;
  const calls = envelope.flatMap(m => m.tool_calls ?? []);
  if (!calls.length) return;
  const fixed = envelope.map(m => m.tool_calls ? {
    ...m, tool_calls: m.tool_calls.map(c => ({ ...c, function: { ...c.function, arguments: '' } })),
  } : m);
  const each = Math.floor(Math.max(0, budget - Buffer.byteLength(JSON.stringify(fixed))) / calls.length);
  for (let i = appendedAt; i < turns.length; i++) {
    const message = turns[i]!;
    if (message.role === 'tool' || !message.tool_calls) continue;
    let changed = false;
    const toolCalls = message.tool_calls.map(call => {
      const original = call.function.arguments;
      if (Buffer.byteLength(JSON.stringify(original)) <= each) return call;
      const marker = { _truncated: `[Context pressure: arguments truncated for final synthesis; original size ${Buffer.byteLength(original)} UTF-8 bytes; full arguments are journaled.]`, preview: '' };
      // Account for BOTH JSON encodings: the argument object and the wire string.
      // Worst case: a control char such as U+0000 becomes \u0000 (6 chars) on the
      // first JSON.stringify, then \\u0000 (7 chars) on the second pass.
      // 12 is a conservative ceiling that holds for all code points.
      const overhead = Buffer.byteLength(JSON.stringify(JSON.stringify(marker)));
      const count = Math.min(1024, Math.floor(Math.max(0, each - overhead) / 12));
      if (count > 0) marker.preview = truncate(original, count);
      changed = true;
      return { ...call, function: { ...call.function, arguments: JSON.stringify(marker) } };
    });
    if (changed) turns[i] = { ...message, tool_calls: toolCalls };
  }
}
