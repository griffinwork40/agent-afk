/**
 * Issue #710 mode 1: a mistyped subcommand (`afk config_set env X --unset`)
 * blamed its trailing flag (`error: unknown option '--unset'`) instead of
 * naming the unrecognized command. These tests exercise the guard directly
 * against real commander `Command` instances (no mocking of interactive.ts's
 * heavy bootstrap chain needed — the guard is a pure commander-level concern).
 */

import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { isUnrecognizedCommandToken, installUnknownCommandGuard } from './unknown-command-guard.js';

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

describe('installUnknownCommandGuard — end-to-end via commander parse', () => {
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

  it('still boots the interactive action for an unrecognized bare token with no flags (mode 2, deliberately unfixed)', async () => {
    const program = buildProgram();
    // `zzzbogus` never reaches unknownOption (no unknown flag present), so
    // the guard cannot and does not intercept it — this documents the
    // residual gap rather than asserting a fix for it.
    await expect(
      program.parseAsync(['node', 'afk', 'zzzbogus']),
    ).resolves.toBeDefined();
  });
});
