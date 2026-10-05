/**
 * Unit tests for src/agent/outcomes/journal-turns.ts
 *
 * All tests use hand-built JournalMessage[] fixtures — no I/O, no FS access.
 */

import { describe, it, expect } from 'vitest';
import { journalMessagesToTurns } from './journal-turns.js';
import type { JournalMessage, JournalResultPart } from '../journal/types.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function userText(text: string): JournalMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistantText(text: string): JournalMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function toolUse(id: string, name: string, input: unknown): JournalMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'tool_use', id, name, input },
    ],
  };
}

function assistantWithTool(text: string, id: string, name: string, input: unknown): JournalMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text },
      { type: 'tool_use', id, name, input },
    ],
  };
}

function toolResult(toolUseId: string, text: string, isError?: boolean): JournalMessage {
  const parts: JournalResultPart[] = [{ type: 'text', text }];
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        toolUseId,
        content: parts,
        ...(isError !== undefined ? { isError } : {}),
      },
    ],
  };
}

function mixedUser(text: string, toolUseId: string, resultText: string): JournalMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'tool_result', toolUseId, content: [{ type: 'text', text: resultText }] },
    ],
  };
}

// ---------------------------------------------------------------------------
// Basic tool_use / tool_result pairing
// ---------------------------------------------------------------------------

describe('journalMessagesToTurns — basic pairing', () => {
  it('pairs a tool_use with its tool_result into one turn', () => {
    const messages: JournalMessage[] = [
      userText('run a command'),
      toolUse('tu-1', 'bash', { command: 'echo hello' }),
      toolResult('tu-1', 'hello'),
    ];
    const turns = journalMessagesToTurns(messages);

    expect(turns).toHaveLength(2);
    // turn 0: user message
    expect(turns[0]!.user).toBe('run a command');
    // turn 1: assistant with tool event
    const te = turns[1]!.toolEvents?.[0];
    expect(te).toBeDefined();
    expect(te!.toolName).toBe('bash');
    expect(te!.input).toContain('echo hello');
    expect(te!.result).toBe('hello');
    expect(te!.isError).toBe(false);
  });

  it('handles an assistant with text + tool_use', () => {
    const messages: JournalMessage[] = [
      userText('do stuff'),
      assistantWithTool("I'll run edit_file", 'tu-2', 'edit_file', {
        file_path: '/foo.ts',
        old_string: 'a',
        new_string: 'b',
      }),
      toolResult('tu-2', 'ok'),
    ];
    const turns = journalMessagesToTurns(messages);
    expect(turns).toHaveLength(2);
    const turn1 = turns[1]!;
    expect(turn1.assistant).toContain("I'll run edit_file");
    expect(turn1.toolEvents?.[0]?.toolName).toBe('edit_file');
    expect(turn1.toolEvents?.[0]?.result).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// isError: true and absent → false
// ---------------------------------------------------------------------------

describe('journalMessagesToTurns — isError mapping', () => {
  it('maps isError:true from journal to isError:true on ToolEvent', () => {
    const messages: JournalMessage[] = [
      userText('do a thing'),
      toolUse('tu-e1', 'bash', { command: 'git commit' }),
      toolResult('tu-e1', 'error: nothing to commit', true),
    ];
    const turns = journalMessagesToTurns(messages);
    expect(turns[1]!.toolEvents?.[0]?.isError).toBe(true);
  });

  it('maps absent isError (journal only writes it when true) to isError:false', () => {
    // No isError field in the tool_result block — journal writer omits it
    const messages: JournalMessage[] = [
      userText('do a thing'),
      toolUse('tu-e2', 'bash', { command: 'echo ok' }),
      toolResult('tu-e2', 'ok'), // no isError field
    ];
    const turns = journalMessagesToTurns(messages);
    const te = turns[1]!.toolEvents?.[0];
    // isError must be explicitly false, not undefined
    expect(te!.isError).toBe(false);
    expect(te!.isError).not.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resultTail: produced and redacted
// ---------------------------------------------------------------------------

describe('journalMessagesToTurns — resultTail', () => {
  it('produces resultTail for pnpm test output', () => {
    const longOutput = 'x'.repeat(300) + '\nTests  10 passed (10)';
    const messages: JournalMessage[] = [
      userText('run tests'),
      toolUse('tu-rt1', 'bash', { command: 'pnpm test' }),
      toolResult('tu-rt1', longOutput),
    ];
    const turns = journalMessagesToTurns(messages);
    const te = turns[1]!.toolEvents?.[0];
    expect(te!.resultTail).toBeDefined();
    expect(te!.resultTail!.length).toBeLessThanOrEqual(240);
    expect(te!.resultTail).toContain('Tests  10 passed');
  });

  it('produces resultTail for test_run tool', () => {
    const messages: JournalMessage[] = [
      userText('run tests'),
      toolUse('tu-rt2', 'test_run', { file: 'src/foo.test.ts' }),
      toolResult('tu-rt2', '1 failed | 9 passed'),
    ];
    const turns = journalMessagesToTurns(messages);
    const te = turns[1]!.toolEvents?.[0];
    expect(te!.resultTail).toBeDefined();
    expect(te!.resultTail).toContain('1 failed');
  });

  it('does NOT produce resultTail for non-verification commands', () => {
    const messages: JournalMessage[] = [
      userText('list files'),
      toolUse('tu-rt3', 'bash', { command: 'ls -la' }),
      toolResult('tu-rt3', 'file1.ts\nfile2.ts'),
    ];
    const turns = journalMessagesToTurns(messages);
    const te = turns[1]!.toolEvents?.[0];
    expect(te!.resultTail).toBeUndefined();
  });

  it('redacts secrets in resultTail', () => {
    const secretToken = 'sk-ant-' + 'A'.repeat(30);
    const output = `pnpm test\n${secretToken}\nTests  5 passed (5)`;
    const messages: JournalMessage[] = [
      userText('run tests'),
      toolUse('tu-rt4', 'bash', { command: 'pnpm test' }),
      toolResult('tu-rt4', output),
    ];
    const turns = journalMessagesToTurns(messages);
    const te = turns[1]!.toolEvents?.[0];
    expect(te!.resultTail).toBeDefined();
    expect(te!.resultTail).not.toContain(secretToken);
    expect(te!.resultTail).toContain('[REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// Multi-turn boundaries
// ---------------------------------------------------------------------------

describe('journalMessagesToTurns — multi-turn boundaries', () => {
  it('produces the correct number of turns for a multi-round session', () => {
    // Turn boundary rule: each user message AND each assistant message starts
    // a new turn. A 4-message session produces 4 turns (not 3) because the
    // second user message and second assistant message are processed separately.
    const messages: JournalMessage[] = [
      userText('first prompt'),
      assistantText('first reply'),
      userText('second prompt'),
      assistantText('second reply'),
    ];
    const turns = journalMessagesToTurns(messages);
    expect(turns).toHaveLength(4);
    expect(turns[0]!.user).toBe('first prompt');
    expect(turns[1]!.assistant).toBe('first reply');
    expect(turns[2]!.user).toBe('second prompt');
    expect(turns[3]!.assistant).toBe('second reply');
  });

  it('creates separate turns for two successive assistant messages', () => {
    const messages: JournalMessage[] = [
      userText('go'),
      assistantText('step one'),
      assistantText('step two'),
    ];
    const turns = journalMessagesToTurns(messages);
    expect(turns).toHaveLength(3);
    expect(turns[1]!.assistant).toBe('step one');
    expect(turns[2]!.assistant).toBe('step two');
  });
});

// ---------------------------------------------------------------------------
// Pure tool_result user messages do NOT start new turns
// ---------------------------------------------------------------------------

describe('journalMessagesToTurns — pure tool-result user messages', () => {
  it('does not start a new turn for a pure-tool-result user message', () => {
    const messages: JournalMessage[] = [
      userText('do stuff'),
      toolUse('tu-p1', 'bash', { command: 'echo 1' }),
      toolResult('tu-p1', 'out1'), // pure tool result — no new turn
    ];
    const turns = journalMessagesToTurns(messages);
    // Expected: turn0 = {user:'do stuff'}, turn1 = {toolEvents:[...]}
    expect(turns).toHaveLength(2);
    // The tool result belongs to the assistant turn, not a new user turn
    const te = turns[1]!.toolEvents?.[0];
    expect(te!.result).toBe('out1');
  });

  it('handles multiple tool_results in a single pure-tool-result user message', () => {
    const messages: JournalMessage[] = [
      userText('do parallel things'),
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu-a', name: 'bash', input: { command: 'echo a' } },
          { type: 'tool_use', id: 'tu-b', name: 'bash', input: { command: 'echo b' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'tu-a', content: [{ type: 'text', text: 'out-a' }] },
          { type: 'tool_result', toolUseId: 'tu-b', content: [{ type: 'text', text: 'out-b' }] },
        ],
      },
    ];
    const turns = journalMessagesToTurns(messages);
    expect(turns).toHaveLength(2);
    const toolEvents = turns[1]!.toolEvents ?? [];
    expect(toolEvents).toHaveLength(2);
    const results = toolEvents.map((te) => te.result);
    expect(results).toContain('out-a');
    expect(results).toContain('out-b');
  });
});

// ---------------------------------------------------------------------------
// Preamble stripping on first user message
// ---------------------------------------------------------------------------

describe('journalMessagesToTurns — preamble stripping', () => {
  it('strips injected preamble from the first user message', () => {
    const preamble =
      '[placeholder-prevent] When including shell commands, resolve placeholders.\n' +
      '[memory: 2 patterns]\n' +
      '1. some pattern\n' +
      '[bridge: prior context]\n' +
      'Recent commits: abc123 chore: do stuff\n' +
      'Read any referenced file for deeper context before acting — these are pointers, not full content.\n' +
      '\n' +
      'fix the login bug';
    const messages: JournalMessage[] = [
      userText(preamble),
      assistantText('done'),
    ];
    const turns = journalMessagesToTurns(messages);
    // First turn's user field should be stripped to just the real prompt
    expect(turns[0]!.user).toBe('fix the login bug');
  });

  it('does not strip plain user messages', () => {
    const messages: JournalMessage[] = [
      userText('what is the capital of France?'),
      assistantText('Paris'),
    ];
    const turns = journalMessagesToTurns(messages);
    expect(turns[0]!.user).toBe('what is the capital of France?');
  });

  it('keeps the raw text when extractUserContent returns undefined (no bridge marker)', () => {
    // Pure boilerplate with no bridge marker or XML tag: extractUserContent
    // returns undefined (no content to extract), so we fall back to the raw
    // text. The LFs can handle this gracefully — first_prompt will be empty
    // after trim() only if the raw text is truly empty.
    const boilerplate = '[skill-routing: active]';
    const messages: JournalMessage[] = [
      userText(boilerplate),
      assistantText('ok'),
    ];
    const turns = journalMessagesToTurns(messages);
    // No bridge marker → extractUserContent returns undefined → raw text preserved
    expect(turns[0]!.user).toBe('[skill-routing: active]');
  });
});

// ---------------------------------------------------------------------------
// Unmatched tool_use (no corresponding tool_result)
// ---------------------------------------------------------------------------

describe('journalMessagesToTurns — unmatched tool_use', () => {
  it('creates a ToolEvent with no result when tool_result is absent', () => {
    const messages: JournalMessage[] = [
      userText('do a thing'),
      toolUse('tu-unmatched', 'write_file', { file_path: '/out.ts' }),
      // No matching tool_result message follows
    ];
    const turns = journalMessagesToTurns(messages);
    expect(turns).toHaveLength(2);
    const te = turns[1]!.toolEvents?.[0];
    expect(te).toBeDefined();
    expect(te!.toolName).toBe('write_file');
    // result should be absent (undefined), not an empty string
    expect(te!.result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Spilled / blob content fallback
// ---------------------------------------------------------------------------

describe('journalMessagesToTurns — spilled/blob content', () => {
  it('handles text_ref parts gracefully (preview text used as result)', () => {
    // Simulate a tool_result where content uses a text_ref (spilled blob).
    // After hydration, a text_ref becomes either a text block (blob found)
    // or a stand-in text block with the preview (blob missing). This test
    // simulates the blob-missing stand-in.
    const standInText = '[journal: spilled text blobs/abc.txt is missing; preview follows]\nTest output preview';
    const messages: JournalMessage[] = [
      userText('run tests'),
      toolUse('tu-blob', 'bash', { command: 'pnpm test' }),
      // Already-hydrated message: the text_ref was resolved to a text block
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'tu-blob',
            content: [{ type: 'text', text: standInText }],
          },
        ],
      },
    ];
    const turns = journalMessagesToTurns(messages);
    const te = turns[1]!.toolEvents?.[0];
    expect(te!.result).toContain('preview follows');
    // isError absent → false
    expect(te!.isError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge cases: empty messages array
// ---------------------------------------------------------------------------

describe('journalMessagesToTurns — edge cases', () => {
  it('returns [] for an empty messages array', () => {
    expect(journalMessagesToTurns([])).toEqual([]);
  });

  it('handles a session that starts with an assistant message', () => {
    const messages: JournalMessage[] = [
      assistantText('hello'),
    ];
    const turns = journalMessagesToTurns(messages);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.assistant).toBe('hello');
  });
});

describe('journalMessagesToTurns — harness text alongside tool results', () => {
  it('does not start a turn for a user message carrying tool_result + appended text', () => {
    const messages: JournalMessage[] = [
      userText('fix the bug'),
      toolUse('tu-1', 'bash', { command: 'pnpm test' }),
      // Harness-appended text riding along with the tool result (hook nudge,
      // framework context). Starts with "No" to prove it cannot reach the
      // in_session_correction keyword match as a user turn.
      mixedUser('No handler available. [framework-generated context]', 'tu-1', 'ok'),
      assistantText('**Done**'),
    ];
    const turns = journalMessagesToTurns(messages);

    const userTurns = turns.filter((t) => t.user !== undefined);
    expect(userTurns).toHaveLength(1);
    expect(userTurns[0]!.user).toBe('fix the bug');
    // The result was still attached to its tool event.
    const ev = turns.flatMap((t) => t.toolEvents ?? []).find((e) => e.toolName === 'bash');
    expect(ev?.result).toBe('ok');
    expect(ev?.isError).toBe(false);
  });
});

describe('journalMessagesToTurns — sidecar input parity', () => {
  it('builds ToolEvent.input with the providers\' summarizeToolInput', async () => {
    const { summarizeToolInput } = await import('../providers/shared/tool-input-summary.js');
    const bashInput = { command: 'git commit -F /tmp/msg.txt' };
    const editInput = { file_path: '/repo/src/a.ts', old_string: 'x', new_string: 'y' };
    const turns = journalMessagesToTurns([
      userText('go'),
      toolUse('tu-1', 'bash', bashInput),
      toolResult('tu-1', '[main abc1234] msg'),
      toolUse('tu-2', 'edit_file', editInput),
      toolResult('tu-2', 'edited'),
    ]);
    const events = turns.flatMap((t) => t.toolEvents ?? []);
    expect(events[0]!.input).toBe(summarizeToolInput('bash', bashInput));
    expect(events[1]!.input).toBe(summarizeToolInput('edit_file', editInput));
  });
});
