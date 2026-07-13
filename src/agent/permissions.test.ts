/**
 * Tests for permission hook helpers.
 */

import { describe, it, expect, vi } from 'vitest';
import { createCanUseToolHook } from './permissions.js';

describe('createCanUseToolHook', () => {
  const OPTS = { signal: new AbortController().signal, toolUseID: 't' };

  // Contract guard: rule keys are matched VERBATIM against the AFK runtime tool
  // name (snake_case), which is what the dispatcher passes to canUseTool. This
  // is the namespace consumers must use; the JSDoc example teaches it.
  it('matches rules by AFK runtime (snake_case) tool name', async () => {
    const hook = createCanUseToolHook({
      rules: { defaultMode: 'allow', tools: { bash: 'deny', edit_file: 'deny' } },
    });
    expect((await hook('bash', {}, OPTS)).behavior).toBe('deny');
    expect((await hook('edit_file', {}, OPTS)).behavior).toBe('deny');
    expect((await hook('read_file', {}, OPTS)).behavior).toBe('allow');
  });

  // Fail-open trap: a PascalCase (Claude Code alias) key does NOT match the
  // snake_case runtime name, so it falls through to defaultMode. With
  // defaultMode:'allow' the tool the author meant to DENY is silently allowed.
  // This test documents the trap so the docs-vs-runtime contract can't regress
  // to teaching PascalCase keys.
  it('fails open when a PascalCase key is used with defaultMode:allow (documented trap)', async () => {
    const hook = createCanUseToolHook({
      rules: { defaultMode: 'allow', tools: { Bash: 'deny' } }, // WRONG namespace
    });
    // Author intended to block bash, but the runtime name 'bash' misses 'Bash':
    expect((await hook('bash', {}, OPTS)).behavior).toBe('allow');
  });

  it('allows tools matching allow rules', async () => {
    const hook = createCanUseToolHook({
      rules: {
        defaultMode: 'deny',
        tools: { Bash: 'allow', Read: 'allow' },
      },
    });

    await expect(hook('Bash', {}, { signal: new AbortController().signal, toolUseID: '1' }))
      .resolves.toEqual({ behavior: 'allow' });
    await expect(hook('Read', {}, { signal: new AbortController().signal, toolUseID: '2' }))
      .resolves.toEqual({ behavior: 'allow' });
  });

  it('denies tools matching deny rules with the reason as message', async () => {
    const hook = createCanUseToolHook({
      rules: {
        defaultMode: 'allow',
        tools: { Edit: { mode: 'deny', reason: 'no file edits' } },
      },
    });

    await expect(hook('Edit', {}, { signal: new AbortController().signal, toolUseID: '1' }))
      .resolves.toEqual({ behavior: 'deny', message: 'no file edits' });
  });

  it('falls through to allow when ask has no onAsk handler', async () => {
    const hook = createCanUseToolHook({
      rules: { defaultMode: 'ask' },
    });

    await expect(hook('UnknownTool', {}, { signal: new AbortController().signal, toolUseID: '1' }))
      .resolves.toEqual({ behavior: 'allow' });
  });

  it('invokes onAsk when a tool resolves to ask', async () => {
    const onAsk = vi.fn().mockResolvedValue({ behavior: 'deny', reason: 'blocked at runtime' });
    const onDecision = vi.fn();

    const hook = createCanUseToolHook({
      rules: { defaultMode: 'ask', tools: { Bash: 'ask' } },
      onAsk,
      onDecision,
    });

    const result = await hook('Bash', { cmd: 'ls' }, { signal: new AbortController().signal, toolUseID: '1' });
    expect(result).toEqual({ behavior: 'deny', message: 'blocked at runtime' });
    expect(onAsk).toHaveBeenCalledWith({ toolName: 'Bash', input: { cmd: 'ls' } });
    expect(onDecision).toHaveBeenCalledWith(
      { toolName: 'Bash', input: { cmd: 'ls' } },
      { behavior: 'deny', reason: 'blocked at runtime' },
    );
  });

  it('calls onDecision for every decision', async () => {
    const onDecision = vi.fn();
    const hook = createCanUseToolHook({
      rules: { defaultMode: 'allow', tools: { Bash: 'deny' } },
      onDecision,
    });

    await hook('Bash', {}, { signal: new AbortController().signal, toolUseID: '1' });
    await hook('Read', {}, { signal: new AbortController().signal, toolUseID: '2' });

    expect(onDecision).toHaveBeenCalledTimes(2);
    expect(onDecision).toHaveBeenNthCalledWith(1, { toolName: 'Bash', input: {} }, { behavior: 'deny', reason: undefined });
    expect(onDecision).toHaveBeenNthCalledWith(2, { toolName: 'Read', input: {} }, { behavior: 'allow' });
  });
});
