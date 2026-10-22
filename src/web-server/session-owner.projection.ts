/** Rebuild the browser projection from the durable, human-visible journal.
 * Never use the model fold: compaction summaries are not transcript rows.
 */
import { getSessionJournalPath } from '../paths.js';
import { hydrateMessages, loadDisplayMessages, loadJournalFold } from '../agent/journal/index.js';
import { hasToolResultBlock, messageText } from '../agent/content/user-authored.js';
import { clip, MAX_TEXT_LEN, MAX_TOOL_INPUT_LEN } from '../agent/session-ledger-project.js';
import type { AgentSession } from '../agent/session/agent-session.js';
import type { JournalMessage } from '../agent/journal/index.js';
import type { LedgerPayload } from '../agent/session-ledger.js';

/** Check BEFORE mutation too: a disabled/failed journal cannot safely rewind web. */
export async function readProjectionMessages(session: AgentSession): Promise<JournalMessage[]> {
  const journal = session.messageJournal;
  const id = session.sessionId;
  if (!journal || !id) throw new Error('Cannot rewind web transcript: message journal unavailable.');
  await journal.flush();
  const fold = loadJournalFold(id);
  if (journal.path !== getSessionJournalPath(id) || !fold || fold.anomalies.length || fold.messages.length !== journal.length) {
    throw new Error('Cannot rewind web transcript: message journal is not durable or consistent.');
  }
  return hydrateMessages(loadDisplayMessages(id));
}

export function projectJournalMessages(messages: readonly JournalMessage[]): LedgerPayload[] {
  const records: LedgerPayload[] = [];
  const tools = new Map<string, string>();
  let turn = false;
  for (const message of messages) {
    if (message.role === 'user' && !hasToolResultBlock(message.content)) {
      if (turn) records.push({ kind: 'done' });
      turn = true;
      const text = messageText(message.content, '\n') || message.content.map((b) => `[${b.type}]`).join(' ');
      records.push({ kind: 'user', text: clip(text, MAX_TEXT_LEN) });
      continue;
    }
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          if (message.role === 'assistant') records.push({ kind: 'assistant', text: clip(block.text, MAX_TEXT_LEN) });
          break;
        case 'thinking':
          records.push({ kind: 'thinking', text: clip(block.thinking, MAX_TEXT_LEN) });
          break;
        case 'tool_use':
          tools.set(block.id, block.name);
          records.push({ kind: 'tool', toolName: block.name, toolUseId: block.id, input: clip(JSON.stringify(block.input) ?? '', MAX_TOOL_INPUT_LEN) });
          break;
        case 'tool_result': {
          const content = clip(block.content.map((p) => p.type === 'text' ? p.text : `[${p.type}]`).join('\n'), MAX_TOOL_INPUT_LEN);
          const toolName = tools.get(block.toolUseId);
          records.push(block.isError
            ? { kind: 'tool_error', content, ...(toolName ? { toolName } : {}) }
            : { kind: 'tool_result', toolUseId: block.toolUseId, content, ...(toolName ? { toolName } : {}) });
          break;
        }
      }
    }
  }
  // Journals contain no billing/duration metadata. Do not fabricate it.
  if (turn) records.push({ kind: 'done' });
  return records;
}
