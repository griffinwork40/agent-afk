/**
 * Tests for buildChildEnv in child-env.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildChildEnv } from './child-env.js';
import type { Environment } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseEnv: Environment = {
  label: 'baseline',
  home: '/sandbox/home',
  cwd: '/sandbox/cwd',
  launch: {
    model: undefined,
    effort: undefined,
    env: {},
  },
};

// ---------------------------------------------------------------------------
// Test: credentials are inherited but not explicitly added
// ---------------------------------------------------------------------------

describe('buildChildEnv', () => {

  it('inherits ANTHROPIC_API_KEY from parent (credential passthrough)', () => {
    // Use vi.stubEnv to survive the global beforeEach that clears config vars.
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test123');
    const result = buildChildEnv(baseEnv, {});
    // Credential is inherited from parent process.env, not explicitly set.
    expect(result['ANTHROPIC_API_KEY']).toBe('sk-ant-test123');
    vi.unstubAllEnvs();
  });

  it('inherits CLAUDE_CODE_OAUTH_TOKEN from parent', () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-test');
    const result = buildChildEnv(baseEnv, {});
    expect(result['CLAUDE_CODE_OAUTH_TOKEN']).toBe('sk-ant-oat01-test');
    vi.unstubAllEnvs();
  });

  it('sets AFK_HOME to env.home', () => {
    const result = buildChildEnv(baseEnv, {});
    expect(result['AFK_HOME']).toBe('/sandbox/home');
  });

  it('sets AFK_STATE_DIR to <env.home>/state', () => {
    const result = buildChildEnv(baseEnv, {});
    expect(result['AFK_STATE_DIR']).toBe('/sandbox/home/state');
  });

  it('sets AFK_FRAMEWORK_DIR to <env.home>/agent-framework', () => {
    const result = buildChildEnv(baseEnv, {});
    expect(result['AFK_FRAMEWORK_DIR']).toBe('/sandbox/home/agent-framework');
  });

  it('sets AFK_WHATIF_EPISODE=1', () => {
    const result = buildChildEnv(baseEnv, {});
    expect(result['AFK_WHATIF_EPISODE']).toBe('1');
  });

  it('sets AFK_MAX_NESTING_DEPTH=0', () => {
    const result = buildChildEnv(baseEnv, {});
    expect(result['AFK_MAX_NESTING_DEPTH']).toBe('0');
  });

  it('sets AFK_RUN_RECEIPT_DISABLED=1', () => {
    const result = buildChildEnv(baseEnv, {});
    expect(result['AFK_RUN_RECEIPT_DISABLED']).toBe('1');
  });

  it('deletes AFK_SESSION_LEDGER_DISABLED (even if set in parent)', () => {
    vi.stubEnv('AFK_SESSION_LEDGER_DISABLED', '1');
    const result = buildChildEnv(baseEnv, {});
    expect(result['AFK_SESSION_LEDGER_DISABLED']).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('removes TELEGRAM_BOT_TOKEN even when set in parent', () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'secret-bot-token');
    const result = buildChildEnv(baseEnv, {});
    expect(result['TELEGRAM_BOT_TOKEN']).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('removes AFK_TELEGRAM_BOT_TOKEN even when set in parent', () => {
    vi.stubEnv('AFK_TELEGRAM_BOT_TOKEN', 'secret-telegram-token');
    const result = buildChildEnv(baseEnv, {});
    expect(result['AFK_TELEGRAM_BOT_TOKEN']).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('removes AFK_TELEGRAM_ALLOWED_CHAT_IDS even when set in parent', () => {
    vi.stubEnv('AFK_TELEGRAM_ALLOWED_CHAT_IDS', '12345');
    const result = buildChildEnv(baseEnv, {});
    expect(result['AFK_TELEGRAM_ALLOWED_CHAT_IDS']).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('removes AFK_ALLOW_PROJECT_MCP even when set in parent', () => {
    vi.stubEnv('AFK_ALLOW_PROJECT_MCP', '1');
    const result = buildChildEnv(baseEnv, {});
    expect(result['AFK_ALLOW_PROJECT_MCP']).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('removes AFK_DUMP_PROMPT even when set in parent', () => {
    vi.stubEnv('AFK_DUMP_PROMPT', '1');
    const result = buildChildEnv(baseEnv, {});
    expect(result['AFK_DUMP_PROMPT']).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('applies env.launch.env overrides', () => {
    const env: Environment = {
      ...baseEnv,
      launch: { model: 'claude-3-5-sonnet', effort: undefined, env: { MY_VAR: 'launch-value' } },
    };
    const result = buildChildEnv(env, {});
    expect(result['MY_VAR']).toBe('launch-value');
  });

  it('applies extra overrides last (they win over launch.env)', () => {
    const env: Environment = {
      ...baseEnv,
      launch: { model: undefined, effort: undefined, env: { MY_VAR: 'launch-value' } },
    };
    const result = buildChildEnv(env, { MY_VAR: 'extra-wins' });
    expect(result['MY_VAR']).toBe('extra-wins');
  });

  it('extra can set ANTHROPIC_BASE_URL for snapshot path', () => {
    const result = buildChildEnv(baseEnv, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999' });
    expect(result['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:9999');
  });
  it('unsets launch.unset keys so the child re-reads them from its sandbox afk.env', () => {
    vi.stubEnv('AFK_MODEL', 'opus');
    const result = buildChildEnv({ ...baseEnv, launch: { env: {}, unset: ['AFK_MODEL'] } }, {});
    expect(result['AFK_MODEL']).toBeUndefined();
    vi.unstubAllEnvs();
  });

  // Issue #2428: sandbox-owned path keys must survive launch.unset — they must
  // always point at the sandbox, never at the real AFK directories.
  it('AFK_FRAMEWORK_DIR is the sandbox path even when parent env has a real path (via unset)', () => {
    vi.stubEnv('AFK_FRAMEWORK_DIR', '/real/framework');
    const result = buildChildEnv(
      { ...baseEnv, launch: { env: {}, unset: ['AFK_FRAMEWORK_DIR'] } },
      {},
    );
    expect(result['AFK_FRAMEWORK_DIR']).toBe('/sandbox/home/agent-framework');
    vi.unstubAllEnvs();
  });

  it('AFK_HOME is the sandbox path even when parent env sets it and launch.unset lists it', () => {
    vi.stubEnv('AFK_HOME', '/real/home');
    const result = buildChildEnv(
      { ...baseEnv, launch: { env: {}, unset: ['AFK_HOME'] } },
      {},
    );
    expect(result['AFK_HOME']).toBe('/sandbox/home');
    vi.unstubAllEnvs();
  });

  it('AFK_STATE_DIR is the sandbox path even when parent env sets it and launch.unset lists it', () => {
    vi.stubEnv('AFK_STATE_DIR', '/real/state');
    const result = buildChildEnv(
      { ...baseEnv, launch: { env: {}, unset: ['AFK_STATE_DIR'] } },
      {},
    );
    expect(result['AFK_STATE_DIR']).toBe('/sandbox/home/state');
    vi.unstubAllEnvs();
  });

  it('launch.env cannot override AFK_FRAMEWORK_DIR (sandbox path always wins)', () => {
    const env: Environment = {
      ...baseEnv,
      launch: { env: { AFK_FRAMEWORK_DIR: '/launch-override/framework' } },
    };
    const result = buildChildEnv(env, {});
    expect(result['AFK_FRAMEWORK_DIR']).toBe('/sandbox/home/agent-framework');
  });

  it('extra cannot override AFK_FRAMEWORK_DIR (sandbox path always wins)', () => {
    const result = buildChildEnv(baseEnv, { AFK_FRAMEWORK_DIR: '/extra-override/framework' });
    expect(result['AFK_FRAMEWORK_DIR']).toBe('/sandbox/home/agent-framework');
  });

  it('launch.env can never re-add a security-deleted var', () => {
    const result = buildChildEnv(
      { ...baseEnv, launch: { env: { AFK_ALLOW_PROJECT_MCP: '1', AFK_SOMETHING: 'x' } } },
      {},
    );
    expect(result['AFK_ALLOW_PROJECT_MCP']).toBeUndefined();
    expect(result['AFK_SOMETHING']).toBe('x');
  });

  it('extra cannot re-add a key that launch.unset explicitly removed', () => {
    vi.stubEnv('AFK_MODEL', 'opus');
    const result = buildChildEnv(
      { ...baseEnv, launch: { env: {}, unset: ['AFK_MODEL'] } },
      { AFK_MODEL: 're-added' },
    );
    // launch.unset removed AFK_MODEL; extra must not reverse that removal.
    expect(result['AFK_MODEL']).toBeUndefined();
    vi.unstubAllEnvs();
  });

  // Medium fix #2295: extra bypassed the deny list before this fix.
  it('extra cannot re-add a security-deleted var (deny-list applied to extra)', () => {
    const result = buildChildEnv(baseEnv, {
      TELEGRAM_BOT_TOKEN: 'should-be-filtered',
      AFK_TELEGRAM_BOT_TOKEN: 'also-filtered',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999', // safe — not on deny list
    });
    expect(result['TELEGRAM_BOT_TOKEN']).toBeUndefined();
    expect(result['AFK_TELEGRAM_BOT_TOKEN']).toBeUndefined();
    expect(result['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:9999');
  });
});
