/**
 * `test_run` tool handler.
 *
 * Discovers the project test command, optionally narrows to a file or test
 * name, executes the suite, and returns structured results including
 * aggregate pass/fail counts and per-failure detail records.
 *
 * Execution model: identical to the bash handler — child_process.spawn with
 * detached: true for process-group cleanup, SIGKILL on timeout, ANSI stripping,
 * and a hard 8MB output cap. Uses context.resolveBase (or cwd) as the process
 * working directory.
 *
 * @module agent/tools/handlers/test-run
 */

import { spawn } from 'child_process';
import type { ToolHandler, ToolHandlerContext } from '../types.js';
import { discoverTestCommand, type DiscoveredRunner } from './test-run-discovery.js';
import { detectTestResult } from './test-runner-detector.js';
import { parseTestFailures, type TestFailure } from './test-failure-parser.js';
import { stripEscapeSequences } from '../../../utils/terminal-sanitize.js';
import { killProcessGroup } from '../../../utils/kill-process-group.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const HARD_CAP_BYTES = 8 * 1024 * 1024; // 8MB — same ceiling as bash handler
const MODEL_CAP_BYTES = 100 * 1024; // 100KB view

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

interface TestRunInput {
  file?: string;
  name?: string;
  timeout_ms?: number;
  coverage?: boolean;
}

function parseInput(raw: unknown): TestRunInput {
  if (typeof raw !== 'object' || raw === null) return {};
  const i = raw as Record<string, unknown>;
  return {
    file: typeof i['file'] === 'string' ? i['file'] : undefined,
    name: typeof i['name'] === 'string' ? i['name'] : undefined,
    timeout_ms:
      typeof i['timeout_ms'] === 'number'
        ? Math.min(Math.max(0, i['timeout_ms']), MAX_TIMEOUT_MS)
        : DEFAULT_TIMEOUT_MS,
    coverage: i['coverage'] === true,
  };
}

// ---------------------------------------------------------------------------
// Command building
// ---------------------------------------------------------------------------

/**
 * Build the full argv for the test invocation, incorporating optional file
 * and name narrowing with runner-specific syntax.
 */
function buildArgv(
  base: string[],
  runner: DiscoveredRunner,
  file?: string,
  name?: string,
  coverage?: boolean,
): string[] {
  const argv = [...base];

  switch (runner) {
    case 'vitest': {
      if (file) argv.push(file);
      if (name) argv.push('--testNamePattern', name);
      if (coverage) argv.push('--coverage');
      break;
    }
    case 'jest': {
      if (file) argv.push(file);
      if (name) argv.push('-t', name);
      if (coverage) argv.push('--coverage');
      break;
    }
    case 'mocha':
    case 'node-generic': {
      if (file) argv.push(file);
      if (name) argv.push('--grep', name);
      break;
    }
    case 'pytest': {
      if (file) argv.push(file);
      if (name) argv.push('-k', name);
      if (coverage) argv.push('--cov');
      break;
    }
    case 'cargo': {
      if (name) argv.push(name);
      if (coverage) argv.push('--', '--include-ignored');
      break;
    }
    case 'go-test': {
      if (file) {
        // go test takes a package path, not a file; use the file's dir
        const pkg = file.includes('/') ? file.split('/').slice(0, -1).join('/') || './...' : './...';
        argv[argv.length - 1] = pkg; // replace ./...
      }
      if (name) argv.push('-run', name);
      if (coverage) argv.push('-coverprofile=coverage.out');
      break;
    }
    case 'rspec': {
      if (file) argv.push(file);
      if (name) argv.push('--example', name);
      break;
    }
  }

  return argv;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function capOutput(s: string): string {
  if (s.length <= MODEL_CAP_BYTES) return s;
  const half = Math.floor(MODEL_CAP_BYTES / 2);
  return (
    s.slice(0, half) +
    `\n\n... [${s.length - MODEL_CAP_BYTES} bytes omitted] ...\n\n` +
    s.slice(s.length - half)
  );
}

// ---------------------------------------------------------------------------
// Spawn + collect
// ---------------------------------------------------------------------------

interface RunOutcome {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

function runCommand(
  argv: string[],
  effectiveCwd: string | undefined,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const start = Date.now();
    const [executable, ...args] = argv as [string, ...string[]];

    let settled = false;
    function settle(outcome: RunOutcome) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      signal.removeEventListener('abort', abortHandler);
      resolve(outcome);
    }

    const proc = spawn(executable, args, {
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
    });
    proc.unref();

    let stdout = '';
    let stderr = '';
    let totalBytes = 0;
    let overflowKilled = false;

    function maybeCap() {
      if (overflowKilled || settled || totalBytes < HARD_CAP_BYTES) return;
      overflowKilled = true;
      if (proc.pid !== undefined) killProcessGroup(proc.pid);
      const combined = stripEscapeSequences((stdout + stderr).trimEnd());
      settle({ output: combined, exitCode: null, timedOut: false, durationMs: Date.now() - start });
    }

    proc.stdout!.on('data', (chunk: Buffer) => {
      const remaining = HARD_CAP_BYTES - totalBytes;
      const safe = chunk.length <= remaining ? chunk : chunk.subarray(0, Math.max(0, remaining));
      totalBytes += safe.length;
      stdout += safe.toString('utf8');
      maybeCap();
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      const remaining = HARD_CAP_BYTES - totalBytes;
      const safe = chunk.length <= remaining ? chunk : chunk.subarray(0, Math.max(0, remaining));
      totalBytes += safe.length;
      stderr += safe.toString('utf8');
      maybeCap();
    });

    const timeoutHandle = setTimeout(() => {
      if (proc.pid !== undefined) killProcessGroup(proc.pid);
      const combined = stripEscapeSequences((stdout + stderr).trimEnd());
      settle({ output: combined, exitCode: null, timedOut: true, durationMs: Date.now() - start });
    }, timeoutMs);

    const abortHandler = () => {
      if (proc.pid !== undefined) killProcessGroup(proc.pid);
      settle({ output: '', exitCode: null, timedOut: false, durationMs: Date.now() - start });
    };
    signal.addEventListener('abort', abortHandler);
    if (signal.aborted) { abortHandler(); return; }

    proc.on('close', (code) => {
      if (settled) return;
      const combined = stripEscapeSequences((stdout + stderr).trimEnd());
      settle({ output: combined, exitCode: code, timedOut: false, durationMs: Date.now() - start });
    });

    proc.on('error', (err) => {
      settle({
        output: `spawn error: ${err.message}`,
        exitCode: null,
        timedOut: false,
        durationMs: Date.now() - start,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Extended ToolResult for test_run
// ---------------------------------------------------------------------------

export interface TestRunResult {
  runner: string;
  command: string;
  passed: number;
  failed: number;
  skipped?: number;
  duration_ms: number;
  failures: TestFailure[];
  raw_output: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const testRunHandler: ToolHandler = async (
  rawInput: unknown,
  signal: AbortSignal,
  context?: ToolHandlerContext,
) => {
  if (signal.aborted) {
    return { content: 'test_run aborted', isError: true };
  }

  const input = parseInput(rawInput);
  const effectiveCwd = context?.resolveBase ?? context?.cwd;

  // 1. Discover
  const discovered = discoverTestCommand(effectiveCwd ?? process.cwd());
  if (!discovered) {
    return {
      content:
        'No test command found. Checked: package.json scripts, pyproject.toml [tool.pytest], ' +
        'Cargo.toml, go.mod/*_test.go, Gemfile+spec/, Makefile test: target.',
      isError: true,
    };
  }

  // 2. Build argv
  const argv = buildArgv(
    discovered.args,
    discovered.runner,
    input.file,
    input.name,
    input.coverage,
  );
  const commandStr = argv.join(' ');

  // 3. Run
  const { output, exitCode, timedOut, durationMs } = await runCommand(
    argv,
    effectiveCwd,
    input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    signal,
  );

  if (signal.aborted) {
    return { content: 'test_run aborted', isError: true };
  }

  if (timedOut) {
    return {
      content: `Test run timed out after ${input.timeout_ms ?? DEFAULT_TIMEOUT_MS}ms.\n\n${capOutput(output)}`,
      isError: true,
    };
  }

  // 4. Parse results
  const aggregate = detectTestResult(output);
  const runner = aggregate?.runner ?? discovered.runner;
  const passed = aggregate?.passed ?? 0;
  const failed = aggregate?.failed ?? 0;
  const skipped = aggregate?.skipped;
  const failures = parseTestFailures(output, runner as import('./test-runner-detector.js').Runner);

  // 5. Build content summary
  const statusEmoji = failed === 0 && exitCode === 0 ? '✅' : '❌';
  const skipNote = skipped !== undefined ? ` | ${skipped} skipped` : '';
  const summary =
    `${statusEmoji} ${runner}: ${passed} passed | ${failed} failed${skipNote} — ${durationMs}ms\n` +
    `Command: ${commandStr}\n` +
    (failures.length > 0
      ? `\nFailed tests:\n${failures.map((f) => `  • ${f.name}${f.file ? ` (${f.file}${f.line !== undefined ? `:${f.line}` : ''})` : ''}: ${f.message}`).join('\n')}`
      : '') +
    `\n\n${capOutput(output)}`;

  const testRunResult: TestRunResult = {
    runner,
    command: commandStr,
    passed,
    failed,
    ...(skipped !== undefined ? { skipped } : {}),
    duration_ms: durationMs,
    failures,
    raw_output: output,
  };

  return {
    content: summary,
    isError: exitCode !== 0 && exitCode !== null,
    testResult: aggregate ?? undefined,
    // Attach the richer structured result as a non-standard field the
    // downstream trace annotation path can pick up.
    ...(testRunResult !== undefined ? { testRunResult } : {}),
  };
};
