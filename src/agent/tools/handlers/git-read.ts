/**
 * Handler for the structured read-only `git_read` tool (#3754).
 *
 * Executes ONLY the argv built by {@link planGitRead}: `execFile('git', argv)`,
 * never a shell string. Fixed global options the model cannot influence
 * neutralise every git path that spawns a program or writes:
 *   --no-pager, -c core.pager=cat, -c core.fsmonitor=false, -c diff.external=
 *   (plus --no-ext-diff/--no-textconv forced per subcommand by the policy),
 *   and --no-optional-locks (status would otherwise refresh the index).
 *   Read-only subcommands run no hooks.
 * Inherited `GIT_*` env vars are dropped (no GIT_DIR / GIT_CONFIG_* / GIT_EXTERNAL_DIFF
 * redirection) and GIT_PAGER=PAGER=cat, GIT_EDITOR=:, GIT_OPTIONAL_LOCKS=0 are set.
 * The process runs in the session cwd; output is bounded.
 *
 * @module agent/tools/handlers/git-read
 */

import { execFile as execFileCallback } from 'node:child_process';
import type { ToolHandler, ToolHandlerContext, ToolResult } from '../types.js';
import { buildChildEnv } from './bash-env-scrub.js';
import { planGitRead } from '../git-read.policy.js';

/** Default and hard ceiling on returned bytes. */
export const GIT_READ_DEFAULT_MAX_BYTES = 50 * 1024;
export const GIT_READ_MAX_BYTES_CEILING = 200 * 1024;
const PROCESS_BUFFER_BYTES = 1024 * 1024;
const TIMEOUT_MS = 30_000;

/** Global options prepended to every invocation (before the subcommand). */
export const GIT_READ_GLOBAL_ARGS: readonly string[] = [
  '--no-pager',
  '--no-optional-locks',
  '-c', 'core.pager=cat',
  '-c', 'core.fsmonitor=false',
  '-c', 'diff.external=',
  '-c', 'color.ui=false',
  '-c', 'log.showSignature=false',
  // Defense in depth for signature verification (policy already rejects %G…,
  // %(signature…) and --sort=signature): pin every verifier program to `false`,
  // a no-op that always fails, so verification reports "bad" without running a
  // repo- or user-configured program. `false` over `true`: a non-zero exit is an
  // unambiguous verification failure on every backend.
  '-c', 'gpg.program=false',
  '-c', 'gpg.openpgp.program=false',
  '-c', 'gpg.ssh.program=false',
  '-c', 'gpg.x509.program=false',
];

/** Child env: inherited env minus every `GIT_*` override, plus pager/editor pins. */
export function buildGitReadEnv(contextEnv: Record<string, string> | undefined): Record<string, string | undefined> {
  const base = buildChildEnv(contextEnv);
  for (const key of Object.keys(base)) {
    if (key.startsWith('GIT_')) delete base[key];
  }
  return {
    ...base,
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_EDITOR: ':',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function clampMaxBytes(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return GIT_READ_DEFAULT_MAX_BYTES;
  return Math.min(Math.floor(v), GIT_READ_MAX_BYTES_CEILING);
}

/** Truncate to `maxBytes` UTF-8 bytes, appending a marker when cut. */
export function boundOutput(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  // Back off to a UTF-8 character boundary: never split a multi-byte sequence.
  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  const head = buf.subarray(0, end).toString('utf8');
  return `${head}\n… [git_read output truncated: ${buf.length - end} of ${buf.length} bytes omitted; narrow with paths/args or raise max_bytes]`;
}

interface ExecOutcome { stdout: string; stderr: string; code: number | null; overflow: boolean; error?: string }

function runGit(argv: string[], cwd: string, env: Record<string, string | undefined>, signal: AbortSignal): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    execFileCallback(
      'git',
      argv,
      { cwd, env, signal, timeout: TIMEOUT_MS, maxBuffer: PROCESS_BUFFER_BYTES, encoding: 'utf8', windowsHide: true },
      (err, stdout, stderr) => {
        if (err === null) { resolve({ stdout, stderr, code: 0, overflow: false }); return; }
        const e = err as NodeJS.ErrnoException & { code?: unknown };
        const overflow = e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        const code = typeof e.code === 'number' ? e.code : null;
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code, overflow, ...(overflow || code !== null ? {} : { error: e.message }) });
      },
    );
  });
}

async function gitReadImpl(input: unknown, signal: AbortSignal, context: ToolHandlerContext | undefined, fallbackCwd: string | undefined): Promise<ToolResult> {
  const req = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const cwd = context?.resolveBase ?? fallbackCwd ?? process.cwd();
  const plan = planGitRead({ subcommand: req['subcommand'], args: req['args'], paths: req['paths'], pattern: req['pattern'] }, cwd);
  if (!plan.ok) return { content: `git_read: ${plan.error}`, isError: true };
  const maxBytes = clampMaxBytes(req['max_bytes']);
  const out = await runGit([...GIT_READ_GLOBAL_ARGS, ...plan.argv], cwd, buildGitReadEnv(context?.env), signal);
  if (out.error !== undefined) return { content: `git_read: failed to run git: ${out.error}`, isError: true };
  // git grep exits 1 for "no matches" — not an error.
  const noMatch = plan.argv[0] === 'grep' && out.code === 1 && out.stderr.trim() === '';
  // git merge-base --is-ancestor exits 1 to mean "false" (not an ancestor) — not an error.
  const isAncestorFalse = plan.argv[0] === 'merge-base' && plan.argv.includes('--is-ancestor') && out.code === 1 && out.stderr.trim() === '';
  // git cat-file -e exits 1 when the object does not exist — not an error.
  const catFileAbsent = plan.argv[0] === 'cat-file' && plan.argv.includes('-e') && out.code === 1 && out.stderr.trim() === '';
  if (out.code !== 0 && !out.overflow && !noMatch && !isAncestorFalse && !catFileAbsent) {
    const errText = out.stderr.trim() || out.stdout.trim();
    // Contract: when git exits 128 (bad revision / bad ref), enrich the error
    // with a structured hint so the model breaks out of retry loops instead of
    // varying the same bad argument. The audit (2026-10-26) found 3 sessions
    // produced 38% of all git_read errors from looping on bad revision args.
    const isBadRef = out.code === 128 || /bad revision|unknown revision|bad object|not a valid object name/.test(errText);
    const hint = isBadRef
      ? `\n\nDo not retry with the same revision. Use \`git_read\` with subcommand \`log\` (e.g. \`--oneline -20\`) or \`branch\` (\`-a\`) to discover valid refs before retrying.`
      : '';
    return { content: boundOutput(`git exited ${out.code ?? 'abnormally'}: ${errText}${hint}`, maxBytes), isError: true };
  }
  const body = out.stdout.length > 0 ? out.stdout
    : noMatch ? '(no matches)'
    : isAncestorFalse ? '(not an ancestor)'
    : catFileAbsent ? '(object not found)'
    : '(no output)';
  return { content: boundOutput(body, maxBytes) };
}

/** Factory closing over the session cwd as the last resolve-base tier. */
export function createGitReadHandler(cwd?: string): ToolHandler {
  return (input, signal, context) => gitReadImpl(input, signal, context, cwd);
}

export const gitReadHandler: ToolHandler = createGitReadHandler();
