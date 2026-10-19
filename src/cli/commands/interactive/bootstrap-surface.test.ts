import { describe, it, expect, vi } from 'vitest';
import { createReplSurface } from './bootstrap-surface.js';
import type { CliConfig } from '../../config.js';
import type { CliOptions } from './shared.js';
import { createDefaultTraceWriter } from '../../../agent/trace/factory.js';

/** Minimal stubs for the args createReplSurface needs. */
function makeArgs(overrides: {
  optionPermissionMode?: CliOptions['permissionMode'];
  optionDSP?: boolean;
  configPermissionMode?: CliConfig['permissionMode'];
} = {}) {
  const options: CliOptions = {
    model: 'sonnet',
    maxTurns: '100',
    dangerouslySkipPermissions: overrides.optionDSP,
    permissionMode: overrides.optionPermissionMode,
  };
  const cliConfig = {
    permissionMode: 'configPermissionMode' in overrides
      ? overrides.configPermissionMode
      : 'bypassPermissions',
  } as CliConfig;
  return {
    options,
    cliConfig,
    sessionModel: 'sonnet',
    resumeTarget: undefined,
    effectiveCwd: undefined,
    extrasCwd: undefined,
    trace: createDefaultTraceWriter(),
  };
}

describe('createReplSurface — initialPermissionMode precedence', () => {
  it('uses --permission-mode flag over config', () => {
    const result = createReplSurface(makeArgs({
      optionPermissionMode: 'default',
      configPermissionMode: 'bypassPermissions',
    }));
    expect(result.initialPermissionMode).toBe('default');
  });

  it('falls back to config when --permission-mode is absent', () => {
    const result = createReplSurface(makeArgs({
      configPermissionMode: 'plan',
    }));
    expect(result.initialPermissionMode).toBe('plan');
  });

  it('--dangerously-skip-permissions overrides --permission-mode', () => {
    const result = createReplSurface(makeArgs({
      optionDSP: true,
      optionPermissionMode: 'default',
      configPermissionMode: 'plan',
    }));
    expect(result.initialPermissionMode).toBe('bypassPermissions');
  });

  it('honors autonomous mode from --permission-mode', () => {
    const result = createReplSurface(makeArgs({
      optionPermissionMode: 'autonomous',
      configPermissionMode: 'default',
    }));
    expect(result.initialPermissionMode).toBe('autonomous');
  });

  it('leaves initialPermissionMode undefined when neither flag nor config is set', () => {
    const result = createReplSurface(makeArgs({
      configPermissionMode: undefined,
    }));
    expect(result.initialPermissionMode).toBeUndefined();
  });
});
