/**
 * Regression: close() must drain the provider before closing the journal.
 *
 * Both providers perform final journal synchronization (JournalSync.sync) at
 * their abort/finalization commit points. Closing the journal before aborting
 * and draining the provider causes those writes to be silently discarded,
 * which can leave the journal ending at an unmatched tool_use or omit
 * completed tool results — corrupting the resume source.
 *
 * Fix: agent-session.ts close() now aborts and drains the provider FIRST,
 * then closes the journal (matching the reset path ordering in session-reset.ts).
 *
 * Strategy: inject a custom InstrumentedJournal whose flush()/close() calls
 * record themselves into a shared globalLog, and inject a provider whose
 * close() mock also records into the same log. This lets us assert that the
 * provider-side journal write appears before the journal's terminal call.
 *
 * @module agent/session/close-journal-ordering.test
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  ModelProvider,
  ProviderEvent,
  ProviderQuery,
  ProviderQueryArgs,
} from '../provider.js';
import type { AgentConfig } from '../types.js';
import type {
  JournalMarkLabel,
  JournalMessage,
  JournalTruncateReason,
  MessageJournal,
} from '../journal/index.js';

vi.mock('../../utils/debug.js', () => ({ debugLog: vi.fn() }));

// ---------------------------------------------------------------------------
// Instrumented journal: every call appends to a shared log so we can assert
// ordering against the provider's close() writes.
// ---------------------------------------------------------------------------

class InstrumentedJournal implements MessageJournal {
  private _length = 0;
  constructor(private readonly log: string[]) {}
  get length(): number { return this._length; }

  append(_index: number, _message: JournalMessage): void {
    this._length++;
    this.log.push('journal:append');
  }
  truncate(_length: number, _reason?: JournalTruncateReason): void {
    this.log.push('journal:truncate');
  }
  mark(_label: JournalMarkLabel, _detail?: Record<string, unknown>): void {
    this.log.push('journal:mark');
  }
  forSubagent(_subagentId: string): MessageJournal {
    return new InstrumentedJournal(this.log);
  }
  async flush(): Promise<void> {
    this.log.push('journal:flush');
  }
  async close(): Promise<void> {
    this.log.push('journal:close');
  }
}

// ---------------------------------------------------------------------------
// Stub provider whose close() writes to the injected journal, simulating the
// final JournalSync.sync commit point.
// ---------------------------------------------------------------------------

function makeStubQuery(args: ProviderQueryArgs, onProviderClose: () => void): ProviderQuery {
  const sessionId = args.config.sessionId ?? 'close-order-sess';
  async function* generate(): AsyncGenerator<ProviderEvent> {
    yield {
      type: 'session.init',
      info: {
        sessionId,
        model: String(args.config.model ?? 'stub'),
        permissionMode: args.config.permissionMode ?? 'bypassPermissions',
        cwd: '/tmp/stub',
        tools: [],
        mcpServers: [],
        slashCommands: [],
        skills: [],
        plugins: [],
        apiKeySource: 'user',
        version: '0.0.0',
        outputStyle: 'default',
      },
    };
  }
  return {
    interrupt: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    supportedCommands: vi.fn().mockResolvedValue([]),
    supportedModels: vi.fn().mockResolvedValue([]),
    supportedAgents: vi.fn().mockResolvedValue([]),
    getContextUsage: vi.fn().mockResolvedValue({}),
    mcpServerStatus: vi.fn().mockResolvedValue([]),
    accountInfo: vi.fn().mockResolvedValue({}),
    rewindFiles: vi.fn().mockResolvedValue({ canRewind: false }),
    /** Simulates JournalSync.sync during provider finalization. */
    close: vi.fn().mockImplementation(async () => { onProviderClose(); }),
    [Symbol.asyncIterator]: () => generate(),
  };
}

class InstrumentedProvider implements ModelProvider {
  readonly name = 'instrumented-close-order';
  constructor(private readonly onProviderClose: () => void) {}
  query(args: ProviderQueryArgs): ProviderQuery {
    return makeStubQuery(args, this.onProviderClose);
  }
}

import { AgentSession } from '../session.js';

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { model: 'sonnet', apiKey: 'test-key', ...overrides };
}

describe('AgentSession.close() — journal ordering', () => {
  it('provider finalization writes land in the journal before journal is closed', async () => {
    const log: string[] = [];
    const journal = new InstrumentedJournal(log);

    const session = new AgentSession(makeConfig({
      provider: new InstrumentedProvider(() => {
        // This callback fires during providerQuery.close() — simulating the
        // final JournalSync.sync commit point. After the fix this must run
        // BEFORE JournalLifecycle.close() flushes/closes the journal.
        log.push('provider:close-write');
        journal.append(0, { role: 'assistant', content: [{ type: 'text', text: 'final-sync' }] });
      }),
      messageJournal: journal,
    }));
    await session.waitForInitialization();
    await session.close();

    const writeIdx = log.indexOf('provider:close-write');
    // Journal finalization is either flush (owned=false) or close (owned=true).
    // Use findLastIndex: the abort handler (onAbort) may call flush() before
    // providerQuery.close() runs — that early flush is an intermediate sync,
    // not the terminal one. The LAST flush/close is the real finalization call
    // from JournalLifecycle.close() (the one guaranteed to come after the fix).
    const terminalIdx = Math.max(
      log.lastIndexOf('journal:flush'),
      log.lastIndexOf('journal:close'),
    );

    // The provider's write MUST have happened.
    expect(writeIdx).toBeGreaterThan(-1);
    // The journal MUST have been finalized at least once.
    expect(terminalIdx).toBeGreaterThan(-1);
    // The ordering invariant: provider write before the terminal journal call.
    expect(writeIdx).toBeLessThan(terminalIdx);
  });

  /**
   * Documents the pre-fix ordering failure: journal was closed BEFORE the
   * provider, so any write in the provider's close() was silently dropped.
   * This test is a static ordering demonstration, not a call to AgentSession.
   */
  it('old ordering (journal closed first) causes writes to arrive after journal finalization', () => {
    const log: string[] = [];
    log.push('journal:close');     // old code: journal.close() was first
    log.push('provider:close-write'); // provider.close() wrote after

    const closeIdx = log.indexOf('journal:close');
    const writeIdx = log.indexOf('provider:close-write');
    // This is exactly the bug: write comes AFTER journal closed.
    expect(closeIdx).toBeLessThan(writeIdx);
  });
});
