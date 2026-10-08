/**
 * Tests for `afk restart` / `afk service restart` shared logic.
 *
 * Uses a fake ServiceManager so no real launchd / systemd / Task Scheduler
 * job is ever touched (see the 2026-09-26 postinstall incident, PR #2233).
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { parseServiceName, registerRestartCommand, restartServices } from './restart.js';
import type { ServiceManager, ServiceName, ServiceRestartOutcome } from '../../service/index.js';

function fakeManager(
  installed: ServiceName[],
  outcomes: Partial<Record<ServiceName, ServiceRestartOutcome>> = {},
): ServiceManager & { restarted: ServiceName[] } {
  const restarted: ServiceName[] = [];
  const label = (name: ServiceName): string => `com.afk.${name}`;
  return {
    restarted,
    backend: 'launchd',
    configKind: 'LaunchAgent plist',
    install: () => ({ kind: 'failed', reason: 'unused' }),
    uninstall: () => ({ kind: 'failed', reason: 'unused' }),
    upgrade: () => ({ kind: 'failed', reason: 'unused' }),
    status: () => {
      throw new Error('unused');
    },
    restart(name) {
      restarted.push(name);
      if (!installed.includes(name)) return { kind: 'not-installed', configPath: `/x/${name}` };
      return outcomes[name] ?? { kind: 'restarted', label: label(name) };
    },
    isInstalled: (name) => installed.includes(name),
    configPath: (name) => `/x/${name}`,
    logPath: (name) => `/logs/${name}`,
    label,
    readConfigFile: () => undefined,
  };
}

const texts = (r: ReturnType<typeof restartServices>): string[] => r.lines.map((l) => l.text);

describe('restartServices — named target', () => {
  it('restarts only the named service', () => {
    const mgr = fakeManager(['telegram', 'daemon']);
    const r = restartServices(mgr, 'daemon');
    expect(mgr.restarted).toEqual(['daemon']);
    expect(r.exitCode).toBe(0);
    expect(texts(r)).toEqual(['✓ Restarted com.afk.daemon']);
  });

  it('fails with an install hint when the named service is not installed', () => {
    const r = restartServices(fakeManager([]), 'telegram');
    expect(r.exitCode).toBe(1);
    expect(r.lines[0]?.level).toBe('error');
    expect(r.lines[0]?.text).toContain("afk service install telegram");
  });

  it('surfaces non-fatal notes as warnings', () => {
    const mgr = fakeManager(['daemon'], {
      daemon: { kind: 'restarted', label: 'com.afk.daemon', notes: ['plist upgrade failed'] },
    });
    const r = restartServices(mgr, 'daemon');
    expect(r.exitCode).toBe(0);
    expect(r.lines[1]).toEqual({ level: 'warning', text: '  ⚠ plist upgrade failed' });
  });
});

describe('restartServices — all installed (no target)', () => {
  it('restarts every installed service', () => {
    const mgr = fakeManager(['telegram', 'daemon']);
    const r = restartServices(mgr);
    expect(mgr.restarted).toEqual(['telegram', 'daemon']);
    expect(r.exitCode).toBe(0);
  });

  it('skips services that are not installed without calling restart on them', () => {
    const mgr = fakeManager(['daemon']);
    const r = restartServices(mgr);
    expect(mgr.restarted).toEqual(['daemon']);
    expect(r.exitCode).toBe(0);
    expect(texts(r)).toContain('○ Skipped telegram (not installed)');
  });

  it('attempts every service even after one fails, then exits 1', () => {
    const mgr = fakeManager(['telegram', 'daemon'], {
      telegram: { kind: 'failed', reason: 'bootstrap: 5: Input/output error' },
    });
    const r = restartServices(mgr);
    expect(mgr.restarted).toEqual(['telegram', 'daemon']);
    expect(r.exitCode).toBe(1);
    expect(texts(r)).toContain('✓ Restarted com.afk.daemon');
    expect(texts(r).some((t) => t.includes('Input/output error'))).toBe(true);
  });

  it('exits 1 with install and telegram-restart hints when nothing is installed', () => {
    const mgr = fakeManager([]);
    const r = restartServices(mgr);
    expect(mgr.restarted).toEqual([]);
    expect(r.exitCode).toBe(1);
    expect(texts(r).join('\n')).toContain('afk service install');
    expect(texts(r).join('\n')).toContain('afk telegram restart');
  });
});

describe('parseServiceName', () => {
  it('accepts names case-insensitively', () => {
    expect(parseServiceName('Telegram')).toBe('telegram');
  });
  it('rejects unknown names', () => {
    expect(() => parseServiceName('web')).toThrow(/Unknown service 'web'/);
  });
});

describe('registerRestartCommand', () => {
  it('registers a top-level `restart` with an optional name argument', () => {
    const program = new Command();
    registerRestartCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'restart');
    expect(cmd).toBeDefined();
    expect(cmd?.registeredArguments.map((a) => [a.name(), a.required])).toEqual([['name', false]]);
  });
});
