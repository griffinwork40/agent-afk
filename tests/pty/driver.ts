/**
 * PTY scrollback harness — in-pty driver (issue #541).
 *
 * Runs INSIDE the pseudo-terminal spawned by tests/pty/harness.ts, launched as:
 *
 *     node --import tsx tests/pty/driver.ts <scenario-name>
 *
 * It picks the named scenario from tests/pty/scenarios.ts, drives the real
 * TerminalCompositor against `process.stdout` (a genuine TTY inside the pty),
 * then emits the completion SENTINEL so the parent can snapshot the emulator
 * buffer at the exact final live-frame state.
 *
 * SENTINEL: an APC string (ESC _ ... ESC \). xterm ignores APC entirely — no
 * glyphs, no scroll — and the parent captures only the bytes BEFORE it, so the
 * sentinel never perturbs the geometry under test. It is emitted AFTER the
 * scenario's final repaint and BEFORE any teardown; the driver deliberately
 * does NOT disarm the compositor, because disarm would clear the live frame and
 * destroy the very state the parent needs to inspect.
 */

import { SCENARIOS } from './scenarios.js';
import { PTY_DONE_SENTINEL } from './constants.js';

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name) {
    process.stderr.write('driver: missing scenario name (argv[2])\n');
    process.exit(64);
  }
  const scenario = SCENARIOS[name];
  if (!scenario) {
    process.stderr.write(`driver: unknown scenario "${name}"; known: ${Object.keys(SCENARIOS).join(', ')}\n`);
    process.exit(65);
  }

  const stdout = process.stdout;
  const stdin = process.stdin;
  if (!stdout.isTTY) {
    // The whole point is a real TTY; refuse if the parent didn't give us one.
    process.stderr.write('driver: process.stdout is not a TTY — must run inside a pty\n');
    process.exit(66);
  }

  try {
    await scenario.drive({ stdout, stdin });
  } catch (err) {
    process.stderr.write(`driver: scenario "${name}" threw: ${(err as Error)?.stack ?? String(err)}\n`);
    process.exit(1);
  }

  // Let the final frame's writes flush through the kernel pty to the parent,
  // THEN mark completion. Bytes arrive in order, so once the parent sees the
  // sentinel it already holds every preceding (compositor) byte.
  await new Promise((r) => setTimeout(r, 60));
  stdout.write(PTY_DONE_SENTINEL);
  await new Promise((r) => setTimeout(r, 40));
  process.exit(0);
}

void main();
