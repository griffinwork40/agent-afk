/**
 * Per-session (and per-subagent) private temp directories for spawned shells.
 *
 * Every agent session in one process used to share the operator's `$TMPDIR`,
 * so one subagent's `rm -rf "$TMPDIR"/tmp.*` deleted the `mktemp` dirs of
 * every concurrent sibling session (observed 2026-09-30). Each session now
 * gets its own directory, injected as `TMPDIR`/`TMP`/`TEMP` into the env the
 * bash and test_run handlers hand to their child processes:
 *
 *   top-level  `<os.tmpdir()>/afk-<uid>/<pid>-<rand>/`
 *   fork       `<dispatching session's dir>/<subagentId>-<rand>/`
 *
 * Invariant (ownership): a directory is deleted at close ONLY if this process
 * created it (`owned`), only after `realpath` proves it sits strictly inside
 * the root, and never through a symlink. Pre-existing or foreign directories
 * are used but never removed.
 *
 * Invariant (laziness): allocation only reserves a path. The directory is
 * created on the first shell spawn ({@link ensureSessionTmpdir}), so sessions
 * that never run a command leave nothing on disk. When it cannot be created
 * the caller drops the override and the shell falls back to the inherited
 * temp dir: a broken namespace must never stop a command from running.
 *
 * Contract (parent lookup): a fork learns its parent's directory from the
 * {@link runInTmpdirScope} async context the dispatcher wraps every tool call
 * in. `assembleChildConfig` runs inside the parent's `agent`/`skill`/`compose`
 * call, so the scope there is the dispatching session's directory.
 *
 * Opt-out: `AFK_SESSION_TMPDIR_DISABLE=1` restores the shared `$TMPDIR`.
 *
 * @module agent/session/session-tmpdir
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { env } from '../../config/env.js';
import type { AgentConfig } from '../types.js';

type Env = Record<string, string>;

/** The env keys a session temp dir is injected under (POSIX + Windows). */
export const TMP_ENV_KEYS = ['TMPDIR', 'TMP', 'TEMP'] as const;

let rootOverride: string | undefined;
/** Allocated session dirs keyed by absolute path. */
const registry = new Map<string, SessionTmpdir>();
/** The dispatching session's temp dir, for nesting forks under it. */
const scope = new AsyncLocalStorage<string>();

/** Test seam: relocate the root (pass `undefined` to restore the default). */
export function setSessionTmpdirRootForTests(root: string | undefined): void {
  rootOverride = root;
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function safeSegment(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '-');
  return cleaned.length > 0 ? cleaned : 'session';
}

/** `<os.tmpdir()>/afk-<uid>` (username on platforms without uids). */
export function sessionTmpdirRoot(): string {
  if (rootOverride !== undefined) return rootOverride;
  let who = String(currentUid() ?? '');
  if (who === '') {
    try {
      who = safeSegment(os.userInfo().username);
    } catch {
      who = 'user';
    }
  }
  return path.join(os.tmpdir(), `afk-${who}`);
}

/** A real directory (not a symlink) owned by this uid. */
function isPrivateDir(dir: string): boolean {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) return false;
  const uid = currentUid();
  return uid === undefined || st.uid === uid;
}

/** mkdir that tolerates a concurrent creator. Returns true when WE created it. */
function mkdirPrivate(dir: string): boolean {
  if (fs.existsSync(dir)) return false;
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/** One allocated (possibly not yet created) session temp directory. */
export class SessionTmpdir {
  private owned = false;

  constructor(
    readonly dir: string,
    readonly root: string,
    private readonly parent: SessionTmpdir | undefined,
  ) {}

  /** Whether this process created the directory (and so may delete it). */
  get isOwned(): boolean {
    return this.owned;
  }

  /** Create the directory (and its ancestors) if missing. False = unusable. */
  ensure(): boolean {
    try {
      if (this.parent !== undefined) {
        if (!this.parent.ensure()) return false;
      } else {
        mkdirPrivate(this.root);
        if (!isPrivateDir(this.root)) return false;
      }
      if (mkdirPrivate(this.dir)) this.owned = true;
      return isPrivateDir(this.dir);
    } catch {
      return false;
    }
  }

  /** Remove the directory iff owned and provably inside the root. Never throws. */
  async cleanup(): Promise<void> {
    if (!this.owned) return;
    this.owned = false;
    try {
      if ((await fs.promises.lstat(this.dir)).isSymbolicLink()) return;
      const realRoot = await fs.promises.realpath(this.root);
      const realDir = await fs.promises.realpath(this.dir);
      if (!realDir.startsWith(realRoot + path.sep)) return;
      await fs.promises.rm(realDir, { recursive: true, force: true });
    } catch {
      // Already gone, or unreadable: nothing this session can reclaim.
    }
  }
}

function register(dir: string, parent: SessionTmpdir | undefined): SessionTmpdir {
  const tmp = new SessionTmpdir(dir, parent?.root ?? sessionTmpdirRoot(), parent);
  registry.set(dir, tmp);
  return tmp;
}

function uniqueName(base: string): string {
  return `${safeSegment(base)}-${randomBytes(4).toString('hex')}`;
}

export function isSessionTmpdirDisabled(): boolean {
  return env.AFK_SESSION_TMPDIR_DISABLE === '1';
}

/** Copy of `base` with every temp-dir key pointed at `dir`. */
export function withTmpEnv(base: Env | undefined, dir: string): Env {
  return { ...base, TMPDIR: dir, TMP: dir, TEMP: dir };
}

/** The registered session dir an env points at, if any. */
export function lookupSessionTmpdir(e: Env | undefined): SessionTmpdir | undefined {
  const dir = e?.['TMPDIR'];
  return dir !== undefined ? registry.get(dir) : undefined;
}

/**
 * Top-level allocation (AgentSession construction). A no-op when disabled or
 * when the config already carries a `TMPDIR` — a fork's (stamped by
 * {@link childTmpEnvPatch}) or one the caller chose deliberately.
 */
export function withSessionTmpdir(config: AgentConfig): AgentConfig {
  if (isSessionTmpdirDisabled() || config.env?.['TMPDIR'] !== undefined) return config;
  const tmp = register(path.join(sessionTmpdirRoot(), uniqueName(String(process.pid))), undefined);
  return { ...config, env: withTmpEnv(config.env, tmp.dir) };
}

/**
 * Fork allocation (`assembleChildConfig`): a fresh dir nested under the
 * dispatching session's dir, merged over `base` so keys like `PLUGIN_ROOT`
 * survive. A caller-chosen (unregistered) `TMPDIR` is respected; an inherited
 * session dir is not — a child never shares its parent's or a sibling's dir.
 */
export function childTmpEnvPatch(base: Env | undefined, subagentId: string): { env?: Env } {
  if (isSessionTmpdirDisabled()) return {};
  const callerDir = base?.['TMPDIR'];
  if (callerDir !== undefined && !registry.has(callerDir)) return {};
  const scoped = scope.getStore();
  const parent = scoped !== undefined ? registry.get(scoped) : undefined;
  const dir = path.join(parent?.dir ?? sessionTmpdirRoot(), uniqueName(subagentId));
  return { env: withTmpEnv(base, register(dir, parent).dir) };
}

/**
 * Lazily create the dir an env points at. True when the env is usable as-is
 * (including foreign/unset `TMPDIR`); false when the session dir could not
 * be created and the caller should drop the override.
 */
export function ensureSessionTmpdir(e: Env | undefined): boolean {
  return lookupSessionTmpdir(e)?.ensure() ?? true;
}

/**
 * The env to spawn with: `e` as-is when its session dir exists (created
 * lazily here), else `e` minus the temp-dir keys so the child inherits the
 * process temp dir instead of a path that does not exist.
 */
export function resolveSpawnTmpEnv(e: Env | undefined): Env | undefined {
  if (e === undefined || ensureSessionTmpdir(e)) return e;
  const copy = { ...e };
  for (const key of TMP_ENV_KEYS) delete copy[key];
  return copy;
}

/** Run `fn` with `dir` as the parent scope for forks it creates. */
export function runInTmpdirScope<R>(dir: string | undefined, fn: () => R): R {
  return dir !== undefined && registry.has(dir) ? scope.run(dir, fn) : fn();
}

/** Session close: delete the session dir if this process created it. */
export async function cleanupSessionTmpdir(e: Env | undefined): Promise<void> {
  const tmp = lookupSessionTmpdir(e);
  if (tmp === undefined) return;
  registry.delete(tmp.dir);
  await tmp.cleanup();
}
