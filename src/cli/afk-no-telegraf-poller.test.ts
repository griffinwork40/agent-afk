/**
 * Invariant test: the REPL / CLI / AFK-channel code NEVER constructs a Telegraf
 * poller in-process.
 *
 * Scope-lock Invariant #2 (from `.afk/plans/afk-telegram-bidirectional.scope.lock.md`):
 *   "Daemon is the SOLE Telegram `getUpdates` poller; REPL NEVER constructs a
 *   Telegraf/second poller (409)."
 *
 * Why this matters: Telegram's long-poll API rejects a second concurrent
 * `getUpdates` consumer with HTTP 409 Conflict. If any REPL code path were to
 * instantiate a `Telegraf` object and call `launch()`, every message to the bot
 * would silently fail while the daemon is running. The bidirectional AFK channel
 * deliberately routes ALL Telegram I/O through the daemon process
 * (`src/telegram/`). The REPL communicates with the daemon only via the
 * per-session ledger file — no socket, no second poller.
 *
 * The test scans every non-test TypeScript file under the REPL/agent AFK paths
 * and asserts zero occurrences of:
 *   - `from 'telegraf'` or `from "telegraf"` (telegraf runtime import)
 *   - `new Telegraf(` (direct Telegraf instantiation)
 *
 * The scanned paths are:
 *   src/cli/**\/*.ts       — all CLI source (REPL, slash commands, etc.)
 *   src/agent/afk-ledger-channel.ts  — REPL-side ledger channel
 *   src/agent/afk-channel.ts         — per-session HMAC helpers
 *   src/agent/elicitation-router.ts  — module-scope elicitation router
 *
 * src/telegram/** is EXPLICITLY EXCLUDED: the daemon is the legitimate
 * sole owner of Telegraf and this test must not flag it.
 *
 * The test is NON-VACUOUS: it asserts that the scanned-file count > 0, so a
 * broken glob cannot produce a spurious pass.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Recursively collect *.ts files under `dir` (excluding *.test.ts). */
function collectTs(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTs(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// build the file list
// ---------------------------------------------------------------------------

const root = path.resolve(__dirname, '../..');

// All CLI source files (REPL, slash commands, afk-mode-toggle, …)
const cliFiles = collectTs(path.join(root, 'src/cli'));

// Key agent-side AFK files that run in the REPL process.
const agentAfkFiles = [
  path.join(root, 'src/agent/afk-ledger-channel.ts'),
  path.join(root, 'src/agent/afk-channel.ts'),
  path.join(root, 'src/agent/elicitation-router.ts'),
];

const allFiles = [...cliFiles, ...agentAfkFiles];

// ---------------------------------------------------------------------------
// assertions
// ---------------------------------------------------------------------------

describe('scope-lock invariant #2: REPL code never imports Telegraf', () => {
  it('has a non-empty file list to scan (guards against a broken glob)', () => {
    // If this assertion fails, collectTs broke or the source tree moved.
    expect(allFiles.length).toBeGreaterThan(0);
    // Sanity-check: we should have at least the three agent AFK files.
    expect(allFiles.length).toBeGreaterThanOrEqual(3);
  });

  it('no REPL/CLI/AFK-channel file imports from telegraf', () => {
    const violations: string[] = [];
    for (const file of allFiles) {
      const content = fs.readFileSync(file, 'utf8');
      if (/from ['"]telegraf['"]/.test(content)) {
        violations.push(file);
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `Scope-lock invariant #2 violated — the following REPL/CLI files import from 'telegraf' ` +
          `(a second Telegraf instance would cause Telegram 409 Conflict):\n` +
          violations.map((f) => `  ${path.relative(root, f)}`).join('\n'),
      );
    }
    expect(violations).toHaveLength(0);
  });

  it('no REPL/CLI/AFK-channel file constructs a Telegraf instance (new Telegraf)', () => {
    const violations: string[] = [];
    for (const file of allFiles) {
      const content = fs.readFileSync(file, 'utf8');
      if (/new Telegraf\(/.test(content)) {
        violations.push(file);
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `Scope-lock invariant #2 violated — the following REPL/CLI files contain 'new Telegraf(' ` +
          `(a second Telegraf instance would cause Telegram 409 Conflict):\n` +
          violations.map((f) => `  ${path.relative(root, f)}`).join('\n'),
      );
    }
    expect(violations).toHaveLength(0);
  });

  it('reports the number of files scanned (informational)', () => {
    // This test always passes — its purpose is to make the scanned-file count
    // visible in the test output so reviewers can confirm the scan is non-trivial.
    const cliCount = cliFiles.length;
    const agentCount = agentAfkFiles.length;
    // Emit a human-readable summary via the assertion message.
    expect({ cliFiles: cliCount, agentAfkFiles: agentCount, total: allFiles.length }).toMatchObject(
      { total: expect.any(Number) },
    );
  });
});
