import { afterEach, describe, expect, it } from 'vitest';
import { isGated, gateReason } from './command-gate.js';
import { register, registerOrReplace, resetRegistry } from '../cli/slash/registry.js';
import type { SlashCommand, SurfaceCapability } from '../cli/slash/types.js';

function registerCommand(name: string, requires?: readonly SurfaceCapability[], aliases?: string[]): void {
  const command: SlashCommand = {
    name, summary: 'test', aliases, requires,
    handler: async () => 'continue',
  };
  register(command);
}

afterEach(resetRegistry);

describe('web command capability gate', () => {
  it.each(['/clear', '/model', '/name', '/thinking', '/fast', '/compact'])(
    'ungates migrated Stage1 control %s', (name) => {
      registerCommand(name);
      expect(isGated(name)).toBe(false);
      expect(gateReason(name)).toBeUndefined();
    },
  );

  it.each([
    '/plan', '/afk', '/retry', '/init', '/sh',
    '/editor', '/copy', '/font-size', '/theme', '/ghost',
    '/suggestions', '/keys', '/tasks:view',
  ])('preserves unsupported command %s through positive metadata', (name) => {
    registerCommand(name);
    expect(isGated(name)).toBe(true);
    expect(gateReason(name)).toMatch(/requires/);
  });

  it.each(['/rewind', '/fork', '/resume', '/exit', '/quit'])(
    '%s is no longer deferred: it runs as a native web command', (name) => {
      registerCommand(name);
      expect(isGated(name)).toBe(false);
    },
  );

  it('derives support for newly registered commands rather than requiring gate edits', () => {
    registerCommand('/new-terminal-command', ['tty']);
    registerCommand('/new-portable-command');
    expect(isGated('/new-terminal-command')).toBe(true);
    expect(isGated('/new-portable-command')).toBe(false);
  });

  it('resolves aliases before evaluating requirements and deferred lifecycle commands', () => {
    registerCommand('/editor', undefined, ['/ed']);
    registerCommand('/fork', undefined, ['/branch']);
    expect(gateReason('/ed')).toBe(gateReason('/editor'));
    expect(gateReason('/branch')).toBe(gateReason('/fork'));
  });

  it('allows migrated command definitions to override compatibility metadata', () => {
    registerCommand('/init', []);
    expect(isGated('/init')).toBe(false);
  });

  it('picks up hot-replaced metadata without a stale gate cache', () => {
    registerCommand('/new', ['tty']);
    expect(isGated('/new')).toBe(true);
    registerOrReplace({ name: '/new', summary: 'portable now', requires: [], handler: async () => 'continue' });
    expect(isGated('/new')).toBe(false);
  });

  it('evaluates the actual supplied capability set when given', () => {
    registerCommand('/clear');
    expect(isGated('/clear', new Set())).toBe(true);
    expect(isGated('/editor', new Set(['tty']))).toBe(false);
  });

  it('does not treat unknown commands as a capability failure', () => {
    expect(isGated('/not-registered')).toBe(false);
    expect(gateReason('/not-registered')).toBeUndefined();
  });
});
