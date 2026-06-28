import { describe, it, expect } from 'vitest';
import { loadBrowserConfig, enforceDomainPolicy } from './config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal env record with optional overrides. */
function makeEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { ...overrides };
}

/** readFileSync stub that always returns "file not found". */
function noFile(_path: string): string | undefined {
  return undefined;
}

/** readFileSync stub that returns the given JSON string for any path. */
function withFile(content: string): (path: string) => string | undefined {
  return (_path: string) => content;
}

// ---------------------------------------------------------------------------
// Headless defaults per surface
// ---------------------------------------------------------------------------

describe('loadBrowserConfig — headless default per surface', () => {
  // 'afk' is the surface string the CLI sets for the whole process
  // (src/cli/index.ts), so it must default to headless — otherwise web_scrape's
  // render escalation opens visible Chromium windows. See the regression test
  // below.
  const headlessSurfaces = ['daemon', 'subagent', 'telegram', 'afk'] as const;
  const headedSurfaces = ['repl', 'interactive', 'cli'] as const;

  for (const surface of headlessSurfaces) {
    it(`surface="${surface}" → headless: true`, () => {
      const cfg = loadBrowserConfig({ surface, env: makeEnv(), readFileSync: noFile });
      expect(cfg.headless).toBe(true);
    });
  }

  for (const surface of headedSurfaces) {
    it(`surface="${surface}" → headless: false`, () => {
      const cfg = loadBrowserConfig({ surface, env: makeEnv(), readFileSync: noFile });
      expect(cfg.headless).toBe(false);
    });
  }

  it('unset surface → headless: false (headed default)', () => {
    const cfg = loadBrowserConfig({ env: makeEnv(), readFileSync: noFile });
    expect(cfg.headless).toBe(false);
  });

  it('unknown surface string → headless: false (headed default)', () => {
    const cfg = loadBrowserConfig({ surface: 'something-exotic', env: makeEnv(), readFileSync: noFile });
    expect(cfg.headless).toBe(false);
  });

  // Regression: the CLI entrypoint sets AGENT_SURFACE='afk' for the whole
  // process, so 'afk' — not 'cli'/'repl'/'interactive' — is the surface every
  // run actually reports. Before this was added to HEADLESS_SURFACES, 'afk'
  // fell through to the headed default and web_scrape's render escalation
  // launched a VISIBLE Chromium window (many at once under parallel scrapes).
  it("surface='afk' (the real default CLI surface) → headless: true", () => {
    const cfg = loadBrowserConfig({ surface: 'afk', env: makeEnv(), readFileSync: noFile });
    expect(cfg.headless).toBe(true);
  });

  it("surface='afk' with AFK_BROWSER_HEADLESS=0 → headless: false (env opt-in to headed)", () => {
    const cfg = loadBrowserConfig({
      surface: 'afk',
      env: makeEnv({ AFK_BROWSER_HEADLESS: '0' }),
      readFileSync: noFile,
    });
    expect(cfg.headless).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AFK_BROWSER_HEADLESS env override
// ---------------------------------------------------------------------------

describe('loadBrowserConfig — AFK_BROWSER_HEADLESS override', () => {
  const headlessTruthy = ['1', 'true', 'yes', 'TRUE', 'YES', 'True'];
  const headlessFalsy = ['0', 'false', 'no', 'FALSE', 'NO', 'False'];

  for (const val of headlessTruthy) {
    it(`AFK_BROWSER_HEADLESS="${val}" on a headed surface → headless: true`, () => {
      const cfg = loadBrowserConfig({
        surface: 'cli',
        env: makeEnv({ AFK_BROWSER_HEADLESS: val }),
        readFileSync: noFile,
      });
      expect(cfg.headless).toBe(true);
    });
  }

  for (const val of headlessFalsy) {
    it(`AFK_BROWSER_HEADLESS="${val}" on a headless surface → headless: false`, () => {
      const cfg = loadBrowserConfig({
        surface: 'daemon',
        env: makeEnv({ AFK_BROWSER_HEADLESS: val }),
        readFileSync: noFile,
      });
      expect(cfg.headless).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Domain list parsing
// ---------------------------------------------------------------------------

describe('loadBrowserConfig — domain list comma-split + trim', () => {
  it('splits and trims allowed domains', () => {
    const cfg = loadBrowserConfig({
      env: makeEnv({ AFK_BROWSER_ALLOWED_DOMAINS: ' github.com , *.atlassian.net , example.org ' }),
      readFileSync: noFile,
    });
    expect(cfg.allowedDomains).toEqual(['github.com', '*.atlassian.net', 'example.org']);
  });

  it('filters out empty entries', () => {
    const cfg = loadBrowserConfig({
      env: makeEnv({ AFK_BROWSER_ALLOWED_DOMAINS: 'github.com,,example.org,' }),
      readFileSync: noFile,
    });
    expect(cfg.allowedDomains).toEqual(['github.com', 'example.org']);
  });

  it('unset allowed domains → empty array (permissive)', () => {
    const cfg = loadBrowserConfig({ env: makeEnv(), readFileSync: noFile });
    expect(cfg.allowedDomains).toEqual([]);
  });

  it('splits and trims blocked domains', () => {
    const cfg = loadBrowserConfig({
      env: makeEnv({ AFK_BROWSER_BLOCKED_DOMAINS: ' *.ads.example.com , badsite.io ' }),
      readFileSync: noFile,
    });
    expect(cfg.blockedDomains).toEqual(['*.ads.example.com', 'badsite.io']);
  });

  it('lowercases domain entries', () => {
    const cfg = loadBrowserConfig({
      env: makeEnv({ AFK_BROWSER_ALLOWED_DOMAINS: 'GITHUB.COM' }),
      readFileSync: noFile,
    });
    expect(cfg.allowedDomains).toEqual(['github.com']);
  });
});

// ---------------------------------------------------------------------------
// Backend validation
// ---------------------------------------------------------------------------

describe('loadBrowserConfig — backend', () => {
  it('unset backend → "playwright"', () => {
    const cfg = loadBrowserConfig({ env: makeEnv(), readFileSync: noFile });
    expect(cfg.backend).toBe('playwright');
  });

  it('AFK_BROWSER_BACKEND=playwright → "playwright"', () => {
    const cfg = loadBrowserConfig({
      env: makeEnv({ AFK_BROWSER_BACKEND: 'playwright' }),
      readFileSync: noFile,
    });
    expect(cfg.backend).toBe('playwright');
  });

  it('unknown backend value throws with descriptive message', () => {
    expect(() =>
      loadBrowserConfig({
        env: makeEnv({ AFK_BROWSER_BACKEND: 'cdp' }),
        readFileSync: noFile,
      }),
    ).toThrow('AFK_BROWSER_BACKEND: only "playwright" is supported in Phase 1, got: cdp');
  });

  it('unknown backend value "puppeteer" throws', () => {
    expect(() =>
      loadBrowserConfig({
        env: makeEnv({ AFK_BROWSER_BACKEND: 'puppeteer' }),
        readFileSync: noFile,
      }),
    ).toThrow('AFK_BROWSER_BACKEND: only "playwright" is supported in Phase 1, got: puppeteer');
  });
});

// ---------------------------------------------------------------------------
// JSON file override
// ---------------------------------------------------------------------------

describe('loadBrowserConfig — JSON file override', () => {
  it('file headless wins over env-derived headless', () => {
    // env-derived would be headed (cli surface, no AFK_BROWSER_HEADLESS)
    const fileContent = JSON.stringify({ headless: true });
    const cfg = loadBrowserConfig({
      surface: 'cli',
      env: makeEnv(),
      readFileSync: withFile(fileContent),
    });
    expect(cfg.headless).toBe(true);
  });

  it('file allowedDomains replaces (not appends) env-derived list', () => {
    const fileContent = JSON.stringify({ allowedDomains: ['file.example.com'] });
    const cfg = loadBrowserConfig({
      env: makeEnv({ AFK_BROWSER_ALLOWED_DOMAINS: 'env.example.com' }),
      readFileSync: withFile(fileContent),
    });
    expect(cfg.allowedDomains).toEqual(['file.example.com']);
  });

  it('file blockedDomains replaces env-derived list', () => {
    const fileContent = JSON.stringify({ blockedDomains: ['bad.example.com'] });
    const cfg = loadBrowserConfig({
      env: makeEnv({ AFK_BROWSER_BLOCKED_DOMAINS: 'env-blocked.example.com' }),
      readFileSync: withFile(fileContent),
    });
    expect(cfg.blockedDomains).toEqual(['bad.example.com']);
  });

  it('file domSnapshots wins over env value', () => {
    const fileContent = JSON.stringify({ domSnapshots: true });
    const cfg = loadBrowserConfig({
      env: makeEnv(),
      readFileSync: withFile(fileContent),
    });
    expect(cfg.domSnapshots).toBe(true);
  });

  it('configPath is set to the resolved path when file was loaded', () => {
    const fileContent = JSON.stringify({});
    let capturedPath = '';
    const readFileSync = (path: string): string | undefined => {
      capturedPath = path;
      return fileContent;
    };
    const cfg = loadBrowserConfig({ env: makeEnv(), readFileSync });
    expect(cfg.configPath).toBe(capturedPath);
    expect(cfg.configPath).not.toBeNull();
  });

  it('configPath is null when no file is present', () => {
    const cfg = loadBrowserConfig({ env: makeEnv(), readFileSync: noFile });
    expect(cfg.configPath).toBeNull();
  });

  it('AFK_BROWSER_CONFIG env var sets explicit config path', () => {
    const fileContent = JSON.stringify({ headless: true });
    const readFileSync = (path: string): string | undefined => {
      return path === '/custom/path/browser.json' ? fileContent : undefined;
    };
    const cfg = loadBrowserConfig({
      env: makeEnv({ AFK_BROWSER_CONFIG: '/custom/path/browser.json' }),
      readFileSync,
    });
    expect(cfg.headless).toBe(true);
    expect(cfg.configPath).toBe('/custom/path/browser.json');
  });

  it('env values apply when file keys are absent (partial file)', () => {
    // Only headless is in the file; domain lists come from env
    const fileContent = JSON.stringify({ headless: true });
    const cfg = loadBrowserConfig({
      surface: 'cli',
      env: makeEnv({ AFK_BROWSER_ALLOWED_DOMAINS: 'github.com' }),
      readFileSync: withFile(fileContent),
    });
    expect(cfg.headless).toBe(true);
    expect(cfg.allowedDomains).toEqual(['github.com']);
  });
});

// ---------------------------------------------------------------------------
// enforceDomainPolicy
// ---------------------------------------------------------------------------

describe('enforceDomainPolicy', () => {
  // Contract: block beats allow. A URL that matches the blocklist is refused
  // even if it would also match the allowlist.
  it('block beats allow: blocked+allowed host → denied', () => {
    const cfg = loadBrowserConfig({
      env: makeEnv({
        AFK_BROWSER_ALLOWED_DOMAINS: '*.atlassian.net',
        AFK_BROWSER_BLOCKED_DOMAINS: '*.atlassian.net',
      }),
      readFileSync: noFile,
    });
    const result = enforceDomainPolicy('https://acme.atlassian.net/board', cfg);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('blocked by AFK_BROWSER_BLOCKED_DOMAINS');
      expect(result.reason).toContain('*.atlassian.net');
    }
  });

  it('*.atlassian.net matches acme.atlassian.net', () => {
    const cfg = loadBrowserConfig({
      env: makeEnv({ AFK_BROWSER_ALLOWED_DOMAINS: '*.atlassian.net' }),
      readFileSync: noFile,
    });
    expect(enforceDomainPolicy('https://acme.atlassian.net/', cfg)).toEqual({ allowed: true });
  });

  it('*.atlassian.net does NOT match foo.bar.atlassian.net', () => {
    const cfg = loadBrowserConfig({
      env: makeEnv({ AFK_BROWSER_ALLOWED_DOMAINS: '*.atlassian.net' }),
      readFileSync: noFile,
    });
    const result = enforceDomainPolicy('https://foo.bar.atlassian.net/', cfg);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('not in AFK_BROWSER_ALLOWED_DOMAINS');
    }
  });

  it('empty allowlist → permissive (any host allowed)', () => {
    const cfg = loadBrowserConfig({ env: makeEnv(), readFileSync: noFile });
    expect(enforceDomainPolicy('https://anything.example.com/', cfg)).toEqual({ allowed: true });
  });

  it('non-empty allowlist refuses non-matching host', () => {
    const cfg = loadBrowserConfig({
      env: makeEnv({ AFK_BROWSER_ALLOWED_DOMAINS: 'github.com' }),
      readFileSync: noFile,
    });
    const result = enforceDomainPolicy('https://evil.com/', cfg);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('not in AFK_BROWSER_ALLOWED_DOMAINS');
    }
  });

  it('non-empty allowlist allows exact matching host', () => {
    const cfg = loadBrowserConfig({
      env: makeEnv({ AFK_BROWSER_ALLOWED_DOMAINS: 'github.com' }),
      readFileSync: noFile,
    });
    expect(enforceDomainPolicy('https://github.com/owner/repo', cfg)).toEqual({ allowed: true });
  });

  it('blocked domain is refused even when allowlist is empty', () => {
    const cfg = loadBrowserConfig({
      env: makeEnv({ AFK_BROWSER_BLOCKED_DOMAINS: 'bad.example.com' }),
      readFileSync: noFile,
    });
    const result = enforceDomainPolicy('https://bad.example.com/', cfg);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('blocked by AFK_BROWSER_BLOCKED_DOMAINS');
    }
  });

  it('host not on blocklist is allowed when allowlist is empty', () => {
    const cfg = loadBrowserConfig({
      env: makeEnv({ AFK_BROWSER_BLOCKED_DOMAINS: 'bad.example.com' }),
      readFileSync: noFile,
    });
    expect(enforceDomainPolicy('https://safe.example.com/', cfg)).toEqual({ allowed: true });
  });

  it('glob *.example.com does not match example.com itself', () => {
    const cfg = loadBrowserConfig({
      env: makeEnv({ AFK_BROWSER_ALLOWED_DOMAINS: '*.example.com' }),
      readFileSync: noFile,
    });
    const result = enforceDomainPolicy('https://example.com/', cfg);
    expect(result.allowed).toBe(false);
  });

  it('URL host comparison is case-insensitive', () => {
    const cfg = loadBrowserConfig({
      env: makeEnv({ AFK_BROWSER_ALLOWED_DOMAINS: 'github.com' }),
      readFileSync: noFile,
    });
    // Browsers normalise hostnames to lowercase; URL constructor does too.
    expect(enforceDomainPolicy('https://github.com/', cfg)).toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------
// Session-vault default profile
// ---------------------------------------------------------------------------

describe('loadBrowserConfig — defaultProfile (session vault)', () => {
  it('defaults to "default" when AFK_BROWSER_DEFAULT_PROFILE is unset', () => {
    const cfg = loadBrowserConfig({ env: makeEnv(), readFileSync: noFile });
    expect(cfg.defaultProfile).toBe('default');
  });

  it('treats empty/whitespace as unset → "default"', () => {
    expect(
      loadBrowserConfig({ env: makeEnv({ AFK_BROWSER_DEFAULT_PROFILE: '' }), readFileSync: noFile })
        .defaultProfile,
    ).toBe('default');
    expect(
      loadBrowserConfig({ env: makeEnv({ AFK_BROWSER_DEFAULT_PROFILE: '   ' }), readFileSync: noFile })
        .defaultProfile,
    ).toBe('default');
  });

  it('reads and trims a custom profile name from env', () => {
    const cfg = loadBrowserConfig({
      env: makeEnv({ AFK_BROWSER_DEFAULT_PROFILE: '  work  ' }),
      readFileSync: noFile,
    });
    expect(cfg.defaultProfile).toBe('work');
  });

  it('throws on an unsafe (path-traversal) profile name', () => {
    expect(() =>
      loadBrowserConfig({
        env: makeEnv({ AFK_BROWSER_DEFAULT_PROFILE: '../../etc' }),
        readFileSync: noFile,
      }),
    ).toThrow(/Invalid browser profile/);
  });

  it('lets browser.json override the env profile', () => {
    const cfg = loadBrowserConfig({
      env: makeEnv({ AFK_BROWSER_DEFAULT_PROFILE: 'work' }),
      readFileSync: withFile(JSON.stringify({ defaultProfile: 'staging' })),
    });
    expect(cfg.defaultProfile).toBe('staging');
  });
});
