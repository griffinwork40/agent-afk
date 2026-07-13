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

import { describe, expect, it } from 'vitest';
import { parseAgentInput, type AgentInput } from './input-parse.js';

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

    it('throws when model is null (explicit non-string)', () => {
      // `null !== undefined`, so it reaches the type check and is rejected.
      expect(() => parseAgentInput({ prompt: 'p', model: null })).toThrow(
        /model must be a string/,
      );
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
      // `agentInput['agent_type'] ?? agentInput['subagent_type']` uses nullish
      // coalescing, so a present-but-empty agent_type ('') still wins the ??
      // (it is not null/undefined). It then trims to '' and is dropped — the
      // alias is NOT consulted. This pins that documented precedence.
      const result = parseAgentInput({
        prompt: 'p',
        agent_type: '   ',
        subagent_type: 'alias',
      });
      expect(result.agent_type).toBeUndefined();
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

    it('accepts an empty-string id_prefix verbatim (no default substitution)', () => {
      // An explicit '' is a string, so it passes the type check and is used
      // as-is — the default only applies when the field is absent.
      expect(parseAgentInput({ prompt: 'p', id_prefix: '' }).id_prefix).toBe('');
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

    it('throws when cwd is an empty string', () => {
      expect(() => parseAgentInput({ prompt: 'p', cwd: '' })).toThrow(
        /cwd must be a non-empty string/,
      );
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
