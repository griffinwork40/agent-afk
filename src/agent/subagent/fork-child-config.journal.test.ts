/**
 * assembleChildConfig × message journal: a fork journals ONLY to the parent's
 * per-subagent journal (`sessions/<parentId>/subagents/<id>.jsonl`), never to
 * the parent's own file, even when the caller's config carries a journal.
 */
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';

vi.mock('../providers/shared/soft-deadline.js', () => ({
  resolveSoftDeadlineMs: vi.fn().mockReturnValue(0),
}));

import { assembleChildConfig, type AssembleChildConfigArgs } from './fork-child-config.js';
import { createMessageJournal, loadJournalMessages, type MessageJournal } from '../journal/index.js';
import { useTmpAfkHome, user } from '../journal/__test-utils__/helpers.js';
import { getSessionJournalPath, getSubagentJournalPath } from '../../paths.js';

useTmpAfkHome();

function makeArgs(parentJournal: MessageJournal | undefined, config: AssembleChildConfigArgs<unknown>['options']['config'] = {}): AssembleChildConfigArgs<unknown> {
  return {
    options: {
      parent: { sessionId: 'parent-sess', ...(parentJournal ? { messageJournal: parentJournal } : {}) },
      config,
      agentType: 'test-agent',
    },
    id: 'child-7',
    resume: 'parent-sess',
    registry: undefined,
    effectiveChildModel: 'claude-sonnet-5',
    effectiveTimeoutMs: 30_000,
    inheritedReadRoots: undefined,
    composedWriteRoots: undefined,
    childController: new AbortController(),
    parentCwd: undefined,
    parentApiKey: undefined,
    parentBaseUrl: undefined,
    parentProvider: undefined,
    parentTraceWriter: undefined,
    parentSurface: undefined,
    parentCanUseTool: undefined,
  };
}

describe('assembleChildConfig message journal', () => {
  it('gives the child parent.forSubagent(id), writing subagents/<id>.jsonl', async () => {
    const parent = createMessageJournal({ getSessionId: () => 'parent-sess' });
    const config = assembleChildConfig(makeArgs(parent));
    expect(config.messageJournal).toBeDefined();
    expect(config.messageJournal).not.toBe(parent);
    expect(config.messageJournal).toBe(parent.forSubagent('child-7'));

    config.messageJournal!.append(0, user('child task'));
    await config.messageJournal!.close();
    await parent.close();
    expect(fs.existsSync(getSubagentJournalPath('parent-sess', 'child-7'))).toBe(true);
    expect(fs.existsSync(getSessionJournalPath('parent-sess'))).toBe(false);
    expect(loadJournalMessages('parent-sess', { subagentId: 'child-7' })).toEqual([user('child task')]);
  });

  it('never inherits the parent journal through options.config, and clears resumeMessages', () => {
    const parent = createMessageJournal({ getSessionId: () => 'parent-sess' });
    const config = assembleChildConfig(
      makeArgs(parent, { messageJournal: parent, resumeMessages: [user('parent history')] }),
    );
    expect(config.messageJournal).not.toBe(parent);
    expect(config.messageJournal).toBe(parent.forSubagent('child-7'));
    expect(config.resumeMessages).toBeUndefined();
  });

  it('leaves the child unjournaled when the parent has no journal (stub parents)', () => {
    const leaked = createMessageJournal({ getSessionId: () => 'parent-sess' });
    const config = assembleChildConfig(makeArgs(undefined, { messageJournal: leaked }));
    expect(config.messageJournal).toBeUndefined();
  });
});
