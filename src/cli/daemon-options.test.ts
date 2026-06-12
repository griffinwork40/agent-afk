import { describe, it, expect } from 'vitest';
import {
  resolveDaemonTimeoutMs,
  resolveSessionStartCooldownMs,
  resolveTriggerMode,
  resolveDefaultTask,
  resolveDefaultTaskId,
  resolveDaemonHost,
  isLoopbackHost,
  DEFAULT_DAEMON_HOST,
  COMPILED_DEFAULT_TASK,
  COMPILED_DEFAULT_TASK_ID,
} from './daemon-options.js';

describe('resolveDaemonTimeoutMs', () => {
  it('returns undefined when neither flag nor env var is set', () => {
    expect(resolveDaemonTimeoutMs(undefined, undefined)).toBeUndefined();
  });

  it('returns undefined for empty-string inputs', () => {
    expect(resolveDaemonTimeoutMs('', '')).toBeUndefined();
    expect(resolveDaemonTimeoutMs(undefined, '')).toBeUndefined();
  });

  it('parses a valid flag value', () => {
    expect(resolveDaemonTimeoutMs('900000', undefined)).toBe(900000);
  });

  it('falls back to env var when flag is unset', () => {
    expect(resolveDaemonTimeoutMs(undefined, '300000')).toBe(300000);
  });

  it('flag takes precedence over env var', () => {
    expect(resolveDaemonTimeoutMs('600000', '300000')).toBe(600000);
  });

  it('throws on non-numeric input', () => {
    expect(() => resolveDaemonTimeoutMs('abc', undefined)).toThrow(/Invalid timeout-ms/);
  });

  it('throws on zero', () => {
    expect(() => resolveDaemonTimeoutMs('0', undefined)).toThrow(/positive integer/);
  });

  it('throws on negative values', () => {
    expect(() => resolveDaemonTimeoutMs('-100', undefined)).toThrow(/positive integer/);
  });

  it('throws on floats', () => {
    expect(() => resolveDaemonTimeoutMs('1000.5', undefined)).toThrow(/positive integer/);
  });

  it('throws on NaN / Infinity inputs', () => {
    expect(() => resolveDaemonTimeoutMs('Infinity', undefined)).toThrow(/Invalid timeout-ms/);
    expect(() => resolveDaemonTimeoutMs('NaN', undefined)).toThrow(/Invalid timeout-ms/);
  });

  it('accepts minimum valid value (1ms)', () => {
    expect(resolveDaemonTimeoutMs('1', undefined)).toBe(1);
  });
});

describe('resolveSessionStartCooldownMs', () => {
  it('returns undefined when neither flag nor env var is set', () => {
    expect(resolveSessionStartCooldownMs(undefined, undefined)).toBeUndefined();
  });

  it('parses a valid flag value', () => {
    expect(resolveSessionStartCooldownMs('21600000', undefined)).toBe(21600000);
  });

  it('falls back to env var when flag is unset', () => {
    expect(resolveSessionStartCooldownMs(undefined, '3600000')).toBe(3600000);
  });

  it('flag takes precedence over env var', () => {
    expect(resolveSessionStartCooldownMs('100', '200')).toBe(100);
  });

  it('accepts zero (disables cooldown)', () => {
    expect(resolveSessionStartCooldownMs('0', undefined)).toBe(0);
  });

  it('rejects negatives', () => {
    expect(() => resolveSessionStartCooldownMs('-1', undefined)).toThrow(
      /non-negative integer/,
    );
  });

  it('rejects floats', () => {
    expect(() => resolveSessionStartCooldownMs('1.5', undefined)).toThrow(
      /non-negative integer/,
    );
  });

  it('rejects non-numeric input', () => {
    expect(() => resolveSessionStartCooldownMs('nope', undefined)).toThrow(
      /Invalid sessionstart-cooldown-ms/,
    );
  });
});

describe('resolveTriggerMode', () => {
  it('defaults to sessionstart when neither --trigger nor --cron are provided (zero-config)', () => {
    expect(resolveTriggerMode(undefined, undefined)).toBe('sessionstart');
    expect(resolveTriggerMode('', undefined)).toBe('sessionstart');
  });

  it('defaults to cron when --cron is provided but --trigger is absent', () => {
    expect(resolveTriggerMode(undefined, '0 */6 * * *')).toBe('cron');
    expect(resolveTriggerMode('', '0 */6 * * *')).toBe('cron');
  });

  it('accepts explicit cron, sessionstart, both via --trigger', () => {
    expect(resolveTriggerMode('cron', undefined)).toBe('cron');
    expect(resolveTriggerMode('sessionstart', undefined)).toBe('sessionstart');
    expect(resolveTriggerMode('both', '0 */6 * * *')).toBe('both');
  });

  it('rejects unknown values', () => {
    expect(() => resolveTriggerMode('random', undefined)).toThrow(/Invalid trigger/);
    expect(() => resolveTriggerMode('CRON', undefined)).toThrow(/Invalid trigger/); // case-sensitive
  });
});

describe('resolveDefaultTask', () => {
  it('returns compiled default when all three args are undefined', () => {
    expect(resolveDefaultTask(undefined, undefined, undefined)).toBe(COMPILED_DEFAULT_TASK);
  });

  it('returns config when only config is set', () => {
    expect(resolveDefaultTask(undefined, undefined, '/from-config')).toBe('/from-config');
  });

  it('returns env when only env is set', () => {
    expect(resolveDefaultTask(undefined, '/from-env', undefined)).toBe('/from-env');
  });

  it('returns flag when only flag is set', () => {
    expect(resolveDefaultTask('/from-flag', undefined, undefined)).toBe('/from-flag');
  });

  it('flag wins when all three are set', () => {
    expect(resolveDefaultTask('/from-flag', '/from-env', '/from-config')).toBe('/from-flag');
  });

  it('env beats config when both are set and no flag', () => {
    expect(resolveDefaultTask(undefined, '/from-env', '/from-config')).toBe('/from-env');
  });

  it('falls through to env when flag is empty string', () => {
    expect(resolveDefaultTask('', '/from-env', '/from-config')).toBe('/from-env');
  });

  it('falls through when flag is whitespace-only', () => {
    expect(resolveDefaultTask('   ', '/from-env', '/from-config')).toBe('/from-env');
  });

  it('falls through to compiled default when config is empty string', () => {
    expect(resolveDefaultTask(undefined, undefined, '')).toBe(COMPILED_DEFAULT_TASK);
  });

  it('frozen-default guard: COMPILED_DEFAULT_TASK is "/forge-friction --auto"', () => {
    expect(COMPILED_DEFAULT_TASK).toBe('/forge-friction --auto');
  });
});

describe('resolveDefaultTaskId', () => {
  it('returns compiled default when all three args are undefined', () => {
    expect(resolveDefaultTaskId(undefined, undefined, undefined)).toBe(COMPILED_DEFAULT_TASK_ID);
  });

  it('returns config when only config is set', () => {
    expect(resolveDefaultTaskId(undefined, undefined, 'config-id')).toBe('config-id');
  });

  it('returns env when only env is set', () => {
    expect(resolveDefaultTaskId(undefined, 'env-id', undefined)).toBe('env-id');
  });

  it('returns flag when only flag is set', () => {
    expect(resolveDefaultTaskId('flag-id', undefined, undefined)).toBe('flag-id');
  });

  it('flag wins when all three are set', () => {
    expect(resolveDefaultTaskId('flag-id', 'env-id', 'config-id')).toBe('flag-id');
  });

  it('env beats config when both are set and no flag', () => {
    expect(resolveDefaultTaskId(undefined, 'env-id', 'config-id')).toBe('env-id');
  });

  it('falls through to env when flag is empty string', () => {
    expect(resolveDefaultTaskId('', 'env-id', 'config-id')).toBe('env-id');
  });

  it('falls through when flag is whitespace-only', () => {
    expect(resolveDefaultTaskId('   ', 'env-id', 'config-id')).toBe('env-id');
  });

  it('falls through to compiled default when config is empty string', () => {
    expect(resolveDefaultTaskId(undefined, undefined, '')).toBe(COMPILED_DEFAULT_TASK_ID);
  });

  it('frozen-default guard: COMPILED_DEFAULT_TASK_ID is "default"', () => {
    expect(COMPILED_DEFAULT_TASK_ID).toBe('default');
  });
});

describe('resolveDaemonHost', () => {
  it('defaults to loopback (127.0.0.1) when neither flag nor env is set', () => {
    expect(resolveDaemonHost(undefined, undefined)).toBe('127.0.0.1');
  });

  it('security guard: DEFAULT_DAEMON_HOST is loopback', () => {
    expect(DEFAULT_DAEMON_HOST).toBe('127.0.0.1');
    expect(resolveDaemonHost(undefined, undefined)).toBe(DEFAULT_DAEMON_HOST);
  });

  it('treats empty / whitespace-only inputs as absent', () => {
    expect(resolveDaemonHost('', '')).toBe('127.0.0.1');
    expect(resolveDaemonHost('   ', undefined)).toBe('127.0.0.1');
    expect(resolveDaemonHost(undefined, '   ')).toBe('127.0.0.1');
  });

  it('uses the env var when the flag is unset', () => {
    expect(resolveDaemonHost(undefined, '0.0.0.0')).toBe('0.0.0.0');
  });

  it('flag takes precedence over env var', () => {
    expect(resolveDaemonHost('192.168.1.10', '0.0.0.0')).toBe('192.168.1.10');
  });

  it('falls through to env when flag is whitespace-only', () => {
    expect(resolveDaemonHost('  ', '0.0.0.0')).toBe('0.0.0.0');
  });
});

describe('isLoopbackHost', () => {
  it('recognises loopback literals (case / whitespace insensitive)', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1', 'LOCALHOST', '  127.0.0.1  ']) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });

  it('treats all-interfaces wildcards and LAN/hostnames as non-loopback', () => {
    for (const h of ['0.0.0.0', '::', '192.168.1.10', '10.0.0.5', '0:0:0:0:0:0:0:0', 'example.com']) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});
