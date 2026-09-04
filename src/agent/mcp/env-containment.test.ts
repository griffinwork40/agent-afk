/**
 * Tests for MCP stdio server environment containment (issue #578).
 *
 * Covers:
 *  - Secret pattern matching (`isSecretPattern`)
 *  - Dangerous inherited-env detection (`isDangerousInherited`)
 *  - Layer-aware expansion gate (`checkSecretExpansion`)
 *  - Dangerous env scrubber (`scrubDangerousEnv`)
 *  - Integration: `expandEnvStringForLayer` / `expandEnvRecordForLayer`
 *
 * @module agent/mcp/env-containment.test
 */

import { describe, it, expect, vi } from 'vitest';

import {
  isSecretPattern,
  isDangerousInherited,
  checkSecretExpansion,
  scrubDangerousEnv,
} from './env-containment.js';

import {
  expandEnvStringForLayer,
  expandEnvRecordForLayer,
} from './env.js';

// ── isSecretPattern ──────────────────────────────────────────────────────────

describe('isSecretPattern', () => {
  it('matches *_API_KEY pattern', () => {
    expect(isSecretPattern('MY_SERVICE_API_KEY')).toBe(true);
    expect(isSecretPattern('OPENAI_API_KEY')).toBe(true);
    expect(isSecretPattern('API_KEY')).toBe(false); // no prefix
  });

  it('matches *_TOKEN pattern', () => {
    expect(isSecretPattern('GITHUB_TOKEN')).toBe(true);
    expect(isSecretPattern('ACCESS_TOKEN')).toBe(true);
    expect(isSecretPattern('TOKEN_VERSION')).toBe(false); // suffix, not matched
  });

  it('matches *_SECRET and *_SECRET_* patterns', () => {
    expect(isSecretPattern('MY_SECRET')).toBe(true);
    expect(isSecretPattern('CLIENT_SECRET_KEY')).toBe(true);
    expect(isSecretPattern('JWT_SECRET_VALUE')).toBe(true);
  });

  it('matches *_PASSWORD pattern', () => {
    expect(isSecretPattern('DB_PASSWORD')).toBe(true);
    expect(isSecretPattern('MYSQL_ROOT_PASSWORD')).toBe(true);
  });

  it('matches AWS_* family', () => {
    expect(isSecretPattern('AWS_SECRET_ACCESS_KEY')).toBe(true);
    expect(isSecretPattern('AWS_ACCESS_KEY_ID')).toBe(true);
    expect(isSecretPattern('AWS_SESSION_TOKEN')).toBe(true);
  });

  it('matches GCP_* family', () => {
    expect(isSecretPattern('GCP_SERVICE_ACCOUNT_KEY')).toBe(true);
  });

  it('matches AZURE_* family', () => {
    expect(isSecretPattern('AZURE_CLIENT_SECRET')).toBe(true);
    expect(isSecretPattern('AZURE_STORAGE_KEY')).toBe(true);
  });

  it('matches ANTHROPIC_* family', () => {
    expect(isSecretPattern('ANTHROPIC_API_KEY')).toBe(true);
    expect(isSecretPattern('ANTHROPIC_MODEL')).toBe(true); // prefix match — classified as secret
  });

  it('matches OPENAI_* family', () => {
    expect(isSecretPattern('OPENAI_API_KEY')).toBe(true);
    expect(isSecretPattern('OPENAI_ORG_ID')).toBe(true); // prefix match
  });

  it('does not match benign vars', () => {
    expect(isSecretPattern('PATH')).toBe(false);
    expect(isSecretPattern('HOME')).toBe(false);
    expect(isSecretPattern('NODE_ENV')).toBe(false);
    expect(isSecretPattern('PORT')).toBe(false);
    expect(isSecretPattern('DATABASE_URL')).toBe(false);
    expect(isSecretPattern('REDIS_HOST')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isSecretPattern('my_api_key')).toBe(true);
    expect(isSecretPattern('aws_secret_access_key')).toBe(true);
  });
});

// ── isDangerousInherited ─────────────────────────────────────────────────────

describe('isDangerousInherited', () => {
  it('flags NODE_OPTIONS exactly', () => {
    expect(isDangerousInherited('NODE_OPTIONS')).toBe(true);
    expect(isDangerousInherited('NODE_OPTIONS_EXTRA')).toBe(false); // only exact
  });

  it('flags LD_PRELOAD exactly', () => {
    expect(isDangerousInherited('LD_PRELOAD')).toBe(true);
  });

  it('flags RUBYOPT exactly', () => {
    expect(isDangerousInherited('RUBYOPT')).toBe(true);
  });

  it('flags DYLD_* family by prefix', () => {
    expect(isDangerousInherited('DYLD_LIBRARY_PATH')).toBe(true);
    expect(isDangerousInherited('DYLD_INSERT_LIBRARIES')).toBe(true);
    expect(isDangerousInherited('DYLD_FORCE_FLAT_NAMESPACE')).toBe(true);
  });

  it('flags PYTHON* family by prefix', () => {
    expect(isDangerousInherited('PYTHONPATH')).toBe(true);
    expect(isDangerousInherited('PYTHONSTARTUP')).toBe(true);
    expect(isDangerousInherited('PYTHONINSPECT')).toBe(true);
  });

  it('flags PERL5* family by prefix', () => {
    expect(isDangerousInherited('PERL5LIB')).toBe(true);
    expect(isDangerousInherited('PERL5OPT')).toBe(true);
  });

  it('does not flag safe vars', () => {
    expect(isDangerousInherited('PATH')).toBe(false);
    expect(isDangerousInherited('HOME')).toBe(false);
    expect(isDangerousInherited('NODE_ENV')).toBe(false);
    expect(isDangerousInherited('LD_LIBRARY_PATH')).toBe(false); // not LD_PRELOAD
  });
});

// ── checkSecretExpansion ─────────────────────────────────────────────────────

describe('checkSecretExpansion', () => {
  it('allows any var for user-global layer', () => {
    const result = checkSecretExpansion('AWS_SECRET_ACCESS_KEY', 'user-global', 'my-server');
    expect(result.allowed).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it('allows any var for cli layer', () => {
    const result = checkSecretExpansion('OPENAI_API_KEY', 'cli', 'my-server');
    expect(result.allowed).toBe(true);
  });

  it('allows any var for plugin layer', () => {
    const result = checkSecretExpansion('ANTHROPIC_API_KEY', 'plugin', 'my-server');
    expect(result.allowed).toBe(true);
  });

  it('blocks secret patterns for project layer', () => {
    const result = checkSecretExpansion('AWS_SECRET_ACCESS_KEY', 'project', 'my-server');
    expect(result.allowed).toBe(false);
    expect(result.warning).toMatch(/blocked secret expansion/);
    expect(result.warning).toMatch(/AWS_SECRET_ACCESS_KEY/);
    expect(result.warning).toMatch(/allowSecretEnv/);
  });

  it('allows non-secret vars for project layer', () => {
    const result = checkSecretExpansion('DATABASE_URL', 'project', 'my-server');
    expect(result.allowed).toBe(true);
  });

  it('respects allowSecretEnv opt-in for project layer', () => {
    const result = checkSecretExpansion(
      'MY_PROJECT_TOKEN',
      'project',
      'my-server',
      ['MY_PROJECT_TOKEN'],
    );
    expect(result.allowed).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it('still blocks vars not in the allowSecretEnv list', () => {
    const result = checkSecretExpansion(
      'OTHER_SECRET',
      'project',
      'my-server',
      ['MY_PROJECT_TOKEN'],
    );
    expect(result.allowed).toBe(false);
  });

  it('includes server name in warning', () => {
    const result = checkSecretExpansion('AWS_ACCESS_KEY_ID', 'project', 'cool-server');
    expect(result.warning).toMatch(/\[mcp:cool-server\]/);
  });
});

// ── trust boundary: project layer cannot self-authorize ────────────────────────

describe('trust boundary: project-layer allowSecretEnv ignored', () => {
  it('checkSecretExpansion blocks secret when no trusted list is passed (project config cannot self-authorize)', () => {
    // Simulate: project .mcp.json has allowSecretEnv but caller passes empty trusted list
    // (transport now uses trustedAllowSecretEnv from user config, not config.allowSecretEnv)
    const result = checkSecretExpansion(
      'AWS_SECRET_ACCESS_KEY',
      'project',
      'evil-server',
      [], // <-- empty trusted list; project config's allowSecretEnv is NOT passed here
    );
    expect(result.allowed).toBe(false);
    // Warning should point to the user-global config, not the project file
    expect(result.warning).toMatch(/~\/.afk\/config\/mcp\.json/);
  });

  it('warning directs user to ~/.afk/config/mcp.json, not project .mcp.json', () => {
    const result = checkSecretExpansion('OPENAI_API_KEY', 'project', 'my-srv');
    expect(result.allowed).toBe(false);
    expect(result.warning).toContain('~/.afk/config/mcp.json');
    expect(result.warning).toContain('project files cannot self-authorize');
  });

  it('user-global config allowSecretEnv (passed as trusted list) is still honoured', () => {
    // When the CALLER (transport) passes the user-global allowlist, it works
    const result = checkSecretExpansion(
      'MY_PROJECT_TOKEN',
      'project',
      'my-server',
      ['MY_PROJECT_TOKEN'], // comes from user-global config, not project file
    );
    expect(result.allowed).toBe(true);
    expect(result.warning).toBeUndefined();
  });
});

// ── scrubDangerousEnv ────────────────────────────────────────────────────────

describe('scrubDangerousEnv', () => {
  it('removes dangerous vars and returns scrubbed list', () => {
    const base: Record<string, string> = {
      PATH: '/usr/bin',
      HOME: '/home/user',
      NODE_OPTIONS: '--require evil.js',
      LD_PRELOAD: '/evil/lib.so',
      DYLD_LIBRARY_PATH: '/evil/dylib',
      PYTHONPATH: '/evil/pypath',
    };
    const scrubbed = scrubDangerousEnv(base);
    expect(scrubbed.sort()).toEqual(['DYLD_LIBRARY_PATH', 'LD_PRELOAD', 'NODE_OPTIONS', 'PYTHONPATH'].sort());
    expect(base).toEqual({ PATH: '/usr/bin', HOME: '/home/user' });
  });

  it('returns empty array when nothing to scrub', () => {
    const base = { PATH: '/usr/bin', HOME: '/home/user' };
    const scrubbed = scrubDangerousEnv(base);
    expect(scrubbed).toEqual([]);
    expect(base).toEqual({ PATH: '/usr/bin', HOME: '/home/user' });
  });

  it('mutates base in-place', () => {
    const base: Record<string, string> = { NODE_OPTIONS: '--bad', PORT: '3000' };
    scrubDangerousEnv(base);
    expect('NODE_OPTIONS' in base).toBe(false);
    expect(base['PORT']).toBe('3000');
  });
});

// ── expandEnvStringForLayer ───────────────────────────────────────────────────

describe('expandEnvStringForLayer', () => {
  it('expands non-secret vars for project layer normally', () => {
    const warn = vi.fn();
    const result = expandEnvStringForLayer(
      'host=${DATABASE_HOST}',
      { layer: 'project', serverName: 'db' },
      { DATABASE_HOST: 'localhost' },
      warn,
    );
    expect(result.value).toBe('host=localhost');
    expect(result.blocked).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('blocks secret vars for project layer and emits warning', () => {
    const warn = vi.fn();
    const result = expandEnvStringForLayer(
      'Bearer ${OPENAI_API_KEY}',
      { layer: 'project', serverName: 'openai-tool' },
      { OPENAI_API_KEY: 'sk-secret' },
      warn,
    );
    expect(result.value).toBe('Bearer ');
    expect(result.blocked).toEqual(['OPENAI_API_KEY']);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatch(/OPENAI_API_KEY/);
  });

  it('allows secret vars for user-global layer without warning', () => {
    const warn = vi.fn();
    const result = expandEnvStringForLayer(
      'Bearer ${OPENAI_API_KEY}',
      { layer: 'user-global', serverName: 'openai-tool' },
      { OPENAI_API_KEY: 'sk-secret' },
      warn,
    );
    expect(result.value).toBe('Bearer sk-secret');
    expect(result.blocked).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('respects allowSecretEnv opt-in for project layer', () => {
    const warn = vi.fn();
    const result = expandEnvStringForLayer(
      '${MY_TOKEN}',
      { layer: 'project', serverName: 'my-server', allowSecretEnv: ['MY_TOKEN'] },
      { MY_TOKEN: 'tok-xyz' },
      warn,
    );
    expect(result.value).toBe('tok-xyz');
    expect(result.blocked).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('escapes $${VAR} regardless of layer', () => {
    const warn = vi.fn();
    const result = expandEnvStringForLayer(
      '$${LITERAL}',
      { layer: 'project', serverName: 'test' },
      { LITERAL: 'unused' },
      warn,
    );
    expect(result.value).toBe('${LITERAL}');
    expect(result.blocked).toEqual([]);
  });

  it('reports missing (unset) vars separately from blocked vars', () => {
    const warn = vi.fn();
    const result = expandEnvStringForLayer(
      '${MISSING_VAR} ${AWS_SECRET_KEY}',
      { layer: 'project', serverName: 'srv' },
      { /* nothing set */ },
      warn,
    );
    // MISSING_VAR is not a secret pattern — goes in missing
    expect(result.missing).toContain('MISSING_VAR');
    // AWS_SECRET_KEY is a secret pattern — goes in blocked
    expect(result.blocked).toContain('AWS_SECRET_KEY');
  });
});

// ── expandEnvRecordForLayer ───────────────────────────────────────────────────

describe('expandEnvRecordForLayer', () => {
  it('returns empty result for undefined input', () => {
    const warn = vi.fn();
    const result = expandEnvRecordForLayer(
      undefined,
      { layer: 'project', serverName: 'srv' },
      {},
      warn,
    );
    expect(result).toEqual({ value: {}, missing: [], blocked: [] });
  });

  it('aggregates blocked across all values, de-duplicated', () => {
    const warn = vi.fn();
    const result = expandEnvRecordForLayer(
      { A: '${AWS_ACCESS_KEY_ID}', B: '${AWS_ACCESS_KEY_ID}', C: '${OPENAI_API_KEY}' },
      { layer: 'project', serverName: 'srv' },
      { AWS_ACCESS_KEY_ID: 'key', OPENAI_API_KEY: 'sk' },
      warn,
    );
    expect(result.blocked.sort()).toEqual(['AWS_ACCESS_KEY_ID', 'OPENAI_API_KEY'].sort());
    // 3 placeholder occurrences but 2 warn calls per unique blocking event
    // (2 expansions of AWS + 1 OPENAI = 3 total warn calls is fine too,
    //  what matters is blocked list is de-duped)
    expect(result.blocked).toHaveLength(2);
  });

  it('does not block anything for user-global layer', () => {
    const warn = vi.fn();
    const result = expandEnvRecordForLayer(
      { KEY: '${ANTHROPIC_API_KEY}', HOST: '${DB_HOST}' },
      { layer: 'user-global', serverName: 'srv' },
      { ANTHROPIC_API_KEY: 'ak-secret', DB_HOST: 'localhost' },
      warn,
    );
    expect(result.value).toEqual({ KEY: 'ak-secret', HOST: 'localhost' });
    expect(result.blocked).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('handles mixed secret + safe vars for project layer', () => {
    const warn = vi.fn();
    const result = expandEnvRecordForLayer(
      { SAFE: '${APP_PORT}', SECRET: '${DB_PASSWORD}' },
      { layer: 'project', serverName: 'mixed' },
      { APP_PORT: '3000', DB_PASSWORD: 's3cr3t' },
      warn,
    );
    expect(result.value['SAFE']).toBe('3000');
    expect(result.value['SECRET']).toBe(''); // blocked → empty
    expect(result.blocked).toContain('DB_PASSWORD');
    expect(warn).toHaveBeenCalled();
  });
});
