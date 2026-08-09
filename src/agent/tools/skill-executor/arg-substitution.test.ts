/**
 * Tests for SKILL.md argument templating.
 *
 * `$ARGUMENTS` behaviour is pre-existing and locked here against regression;
 * positional `${N}`, quoting, escaping and the single-pass property are new.
 *
 * @module agent/tools/skill-executor/arg-substitution.test
 */

import { describe, it, expect } from 'vitest';
import { substituteSkillArgs, tokenizeArgs } from './arg-substitution.js';

describe('tokenizeArgs', () => {
  it('splits on whitespace and collapses runs', () => {
    expect(tokenizeArgs('a b   c')).toEqual(['a', 'b', 'c']);
    expect(tokenizeArgs('  leading and trailing  ')).toEqual(['leading', 'and', 'trailing']);
    expect(tokenizeArgs('')).toEqual([]);
  });

  it('groups double- and single-quoted phrases and strips the quotes', () => {
    expect(tokenizeArgs('"hello world" second')).toEqual(['hello world', 'second']);
    expect(tokenizeArgs("'hello world' second")).toEqual(['hello world', 'second']);
    expect(tokenizeArgs('pre "mid dle" post')).toEqual(['pre', 'mid dle', 'post']);
  });

  it('treats the opposite quote as literal inside a quoted run', () => {
    expect(tokenizeArgs('"it\'s fine"')).toEqual(["it's fine"]);
  });

  it('preserves an empty quoted token so later positions do not shift', () => {
    expect(tokenizeArgs('"" b')).toEqual(['', 'b']);
  });

  it('tolerates an unterminated quote rather than throwing', () => {
    // Rendering a prompt must not hard-fail over a typo in a skill body.
    expect(tokenizeArgs('a "unterminated here')).toEqual(['a', 'unterminated here']);
  });

  it('does not process backslash escapes (a Windows path survives intact)', () => {
    expect(tokenizeArgs('C:\\Users\\me\\file.txt')).toEqual(['C:\\Users\\me\\file.txt']);
  });
});

describe('substituteSkillArgs — $ARGUMENTS (pre-existing behaviour)', () => {
  it('expands both $ARGUMENTS and $ARGUMENT to the full raw string', () => {
    expect(substituteSkillArgs('run $ARGUMENTS now', 'a b c')).toBe('run a b c now');
    expect(substituteSkillArgs('run $ARGUMENT now', 'a b c')).toBe('run a b c now');
  });

  it('expands to empty string when args are absent or empty', () => {
    expect(substituteSkillArgs('x $ARGUMENTS y', undefined)).toBe('x  y');
    expect(substituteSkillArgs('x $ARGUMENTS y', '')).toBe('x  y');
  });

  it('leaves a body with no placeholder unchanged', () => {
    expect(substituteSkillArgs('nothing to do here', 'a b')).toBe('nothing to do here');
  });

  it('does not match a longer identifier such as $ARGUMENTSX', () => {
    expect(substituteSkillArgs('$ARGUMENTSX', 'a')).toBe('$ARGUMENTSX');
  });

  it('inserts regex-special replacement patterns verbatim', () => {
    // Guards the replacer-as-function contract: `$&`/`$$` in args must not be
    // reinterpreted by String.prototype.replace.
    expect(substituteSkillArgs('[$ARGUMENTS]', '$& $$ $` $1')).toBe('[$& $$ $` $1]');
  });
});

describe('substituteSkillArgs — positional ${N}', () => {
  it('expands 1-indexed positionals', () => {
    expect(substituteSkillArgs('${1} then ${2}', 'first second')).toBe('first then second');
  });

  it('respects quoting when assigning positions', () => {
    expect(substituteSkillArgs('[${1}] [${2}]', '"hello world" second')).toBe('[hello world] [second]');
  });

  it('leaves a positional with no corresponding argument VERBATIM', () => {
    // A literal `${3}` in the rendered prompt is a legible symptom of an author
    // bug; silently blanking it would hide the mistake.
    expect(substituteSkillArgs('${1} ${2} ${3}', 'only one')).toBe('only one ${3}');
  });

  it('leaves ${0} alone — it is not a positional', () => {
    expect(substituteSkillArgs('${0} ${1}', 'a b')).toBe('${0} a');
  });

  it('supports multi-digit positionals', () => {
    const args = 'a1 a2 a3 a4 a5 a6 a7 a8 a9 a10';
    expect(substituteSkillArgs('${10}', args)).toBe('a10');
  });

  it('coexists with $ARGUMENTS in one body', () => {
    expect(substituteSkillArgs('all=[$ARGUMENTS] first=[${1}]', 'x y')).toBe('all=[x y] first=[x]');
  });

  it('leaves currency and shell field references literal', () => {
    expect(substituteSkillArgs("Budget $1.00; awk '{print $1}'", 'first')).toBe(
      "Budget $1.00; awk '{print $1}'",
    );
  });
});

describe('substituteSkillArgs — escaping', () => {
  it('renders an escaped placeholder literally, minus the backslash', () => {
    expect(substituteSkillArgs('\\${1} and \\$ARGUMENTS', 'a b')).toBe('${1} and $ARGUMENTS');
  });

  it('still expands unescaped placeholders alongside escaped ones', () => {
    expect(substituteSkillArgs('\\${1} but ${2}', 'a b')).toBe('${1} but b');
  });
});

describe('substituteSkillArgs — single-pass property', () => {
  it('does not re-expand a placeholder that appears inside the args', () => {
    // The load-bearing guarantee: two sequential .replace() passes would let
    // the positional pass rewrite text the $ARGUMENTS pass just inserted.
    expect(substituteSkillArgs('[$ARGUMENTS]', '${1} literal')).toBe('[${1} literal]');
  });

  it('does not re-expand when a positional token itself contains a placeholder', () => {
    expect(substituteSkillArgs('[${1}]', '"${2} stays" other')).toBe('[${2} stays]');
  });
});
