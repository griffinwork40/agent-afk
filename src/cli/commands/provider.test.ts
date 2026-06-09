/**
 * Tests for the `afk provider auth diagnose` command's pure builder.
 *
 * The CLI wrapper around it (Commander action) is exercised by the e2e
 * snapshot harness; here we only verify the data shape so the JSON contract
 * with downstream shell scripts is locked.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildProviderAuthDiagnose } from './provider.js';

describe('buildProviderAuthDiagnose', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    delete process.env['OPENAI_API_KEY'];
    delete process.env['CODEX_API_KEY'];
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns exit code 0 when explicit config key is provided', () => {
    const r = buildProviderAuthDiagnose('sk-explicit-1234');
    expect(r.exitCode).toBe(0);
    expect(r.source).toBe('config');
    expect(r.last4).toBe('1234');
    expect(r.message).toMatch(/config/i);
  });

  it('returns exit code 0 when OPENAI_API_KEY is set', () => {
    process.env['OPENAI_API_KEY'] = 'sk-env-9999';
    const r = buildProviderAuthDiagnose(undefined);
    expect(r.exitCode).toBe(0);
    expect(r.source).toBe('env');
    expect(r.last4).toBe('9999');
  });

  it('returns nonzero exit code with actionable message when no auth resolves', () => {
    // Inject hermetic deps so this test is isolated from the host machine's
    // real credentials. Without this, a developer whose ~/.codex/auth.json
    // contains a ChatGPT OAuth bundle (and AFK_OPENAI_CHATGPT_OAUTH=1) would
    // cause resolveOpenAIAuth to return source:'chatgpt-oauth' with a real
    // access_token — making exitCode 0 and source outside the allowlist below.
    const hermeticDeps = {
      readEnv: (key: string) => {
        // Expose only the env vars already cleared by beforeEach (OPENAI_API_KEY,
        // CODEX_API_KEY) as absent, and explicitly suppress the OAuth opt-in flag.
        if (key === 'OPENAI_API_KEY' || key === 'CODEX_API_KEY' || key === 'AFK_OPENAI_CHATGPT_OAUTH') {
          return undefined;
        }
        return undefined;
      },
      homedir: () => '/nonexistent-test-home',
      readFile: (_path: string) => null, // no ~/.codex/auth.json
    };
    const r = buildProviderAuthDiagnose(undefined, hermeticDeps);
    // With no env vars and no filesystem auth the resolver must return
    // no-usable-auth (exitCode 1) with an actionable message.
    expect(r.exitCode).toBe(1);
    expect(r.message.toLowerCase()).toMatch(/openai_api_key|codex login/);
  });

  it('never includes raw key material in the returned message', () => {
    const r = buildProviderAuthDiagnose('sk-VERYSECRETVALUE1234');
    expect(r.message).not.toContain('VERYSECRET');
    expect(r.message).not.toContain('sk-VERY');
    // last4 is fine
    expect(r.last4).toBe('1234');
  });
});
