/**
 * Integration tests for the session-level tool system.
 *
 * Exercises the full flow: SessionToolDispatcher receives ToolCalls,
 * routes through permissions + hooks + handlers, returns ToolResults.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionToolDispatcher } from './dispatcher.js';
import { createBuiltinHandlers } from './handlers/index.js';
import { builtinToolSchemas } from './schemas.js';
import { createHookRegistryImpl } from '../hook-registry.js';
import type { ToolCall } from './types.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { promises as fs } from 'fs';

function makeCall(name: string, input: unknown): ToolCall {
  return {
    id: `call-${name}`,
    name,
    input,
    signal: new AbortController().signal,
  };
}

describe('tool system integration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(join(tmpdir(), 'tool-integration-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('dispatches read_file through the full pipeline', async () => {
    const filePath = join(tmpDir, 'test.txt');
    await fs.writeFile(filePath, 'line one\nline two\n');

    const dispatcher = new SessionToolDispatcher({
      handlers: createBuiltinHandlers(),
      schemas: [...builtinToolSchemas],
    });

    const result = await dispatcher.execute(makeCall('read_file', { file_path: filePath }));
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('line one');
    expect(result.content).toContain('line two');
  });

  it('dispatches write_file then read_file to verify', async () => {
    const filePath = join(tmpDir, 'output.txt');

    const dispatcher = new SessionToolDispatcher({
      handlers: createBuiltinHandlers(),
      schemas: [...builtinToolSchemas],
      permissions: { allowedTools: ['write_file', 'read_file'] },
    });

    const writeResult = await dispatcher.execute(
      makeCall('write_file', { file_path: filePath, content: 'hello world' }),
    );
    expect(writeResult.isError).toBeUndefined();
    expect(writeResult.content).toContain('11 bytes');

    const readResult = await dispatcher.execute(
      makeCall('read_file', { file_path: filePath }),
    );
    expect(readResult.content).toContain('hello world');
  });

  it('dispatches edit_file to modify content', async () => {
    const filePath = join(tmpDir, 'edit-target.txt');
    await fs.writeFile(filePath, 'foo bar baz\n');

    const dispatcher = new SessionToolDispatcher({
      handlers: createBuiltinHandlers(),
      schemas: [...builtinToolSchemas],
      permissions: { allowedTools: ['edit_file'] },
    });

    const result = await dispatcher.execute(
      makeCall('edit_file', {
        file_path: filePath,
        old_string: 'bar',
        new_string: 'qux',
      }),
    );
    expect(result.isError).toBeUndefined();

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toContain('foo qux baz');
  });

  it('allows bash when no permissions config provided', async () => {
    const dispatcher = new SessionToolDispatcher({
      handlers: createBuiltinHandlers(),
      schemas: [...builtinToolSchemas],
    });

    const result = await dispatcher.execute(
      makeCall('bash', { command: 'echo hello' }),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('hello');
  });

  it('allows bash with explicit permissions', async () => {
    const dispatcher = new SessionToolDispatcher({
      handlers: createBuiltinHandlers(),
      schemas: [...builtinToolSchemas],
      permissions: { allowedTools: ['bash'] },
    });

    const result = await dispatcher.execute(
      makeCall('bash', { command: 'echo hello' }),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('hello');
  });

  it('PreToolUse hook blocks tool execution', async () => {
    const registry = createHookRegistryImpl();
    registry.register('PreToolUse', async () => ({
      decision: 'block' as const,
      reason: 'security policy',
    }));

    const dispatcher = new SessionToolDispatcher({
      handlers: createBuiltinHandlers(),
      schemas: [...builtinToolSchemas],
      hookRegistry: registry,
    });

    const result = await dispatcher.execute(
      makeCall('read_file', { file_path: '/etc/hostname' }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('blocked by PreToolUse hook');
  });

  it('PostToolUse hook observes tool output', async () => {
    const filePath = join(tmpDir, 'observed.txt');
    await fs.writeFile(filePath, 'secret content\n');

    const registry = createHookRegistryImpl();
    const postSpy = vi.fn(async () => ({}));
    registry.register('PostToolUse', postSpy);

    const dispatcher = new SessionToolDispatcher({
      handlers: createBuiltinHandlers(),
      schemas: [...builtinToolSchemas],
      hookRegistry: registry,
    });

    await dispatcher.execute(makeCall('read_file', { file_path: filePath }));
    expect(postSpy).toHaveBeenCalledOnce();
  });

  it('dispatches list_directory on tmpDir', async () => {
    await fs.writeFile(join(tmpDir, 'a.txt'), '');
    await fs.mkdir(join(tmpDir, 'subdir'));

    const dispatcher = new SessionToolDispatcher({
      handlers: createBuiltinHandlers(),
      schemas: [...builtinToolSchemas],
    });

    const result = await dispatcher.execute(
      makeCall('list_directory', { path: tmpDir }),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('a.txt');
    expect(result.content).toContain('subdir/');
  });

  it('dispatches glob to find files', async () => {
    await fs.writeFile(join(tmpDir, 'foo.ts'), '');
    await fs.writeFile(join(tmpDir, 'bar.js'), '');

    const dispatcher = new SessionToolDispatcher({
      handlers: createBuiltinHandlers(),
      schemas: [...builtinToolSchemas],
    });

    const result = await dispatcher.execute(
      makeCall('glob', { pattern: '*.ts', path: tmpDir }),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('foo.ts');
    expect(result.content).not.toContain('bar.js');
  });

  it('dispatches grep to search file content', async () => {
    await fs.writeFile(join(tmpDir, 'haystack.txt'), 'find the needle here\n');

    const dispatcher = new SessionToolDispatcher({
      handlers: createBuiltinHandlers(),
      schemas: [...builtinToolSchemas],
    });

    const result = await dispatcher.execute(
      makeCall('grep', { pattern: 'needle', path: tmpDir }),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('needle');
    expect(result.content).toContain('haystack.txt');
  });

  it('multi-tool sequence: write → edit → read', async () => {
    const filePath = join(tmpDir, 'multi.txt');

    const dispatcher = new SessionToolDispatcher({
      handlers: createBuiltinHandlers(),
      schemas: [...builtinToolSchemas],
      permissions: { allowedTools: ['write_file', 'edit_file', 'read_file'] },
    });

    await dispatcher.execute(
      makeCall('write_file', { file_path: filePath, content: 'original text' }),
    );

    await dispatcher.execute(
      makeCall('edit_file', {
        file_path: filePath,
        old_string: 'original',
        new_string: 'modified',
      }),
    );

    const result = await dispatcher.execute(
      makeCall('read_file', { file_path: filePath }),
    );
    expect(result.content).toContain('modified text');
  });

  describe('render-only diff sidechannel — end-to-end', () => {
    it('edit_file dispatched through SessionToolDispatcher carries render.diff', async () => {
      const filePath = join(tmpDir, 'edit-diff.txt');
      const dispatcher = new SessionToolDispatcher({
        handlers: createBuiltinHandlers(),
        schemas: [...builtinToolSchemas],
        permissions: { allowedTools: ['write_file', 'edit_file'] },
      });

      await dispatcher.execute(
        makeCall('write_file', { file_path: filePath, content: 'old line\nkeep\n' }),
      );

      const result = await dispatcher.execute(
        makeCall('edit_file', {
          file_path: filePath,
          old_string: 'old line',
          new_string: 'new line',
        }),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toBe(`Replaced 1 occurrence in ${filePath}`);
      expect(result.render?.diff).toBeDefined();
      expect(result.render!.diff!.addedLines).toBe(1);
      expect(result.render!.diff!.removedLines).toBe(1);

      // Find the `-` and `+` lines in the diff payload.
      const allLines = result.render!.diff!.hunks.flatMap((h) => h.lines);
      const minus = allLines.find((l) => l.kind === '-');
      const plus = allLines.find((l) => l.kind === '+');
      expect(minus?.text).toBe('old line');
      expect(plus?.text).toBe('new line');
    });

    it('write_file to a new path emits an all-additions diff', async () => {
      const filePath = join(tmpDir, 'new-file.txt');
      const dispatcher = new SessionToolDispatcher({
        handlers: createBuiltinHandlers(),
        schemas: [...builtinToolSchemas],
        permissions: { allowedTools: ['write_file'] },
      });

      const result = await dispatcher.execute(
        makeCall('write_file', { file_path: filePath, content: 'a\nb\nc' }),
      );

      expect(result.isError).toBeUndefined();
      expect(result.render?.diff).toBeDefined();
      expect(result.render!.diff!.addedLines).toBe(3);
      expect(result.render!.diff!.removedLines).toBe(0);
    });
  });
});
