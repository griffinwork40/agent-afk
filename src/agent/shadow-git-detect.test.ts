/**
 * Unit tests for the shadow-git detector (issue #3758).
 *
 * Covers:
 *   (A) --no-verify on git push / git commit
 *   (B) explicit author/committer identity override (--author, -c user.email=,
 *       GIT_AUTHOR_EMAIL, GIT_COMMITTER_EMAIL)
 *   Exemptions: Co-authored-by trailers, known-bot identities, agent email
 *   Hook wiring: approve-with-reason on hit, passthrough on miss, non-bash ignored
 */
import { describe, expect, it } from 'vitest';
import {
  detectShadowGit,
  createShadowGitDetect,
  SHADOW_GIT_REASON_PREFIX,
} from './shadow-git-detect.js';
import type { HookContext } from './hooks.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function bashContext(command: string): HookContext {
  return {
    event: 'PreToolUse',
    toolName: 'bash',
    input: { command },
  } as HookContext;
}

// ---------------------------------------------------------------------------
// detectShadowGit — pure detector
// ---------------------------------------------------------------------------

describe('detectShadowGit – (A) --no-verify', () => {
  it('flags git push --no-verify', () => {
    const hits = detectShadowGit('git push --no-verify origin main');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'no-verify', pattern: 'git-push-no-verify' });
  });

  it('flags git push with --no-verify before the sub-command args', () => {
    const hits = detectShadowGit('git push --no-verify');
    expect(hits[0]).toMatchObject({ kind: 'no-verify', pattern: 'git-push-no-verify' });
  });

  it('flags git commit --no-verify', () => {
    const hits = detectShadowGit('git commit --no-verify -m "wip"');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'no-verify', pattern: 'git-commit-no-verify' });
  });

  it('flags both push and commit --no-verify in a compound command', () => {
    const hits = detectShadowGit('git commit --no-verify -m "x" && git push --no-verify');
    const kinds = hits.map((h) => h.pattern);
    expect(kinds).toContain('git-commit-no-verify');
    expect(kinds).toContain('git-push-no-verify');
  });

  it('does not flag --no-verify on git fetch (unrelated sub-command)', () => {
    // git fetch has no --no-verify flag; the regex only fires on push/commit
    const hits = detectShadowGit('git fetch --no-verify');
    expect(hits).toHaveLength(0);
  });

  it('does not flag a plain git push without --no-verify', () => {
    expect(detectShadowGit('git push origin main')).toHaveLength(0);
  });

  it('does not flag echo containing --no-verify text', () => {
    // "echo '...--no-verify...'" does not match the git subcommand anchor
    expect(detectShadowGit("echo 'use git push --no-verify to skip hooks'")).toHaveLength(0);
  });
});

describe('detectShadowGit – (B) identity overrides', () => {
  it('flags git commit --author with a non-agent email', () => {
    const hits = detectShadowGit('git commit --author "Human User <human@example.com>" -m "msg"');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'identity', email: 'human@example.com' });
  });

  it('flags git commit --author= (equals form) with a non-agent email', () => {
    const hits = detectShadowGit('git commit --author="Dev <dev@corp.com>" -m "msg"');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'identity', email: 'dev@corp.com' });
  });

  it('flags -c user.email= override', () => {
    const hits = detectShadowGit('git -c user.email=human@example.com commit -m "msg"');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'identity', email: 'human@example.com' });
  });

  it('flags -c user.email= with quoted value', () => {
    const hits = detectShadowGit("git -c user.email='human@example.com' commit -m 'msg'");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'identity', email: 'human@example.com' });
  });

  it('flags GIT_AUTHOR_EMAIL env var', () => {
    const hits = detectShadowGit('GIT_AUTHOR_EMAIL=human@example.com git commit -m "msg"');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'identity', email: 'human@example.com' });
  });

  it('flags GIT_COMMITTER_EMAIL env var', () => {
    const hits = detectShadowGit('GIT_COMMITTER_EMAIL=human@example.com git commit -m "msg"');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'identity', email: 'human@example.com' });
  });

  it('does not flag the configured agent email', () => {
    expect(
      detectShadowGit('git commit --author "AFK Agent <agent@agentafk.com>" -m "fix"'),
    ).toHaveLength(0);
  });

  it('does not flag GIT_AUTHOR_EMAIL set to agent email', () => {
    expect(
      detectShadowGit('GIT_AUTHOR_EMAIL=agent@agentafk.com git commit -m "x"'),
    ).toHaveLength(0);
  });

  it('does not flag github-actions bot email', () => {
    expect(
      detectShadowGit('GIT_AUTHOR_EMAIL=github-actions@github.com git commit -m "x"'),
    ).toHaveLength(0);
  });

  it('does not flag dependabot email', () => {
    expect(
      detectShadowGit('git commit --author "dependabot <dependabot@users.noreply.github.com>" -m "bump"'),
    ).toHaveLength(0);
  });

  it('does not flag renovate bot email', () => {
    expect(
      detectShadowGit('git commit --author "Renovate Bot <renovate@whitesourcesoftware.com>" -m "bump"'),
    ).toHaveLength(0);
  });

  it('does not flag noreply@github.com', () => {
    expect(
      detectShadowGit('GIT_COMMITTER_EMAIL=noreply@github.com git commit -m "x"'),
    ).toHaveLength(0);
  });

  it('does not flag Co-authored-by trailer text (not an --author flag)', () => {
    // Co-authored-by appears in the commit message, not as a git flag
    const cmd = `git commit -m "feat: thing\n\nCo-authored-by: Human <human@example.com>"`;
    expect(detectShadowGit(cmd)).toHaveLength(0);
  });

  it('does not flag -c user.name= alone (name-only override, no email)', () => {
    expect(detectShadowGit('git -c user.name="Human User" commit -m "msg"')).toHaveLength(0);
  });

  it('deduplicates repeated email hits', () => {
    // Same email appears in both --author and GIT_AUTHOR_EMAIL
    const hits = detectShadowGit(
      'GIT_AUTHOR_EMAIL=human@example.com git commit --author "H <human@example.com>" -m "x"',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'identity', email: 'human@example.com' });
  });
});

describe('detectShadowGit – combined hits', () => {
  it('returns both no-verify and identity hits for a command with both', () => {
    const hits = detectShadowGit(
      'git commit --no-verify --author "Human <human@example.com>" -m "x"',
    );
    const kinds = hits.map((h) => h.kind);
    expect(kinds).toContain('no-verify');
    expect(kinds).toContain('identity');
  });
});

describe('detectShadowGit – edge / empty cases', () => {
  it('returns empty for empty command', () => {
    expect(detectShadowGit('')).toHaveLength(0);
  });

  it('returns empty for unrelated bash command', () => {
    expect(detectShadowGit('pnpm test')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Regression tests for review comments (issues 2, 3, 4)
// ---------------------------------------------------------------------------

describe('detectShadowGit – issue 4: git commit -n short form', () => {
  it('flags git commit -n (short form of --no-verify)', () => {
    const hits = detectShadowGit('git commit -n -m "wip"');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'no-verify', pattern: 'git-commit-no-verify' });
  });

  it('flags git commit -n with other flags', () => {
    const hits = detectShadowGit('git commit -n -a -m "wip"');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'no-verify', pattern: 'git-commit-no-verify' });
  });

  it('does not flag git push -n (push has no -n / --no-verify)', () => {
    // -n on push means --dry-run, not --no-verify; only commit is short-form
    const hits = detectShadowGit('git push -n origin main');
    expect(hits).toHaveLength(0);
  });
});

describe('detectShadowGit – issue 3: no-verify in quoted message', () => {
  it('does not flag --no-verify inside a double-quoted commit message', () => {
    expect(detectShadowGit('git commit -m "document --no-verify usage"')).toHaveLength(0);
  });

  it('does not flag --no-verify inside a single-quoted commit message', () => {
    expect(detectShadowGit("git commit -m 'document --no-verify usage'")).toHaveLength(0);
  });

  it('does not flag --no-verify in a later compound command after push', () => {
    expect(detectShadowGit('git push origin main && echo --no-verify')).toHaveLength(0);
  });

  it('does not flag --no-verify in a semicolon-separated later command', () => {
    expect(detectShadowGit('git push origin main; echo --no-verify')).toHaveLength(0);
  });

  it('does not flag --no-verify in a pipe-separated later command', () => {
    expect(detectShadowGit('git push origin main | grep --no-verify')).toHaveLength(0);
  });

  it('still flags real --no-verify on git push in compound command', () => {
    const hits = detectShadowGit('git push --no-verify origin main && echo done');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'no-verify', pattern: 'git-push-no-verify' });
  });
});

describe('detectShadowGit – issue 2: identity regexes scoped to git invocations', () => {
  it('does not flag echo of GIT_AUTHOR_EMAIL (not a git invocation)', () => {
    expect(detectShadowGit('echo GIT_AUTHOR_EMAIL=human@example.com')).toHaveLength(0);
  });

  it('does not flag rg search mentioning an email (not a git invocation)', () => {
    expect(detectShadowGit('rg "GIT_AUTHOR_EMAIL=human@example.com" .')).toHaveLength(0);
  });

  it('does not flag a commit message containing GIT_AUTHOR_EMAIL', () => {
    expect(
      detectShadowGit('git commit -m "set GIT_AUTHOR_EMAIL=human@example.com in env"'),
    ).toHaveLength(0);
  });

  it('flags GIT_AUTHOR_EMAIL when same segment calls git', () => {
    const hits = detectShadowGit('GIT_AUTHOR_EMAIL=human@example.com git commit -m "x"');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'identity', email: 'human@example.com' });
  });

  it('does not flag GIT_AUTHOR_EMAIL in a prior segment separated by semicolon', () => {
    // env-var assignment is in segment 1; git runs in segment 2 with no override
    expect(detectShadowGit('export GIT_AUTHOR_EMAIL=human@example.com; git commit -m "x"')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createShadowGitDetect — hook wiring
// ---------------------------------------------------------------------------

describe('createShadowGitDetect hook', () => {
  const hook = createShadowGitDetect();

  it('returns approve with reason prefix on a --no-verify hit', () => {
    const decision = hook(bashContext('git push --no-verify origin main'));
    expect(decision).toMatchObject({ decision: 'approve' });
    expect(typeof (decision as { reason?: string }).reason).toBe('string');
    expect((decision as { reason?: string }).reason).toMatch(SHADOW_GIT_REASON_PREFIX);
    expect((decision as { reason?: string }).reason).toContain('git-push-no-verify');
  });

  it('returns approve with reason prefix on an identity hit', () => {
    const decision = hook(bashContext('git commit --author "H <h@example.com>" -m "x"'));
    expect(decision).toMatchObject({ decision: 'approve' });
    expect((decision as { reason?: string }).reason).toMatch(SHADOW_GIT_REASON_PREFIX);
    expect((decision as { reason?: string }).reason).toContain('git-identity-override');
  });

  it('returns empty object (pass-through) when no pattern matches', () => {
    const decision = hook(bashContext('git push origin main'));
    expect(decision).toEqual({});
  });

  it('ignores non-bash tools', () => {
    const ctx = { event: 'PreToolUse', toolName: 'write_file', input: { file_path: 'x' } } as HookContext;
    expect(hook(ctx)).toEqual({});
  });

  it('ignores non-PreToolUse events', () => {
    const ctx = { event: 'PostToolUse', toolName: 'bash', input: { command: 'git push --no-verify' } } as HookContext;
    expect(hook(ctx)).toEqual({});
  });

  it('includes the offending email in the reason string', () => {
    const decision = hook(bashContext('GIT_AUTHOR_EMAIL=human@example.com git commit -m "x"'));
    expect((decision as { reason?: string }).reason).toContain('human@example.com');
  });
});
