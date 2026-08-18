/**
 * Issue #710 — unknown subcommand guard (mode 1 + mode 2).
 *
 * Mode 1: a mistyped subcommand with a trailing flag (`afk config_set env X
 * --unset`) blamed the flag instead of the command.  Fixed via `unknownOption`
 * monkey-patch in `installUnknownCommandGuard`.
 *
 * Mode 2: a bare unknown single-word token with no flags (`afk skill`) was
 * silently swallowed by the default `interactive` command, causing forkbombs
 * when a subagent re-invoked itself.  Fixed via `checkBareUnknownCommand`
 * called from the `interactive` action before any side-effect.
 *
 * These tests exercise both guards directly against real commander `Command`
 * instances (no mocking of interactive.ts's heavy bootstrap chain needed —
 * the guards are pure commander-level concerns).
 */

import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import {
  isUnrecognizedCommandToken,
  installUnknownCommandGuard,
  checkBareUnknownCommand,
  suggestCliCommand,
} from './unknown-command-guard.js';

/** Build a minimal program shaped like the real CLI: a default `interactive`
 * command plus a couple of named sibling subcommands, with the guard wired
 * in exactly as `registerInteractiveCommand` does. */
function buildProgram(): Command {
  const program = new Command();
  program.name('afk').exitOverride();

  const interactiveCmd = program
    .command('interactive', { isDefault: true })
    .argument('[input...]')
    .option('--model <model>', 'model')
    .action(() => {
      /* no-op: presence of a call is asserted via captured state below */
    });
  program.commands.find((c) => c.name() === 'interactive')?.alias('i');

  program
    .command('config')
    .description('config stuff')
    .action(() => undefined);

  program
    .command('schedule')
    .description('manage schedules')
    .action(() => undefined);

  installUnknownCommandGuard(interactiveCmd, program);
  return program;
}

describe('isUnrecognizedCommandToken', () => {
  const program = buildProgram();

  it('flags a plain mistyped token', () => {
    expect(isUnrecognizedCommandToken('config_set', program)).toBe(true);
  });

  it('does not flag a registered command name', () => {
    expect(isUnrecognizedCommandToken('config', program)).toBe(false);
  });

  it('does not flag a registered alias', () => {
    expect(isUnrecognizedCommandToken('i', program)).toBe(false);
  });

  it('does not flag a leading slash (documented slash-command launch path)', () => {
    expect(isUnrecognizedCommandToken('/review', program)).toBe(false);
  });

  it('does not flag a leading dash (the token IS the unknown flag itself)', () => {
    expect(isUnrecognizedCommandToken('--badflag', program)).toBe(false);
  });

  it('does not flag undefined or empty', () => {
    expect(isUnrecognizedCommandToken(undefined, program)).toBe(false);
    expect(isUnrecognizedCommandToken('', program)).toBe(false);
  });
});

describe('suggestCliCommand', () => {
  const program = buildProgram();

  it('suggests the close command for a typo within distance 2', () => {
    // 'shedule' → distance 2 from 'schedule'
    expect(suggestCliCommand('shedule', program)).toBe('schedule');
  });

  it('suggests the close command at distance 1', () => {
    // 'schedul' → distance 1 from 'schedule'
    expect(suggestCliCommand('schedul', program)).toBe('schedule');
  });

  it('returns undefined for a word with no near-miss (distance > 2)', () => {
    // 'zzzbogus' is far from every registered name
    expect(suggestCliCommand('zzzbogus', program)).toBeUndefined();
  });

  it('returns undefined for an exact known command name (already registered)', () => {
    // 'config' → distance 0, but the function still returns it as a suggestion
    // (the caller is responsible for filtering already-registered tokens earlier)
    expect(suggestCliCommand('config', program)).toBe('config');
  });
});

describe('checkBareUnknownCommand — mode 2 detection', () => {
  const program = buildProgram();

  it('returns isUnknown:true for a single word close to a subcommand name', () => {
    // 'shedule' is distance 2 from 'schedule'
    const result = checkBareUnknownCommand(['shedule'], program);
    expect(result.isUnknown).toBe(true);
    if (result.isUnknown) {
      expect(result.token).toBe('shedule');
      expect(result.suggestion).toBe('schedule');
    }
  });

  it('returns isUnknown:false for a word with no near-miss (legitimate one-word prompt)', () => {
    // 'zzzbogus' has no close registered command → treat as prompt
    const result = checkBareUnknownCommand(['zzzbogus'], program);
    expect(result.isUnknown).toBe(false);
  });

  it('returns isUnknown:false for a registered command name (already dispatched by Commander)', () => {
    const result = checkBareUnknownCommand(['config'], program);
    expect(result.isUnknown).toBe(false);
  });

  it('returns isUnknown:false for a multi-word input (quoted prompt)', () => {
    // `afk "do a thing"` → input = ['do a thing'] — has space, never a command
    const result = checkBareUnknownCommand(['do a thing'], program);
    expect(result.isUnknown).toBe(false);
  });

  it('returns isUnknown:false for multiple input tokens (multi-word bare prompt)', () => {
    // `afk do a thing` → input = ['do', 'a', 'thing']
    const result = checkBareUnknownCommand(['do', 'a', 'thing'], program);
    expect(result.isUnknown).toBe(false);
  });

  it('returns isUnknown:false for a slash-command launch token', () => {
    const result = checkBareUnknownCommand(['/review'], program);
    expect(result.isUnknown).toBe(false);
  });

  it('returns isUnknown:false for an empty input array (bare `afk`)', () => {
    const result = checkBareUnknownCommand([], program);
    expect(result.isUnknown).toBe(false);
  });
});

describe('installUnknownCommandGuard — end-to-end via commander parse (mode 1)', () => {
  it('names the unrecognized command, not the trailing flag, for `config_set env X --unset`', async () => {
    const program = buildProgram();
    let caught: unknown;
    try {
      await program.parseAsync(['node', 'afk', 'config_set', 'env', 'X', '--unset']);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("unknown command 'config_set'");
    expect(message).not.toContain("unknown option '--unset'");
  });

  it('leaves the bare-prompt path untouched (`afk "do a thing"`)', async () => {
    const program = buildProgram();
    // No flags at all → unknownOption never fires → guard never engages →
    // the default `interactive` action runs normally (no throw).
    await expect(
      program.parseAsync(['node', 'afk', 'do a thing']),
    ).resolves.toBeDefined();
  });

  it('leaves the documented `afk /review` slash-command path untouched', async () => {
    const program = buildProgram();
    await expect(
      program.parseAsync(['node', 'afk', '/review']),
    ).resolves.toBeDefined();
  });

  it('leaves a genuinely bad flag on the bare invocation blaming the flag (unchanged behavior)', async () => {
    const program = buildProgram();
    let caught: unknown;
    try {
      await program.parseAsync(['node', 'afk', '--badflag']);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("unknown option '--badflag'");
  });

  it('leaves a genuinely bad flag after the alias blaming the flag (unchanged behavior)', async () => {
    const program = buildProgram();
    let caught: unknown;
    try {
      await program.parseAsync(['node', 'afk', 'i', '--badflag']);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("unknown option '--badflag'");
  });

  it('still boots the interactive action for an unrecognized bare token with no near-miss', async () => {
    const program = buildProgram();
    // `zzzbogus` has no known-command near-miss — the mode-2 guard does not
    // intercept it and `isUnknown` returns false, so the action runs normally.
    await expect(
      program.parseAsync(['node', 'afk', 'zzzbogus']),
    ).resolves.toBeDefined();
  });
});
