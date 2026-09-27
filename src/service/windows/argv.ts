/**
 * Win32 argv + environment resolution for Task Scheduler services.
 *
 * Why not reuse `resolveProgramArguments` from `../launchd/plist.ts`
 * wholesale: its `daemon` branch goes through `resolveAfkBinary()`, which
 * validates against POSIX trusted prefixes (`/usr/local/bin/`, …), shells
 * out to `which`, and probes POSIX candidate paths — none of which can
 * succeed on Windows, so a daemon install would always fail. On Windows a
 * global npm install exposes `afk` as an `afk.cmd` shim that runs
 * `node <prefix>\node_modules\agent-afk\dist\cli.mjs`, so the currently
 * executing CLI script (`process.argv[1]`) is the real entry. We run it
 * through `process.execPath` directly — no shim, no PATH lookup.
 *
 * The telegram branch is platform-neutral (`[process.execPath, entry]`),
 * so it still delegates to the shared helper.
 *
 * PATH: `resolveServicePath()` appends POSIX system dirs and would
 * *replace* the user's PATH (dropping System32, git, …) if injected via
 * `set "PATH=…"`. A Task Scheduler task running with an InteractiveToken
 * already inherits the user's environment, so we inject nothing by
 * default; the program itself is invoked by absolute path.
 *
 * @module service/windows/argv
 */

import { existsSync, realpathSync } from 'fs';
import type { ServiceName } from '../types.js';
import { resolveProgramArguments } from '../launchd/plist.js';

/** Test seams for {@link resolveWindowsProgramArguments}. */
export interface WindowsArgvDeps {
  existsCheck?: (p: string) => boolean;
  argv1?: string | undefined;
  execPath?: string;
  realpathFn?: (p: string) => string;
}

/**
 * Build the argv for a Windows service task. Throws with an actionable
 * message when the entry cannot be resolved — we refuse to register a
 * task that would crash-loop under RestartOnFailure.
 */
export function resolveWindowsProgramArguments(name: ServiceName, deps: WindowsArgvDeps = {}): string[] {
  const existsCheck = deps.existsCheck ?? existsSync;
  if (name === 'telegram') return resolveProgramArguments('telegram', existsCheck);

  const argv1 = 'argv1' in deps ? deps.argv1 : process.argv[1];
  const execPath = deps.execPath ?? process.execPath;
  const realpathFn = deps.realpathFn ?? realpathSync;
  if (!argv1) {
    throw new Error("Could not determine the running 'afk' CLI script (process.argv[1] is empty).");
  }
  let entry: string;
  try {
    entry = realpathFn(argv1);
  } catch {
    throw new Error(`Could not resolve the running 'afk' CLI script: ${argv1}`);
  }
  if (entry.endsWith('.ts')) {
    throw new Error(
      `Refusing to install daemon service pointing at TypeScript source (${entry}). ` +
        `Run 'pnpm build' first, or install agent-afk globally ('npm install -g agent-afk').`,
    );
  }
  if (!/\.(m?js|cjs)$/i.test(entry) || !existsCheck(entry)) {
    throw new Error(
      `Resolved 'afk' CLI entry is not a JavaScript file on disk: ${entry}. ` +
        `Run 'afk service install daemon' from a globally-installed agent-afk.`,
    );
  }
  return [execPath, entry, 'daemon'];
}
