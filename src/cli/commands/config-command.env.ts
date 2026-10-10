/**
 * `afk config env` subcommand tree — get / set / unset afk.env vars.
 *
 * Extracted from {@link registerConfigCommand} to keep that function within
 * the 200-line function ceiling. The `envCmd` parent Command is passed in so
 * this helper registers against the same `config env` node.
 *
 * @module cli/commands/config-command.env
 */

import type { Command } from 'commander';
import { palette } from '../palette.js';
import { promptSecret } from '../../utils/prompt-secret.js';
import { classifyEnvKey } from '../../config/settable-keys.js';
import { errorMessage } from '../../utils/errors.js';
import {
  setEnvVar,
  unsetEnvVar,
  getEnvVar,
  listEnv,
  RESTART_NOTE,
} from '../../config/mutate.js';
import { readFileSync } from 'fs';

/** Print an error and set a nonzero exit code (2 = bad input / refused). */
function fail(message: string): void {
  console.error(palette.warning(`✗ ${message}`));
  process.exitCode = 2;
}

/** Read the entire stdin stream synchronously (for `--stdin` secret entry). */
function readStdin(): string {
  try {
    return readFileSync(0, 'utf-8').replace(/\n$/, '');
  } catch {
    return '';
  }
}

/**
 * Register the `afk config env get/set/unset` subcommands onto the supplied
 * `envCmd` Commander node. Called by {@link registerConfigCommand} after it
 * creates the `env` sub-command.
 */
export function registerEnvSubcommands(envCmd: Command): void {
  envCmd
    .command('get [key]')
    .description('Read afk.env — one var or all present (secrets masked)')
    .option('--all', 'Include every known var, not just those set')
    .option('--json', 'Output JSON')
    .action((key: string | undefined, opts: { all?: boolean; json?: boolean }) => {
      try {
        if (key) {
          const v = getEnvVar(key);
          if (opts.json) console.log(JSON.stringify(v));
          else console.log(`${v.key} [${v.class}]: ${v.persisted ?? palette.meta('(unset)')}`);
        } else {
          const list = listEnv({ all: opts.all });
          if (opts.json) console.log(JSON.stringify(list, null, 2));
          else for (const e of list) console.log(`${e.key} [${e.class}]: ${e.persisted ?? palette.meta('(unset)')}`);
        }
      } catch (err) {
        fail(errorMessage(err));
      }
    });

  envCmd
    .command('set <key> [value]')
    .description('Set an afk.env var. Secret vars are prompted (masked) unless --stdin is given.')
    .option('--stdin', 'Read the value from stdin (for scripted secret entry)')
    .option('--json', 'Output JSON')
    .action(async (key: string, value: string | undefined, opts: { stdin?: boolean; json?: boolean }) => {
      try {
        const cls = classifyEnvKey(key);
        let resolved = value;
        if (cls === 'secret') {
          // Secrets must never come from a positional arg (argv / shell history).
          if (opts.stdin) resolved = readStdin();
          else resolved = await promptSecret(`${key} (input hidden): `);
          if (value !== undefined) {
            console.error(palette.warning('  note: positional value ignored for a secret var — use the prompt or --stdin'));
          }
        } else if (resolved === undefined) {
          if (opts.stdin) resolved = readStdin();
          else { fail(`${key} requires a value`); return; }
        }
        const r = setEnvVar(key, resolved ?? '', { allowSecret: true, allowProtected: true });
        if (opts.json) console.log(JSON.stringify({ ok: true, ...r }));
        else console.log(palette.success(`✓ ${r.key} = ${r.display} → ${r.persistedTo}\n  ${RESTART_NOTE}.`));
      } catch (err) {
        fail(errorMessage(err));
      }
    });

  envCmd
    .command('unset <key>')
    .description('Remove an afk.env var')
    .option('--json', 'Output JSON')
    .action((key: string, opts: { json?: boolean }) => {
      try {
        const r = unsetEnvVar(key, { allowSecret: true, allowProtected: true });
        if (opts.json) console.log(JSON.stringify({ ok: true, ...r }));
        else console.log(r.removed ? palette.success(`✓ removed ${r.key} → ${r.persistedTo}`) : palette.meta(`(${r.key} was not set)`));
      } catch (err) {
        fail(errorMessage(err));
      }
    });
}
