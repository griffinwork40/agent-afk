import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  groupTurns,
  humanText,
  loadReplayTurns,
  replayJournal,
  renderReplayTurns,
  splitRounds,
  turnEvents,
  type ReplayTurn,
} from './turn-record-renderer.replay.journal.js';
import { printResumeBanner, type CompletionWriter } from './shared.js';
import { createMessageJournal, JournalSync, type JournalAdapter, type JournalMessage } from '../../../agent/journal/index.js';
import { assistant, toolResult, useTmpAfkHome, user } from '../../../agent/journal/__test-utils__/helpers.js';
import type { SessionStats, TurnRecord } from '../../slash/types.js';

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
const toolUse = (id: string, command = 'ls'): JournalMessage => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name: 'bash', input: { command } }],
});

describe('humanText', () => {
  it('prefers the longest sidecar hint that the journal text ends with', () => {
    const m = user('[placeholder-prevent] harness stuff\n[bridge: ctx]\nRead any referenced file...\nwhy does fork lose content?');
    expect(humanText(m, new Set(['content?', 'why does fork lose content?'])).text).toBe('why does fork lose content?');
  });

  it('only matches a hint on a line boundary (a "." turn must not claim every sentence)', () => {
    expect(humanText(user('please review this skill.'), new Set(['.'])).text).toBe('please review this skill.');
    expect(humanText(user('.'), new Set(['.'])).text).toBe('.');
  });

  it('peels bracket preambles without hints', () => {
    const m = user('[skill-routing: active]\n- route things\n\nactual question here');
    expect(humanText(m).text).toBe('actual question here');
  });

  it('collapses a skill breadcrumb to /name args and drops system reminders', () => {
    const m = user('<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>2523</command-args>');
    expect(humanText(m).text).toBe('/review 2523');
    expect(humanText(user('<system-reminder>\nmanifest\n</system-reminder>\nplain ask')).text).toBe('plain ask');
    const wrapped = user(
      '[placeholder-prevent] x\nRead any referenced file for deeper context before acting — these are pointers, not full content.\n\n' +
        '<command-name>/forge</command-name>\n<command-message>forge</command-message>\n<command-args></command-args>Use the `skill` tool to dispatch this skill.',
    );
    expect(humanText(wrapped).text).toBe('/forge');
  });

  it('turns a background subagent delivery into a note, and annotates images', () => {
    expect(humanText(user('<background-subagent-result jobId="j1" status="completed">x</background-subagent-result>'))).toEqual({
      text: '',
      note: 'background subagent result delivered',
    });
    const withImage: JournalMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'look' }, { type: 'image', source: { kind: 'url', url: 'https://x/y.png' } }],
    };
    expect(humanText(withImage).text).toBe('look [1 image attached]');
  });
});

describe('groupTurns / splitRounds / turnEvents', () => {
  const convo: JournalMessage[] = [
    user('q1'),
    toolUse('t1'),
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: [{ type: 'text', text: 'out' }] }, { type: 'text', text: 'injected ctx' }] },
    assistant('answer 1'),
    user('q2'),
    assistant('answer 2'),
  ];

  it('opens a turn per human message; tool_result carriers (and their text) stay in the turn', () => {
    const turns = groupTurns(convo);
    expect(turns.map((t) => t.user)).toEqual(['q1', 'q2']);
    expect(turns[0]!.body).toHaveLength(3);
  });

  it('puts leading non-human messages in a headless turn', () => {
    expect(groupTurns([assistant('hi')])).toEqual([{ user: '', body: [assistant('hi')] }]);
  });

  it('splits a body into model rounds at each assistant message', () => {
    const body = groupTurns(convo)[0]!.body;
    expect(splitRounds(body).map((r) => r.length)).toEqual([2, 1]);
  });

  it('emits the live event shapes, paragraph-separating consecutive text', () => {
    const events = turnEvents([toolUse('t1', 'pwd'), toolResult('t1', 'boom'), assistant('one'), assistant('two')]);
    expect(events).toEqual([
      { type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: 't1', toolName: 'bash', toolInput: '{"command":"pwd"}' } },
      { type: 'chunk', chunk: { type: 'tool_result', toolUseId: 't1', content: 'boom' } },
      { type: 'chunk', chunk: { type: 'content', content: 'one' } },
      { type: 'chunk', chunk: { type: 'content', content: '\n\ntwo' } },
      { type: 'done' },
    ]);
  });

  it('strips CSI and OSC sequences from assistant text in turnEvents', () => {
    // \x1b[2J is a clear-screen CSI; \x1b]0;evil\x07 is an OSC title-set.
    const events = turnEvents([assistant('safe \x1b[2J text \x1b]0;evil\x07 end')]);
    const contentChunks = events.filter(
      (e): e is Extract<typeof events[number], { type: 'chunk' }> =>
        e.type === 'chunk' && e.chunk.type === 'content',
    );
    expect(contentChunks.length).toBe(1);
    const content = contentChunks[0]!.chunk.type === 'content' ? contentChunks[0]!.chunk.content : '';
    expect(content).not.toMatch(/\x1b/);
    expect(content).toContain('safe');
    expect(content).toContain('end');
  });

  it('strips assistant text that reduces to empty after escape stripping (no empty content chunk)', () => {
    // A message that is ONLY a clear-screen escape should not produce a content event.
    const events = turnEvents([assistant('\x1b[2J')]);
    const contentChunks = events.filter((e) => e.type === 'chunk' && e.chunk.type === 'content');
    expect(contentChunks).toHaveLength(0);
  });

  it('fix#1: escape-only block after a text block does not produce a blank-paragraph chunk', () => {
    // lastWasText=true (from 'real text') then an escape-only block: the old
    // code prepended '\\n\\n' before stripping, so safeText === '\\n\\n' passed
    // the length>0 guard and emitted a content chunk of just two newlines.
    const events = turnEvents([assistant('real text'), assistant('\x1b[2J')]);
    const contentChunks = events.filter((e) => e.type === 'chunk' && e.chunk.type === 'content');
    // Only the 'real text' chunk — no trailing blank-paragraph chunk.
    expect(contentChunks).toHaveLength(1);
    const only = contentChunks[0]!;
    expect(only.type === 'chunk' && only.chunk.type === 'content' ? only.chunk.content : '').toBe('real text');
  });
});

describe('replayJournal / printResumeBanner (real journal on disk)', () => {
  useTmpAfkHome();
  const identity: JournalAdapter<JournalMessage> = { toJournal: (m) => m, fromJournalMessages: (ms) => ms };

  async function writeJournal(sessionId: string, messages: JournalMessage[]): Promise<void> {
    const j = createMessageJournal({ getSessionId: () => sessionId });
    new JournalSync(j, identity).sync(messages);
    await j.close();
  }

  function stats(sessionId: string | undefined, turns: TurnRecord[]): SessionStats {
    return {
      totalTurns: turns.length,
      totalCostUsd: 0,
      totalTokens: 0,
      totalDurationMs: 0,
      sessionStartTime: 0,
      turnCosts: [],
      turnTokens: [],
      turns,
      model: 'sonnet',
      permissionMode: 'default',
      ...(sessionId !== undefined ? { sessionId } : {}),
    } as SessionStats;
  }

  it('returns null (caller falls back) when there is no journal or no session id', async () => {
    const lines: string[] = [];
    expect(await replayJournal('missing', { fn: (l) => lines.push(l) })).toBeNull();
    expect(await replayJournal(undefined, { fn: (l) => lines.push(l) })).toBeNull();
    expect(loadReplayTurns('missing')).toBeNull();
    expect(lines).toEqual([]);
  });

  it('renders full markdown text and tool output through the live renderer', async () => {
    const long = 'x'.repeat(2500);
    await writeJournal('s1', [
      user('[placeholder-prevent] preamble\nshow me'),
      toolUse('t1', 'echo hi'),
      toolResult('t1', 'hi from tool'),
      assistant(`# Heading\n\nsome **bold** text ${long} END-MARKER`),
    ]);
    const lines: string[] = [];
    const n = await replayJournal('s1', { fn: (l) => lines.push(l) }, { hints: ['show me'] });
    const out = stripAnsi(lines.join('\n'));
    expect(n).toBe(1);
    expect(out).toContain('show me');
    expect(out).not.toContain('placeholder-prevent');
    expect(out).toContain('Heading');
    expect(out).not.toContain('**bold**');
    expect(out).toContain('END-MARKER'); // no 2000-char truncation
    expect(out).toContain('bash');
    expect(out.indexOf('bash')).toBeLessThan(out.indexOf('Heading')); // tools stay in live order
  });

  it('honors maxTurns with an omitted-turns notice', async () => {
    await writeJournal('s2', [user('one'), assistant('a'), user('two'), assistant('b'), user('three'), assistant('c')]);
    const lines: string[] = [];
    expect(await replayJournal('s2', { fn: (l) => lines.push(l) }, { maxTurns: 1 })).toBe(1);
    const out = stripAnsi(lines.join('\n'));
    expect(out).toContain('2 earlier turns omitted');
    expect(out).toContain('three');
    expect(out).not.toContain('one');
  });

  it('printResumeBanner prefers the journal and counts journal turns', async () => {
    await writeJournal('s3', [user('from journal'), assistant('journal answer')]);
    const lines: string[] = [];
    const writer: CompletionWriter = { fn: (l: string) => lines.push(l) } as CompletionWriter;
    await printResumeBanner(stats('s3', [{ user: 'from journal', assistant: 'sidecar answer', timestamp: 0 }]), writer);
    const out = stripAnsi(lines.join('\n'));
    expect(out).toContain('Resuming session (1 turn)');
    expect(out).toContain('journal answer');
    expect(out).not.toContain('sidecar answer');
    expect(out).toContain('End of history');
  });

  it('printResumeBanner falls back to the sidecar replay without a journal', async () => {
    const lines: string[] = [];
    const writer: CompletionWriter = { fn: (l: string) => lines.push(l) } as CompletionWriter;
    await printResumeBanner(stats('no-journal', [{ user: 'q', assistant: 'sidecar answer', timestamp: 0 }]), writer);
    expect(stripAnsi(lines.join('\n'))).toContain('sidecar answer');
  });

  it('does not pass CSI/OSC sequences in user text or assistant text to the terminal', async () => {
    // The injected sequences are the ones the spec calls out: clear-screen CSI
    // and OSC title-set. Palette/prompt styling may legitimately emit SGR
    // codes (e.g. \x1b[0m), so we check for the *specific* injected patterns
    // rather than all ESC bytes.
    const injectedUser = 'hello \x1b[2J world \x1b]0;evil\x07';
    const injectedAssistant = 'assistant reply \x1b[2J done \x1b]0;pwned\x07';
    await writeJournal('s-escape', [user(injectedUser), assistant(injectedAssistant)]);
    const lines: string[] = [];
    await replayJournal('s-escape', { fn: (l) => lines.push(l) });
    const out = lines.join('\n');
    // The specific injected clear-screen and OSC sequences must not appear.
    expect(out).not.toContain('\x1b[2J');
    expect(out).not.toContain('\x1b]0;');
    // Human-readable content should survive (possibly reformatted by markdown renderer).
    expect(out).toMatch(/hello/);
  });
});

describe('renderReplayTurns (unit — no disk I/O)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('fix#2: returns the count actually rendered when a mid-render failure stops early', async () => {
    // Build three turns; the second one will throw during renderTurn.
    const makeTurn = (u: string): ReplayTurn => ({ user: u, body: [] });
    const turns: ReplayTurn[] = [makeTurn('one'), makeTurn('THROW'), makeTurn('three')];
    const lines: string[] = [];

    // Patch renderRound (called inside renderTurn for each round) to throw on
    // the second turn. Because the body is empty, renderRound is never called
    // and we instead throw directly in renderTurn via the WriterSink when the
    // user echo fires. We trigger on content so the test stays stable even if
    // emit counts change: the user-echo for the 'THROW' turn will include the
    // text 'THROW', making the trigger content-based rather than positional.
    const throwingSink = {
      fn: (l: string) => {
        if (l.includes('THROW')) throw new Error('simulated mid-render failure');
        lines.push(l);
      },
    };

    const rendered = await renderReplayTurns(turns, throwingSink);
    // Only 1 turn completed before the throw; the catch path fires for turn 2.
    expect(rendered).toBe(1);
    // The incomplete-replay notice should have been emitted.
    expect(stripAnsi(lines.join('\n'))).toContain('history replay incomplete');
  });

  it('fix#3: formatSubmittedEcho always uses isTTY:false regardless of process.stdout.isTTY', async () => {
    // Simulate a TTY stdout — the old code read process.stdout.isTTY live,
    // which would produce right-aligned output inconsistent with forceNonTty.
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      const turn: ReplayTurn = { user: 'hello from user', body: [] };
      const lines: string[] = [];
      await renderReplayTurns([turn], { fn: (l: string) => lines.push(l) });
      const out = stripAnsi(lines.join('\n'));
      // Non-TTY echo: promptText + buffer verbatim, no right-alignment padding.
      // The line must contain the user text without any leading space padding
      // that the TTY right-align path would produce.
      expect(out).toContain('hello from user');
      // TTY path would right-pad with spaces; non-TTY path produces zero leading spaces.
      // The non-TTY echo is "promptText + buffer" with no right-alignment padding.
      const echoLine = lines.find((l) => stripAnsi(l).includes('hello from user')) ?? '';
      // Non-TTY produces "promptText + buffer" verbatim — no leading whitespace at all.
      // Asserting toBe(0) proves the non-TTY path was taken, not just that fewer
      // than 10 spaces appear (which a TTY path could also satisfy).
      const leadingSpaces = (stripAnsi(echoLine).match(/^(\s*)/) ?? ['', ''])[1]!.length;
      expect(leadingSpaces).toBe(0);
    } finally {
      if (originalIsTTY !== undefined) {
        Object.defineProperty(process.stdout, 'isTTY', originalIsTTY);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (process.stdout as any).isTTY;
      }
    }
  });
});
