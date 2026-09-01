/**
 * Test-command discovery for the `test_run` tool.
 *
 * Reads project config files (package.json, pyproject.toml, Cargo.toml,
 * Makefile, etc.) to discover the test runner and command — without executing
 * anything. Returns the best candidate or `null` if no test setup is found.
 *
 * Design invariant: **this module never spawns a child process**. All
 * detection is done via synchronous file I/O (fs.existsSync / fs.readFileSync).
 *
 * @module agent/tools/handlers/test-run-discovery
 */

import fs from 'fs';
import path from 'path';

/** The discovered test-runner variant, aligned with TestResult.runner. */
export type DiscoveredRunner =
  | 'vitest'
  | 'jest'
  | 'pytest'
  | 'mocha'
  | 'go-test'
  | 'cargo'
  | 'rspec'
  | 'node-generic';

/** Result of a successful discovery. */
export interface DiscoveredCommand {
  runner: DiscoveredRunner;
  /** The raw command string (e.g. "pnpm test" or "pytest"). */
  command: string;
  /** Argv array ready for spawn. The first entry is the executable. */
  args: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** Detect the package manager by lock-file presence (pnpm > yarn > bun > npm). */
function detectPackageManager(cwd: string): string {
  if (exists(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (exists(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (exists(path.join(cwd, 'bun.lockb'))) return 'bun';
  return 'npm';
}

/** Return the runner tag for a script body, or null if unrecognised. */
function scriptRunner(body: string): DiscoveredRunner | null {
  if (/\bvitest\b/.test(body)) return 'vitest';
  if (/\bjest\b/.test(body)) return 'jest';
  if (/\bmocha\b/.test(body)) return 'mocha';
  return null;
}

// ---------------------------------------------------------------------------
// Per-ecosystem detectors (pure, no side-effects)
// ---------------------------------------------------------------------------

function detectNode(cwd: string): DiscoveredCommand | null {
  const pkgPath = path.join(cwd, 'package.json');
  const text = readText(pkgPath);
  if (!text) return null;

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }

  const scripts = pkg['scripts'] as Record<string, string> | undefined;
  if (!scripts || typeof scripts !== 'object') return null;

  const pm = detectPackageManager(cwd);

  // Preference order: test:unit > test:integration > test
  for (const scriptName of ['test:unit', 'test:integration', 'test']) {
    const body = scripts[scriptName];
    if (typeof body !== 'string' || !body.trim()) continue;

    const runner = scriptRunner(body) ?? 'node-generic';
    const command = `${pm} run ${scriptName}`;
    return {
      runner,
      command,
      args: [pm, 'run', scriptName],
    };
  }
  return null;
}

function detectPython(cwd: string): DiscoveredCommand | null {
  const pyprojectPath = path.join(cwd, 'pyproject.toml');
  const text = readText(pyprojectPath);
  if (!text) return null;

  // Check for [tool.pytest] or [tool.pytest.ini_options]
  if (/\[tool\.pytest/.test(text)) {
    return { runner: 'pytest', command: 'pytest', args: ['pytest'] };
  }

  // Fallback: setup.cfg or pytest.ini presence
  if (
    exists(path.join(cwd, 'pytest.ini')) ||
    exists(path.join(cwd, 'setup.cfg'))
  ) {
    return { runner: 'pytest', command: 'pytest', args: ['pytest'] };
  }

  return null;
}

function detectRust(cwd: string): DiscoveredCommand | null {
  if (!exists(path.join(cwd, 'Cargo.toml'))) return null;
  return { runner: 'cargo', command: 'cargo test', args: ['cargo', 'test'] };
}

function detectGo(cwd: string): DiscoveredCommand | null {
  // Look for *_test.go files in the root or immediate subdirs
  const entries = (() => {
    try {
      return fs.readdirSync(cwd);
    } catch {
      return [];
    }
  })();

  const hasGoTest = entries.some((f) => f.endsWith('_test.go'));
  if (hasGoTest || exists(path.join(cwd, 'go.mod'))) {
    // Verify at least one _test.go exists anywhere or there's a go.mod
    if (hasGoTest || exists(path.join(cwd, 'go.mod'))) {
      return {
        runner: 'go-test',
        command: 'go test ./...',
        args: ['go', 'test', './...'],
      };
    }
  }
  return null;
}

function detectRuby(cwd: string): DiscoveredCommand | null {
  if (
    exists(path.join(cwd, 'Gemfile')) &&
    exists(path.join(cwd, 'spec'))
  ) {
    return {
      runner: 'rspec',
      command: 'bundle exec rspec',
      args: ['bundle', 'exec', 'rspec'],
    };
  }
  return null;
}

function detectMakefile(cwd: string): DiscoveredCommand | null {
  const text = readText(path.join(cwd, 'Makefile'));
  if (!text) return null;

  // Look for a `test:` target at the start of a line
  if (/^test:/m.test(text)) {
    return {
      runner: 'node-generic',
      command: 'make test',
      args: ['make', 'test'],
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Auto-detect the project's test command from `cwd`.
 *
 * Returns the first successful match in ecosystem preference order:
 * Node → Python → Rust → Go → Ruby → Makefile fallback.
 *
 * **Never executes anything.**
 */
export function discoverTestCommand(cwd: string): DiscoveredCommand | null {
  return (
    detectNode(cwd) ??
    detectPython(cwd) ??
    detectRust(cwd) ??
    detectGo(cwd) ??
    detectRuby(cwd) ??
    detectMakefile(cwd) ??
    null
  );
}
