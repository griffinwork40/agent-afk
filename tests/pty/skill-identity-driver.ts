/**
 * PTY driver for skill-identity scenarios (skill-dispatch-preview-ui).
 *
 * Mirror of tests/pty/driver.ts but loads SKILL_IDENTITY_SCENARIOS from
 * skill-identity-fixtures.ts instead of the main scenarios.ts registry.
 * Spawned by tests/pty/skill-identity.pty.test.ts as:
 *
 *     node --import tsx tests/pty/skill-identity-driver.ts <scenario-name>
 */

import { SKILL_IDENTITY_SCENARIOS } from './skill-identity-fixtures.js';
import { PTY_DONE_SENTINEL } from './constants.js';

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name) {
    process.stderr.write('skill-identity-driver: missing scenario name (argv[2])\n');
    process.exit(64);
  }
  const scenario = SKILL_IDENTITY_SCENARIOS[name];
  if (!scenario) {
    process.stderr.write(
      `skill-identity-driver: unknown scenario "${name}"; known: ${Object.keys(SKILL_IDENTITY_SCENARIOS).join(', ')}\n`,
    );
    process.exit(65);
  }

  const stdout = process.stdout;
  const stdin = process.stdin;
  if (!stdout.isTTY) {
    process.stderr.write('skill-identity-driver: process.stdout is not a TTY — must run inside a pty\n');
    process.exit(66);
  }

  try {
    await scenario.drive({ stdout, stdin });
  } catch (err) {
    process.stderr.write(
      `skill-identity-driver: scenario "${name}" threw: ${(err as Error)?.stack ?? String(err)}\n`,
    );
    process.exit(1);
  }

  // Let the final frame's writes flush through the kernel pty to the parent,
  // THEN mark completion. Same protocol as tests/pty/driver.ts.
  await new Promise((r) => setTimeout(r, 80));
  stdout.write(PTY_DONE_SENTINEL);
  await new Promise((r) => setTimeout(r, 60));
  process.exit(0);
}

void main();
