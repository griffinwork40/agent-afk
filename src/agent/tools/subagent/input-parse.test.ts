/**
 * Direct unit tests for the pure `parseAgentInput` validator.
 *
 * Follow-up to #443: the extracted `subagent/` modules had no direct unit
 * tests, only transitive coverage through `subagent-executor.test.ts`. This
 * file covers `input-parse.ts` exhaustively at the function boundary — every
 * happy path and every rejection/edge path of the validation pipeline —
 * without going through the executor.
 *
 * `parseAgentInput` is pure (no executor instance, no I/O), so these tests are
 * plain input → output assertions with no mock harness.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { parseAgentInput, type AgentInput } from './input-parse.js';

// Invariant: the AFK breadth targets are derived from env on EVERY call, so a
// leaked `stubEnv` would silently change what later cases in this file treat as
// too-broad. Unstub after each test rather than relying on case ordering.
afterEach(() => {
  vi.unstubAllEnvs();
});

/** Escape a literal path for embedding in a `toThrow` RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('parseAgentInput', () => {
  describe('input shape', () => {
    it('throws when input is not an object (string)', () => {
      expect(() => parseAgentInput('not an object')).toThrow(/must be an object/);
    });

    it('throws when input is null', () => {
      expect(() => parseAgentInput(null)).toThrow(/must be an object/);
    });

    it('throws when input is a number', () => {
      expect(() => parseAgentInput(42)).toThrow(/must be an object/);
    });

    it('throws when input is undefined', () => {
      expect(() => parseAgentInput(undefined)).toThrow(/must be an object/);
    });

    it('accepts a plain object with only a prompt', () => {
      const result = parseAgentInput({ prompt: 'do the thing' });
      expect(result.prompt).toBe('do the thing');
    });
  });

  describe('prompt', () => {
    it('throws when prompt is missing', () => {
      expect(() => parseAgentInput({})).toThrow(
        /must have a "prompt" field of type string/,
      );
    });

    it('throws when prompt is not a string (number)', () => {
      expect(() => parseAgentInput({ prompt: 123 })).toThrow(
        /must have a "prompt" field of type string/,
      );
    });

    it('throws when prompt is an empty string', () => {
      expect(() => parseAgentInput({ prompt: '' })).toThrow(/cannot be empty/);
    });

    it('throws when prompt is whitespace-only', () => {
      expect(() => parseAgentInput({ prompt: '   \n\t  ' })).toThrow(/cannot be empty/);
    });

    it('preserves the prompt verbatim (no trimming of the stored value)', () => {
      // Only the emptiness CHECK trims; the returned prompt is the original.
      const result = parseAgentInput({ prompt: '  leading and trailing  ' });
      expect(result.prompt).toBe('  leading and trailing  ');
    });
  });

  describe('attachments', () => {
    it('accepts absolute image paths and preserves prompt as a string', () => {
      const result = parseAgentInput({ prompt: '  inspect  ', attachments: ['/tmp/a.png'] });
      expect(result.prompt).toBe('  inspect  ');
      expect(result.attachments).toEqual(['/tmp/a.png']);
    });

    it('rejects a non-array value', () => {
      expect(() => parseAgentInput({ prompt: 'p', attachments: '/tmp/a.png' })).toThrow(
        /attachments must be an array/,
      );
    });

    it('rejects non-string and empty entries', () => {
      expect(() => parseAgentInput({ prompt: 'p', attachments: [42] })).toThrow(
        /attachments entries must be strings/,
      );
      expect(() => parseAgentInput({ prompt: 'p', attachments: ['  '] })).toThrow(
        /must not be empty strings/,
      );
    });

    it('accepts inbound image ids and rejects other relative strings', () => {
      expect(parseAgentInput({ prompt: 'p', attachments: ['img_a1b2c3'] }).attachments)
        .toEqual(['img_a1b2c3']);
      expect(() => parseAgentInput({ prompt: 'p', attachments: ['a.png'] })).toThrow(
        /absolute image paths or inbound image ids/,
      );
    });

    it('rejects img_XXXX (non-hex chars in the hex portion)', () => {
      expect(() => parseAgentInput({ prompt: 'p', attachments: ['img_XXXX'] })).toThrow(
        /absolute image paths or inbound image ids/,
      );
    });

    it('rejects img_a1b2 (too short — fewer than 6 hex chars)', () => {
      expect(() => parseAgentInput({ prompt: 'p', attachments: ['img_a1b2'] })).toThrow(
        /absolute image paths or inbound image ids/,
      );
    });

    it('rejects img_a1b2c3_0 (suffix must start at 1, not 0)', () => {
      expect(() => parseAgentInput({ prompt: 'p', attachments: ['img_a1b2c3_0'] })).toThrow(
        /absolute image paths or inbound image ids/,
      );
    });

    it('rejects img_a1b2c3_01 (leading zero in suffix)', () => {
      expect(() => parseAgentInput({ prompt: 'p', attachments: ['img_a1b2c3_01'] })).toThrow(
        /absolute image paths or inbound image ids/,
      );
    });

    it('accepts img_a1b2c3_1 (valid suffix)', () => {
      expect(parseAgentInput({ prompt: 'p', attachments: ['img_a1b2c3_1'] }).attachments)
        .toEqual(['img_a1b2c3_1']);
    });

    it('accepts img_abcdef1234 (longer hex, > 6 chars)', () => {
      expect(parseAgentInput({ prompt: 'p', attachments: ['img_abcdef1234'] }).attachments)
        .toEqual(['img_abcdef1234']);
    });

    it('rejects background attachments explicitly', () => {
      expect(() =>
        parseAgentInput({ prompt: 'p', attachments: ['/tmp/a.png'], mode: 'background' }),
      ).toThrow(/not supported with mode:"background"/);
    });
  });

  describe('model', () => {
    it('defaults model to undefined when omitted', () => {
      const result = parseAgentInput({ prompt: 'p' });
      expect(result.model).toBeUndefined();
    });

    it('accepts a string model', () => {
      const result = parseAgentInput({ prompt: 'p', model: 'opus' });
      expect(result.model).toBe('opus');
    });

    it('throws when model is not a string (number)', () => {
      expect(() => parseAgentInput({ prompt: 'p', model: 5 })).toThrow(
        /model must be a string/,
      );
    });

    it('treats a null model as absent (inherit the parent model)', () => {
      // Was: threw. `null` is serializer padding for "no value", not intent.
      expect(parseAgentInput({ prompt: 'p', model: null }).model).toBeUndefined();
    });

    it('treats an empty-string model as absent rather than dispatching model ""', () => {
      expect(parseAgentInput({ prompt: 'p', model: '' }).model).toBeUndefined();
    });
  });

  describe('max_turns', () => {
    it('defaults to 0 (unlimited) and marks it non-explicit when omitted', () => {
      // #448: uncapped by default. 0 = no ceiling (matches AgentSession's
      // falsy-maxTurns = no-cap check in assertCanSend).
      const result = parseAgentInput({ prompt: 'p' });
      expect(result.max_turns).toBe(0);
      expect(result.max_turns_explicit).toBe(false);
    });

    it('marks max_turns_explicit true when supplied', () => {
      const result = parseAgentInput({ prompt: 'p', max_turns: 5 });
      expect(result.max_turns).toBe(5);
      expect(result.max_turns_explicit).toBe(true);
    });

    it('preserves a large value with no upper ceiling (100 stays 100)', () => {
      // #448 removed the old "clamp to 50" cap — the caller (or a named
      // agent's frontmatter) owns any ceiling it wants.
      const result = parseAgentInput({ prompt: 'p', max_turns: 100 });
      expect(result.max_turns).toBe(100);
      expect(result.max_turns_explicit).toBe(true);
    });

    it('preserves the former upper-boundary value unchanged (50 stays 50)', () => {
      expect(parseAgentInput({ prompt: 'p', max_turns: 50 }).max_turns).toBe(50);
    });

    it('clamps negatives up to 0 (unlimited)', () => {
      // Math.max(0, Math.floor(-5)) === 0.
      const result = parseAgentInput({ prompt: 'p', max_turns: -5 });
      expect(result.max_turns).toBe(0);
    });

    it('keeps zero as zero (unlimited)', () => {
      expect(parseAgentInput({ prompt: 'p', max_turns: 0 }).max_turns).toBe(0);
    });

    it('preserves the value 1 unchanged', () => {
      expect(parseAgentInput({ prompt: 'p', max_turns: 1 }).max_turns).toBe(1);
    });

    it('floors fractional values', () => {
      // Math.floor(3.9) === 3.
      expect(parseAgentInput({ prompt: 'p', max_turns: 3.9 }).max_turns).toBe(3);
    });

    it('floors a small fractional value down to 0 (0.5 → 0, unlimited)', () => {
      // Math.floor(0.5) === 0, then Math.max(0, 0) === 0.
      expect(parseAgentInput({ prompt: 'p', max_turns: 0.5 }).max_turns).toBe(0);
    });

    it('throws when max_turns is not a number (string)', () => {
      expect(() => parseAgentInput({ prompt: 'p', max_turns: '10' })).toThrow(
        /max_turns must be a number/,
      );
    });
  });

  describe('max_tool_use_iterations', () => {
    it('defaults to 0 (unlimited) and marks it non-explicit when omitted', () => {
      const result = parseAgentInput({ prompt: 'p' });
      expect(result.max_tool_use_iterations).toBe(0);
      expect(result.max_tool_use_iterations_explicit).toBe(false);
    });

    it('marks max_tool_use_iterations_explicit true when supplied', () => {
      const result = parseAgentInput({ prompt: 'p', max_tool_use_iterations: 8 });
      expect(result.max_tool_use_iterations).toBe(8);
      expect(result.max_tool_use_iterations_explicit).toBe(true);
    });

    it('preserves a large value with no upper ceiling (200 stays 200)', () => {
      const result = parseAgentInput({ prompt: 'p', max_tool_use_iterations: 200 });
      expect(result.max_tool_use_iterations).toBe(200);
      expect(result.max_tool_use_iterations_explicit).toBe(true);
    });

    it('clamps negatives up to 0 (unlimited)', () => {
      // Math.max(0, Math.floor(-3)) === 0.
      expect(parseAgentInput({ prompt: 'p', max_tool_use_iterations: -3 }).max_tool_use_iterations).toBe(0);
    });

    it('floors fractional values', () => {
      expect(parseAgentInput({ prompt: 'p', max_tool_use_iterations: 4.9 }).max_tool_use_iterations).toBe(4);
    });

    it('throws when max_tool_use_iterations is not a number (string)', () => {
      expect(() => parseAgentInput({ prompt: 'p', max_tool_use_iterations: '5' })).toThrow(
        /max_tool_use_iterations must be a number/,
      );
    });
  });

  describe('agent_type / subagent_type alias', () => {
    it('is undefined (key omitted) when neither is supplied', () => {
      const result = parseAgentInput({ prompt: 'p' });
      expect(result.agent_type).toBeUndefined();
      expect('agent_type' in result).toBe(false);
    });

    it('accepts agent_type', () => {
      const result = parseAgentInput({ prompt: 'p', agent_type: 'research-agent' });
      expect(result.agent_type).toBe('research-agent');
    });

    it('accepts subagent_type as an alias', () => {
      const result = parseAgentInput({ prompt: 'p', subagent_type: 'git-investigator' });
      expect(result.agent_type).toBe('git-investigator');
    });

    it('prefers the canonical agent_type when both are present', () => {
      const result = parseAgentInput({
        prompt: 'p',
        agent_type: 'canonical',
        subagent_type: 'alias',
      });
      expect(result.agent_type).toBe('canonical');
    });

    it('trims surrounding whitespace from the resolved value', () => {
      const result = parseAgentInput({ prompt: 'p', agent_type: '  research-agent  ' });
      expect(result.agent_type).toBe('research-agent');
    });

    it('treats a whitespace-only agent_type as absent (key omitted)', () => {
      // Trimmed length is 0 → agent_type stays undefined and the key is omitted.
      const result = parseAgentInput({ prompt: 'p', agent_type: '   ' });
      expect(result.agent_type).toBeUndefined();
      expect('agent_type' in result).toBe(false);
    });

    it('falls through to the alias when canonical is a whitespace-only string', () => {
      // Previously the body pinned the opposite of this title: nullish
      // coalescing (`agent_type ?? subagent_type`) let a present-but-blank
      // canonical win the `??` (it is not null/undefined), then trimmed it away
      // — so BOTH were dropped and the caller's real alias was ignored.
      // readOptional skips blanks by key order, so precedence now matches the
      // documented "canonical wins" rule only when canonical is real.
      const result = parseAgentInput({
        prompt: 'p',
        agent_type: '   ',
        subagent_type: 'alias',
      });
      expect(result.agent_type).toBe('alias');
    });

    it('keeps canonical precedence when BOTH are real', () => {
      expect(
        parseAgentInput({ prompt: 'p', agent_type: 'canonical', subagent_type: 'alias' })
          .agent_type,
      ).toBe('canonical');
    });

    it('throws when agent_type is not a string (number)', () => {
      expect(() => parseAgentInput({ prompt: 'p', agent_type: 7 })).toThrow(
        /agent_type must be a string/,
      );
    });

    it('throws when only subagent_type is supplied and it is not a string', () => {
      expect(() => parseAgentInput({ prompt: 'p', subagent_type: 7 })).toThrow(
        /agent_type must be a string/,
      );
    });
  });

  describe('id_prefix', () => {
    it("defaults to 'agent-tool' when omitted", () => {
      expect(parseAgentInput({ prompt: 'p' }).id_prefix).toBe('agent-tool');
    });

    it('accepts a custom id_prefix', () => {
      expect(parseAgentInput({ prompt: 'p', id_prefix: 'code-review' }).id_prefix).toBe(
        'code-review',
      );
    });

    it('falls back to the default for a blank id_prefix', () => {
      // Was: used '' verbatim, yielding unlabelled subagent ids. Blank is
      // not-supplied, so the default applies.
      expect(parseAgentInput({ prompt: 'p', id_prefix: '' }).id_prefix).toBe('agent-tool');
      expect(parseAgentInput({ prompt: 'p', id_prefix: null }).id_prefix).toBe('agent-tool');
    });

    it('throws when id_prefix is not a string (number)', () => {
      expect(() => parseAgentInput({ prompt: 'p', id_prefix: 1 })).toThrow(
        /id_prefix must be a string/,
      );
    });
  });

  describe('mode', () => {
    it("defaults to 'foreground' when omitted", () => {
      expect(parseAgentInput({ prompt: 'p' }).mode).toBe('foreground');
    });

    it("accepts 'foreground'", () => {
      expect(parseAgentInput({ prompt: 'p', mode: 'foreground' }).mode).toBe('foreground');
    });

    it("accepts 'background'", () => {
      expect(parseAgentInput({ prompt: 'p', mode: 'background' }).mode).toBe('background');
    });

    it('rejects an unknown mode string loudly', () => {
      expect(() => parseAgentInput({ prompt: 'p', mode: 'sideways' })).toThrow(
        /mode must be "foreground" or "background"/,
      );
    });

    it('includes the offending value in the error message', () => {
      expect(() => parseAgentInput({ prompt: 'p', mode: 'back' })).toThrow(/"back"/);
    });

    it('rejects a non-string mode (number)', () => {
      expect(() => parseAgentInput({ prompt: 'p', mode: 1 })).toThrow(
        /mode must be "foreground" or "background"/,
      );
    });
  });

  describe('cwd', () => {
    it('is undefined (key omitted) when not supplied — parent fallback preserved', () => {
      const result = parseAgentInput({ prompt: 'p' });
      expect(result.cwd).toBeUndefined();
      expect('cwd' in result).toBe(false);
    });

    it('accepts an absolute POSIX path', () => {
      expect(parseAgentInput({ prompt: 'p', cwd: '/tmp/wt/feat-x' }).cwd).toBe(
        '/tmp/wt/feat-x',
      );
    });

    it('throws when cwd is not a string (number)', () => {
      expect(() => parseAgentInput({ prompt: 'p', cwd: 42 })).toThrow(
        /cwd must be a string/,
      );
    });

    it('treats an empty-string cwd as absent (blank means not-supplied)', () => {
      // Was: threw "cwd must be a non-empty string". A model padding the
      // optional with '' read that as "cwd is required" and, because cwd and
      // isolation are mutually exclusive, gave up isolation entirely.
      const result = parseAgentInput({ prompt: 'p', cwd: '' });
      expect(result.cwd).toBeUndefined();
      expect('cwd' in result).toBe(false);
    });

    it('treats a whitespace-only cwd as absent', () => {
      expect(parseAgentInput({ prompt: 'p', cwd: '   ' }).cwd).toBeUndefined();
    });

    it('treats a null cwd as absent', () => {
      expect(parseAgentInput({ prompt: 'p', cwd: null }).cwd).toBeUndefined();
    });

    it('throws when cwd is a relative path', () => {
      expect(() => parseAgentInput({ prompt: 'p', cwd: 'relative/path' })).toThrow(
        /cwd must be an absolute path/,
      );
    });

    it('throws when cwd is a dot-relative path', () => {
      expect(() => parseAgentInput({ prompt: 'p', cwd: './also-relative' })).toThrow(
        /cwd must be an absolute path/,
      );
    });

    it("throws when cwd contains a '..' segment (forward slash)", () => {
      expect(() => parseAgentInput({ prompt: 'p', cwd: '/tmp/wt/../escape' })).toThrow(
        /must not contain '\.\.' segments/,
      );
    });

    it("throws when cwd contains a '..' segment (backslash separator, Windows-shape)", () => {
      // The segment split covers both `/` and `\` so a Windows-formatted '..'
      // is rejected even on POSIX hosts. Use an absolute POSIX prefix so the
      // isAbsolute() gate passes first and the split branch is what fires.
      expect(() => parseAgentInput({ prompt: 'p', cwd: '/tmp\\..\\escape' })).toThrow(
        /must not contain '\.\.' segments/,
      );
    });

    it("accepts a path where '..' appears only as a substring, not a whole segment", () => {
      // '..foo' and 'foo..' are legitimate segment names; only a bare '..'
      // segment is rejected. This guards against an over-eager `includes('..')`
      // on the raw string.
      const result = parseAgentInput({ prompt: 'p', cwd: '/tmp/wt/..foo/bar..baz' });
      expect(result.cwd).toBe('/tmp/wt/..foo/bar..baz');
    });

    // --- Hardening: breadth rejection (#740) — mirrors the readRoots guard ---
    it('throws when cwd is the home directory', () => {
      expect(() => parseAgentInput({ prompt: 'p', cwd: os.homedir() })).toThrow(
        /must not be a filesystem root, your home directory, or an ancestor/,
      );
    });

    it('redirects a home-directory cwd to readRoots rather than a narrower cwd', () => {
      // Observed failure: an agent asked to explain the operator's dotfiles set
      // cwd to $HOME, was refused, and re-planned around WHERE TO STAND instead
      // of WHAT TO GRANT. A read-only task should never relocate cwd.
      expect(() => parseAgentInput({ prompt: 'p', cwd: os.homedir() })).toThrow(
        /grant those paths via readRoots/,
      );
    });

    it('throws when cwd is an ancestor of the home directory', () => {
      const parentOfHome = path.dirname(os.homedir());
      expect(() => parseAgentInput({ prompt: 'p', cwd: parentOfHome })).toThrow(
        /must not be a filesystem root, your home directory, or an ancestor/,
      );
    });

    it('throws when cwd is a filesystem root', () => {
      const FS_ROOT = path.parse(path.resolve('.')).root || path.sep;
      expect(() => parseAgentInput({ prompt: 'p', cwd: FS_ROOT })).toThrow(
        /must not be a filesystem root, your home directory, or an ancestor/,
      );
    });

    // --- Hardening: breadth rejection resolves symlinks (#664 Codex P1) ---
    // `isTooBroadRoot` runs on BOTH the lexical AND the symlink-resolved form at
    // every call site (#783 follow-up to #753): the readRoots block below
    // already covers this leg, but `cwd` has its own separate `isTooBroadRoot`
    // call on `realResolvedCwd` (input-parse.ts) that was previously
    // unexercised. A symlink whose target is `/` or the home dir is not itself
    // broad lexically, but the containment layer realpaths granted roots, so it
    // becomes a broad real root at read time — same rationale as readRoots.
    it('throws when cwd is a symlink pointing at the filesystem root (#664)', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-sym-'));
      const link = path.join(dir, 'broad-link');
      const fsRoot = path.parse(dir).root || path.sep;
      try {
        fs.symlinkSync(fsRoot, link, 'dir');
        expect(() => parseAgentInput({ prompt: 'p', cwd: link })).toThrow(
          /must not be a filesystem root, your home directory, or an ancestor/,
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('throws when cwd is a symlink pointing at the home directory (#664)', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-sym-'));
      const link = path.join(dir, 'home-link');
      try {
        fs.symlinkSync(os.homedir(), link, 'dir');
        expect(() => parseAgentInput({ prompt: 'p', cwd: link })).toThrow(
          /must not be a filesystem root, your home directory, or an ancestor/,
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    // A relocated AFK_HOME is neither the home dir nor an ancestor of it, so
    // the home-only targets did not catch it — yet granting it as `cwd` empties
    // that child's AFK-anchored credential floor by exactly the route `$HOME`
    // empties the home-anchored one (the bash grant filter drops any candidate
    // whose ancestor was granted, and `${AFK_HOME}/config` is one).
    it('throws when cwd is a relocated AFK_HOME', () => {
      vi.stubEnv('AFK_HOME', '/tmp/relocated-afk-home');
      expect(() => parseAgentInput({ prompt: 'p', cwd: '/tmp/relocated-afk-home' })).toThrow(
        /must not be a filesystem root, your home directory, or an ancestor/,
      );
      // An ancestor of the relocated home is refused too.
      expect(() => parseAgentInput({ prompt: 'p', cwd: '/tmp' })).toThrow(
        /must not be a filesystem root, your home directory, or an ancestor/,
      );
    });

    it('throws when cwd is a relocated AFK_STATE_DIR', () => {
      vi.stubEnv('AFK_STATE_DIR', '/tmp/relocated-afk-state');
      expect(() => parseAgentInput({ prompt: 'p', cwd: '/tmp/relocated-afk-state' })).toThrow(
        /must not be a filesystem root, your home directory, or an ancestor/,
      );
    });

    // Descendants stay legal: a plugin/worktree dir BELOW the AFK home is a
    // legitimate cwd and must not be swept up by the breadth guard.
    it('still accepts a subdir BELOW a relocated AFK_HOME', () => {
      vi.stubEnv('AFK_HOME', '/tmp/relocated-afk-home');
      const result = parseAgentInput({ prompt: 'p', cwd: '/tmp/relocated-afk-home/plugins/x' });
      expect(result.cwd).toBe('/tmp/relocated-afk-home/plugins/x');
    });

    it('throws when a writeRoots entry is a relocated AFK_HOME', () => {
      vi.stubEnv('AFK_HOME', '/tmp/relocated-afk-home');
      expect(() =>
        parseAgentInput({ prompt: 'p', writeRoots: ['/tmp/relocated-afk-home'] }),
      ).toThrow(/must not be a filesystem root, your home directory, or an ancestor/);
    });

    // A malformed AFK_HOME must not loosen the guard: the home-anchored
    // rejections still fire, and parseAgentInput does not throw the env error.
    it('keeps the home-anchored guard when AFK_HOME is malformed', () => {
      vi.stubEnv('AFK_HOME', 'relative/not-absolute');
      expect(() => parseAgentInput({ prompt: 'p', cwd: os.homedir() })).toThrow(
        /must not be a filesystem root, your home directory, or an ancestor/,
      );
      expect(parseAgentInput({ prompt: 'p', cwd: '/tmp/wt/feat-y' }).cwd).toBe('/tmp/wt/feat-y');
    });

    it('still accepts a normal absolute project subdir (not broad)', () => {
      // The breadth guard must not over-reject: a genuine project worktree path
      // stays accepted, same as before this field grew the check.
      const result = parseAgentInput({ prompt: 'p', cwd: '/tmp/wt/feat-y' });
      expect(result.cwd).toBe('/tmp/wt/feat-y');
    });

    // --- Hardening: ancestor-of-credential rejection (#852) ---
    // cwd becomes the child's resolveBase, which deriveRestrictedSubstrings
    // seeds into `granted` alongside the explicit roots — so an ancestor cwd
    // lifts the bash floor exactly as a readRoots grant would.
    it('throws when cwd is an ancestor of a bash credential root (#852)', () => {
      const appSupport = path.join(os.homedir(), 'Library', 'Application Support');
      expect(() => parseAgentInput({ prompt: 'p', cwd: appSupport })).toThrow(
        /must not be at or above a credential root/,
      );
    });
  });

  describe('writeRoots', () => {
    it('is undefined (key omitted) when not supplied', () => {
      const result = parseAgentInput({ prompt: 'p' });
      expect(result.writeRoots).toBeUndefined();
      expect('writeRoots' in result).toBe(false);
    });

    it('accepts an array of absolute paths', () => {
      const result = parseAgentInput({ prompt: 'p', writeRoots: ['/abs/a', '/abs/b'] });
      expect(result.writeRoots).toEqual(['/abs/a', '/abs/b']);
    });

    it('throws when writeRoots is not an array (string)', () => {
      expect(() => parseAgentInput({ prompt: 'p', writeRoots: '/abs/a' })).toThrow(
        /writeRoots must be an array/,
      );
    });

    it('throws when an entry is a relative path', () => {
      expect(() => parseAgentInput({ prompt: 'p', writeRoots: ['relative/path'] })).toThrow(
        /writeRoots entries must be absolute paths/,
      );
    });

    it("throws when an entry contains a '..' segment", () => {
      expect(() =>
        parseAgentInput({ prompt: 'p', writeRoots: ['/tmp/../escape'] }),
      ).toThrow(/writeRoots entries must not contain '\.\.' segments/);
    });

    it('throws when an entry is an empty string', () => {
      expect(() => parseAgentInput({ prompt: 'p', writeRoots: [''] })).toThrow(
        /writeRoots entries must be non-empty strings/,
      );
    });

    it('normalizes an empty array to undefined (field absent)', () => {
      const result = parseAgentInput({ prompt: 'p', writeRoots: [] });
      expect(result.writeRoots).toBeUndefined();
      expect('writeRoots' in result).toBe(false);
    });

    // --- Hardening: breadth rejection (#740) — mirrors the readRoots guard ---
    it('throws when a writeRoots entry is the home directory', () => {
      expect(() => parseAgentInput({ prompt: 'p', writeRoots: [os.homedir()] })).toThrow(
        /must not be a filesystem root, your home directory, or an ancestor/,
      );
    });

    // #783 follow-up to #753/#740: `cwd` already had a filesystem-root
    // rejection case; `writeRoots` did not, despite sharing the same
    // `isTooBroadRoot` call.
    it('throws when a writeRoots entry is a filesystem root', () => {
      const FS_ROOT = path.parse(path.resolve('.')).root || path.sep;
      expect(() => parseAgentInput({ prompt: 'p', writeRoots: [FS_ROOT] })).toThrow(
        /must not be a filesystem root, your home directory, or an ancestor/,
      );
    });

    // --- Hardening: breadth rejection resolves symlinks (#664 Codex P1) ---
    // Same rationale as the `cwd` symlink cases above: `isTooBroadRoot` runs on
    // both the lexical AND symlink-resolved form of each writeRoots entry
    // (input-parse.ts), and that realpath leg was previously unexercised here.
    it('throws when a writeRoots entry is a symlink pointing at the filesystem root (#664)', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-sym-'));
      const link = path.join(dir, 'broad-link');
      const fsRoot = path.parse(dir).root || path.sep;
      try {
        fs.symlinkSync(fsRoot, link, 'dir');
        expect(() => parseAgentInput({ prompt: 'p', writeRoots: [link] })).toThrow(
          /must not be a filesystem root, your home directory, or an ancestor/,
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('throws when a writeRoots entry is a symlink pointing at the home directory (#664)', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-sym-'));
      const link = path.join(dir, 'home-link');
      try {
        fs.symlinkSync(os.homedir(), link, 'dir');
        expect(() => parseAgentInput({ prompt: 'p', writeRoots: [link] })).toThrow(
          /must not be a filesystem root, your home directory, or an ancestor/,
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('still accepts a normal absolute subdir entry (not broad)', () => {
      // The breadth guard must not over-reject: an ordinary write root stays
      // accepted, same as before this field grew the check.
      const result = parseAgentInput({ prompt: 'p', writeRoots: ['/sibling/repo'] });
      expect(result.writeRoots).toEqual(['/sibling/repo']);
    });

    it('throws when writeRoots and isolation:worktree are both supplied (mutually exclusive)', () => {
      expect(() =>
        parseAgentInput({ prompt: 'p', writeRoots: ['/abs/a'], isolation: 'worktree' }),
      ).toThrow(/writeRoots and isolation are mutually exclusive/);
    });

    it('accepts writeRoots together with cwd (the main use case)', () => {
      const result = parseAgentInput({
        prompt: 'p',
        cwd: '/tmp/wt/x',
        writeRoots: ['/sibling/repo'],
      });
      expect(result.cwd).toBe('/tmp/wt/x');
      expect(result.writeRoots).toEqual(['/sibling/repo']);
    });

    // --- Hardening: ancestor-of-credential rejection (#852) ---
    // writeRoots feed the same `granted` set in deriveRestrictedSubstrings that
    // cwd and readRoots do, so leaving this field unchecked would just relocate
    // the erosion rather than close it.
    it('throws when an entry is an ancestor of a bash credential root (#852)', () => {
      const appSupport = path.join(os.homedir(), 'Library', 'Application Support');
      expect(() => parseAgentInput({ prompt: 'p', writeRoots: [appSupport] })).toThrow(
        /must not be at or above a credential root/,
      );
    });
  });

  describe('readRoots (#662)', () => {
    // A concrete, non-broad, non-denylisted absolute path (mirrors the
    // writeRoots test style). Not a filesystem root, not the home dir nor an
    // ancestor of it, and not inside the read-denylist.
    const SAFE = '/abs/data';

    it('is undefined (key omitted) when not supplied', () => {
      const result = parseAgentInput({ prompt: 'p' });
      expect(result.readRoots).toBeUndefined();
      expect('readRoots' in result).toBe(false);
    });

    it('accepts an array of absolute paths', () => {
      const result = parseAgentInput({ prompt: 'p', readRoots: ['/abs/a', '/abs/b'] });
      expect(result.readRoots).toEqual(['/abs/a', '/abs/b']);
    });

    it('throws when readRoots is not an array (string)', () => {
      expect(() => parseAgentInput({ prompt: 'p', readRoots: '/abs/a' })).toThrow(
        /readRoots must be an array/,
      );
    });

    it('throws when an entry is a relative path', () => {
      expect(() => parseAgentInput({ prompt: 'p', readRoots: ['relative/path'] })).toThrow(
        /readRoots entries must be absolute paths/,
      );
    });

    it("throws when an entry contains a '..' segment", () => {
      expect(() =>
        parseAgentInput({ prompt: 'p', readRoots: ['/tmp/../escape'] }),
      ).toThrow(/readRoots entries must not contain '\.\.' segments/);
    });

    it('throws when an entry is an empty string', () => {
      expect(() => parseAgentInput({ prompt: 'p', readRoots: [''] })).toThrow(
        /readRoots entries must be non-empty strings/,
      );
    });

    it('normalizes an empty array to undefined (field absent)', () => {
      const result = parseAgentInput({ prompt: 'p', readRoots: [] });
      expect(result.readRoots).toBeUndefined();
      expect('readRoots' in result).toBe(false);
    });

    // --- Hardening: breadth rejection ---
    it('throws when an entry is a filesystem root', () => {
      const FS_ROOT = path.parse(path.resolve('.')).root || path.sep;
      expect(() => parseAgentInput({ prompt: 'p', readRoots: [FS_ROOT] })).toThrow(
        /must not be a filesystem root, your home directory, or an ancestor/,
      );
    });

    it('throws when an entry is the home directory', () => {
      expect(() => parseAgentInput({ prompt: 'p', readRoots: [os.homedir()] })).toThrow(
        /must not be a filesystem root, your home directory, or an ancestor/,
      );
    });

    it('points a home-directory rejection at file-granular grants', () => {
      // The remedy noun matters. "grant a specific subdirectory instead" is the
      // WRONG advice for this task class: home-root dotfiles (~/.zshrc,
      // ~/.gitconfig) sit directly at $HOME, so no grantable subdirectory
      // encloses them — a caller told to find one enumerates guesses instead of
      // listing the files it actually needs.
      expect(() => parseAgentInput({ prompt: 'p', readRoots: [os.homedir()] })).toThrow(
        /a single file is a valid read root/,
      );
    });

    it('accepts a single FILE as an entry (the home-root dotfile shape)', () => {
      const dotfile = path.join(os.homedir(), '.zshrc');
      expect(parseAgentInput({ prompt: 'p', readRoots: [dotfile] }).readRoots).toEqual([dotfile]);
    });

    it('throws when an entry is an ancestor of the home directory', () => {
      // The parent of homedir (e.g. /Users or /home) lexically CONTAINS homedir,
      // so granting it would over-grant the whole user tree.
      const parentOfHome = path.dirname(os.homedir());
      expect(() => parseAgentInput({ prompt: 'p', readRoots: [parentOfHome] })).toThrow(
        /must not be a filesystem root, your home directory, or an ancestor/,
      );
    });

    // --- Hardening: breadth rejection resolves symlinks (#664 Codex P1) ---
    // The lexical breadth check alone is bypassable: a symlink whose target is
    // `/` or the home dir is not itself broad, but the containment layer
    // realpaths granted roots, so it becomes a broad real root at read time.
    // The breadth check must therefore run on the symlink-resolved target too.
    it('throws when an entry is a symlink pointing at the filesystem root (#664)', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-sym-'));
      const link = path.join(dir, 'broad-link');
      const fsRoot = path.parse(dir).root || path.sep;
      try {
        fs.symlinkSync(fsRoot, link, 'dir');
        expect(() => parseAgentInput({ prompt: 'p', readRoots: [link] })).toThrow(
          /must not be a filesystem root, your home directory, or an ancestor/,
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('throws when an entry is a symlink pointing at the home directory (#664)', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-sym-'));
      const link = path.join(dir, 'home-link');
      try {
        fs.symlinkSync(os.homedir(), link, 'dir');
        expect(() => parseAgentInput({ prompt: 'p', readRoots: [link] })).toThrow(
          /must not be a filesystem root, your home directory, or an ancestor/,
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('accepts an entry that is a symlink pointing at a safe (non-broad) subdirectory', () => {
      // The symlink pass must not OVER-reject: a link to an ordinary subdir is a
      // legitimate grant and its stored value stays the original entry.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-sym-'));
      const target = path.join(dir, 'data');
      const link = path.join(dir, 'data-link');
      try {
        fs.mkdirSync(target);
        fs.symlinkSync(target, link, 'dir');
        const result = parseAgentInput({ prompt: 'p', readRoots: [link] });
        expect(result.readRoots).toEqual([link]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    // --- Hardening: denylist rejection ---
    it('throws when an entry targets a read-denylisted credential path (~/.ssh)', () => {
      const ssh = path.join(os.homedir(), '.ssh');
      expect(() => parseAgentInput({ prompt: 'p', readRoots: [ssh] })).toThrow(
        /must not target a protected\/credential path/,
      );
    });

    it('throws when an entry targets the AFK config (credential) dir', () => {
      const afkConfig = path.join(os.homedir(), '.afk', 'config');
      expect(() => parseAgentInput({ prompt: 'p', readRoots: [afkConfig] })).toThrow(
        /must not target a protected\/credential path/,
      );
    });

    // --- Hardening: ancestor-of-credential rejection (#852) ---
    //
    // Invariant: a model must not be able to self-grant a root that ERASES a
    // bash credential floor. `deriveRestrictedSubstrings` deliberately drops
    // any candidate a granted root is an ancestor of — that is the documented
    // operator lift (`/allow-dir ~/.ssh` means the operator wants it) — but a
    // model reaches the same filter with no human in the loop via this field.
    // The rejection lives here rather than in the grant filter precisely
    // because this parser sees ONLY model-authored agent-tool calls, while
    // every operator grant path reaches the grant manager without passing
    // through it. That is what keeps the operator's lift working.
    //
    // These cases are distinct from the denylist cases above: the denylist
    // catches an entry that IS a credential path; these catch one that merely
    // sits ABOVE it.
    it('throws when an entry is an ancestor of a bash credential root (~/Library/Application Support) (#852)', () => {
      // The issue's concrete vector: not too-broad (isTooBroadRoot anchors only
      // on /, home and the AFK dirs) and not read-denied (only the per-browser
      // subtrees under it are), yet granting it drops the whole vendor tree —
      // browser secrets included — out of the child's bash gate.
      const appSupport = path.join(os.homedir(), 'Library', 'Application Support');
      expect(() => parseAgentInput({ prompt: 'p', readRoots: [appSupport] })).toThrow(
        /must not be at or above a credential root/,
      );
    });

    it('throws when an entry is a PARENT of a bash credential root (~/Library, ~/.config) (#852)', () => {
      const home = os.homedir();
      expect(() =>
        parseAgentInput({ prompt: 'p', readRoots: [path.join(home, 'Library')] }),
      ).toThrow(/must not be at or above a credential root/);
      // ~/.config covers both ~/.config/gh and ~/.config/gcloud.
      expect(() =>
        parseAgentInput({ prompt: 'p', readRoots: [path.join(home, '.config')] }),
      ).toThrow(/must not be at or above a credential root/);
    });

    it('throws when an entry is ~/.afk (ancestor of the AFK credential dir) (#852)', () => {
      expect(() =>
        parseAgentInput({ prompt: 'p', readRoots: [path.join(os.homedir(), '.afk')] }),
      ).toThrow(/must not be at or above a credential root/);
    });

    it('names the specific root it would un-gate, so the model can narrow the grant', () => {
      const appSupport = path.join(os.homedir(), 'Library', 'Application Support');
      expect(() => parseAgentInput({ prompt: 'p', readRoots: [appSupport] })).toThrow(
        new RegExp(escapeRe(appSupport)),
      );
    });

    // --- The guard must not over-reject (#852) ---
    it('still accepts a NARROWER path inside a sensitive tree', () => {
      // Containment direction matters: a grant INSIDE a sensitive tree does not
      // lift the enclosing root, so it is not this guard's business. (The
      // denylisted browser subtrees are still refused by the isReadDenied leg.)
      const inner = path.join(os.homedir(), 'Library', 'Application Support', 'SomeApp', 'data');
      expect(parseAgentInput({ prompt: 'p', readRoots: [inner] }).readRoots).toEqual([inner]);
    });

    it('still accepts the deliberately-grantable AFK state + framework dirs', () => {
      // Regression guard for the fork read-denial remedy (Gap A / Gap C in
      // forkSubagent): confined children legitimately read these, and neither
      // is an ancestor of ~/.afk/config, so the new check must leave them alone.
      const home = os.homedir();
      for (const dir of [
        path.join(home, '.afk', 'state'),
        path.join(home, '.afk', 'agent-framework'),
      ]) {
        expect(parseAgentInput({ prompt: 'p', readRoots: [dir] }).readRoots).toEqual([dir]);
      }
    });

    it('still accepts ordinary out-of-repo dirs (the #662 use case)', () => {
      const downloads = path.join(os.homedir(), 'Downloads');
      expect(parseAgentInput({ prompt: 'p', readRoots: [downloads] }).readRoots).toEqual([
        downloads,
      ]);
      expect(parseAgentInput({ prompt: 'p', readRoots: ['/tmp/scratch'] }).readRoots).toEqual([
        '/tmp/scratch',
      ]);
    });

    // --- Deliberate divergence from writeRoots ---
    it('is ALLOWED together with isolation:worktree (does NOT throw — divergence from writeRoots)', () => {
      // Widening a confined worktree fork's READS is legitimate; only WRITES
      // break isolation. This is the deliberate #662 divergence.
      const result = parseAgentInput({
        prompt: 'p',
        readRoots: [SAFE],
        isolation: 'worktree',
      });
      expect(result.readRoots).toEqual([SAFE]);
      expect(result.isolation).toBe('worktree');
    });

    it('accepts readRoots together with cwd (the main use case)', () => {
      const result = parseAgentInput({ prompt: 'p', cwd: '/tmp/wt/x', readRoots: [SAFE] });
      expect(result.cwd).toBe('/tmp/wt/x');
      expect(result.readRoots).toEqual([SAFE]);
    });
  });

  describe('isolation', () => {
    it('defaults to omitted (no field) when absent', () => {
      const result = parseAgentInput({ prompt: 'p' });
      expect(result.isolation).toBeUndefined();
      expect('isolation' in result).toBe(false);
    });

    it("normalizes 'none' to omitted (no field)", () => {
      const result = parseAgentInput({ prompt: 'p', isolation: 'none' });
      expect(result.isolation).toBeUndefined();
      expect('isolation' in result).toBe(false);
    });

    it("retains 'worktree'", () => {
      expect(parseAgentInput({ prompt: 'p', isolation: 'worktree' }).isolation).toBe(
        'worktree',
      );
    });

    it('throws on an unknown isolation value', () => {
      expect(() => parseAgentInput({ prompt: 'p', isolation: 'container' })).toThrow(
        /isolation must be "none" or "worktree"/,
      );
    });

    it('throws when cwd and isolation:worktree are both supplied (mutually exclusive)', () => {
      expect(() =>
        parseAgentInput({ prompt: 'p', cwd: '/tmp/wt/x', isolation: 'worktree' }),
      ).toThrow(/mutually exclusive/);
    });

    it('names the escape hatch in the cwd/isolation conflict message', () => {
      // The model gets another round after this throw, so the message must say
      // WHICH field to drop for WHICH goal — a rule-only message led callers to
      // drop isolation and silently degrade to an unisolated dispatch.
      expect(() =>
        parseAgentInput({ prompt: 'p', cwd: '/tmp/wt/x', isolation: 'worktree' }),
      ).toThrow(/OMIT cwd entirely/);
    });

    it('names the escape hatch in the writeRoots/isolation conflict message', () => {
      expect(() =>
        parseAgentInput({ prompt: 'p', writeRoots: ['/tmp/w'], isolation: 'worktree' }),
      ).toThrow(/Omit writeRoots to isolate/);
    });
  });

  // Regression: the padded-optional trap. A model that pads optionals with ''
  // (or null) hit "cwd and isolation are mutually exclusive", retried with
  // isolation alone but still emitted cwd:'', hit "cwd must be a non-empty
  // string", concluded cwd was REQUIRED — and therefore that isolation was
  // inexpressible — then dropped isolation and dispatched into the shared tree.
  // Every case below must parse, not throw.
  describe('blank optional fields normalize to absent (padded-serializer trap)', () => {
    it("accepts cwd:'' alongside isolation:'worktree' and keeps the isolation", () => {
      const result = parseAgentInput({ prompt: 'p', cwd: '', isolation: 'worktree' });
      expect(result.isolation).toBe('worktree');
      expect('cwd' in result).toBe(false);
    });

    it("accepts cwd:null alongside isolation:'worktree'", () => {
      expect(parseAgentInput({ prompt: 'p', cwd: null, isolation: 'worktree' }).isolation).toBe(
        'worktree',
      );
    });

    it('accepts a fully padded dispatch (every optional blank)', () => {
      const result = parseAgentInput({
        prompt: 'p',
        cwd: '',
        model: '',
        agent_type: '',
        id_prefix: '',
        mode: '',
        isolation: '',
        max_turns: null,
        max_tool_use_iterations: null,
        attachments: null,
        writeRoots: null,
        readRoots: null,
      });
      expect(result.mode).toBe('foreground');
      expect(result.id_prefix).toBe('agent-tool');
      expect(result.max_turns).toBe(0);
      expect(result.max_turns_explicit).toBe(false);
      expect(result.max_tool_use_iterations_explicit).toBe(false);
      expect(result.cwd).toBeUndefined();
      expect(result.model).toBeUndefined();
      expect(result.agent_type).toBeUndefined();
      expect(result.isolation).toBeUndefined();
      expect(result.attachments).toBeUndefined();
      expect(result.writeRoots).toBeUndefined();
      expect(result.readRoots).toBeUndefined();
    });

    it('lets a real subagent_type through a blank canonical agent_type', () => {
      // Plain `??` kept the blank because '' !== undefined, dropping both.
      expect(
        parseAgentInput({ prompt: 'p', agent_type: '', subagent_type: 'research-agent' })
          .agent_type,
      ).toBe('research-agent');
    });

    it('still rejects a wrong-typed optional loudly (blank-collapse is not coercion)', () => {
      expect(() => parseAgentInput({ prompt: 'p', cwd: 42 })).toThrow(/cwd must be a string/);
      expect(() => parseAgentInput({ prompt: 'p', max_turns: '10' })).toThrow(
        /max_turns must be a number/,
      );
      expect(() => parseAgentInput({ prompt: 'p', mode: 'back' })).toThrow(/"back"/);
    });

    it("allows cwd together with isolation:'none' (none is a no-op)", () => {
      const result = parseAgentInput({ prompt: 'p', cwd: '/tmp/wt/x', isolation: 'none' });
      expect(result.cwd).toBe('/tmp/wt/x');
      expect('isolation' in result).toBe(false);
    });

    it('throws when isolation:worktree is combined with mode:background (MVP forbid)', () => {
      expect(() =>
        parseAgentInput({ prompt: 'p', isolation: 'worktree', mode: 'background' }),
      ).toThrow(/not supported with mode:"background"/);
    });
  });

  describe('full happy path', () => {
    it('parses every field together with expected precedence and defaults', () => {
      const result = parseAgentInput({
        prompt: 'investigate the failing test',
        model: 'sonnet',
        max_turns: 25,
        max_tool_use_iterations: 12,
        id_prefix: 'diagnose',
        subagent_type: 'research-agent',
        mode: 'background',
        cwd: '/tmp/wt/diagnose-run',
      });

      const expected: AgentInput = {
        prompt: 'investigate the failing test',
        model: 'sonnet',
        max_turns: 25,
        max_turns_explicit: true,
        max_tool_use_iterations: 12,
        max_tool_use_iterations_explicit: true,
        id_prefix: 'diagnose',
        agent_type: 'research-agent',
        mode: 'background',
        cwd: '/tmp/wt/diagnose-run',
      };
      expect(result).toEqual(expected);
    });

    it('returns a minimal object with defaults when only prompt is given', () => {
      const result = parseAgentInput({ prompt: 'minimal' });
      const expected: AgentInput = {
        prompt: 'minimal',
        model: undefined,
        // #448: turn/tool-use budgets are uncapped (0) and non-explicit by default.
        max_turns: 0,
        max_turns_explicit: false,
        max_tool_use_iterations: 0,
        max_tool_use_iterations_explicit: false,
        id_prefix: 'agent-tool',
        mode: 'foreground',
      };
      expect(result).toEqual(expected);
      // Optional keys must be omitted (not present-as-undefined) so downstream
      // spreads and strict own-key checks behave.
      expect('agent_type' in result).toBe(false);
      expect('cwd' in result).toBe(false);
    });

    it('ignores unrecognized extra keys on the input object', () => {
      const result = parseAgentInput({ prompt: 'p', bogusExtra: 'ignored' } as Record<string, unknown>);
      expect(result.prompt).toBe('p');
      expect('bogusExtra' in result).toBe(false);
    });
  });
});
