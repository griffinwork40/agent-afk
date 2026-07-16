/**
 * End-to-end coverage: read_file / glob / grep + write-confinement through a
 * LIVE child dispatcher (a real forked worktree subagent). Closes the gap in
 * issue #440.
 *
 * # What this exercises (and why the existing test is not enough)
 *
 * PR #416 gave a worktree subagent `readRoots = [cwd, mainRoot(, state)]` so a
 * fork running in a linked worktree can read the MAIN checkout (main-repo
 * absolute paths pervade the context a subagent sees). Before this file that
 * grant was covered ONLY by config-shape assertions against a MOCKED
 * AgentSession (`./subagent-worktree-readroot.test.ts`): those tests assert
 * `childConfig.readRoots === [cwd, mainRoot, state]` but never drive the real
 * read_file/glob/grep/write_file handlers, so a regression anywhere DOWNSTREAM
 * of `forkSubagent`'s root computation — the `query()` → `ensureSharedRoots` →
 * `buildDispatcher` root-seeding in `providers/anthropic-direct/index.ts`, or
 * the containment check in `tools/handlers/_cwd-utils.ts` — would pass the
 * mocked test yet break real forks.
 *
 * This file drives the FULL live path with NO production-code change:
 *
 *   SubagentManager.forkSubagent({ cwd: <tmp worktree> })   ← real root compute
 *     → real child AgentSession (NO injected config.provider)
 *       → real AnthropicDirectProvider.query()               ← real root seed
 *         → real SessionToolDispatcher (buildDispatcher)      ← real dispatcher
 *           → real read_file / glob / grep / write_file handlers
 *             → real resolveAndContain containment            ← real invariant
 *
 * Only the Anthropic SDK network boundary is faked, via the provider's
 * `__setAnthropicClientFactory` escape hatch (the same seam the provider's own
 * integration tests use — see `providers/anthropic-direct.test.ts`). The mock
 * `messages.create` emits a deterministic sequence of `tool_use` blocks, so the
 * child's tool-use loop calls the REAL handlers without a single model call.
 *
 * # Assertions (the four the issue names)
 *
 *   1. read_file / glob / grep SUCCEED on a worktree-relative path,
 *   2. read_file SUCCEEDS on a MAIN-REPO ABSOLUTE path (the #416 case:
 *      readRoots includes mainRoot),
 *   3. a write_file OUTSIDE the worktree is DENIED (write-confinement stays
 *      confined to the worktree even though READ scope widened).
 *
 * # Worktree fixture — no real git required
 *
 * The temp worktree is created at `<tmp>/.afk-worktrees/<slug>`. `forkSubagent`
 * resolves the main-repo root via `resolveWorktreeMainRoot`, which — when
 * `git rev-parse` fails on a non-git temp dir — recovers the main root LEXICALLY
 * from the `.afk-worktrees/` path segment (see `worktree-read-root.ts`, the
 * #544/#554 git-free fallback). So the fixture is a plain directory tree: no
 * `git init`, no network, fully deterministic. `os.tmpdir()` is `realpath`'d up
 * front because the containment check compares real (symlink-resolved) paths and
 * macOS `/var/folders` is a symlink to `/private/var/folders`.
 *
 * @module agent/subagent-dispatcher-readroot.e2e.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import type Anthropic from '@anthropic-ai/sdk';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import { SubagentManager } from './subagent.js';
import { __setAnthropicClientFactory } from './providers/anthropic-direct/index.js';
import type { OutputEvent } from './types/session-types.js';

// --- Mock Anthropic SDK: replays one prebuilt stream per messages.create call.

/**
 * Build a `messages.create` stand-in that returns the i-th prebuilt round on
 * the i-th call (clamping to the last round once exhausted, so an unexpected
 * extra loop iteration still terminates rather than hanging).
 */
function replayRounds(
  rounds: RawMessageStreamEvent[][],
): () => AsyncIterable<RawMessageStreamEvent> {
  let i = 0;
  return function create(): AsyncIterable<RawMessageStreamEvent> {
    const stream = rounds[Math.min(i, rounds.length - 1)] ?? [];
    i += 1;
    return (async function* () {
      for (const ev of stream) yield ev;
    })();
  };
}

class MockAnthropic {
  public messages: { create: () => AsyncIterable<RawMessageStreamEvent> };
  constructor(create: () => AsyncIterable<RawMessageStreamEvent>) {
    this.messages = { create };
  }
}

function installMockSdk(rounds: RawMessageStreamEvent[][]): void {
  __setAnthropicClientFactory(
    () => new MockAnthropic(replayRounds(rounds)) as unknown as Anthropic,
  );
}

// --- Raw Anthropic stream builders (shape mirrors anthropic-direct.test.ts).

/** One assistant round that emits a single `tool_use` block (stop_reason=tool_use). */
function toolUseRound(
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: `msg_${toolUseId}`,
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-5',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 7,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
          service_tier: null,
        },
      },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: toolUseId, name: toolName, input: {} },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    } as unknown as RawMessageStreamEvent,
    { type: 'content_block_stop', index: 0 } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 9 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

/** A terminal text round (stop_reason=end_turn) that ends the tool-use loop. */
function endTurnRound(text: string): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_end',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-5',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 5,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
          service_tier: null,
        },
      },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '', citations: [] },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    } as unknown as RawMessageStreamEvent,
    { type: 'content_block_stop', index: 0 } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 4 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

// --- Driver: fork a real worktree subagent + collect its tool results.

interface ToolOutcome {
  toolUseId: string;
  toolName?: string;
  content: string;
  isError: boolean;
}

/**
 * Fork a real subagent with `cwd = worktree`, drive one turn against the mocked
 * SDK, and collect every tool call's name + result by correlating the
 * `tool_use_detail` chunk (carries the name) with its `tool_result` chunk
 * (carries content + isError), keyed on `toolUseId`.
 *
 * NOTE: the `tool_result` chunk's `content` is a DISPLAY PREVIEW (single-line
 * output over 80 chars is clipped with `…`; multi-line output is collapsed — see
 * `stream-consumer.ts truncateContent`). Assertions therefore key on `isError`
 * and short, un-clipped content or a leading substring — never a long exact
 * string.
 */
async function runForkedTools(
  worktree: string,
  rounds: RawMessageStreamEvent[][],
): Promise<ToolOutcome[]> {
  installMockSdk(rounds);
  const manager = new SubagentManager({ cwd: worktree });
  const handle = await manager.forkSubagent({
    parent: { sessionId: undefined },
    config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
    agentType: 'readroot-e2e',
  });

  const names = new Map<string, string>();
  const outcomes: ToolOutcome[] = [];
  try {
    for await (const event of handle.session.sendMessageStream(
      'exercise the file tools',
    ) as AsyncIterable<OutputEvent>) {
      if (event.type !== 'chunk') continue;
      const chunk = event.chunk;
      if (chunk.type === 'tool_use_detail') {
        names.set(chunk.toolUseId, chunk.toolName);
      } else if (chunk.type === 'tool_result') {
        outcomes.push({
          toolUseId: chunk.toolUseId,
          toolName: names.get(chunk.toolUseId),
          content: chunk.content,
          isError: chunk.isError === true,
        });
      }
    }
  } finally {
    await handle.teardown();
    await manager.teardownAll();
  }
  return outcomes;
}

// --- Suite ---

describe('forked worktree subagent — live dispatcher read/glob/grep + write-confinement (#440)', () => {
  let tmpRoot: string; // acts as the "main repo" root
  let worktree: string; // <tmpRoot>/.afk-worktrees/wt

  beforeEach(async () => {
    // realpath: containment compares symlink-resolved paths; macOS tmpdir is a
    // symlink. Resolve once so the seeded roots and the target paths agree.
    tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'wt-e2e-')));
    worktree = path.join(tmpRoot, '.afk-worktrees', 'wt');
    await fs.mkdir(worktree, { recursive: true });

    // Worktree-local files. Keep the readable one SHORT and single-line so the
    // stream preview does not clip it — lets us assert the exact content.
    await fs.writeFile(path.join(worktree, 'note.txt'), 'WT_NOTE', 'utf8');
    await fs.writeFile(path.join(worktree, 'findme.txt'), 'NEEDLE_TOKEN\n', 'utf8');

    // A MAIN-repo file, OUTSIDE the worktree but inside the (lexically-derived)
    // main root — the #416 read case. Short + single-line for the same reason.
    await fs.writeFile(path.join(tmpRoot, 'MAIN_ONLY.txt'), 'MAIN_FILE', 'utf8');
  });

  afterEach(async () => {
    __setAnthropicClientFactory(null);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('read_file / glob / grep succeed on WORKTREE-relative paths', async () => {
    const rounds = [
      toolUseRound('t_read', 'read_file', { file_path: path.join(worktree, 'note.txt') }),
      toolUseRound('t_glob', 'glob', { pattern: '*.txt', path: worktree }),
      toolUseRound('t_grep', 'grep', { pattern: 'NEEDLE_TOKEN', path: worktree }),
      endTurnRound('done'),
    ];
    const outcomes = await runForkedTools(worktree, rounds);

    expect(outcomes.map((o) => o.toolName)).toEqual(['read_file', 'glob', 'grep']);
    for (const o of outcomes) {
      expect(o.isError, `${o.toolName} should succeed: ${o.content}`).toBe(false);
    }

    const read = outcomes.find((o) => o.toolName === 'read_file');
    // read_file prefixes each line with `<n>\t`; content is short → un-clipped.
    expect(read?.content).toContain('WT_NOTE');

    // glob returns newline-separated RELATIVE names (short → un-clipped) and,
    // critically, actually MATCHED (not the "No files matched …" empty result).
    const glob = outcomes.find((o) => o.toolName === 'glob');
    expect(glob?.content).not.toMatch(/^No files matched/);
    expect(glob?.content).toContain('note.txt');

    // grep prints `<abs-path>:<line>:<content>`; the long tmp path pushes the
    // matched token past the 80-char stream preview clip, so assert on success
    // + the un-clipped-friendly invariant that it is NOT the no-match message
    // (a DENIED path would have failed at containment with isError=true, which
    // the loop above already rules out — so this proves a real in-root match).
    const grep = outcomes.find((o) => o.toolName === 'grep');
    expect(grep?.content).not.toMatch(/^No matches found/);
  });

  it('read_file succeeds on a MAIN-REPO ABSOLUTE path (the #416 grant: readRoots ⊇ mainRoot)', async () => {
    const mainAbsPath = path.join(tmpRoot, 'MAIN_ONLY.txt');
    // Pre-condition: the target really is OUTSIDE the worktree (so success can
    // only come from the mainRoot grant, not from a cwd-relative fallback).
    expect(mainAbsPath.startsWith(worktree)).toBe(false);

    const rounds = [
      toolUseRound('t_main', 'read_file', { file_path: mainAbsPath }),
      endTurnRound('done'),
    ];
    const outcomes = await runForkedTools(worktree, rounds);

    expect(outcomes).toHaveLength(1);
    const read = outcomes[0];
    expect(read?.toolName).toBe('read_file');
    expect(read?.isError, `main-repo read should succeed: ${read?.content}`).toBe(false);
    expect(read?.content).toContain('MAIN_FILE');
  });

  it('write_file OUTSIDE the worktree is DENIED (read scope widened, WRITE stays confined)', async () => {
    // Target sits in the main root — readable (previous test) but must NOT be
    // writable: the #416 grant widens READ only; writeRoots stay = [worktree].
    const outsideWrite = path.join(tmpRoot, 'SHOULD_NOT_EXIST.txt');
    const rounds = [
      toolUseRound('t_wr', 'write_file', { file_path: outsideWrite, content: 'FORBIDDEN' }),
      endTurnRound('done'),
    ];
    const outcomes = await runForkedTools(worktree, rounds);

    expect(outcomes).toHaveLength(1);
    const write = outcomes[0];
    expect(write?.toolName).toBe('write_file');
    // Containment denial: isError true, message begins with the `Path ...`
    // preamble (the full "outside the allowed write roots" text is past the
    // 80-char preview clip, so assert the un-clipped leading substring).
    expect(write?.isError).toBe(true);
    expect(write?.content).toMatch(/^Path /);

    // Strongest, behavior-level invariant: the file was never created.
    const created = await fs
      .access(outsideWrite)
      .then(() => true)
      .catch(() => false);
    expect(created, 'out-of-worktree write must not have landed on disk').toBe(false);
  });

  it('write_file INSIDE the worktree still succeeds (confinement is not over-broad)', async () => {
    // Control: proves the write denial above is specifically an out-of-root
    // rejection, not a blanket "forks cannot write" — the worktree is writable.
    const insideWrite = path.join(worktree, 'child-created.txt');
    const rounds = [
      toolUseRound('t_ok', 'write_file', { file_path: insideWrite, content: 'ALLOWED' }),
      endTurnRound('done'),
    ];
    const outcomes = await runForkedTools(worktree, rounds);

    expect(outcomes).toHaveLength(1);
    const write = outcomes[0];
    expect(write?.toolName).toBe('write_file');
    expect(write?.isError, `in-worktree write should succeed: ${write?.content}`).toBe(false);

    const written = await fs.readFile(insideWrite, 'utf8');
    expect(written).toBe('ALLOWED');
  });
});
