/**
 * Direct unit tests for the path-root breadth guards.
 *
 * `isTooBroadRoot` is covered transitively through `input-parse.test.ts` (every
 * rejection message it produces is asserted there); this file covers the #852
 * ancestor guard at the function boundary, plus the coupling property that ties
 * it to the bash-restriction filter it defends.
 */

import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isTooBroadRoot, ungatedSensitiveRoot } from './root-validation.js';
import { deriveRestrictedSubstrings } from '../hooks/bash-restriction-hook.js';

const HOME = os.homedir();

/** The unfiltered candidate list — what the bash floor protects. */
function allCandidates(): string[] {
  return deriveRestrictedSubstrings({ resolveBase: undefined, readRoots: [], writeRoots: [] });
}

/**
 * The ancestor-coverage predicate as spelled in `source`, normalized so the two
 * call sites are comparable: the named-import spelling (`isAbsolute`) and the
 * namespace spelling (`path.isAbsolute`) fold together, as does whitespace.
 * Deliberately source-text based — see the predicate-identity case below for why
 * a behavioural assertion cannot cover this on POSIX.
 */
function coveragePredicate(source: string): string {
  const match = source.match(/if \((rel === ''[\s\S]*?)\)\s*return /);
  if (match?.[1] === undefined) {
    throw new Error('coverage predicate not found — did the `rel` binding get renamed?');
  }
  return match[1]
    .replace(/\bpath\.isAbsolute\b/g, 'isAbsolute')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('ungatedSensitiveRoot (#852)', () => {
  describe('rejects roots that would erase a credential floor', () => {
    it('flags the credential root itself', () => {
      // The issue's vector. Note this root is NOT caught by either pre-existing
      // guard: isTooBroadRoot anchors on / + home + the AFK dirs, and the read
      // denylist covers only the per-browser subtrees beneath it.
      const appSupport = path.join(HOME, 'Library', 'Application Support');
      expect(isTooBroadRoot(appSupport)).toBe(false);
      expect(ungatedSensitiveRoot(appSupport)).toBe(appSupport);
    });

    it('flags a parent of a credential root', () => {
      expect(ungatedSensitiveRoot(path.join(HOME, 'Library'))).toBeDefined();
      expect(ungatedSensitiveRoot(path.join(HOME, '.config'))).toBeDefined();
      expect(ungatedSensitiveRoot(path.join(HOME, '.afk'))).toBeDefined();
      expect(ungatedSensitiveRoot('/etc')).toBeDefined();
    });

    it('returns WHICH root would be un-gated, not just a boolean', () => {
      // The parse-layer error embeds this so the model can narrow the grant
      // instead of guessing which of ~25 roots it collided with.
      expect(ungatedSensitiveRoot(path.join(HOME, '.config'))).toBe(
        path.join(HOME, '.config', 'gh'),
      );
    });
  });

  describe('does not over-reject', () => {
    it('allows ordinary out-of-repo dirs', () => {
      for (const p of ['/tmp/scratch', '/abs/data', path.join(HOME, 'Downloads')]) {
        expect(ungatedSensitiveRoot(p)).toBeUndefined();
      }
    });

    it('allows a path INSIDE a sensitive tree', () => {
      // Containment direction: a grant below a credential root does not lift
      // that root, so it is not this guard's concern.
      expect(
        ungatedSensitiveRoot(path.join(HOME, 'Library', 'Application Support', 'App', 'x')),
      ).toBeUndefined();
      expect(ungatedSensitiveRoot(path.join(HOME, '.config', 'someapp'))).toBeUndefined();
    });

    it('allows the deliberately-grantable AFK state + framework dirs', () => {
      // Confined forks legitimately read these (the Gap A / Gap C grants in
      // forkSubagent); neither is an ancestor of ~/.afk/config.
      expect(ungatedSensitiveRoot(path.join(HOME, '.afk', 'state'))).toBeUndefined();
      expect(ungatedSensitiveRoot(path.join(HOME, '.afk', 'agent-framework'))).toBeUndefined();
    });

    it('allows a not-yet-created path without collapsing to its nearest existing ancestor', () => {
      // realpathSafe re-appends the trailing segments for a missing path, so a
      // non-existent grant must not be judged as if it were its existing parent
      // (which would reject nearly everything).
      expect(ungatedSensitiveRoot('/tmp/definitely-not-created-852/a/b')).toBeUndefined();
    });
  });

  it('resolves symlinks before judging (a link INTO an ancestor is still rejected)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk852-'));
    const link = path.join(dir, 'link');
    try {
      // Target must EXIST on every platform the suite runs on: realpathSafe
      // falls back to re-appending the trailing segments for an unresolvable
      // path, so a DANGLING link resolves to the link's own path and would
      // silently assert nothing. The home dir exists everywhere and is an
      // ancestor of the home-anchored credential roots (~/.ssh, …); a
      // home-relative target like ~/Library is macOS-only and would make this
      // case vacuous on Linux CI rather than failing loudly.
      fs.symlinkSync(HOME, link, 'dir');
      // Lexically innocuous (/tmp/...), but its realpath is an ancestor of a
      // credential root — the lexical-only check that #664 closed for
      // isTooBroadRoot would have passed it.
      expect(ungatedSensitiveRoot(link)).toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Invariant: this is the property the whole fix rests on, and it is why the
  // guard reuses `deriveRestrictedSubstrings` instead of keeping its own list
  // of roots. A root the guard ACCEPTS must leave the bash floor completely
  // intact; if the two ever drift — someone adds a root to the bash floor but
  // not to the guard's notion of sensitive — this fails rather than silently
  // reopening #852 for the newly-added root.
  it('lockstep: any root the guard accepts drops NOTHING from the bash floor', () => {
    const full = allCandidates();
    const accepted = [
      '/tmp/scratch',
      '/abs/data',
      path.join(HOME, 'Downloads'),
      path.join(HOME, '.afk', 'state'),
      path.join(HOME, '.afk', 'agent-framework'),
      path.join(HOME, 'Library', 'Application Support', 'App', 'x'),
      path.join(HOME, '.config', 'someapp'),
    ];
    for (const root of accepted) {
      expect(ungatedSensitiveRoot(root)).toBeUndefined();
      const withGrant = deriveRestrictedSubstrings({
        resolveBase: undefined,
        readRoots: [root],
        writeRoots: [],
      });
      expect(withGrant).toEqual(full);
    }
  });

  it('lockstep: every root the bash floor protects is itself refused as a grant', () => {
    // The converse direction — no candidate root may be grantable, or a model
    // could name it directly and erase exactly that one.
    for (const candidate of allCandidates()) {
      expect(ungatedSensitiveRoot(candidate)).toBeDefined();
    }
  });

  // Invariant: the two lockstep cases above compare a root against ITSELF or
  // against an UNRELATED root, and on POSIX those are the only reachable
  // topologies — `path.relative` between two absolute POSIX paths is never
  // absolute. The one topology where the guard and the filter can DISAGREE is a
  // win32 cross-drive pair, where relative() yields a drive-qualified ABSOLUTE
  // string; a behavioural test for it therefore only runs on the opt-in windows
  // CI leg (see hooks/bash-restriction-hook.test.ts). This case is the guard
  // that runs everywhere: it pins the two coverage predicates as textually
  // identical, so dropping `isAbsolute` from either side fails here on every
  // platform instead of silently reopening #852 on Windows only.
  it('predicate identity: guard and bash filter spell coverage the same way', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const guardSrc = fs.readFileSync(path.join(here, 'root-validation.ts'), 'utf8');
    const filterSrc = fs.readFileSync(
      path.join(here, '..', 'hooks', 'bash-restriction-hook.ts'),
      'utf8',
    );
    expect(coveragePredicate(guardSrc)).toBe(coveragePredicate(filterSrc));
    // Pin the shape too, so an edit that weakens BOTH sides in lockstep still fails.
    expect(coveragePredicate(guardSrc)).toBe(
      "rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))",
    );
  });
});
