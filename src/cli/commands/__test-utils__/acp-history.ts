import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { JournalMessage, JournalRecord } from '../../../agent/journal/types.js';
import { getSessionJournalPath } from '../../../paths.js';
import { persistedId } from './acp-scripts.js';

/** Real on-disk journal, not a mock of A4's load or replay exports. `journalId` defaults to the fixture id. */
export function seedHistory(root: string, journalId: string = persistedId): void {
  const messages: JournalMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'Read a.txt' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'read_file',
      input: { file_path: path.join(root, 'a.txt'), offset: 1 } }] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tool-1',
      content: [{ type: 'text', text: 'old\n' }], isError: false }] },
    { role: 'assistant', content: [{ type: 'text', text: 'The file says old.' }] },
  ];
  const records: JournalRecord[] = [
    { v: 1, ts: 1, kind: 'meta', sessionId: journalId, writerId: 'acp-golden-history',
      cwd: root, model: 'claude-sonnet-4-5', provider: 'anthropic-direct' },
    ...messages.map((message, index): JournalRecord => ({ v: 1, ts: index + 2,
      kind: 'append', index, message })),
  ];
  const filename = getSessionJournalPath(journalId);
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, records.map(record => JSON.stringify(record)).join('\n') + '\n');
}
