/**
 * Per-session (and per-subagent) private temp directories for spawned shells.
 *
 * Every agent session in one process used to share the operator's `$TMPDIR`,
 * so one subagent's `rm -rf "$TMPDIR"/tmp.*` deleted the `mktemp` dirs of
 * every concurrent sibling session (observed 2026-09-30). Each session now
 * gets its own directory, injected as `TMPDIR`/`TMP`/`TEMP` into the env the
 * bash and test_run handlers hand to their child processes:
 *
 *   top-level  `<shortBase>/afk-<uid>/<rand8>/`
 *   fork       `<dispatching session's dir>/<rand8>/`
 *
 * Invariant (sun_path budget): POSIX `struct sockaddr_un.sun_path` is 104
 * bytes on macOS and 108 bytes on Linux (both NUL-terminated, so effective
 * limits are 103 / 107). Tools that create IPC sockets under TMPDIR (tsx,
 * ssh ControlPath, gpg-agent, tmux) will fail with EINVAL if the session dir
 * path is too long. We keep the per-session leaf to 8 random hex characters
 * so the full session dir fits in {@link UNIX_SOCKET_PATH_MAX} bytes minus the
 * longest socket suffix any such tool appends (~40 chars), giving a
 * comfortable budget. See SOCKET_LENGTH_BUDGET_CHECK comment below for the
 * explicit arithmetic.
 *
 * Invariant (short base): on darwin `os.tmpdir()` resolves through the
 * per-user var-folders path (~60 chars), blowing the sun_path budget before
 * a single level of nesting. We root the session dirs at `/tmp/afk-<uid>`
 * on darwin instead; /tmp is a symlink to /private/tmp and the kernel resolves
 * it, but the string we put in TMPDIR is only 4 chars, not 40+. On other
 * platforms `os.tmpdir()` is short enough that we use it unchanged.
 *
 * Invariant (ownership): a directory is deleted at close ONLY if this process
 * created it (`owned`), only after `lstat` proves it is not a symlink, only
 * after `realpath` proves it sits strictly inside the root, and always via
 * the lstat'd path (never via a realpath result that could race). Pre-existing
 * or foreign directories are used but never removed.
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
import { debugLog } from '../../utils/debug.js';
import type { AgentConfig } from '../types.js';

type Env = Record<string, string>;

/** The env keys a session temp dir is injected under (POSIX + Windows). */
export const TMP_ENV_KEYS = ['TMPDIR', 'TMP', 'TEMP'] as const;

// Invariant (sun_path budget): POSIX sun_path is 104 bytes on macOS (including
// NUL terminator), 108 bytes on Linux. IPC tools (tsx, ssh ControlPath, tmux,
// gpg-agent) create unix sockets under TMPDIR; typical worst-case suffix is
// "/tsx-<uid5>/<pid7>.pipe" = 23 chars. We target a session-dir length of at
// most UNIX_SOCKET_PATH_MAX - 40 to give a 17-char margin for tool variation.
//
// SOCKET_LENGTH_BUDGET_CHECK (macOS, uid=501, pid=1234567):
//   base  "/tmp/afk-501"        = 12 chars
//   leaf  "/<8hex>"             =  9 chars  (1 sep + 8 hex)
//   dir   total                 = 21 chars  ✓ well under 104-40=64
//
// SOCKET_LENGTH_BUDGET_CHECK (Linux, same inputs):
//   dir length 21 ≤ 108-40=68  ✓
//
// The leaf is 8 random hex chars (4 bytes = 2^32 values), sufficient to avoid
// collisions in any realistic parallel-session scenario.

/** Minimum of macOS and Linux sun_path limits (bytes, NUL-terminated). */
export const UNIX_SOCKET_PATH_MAX = 104;
/**
 * Characters we reserve for the tool-appended socket suffix:
 * "/tsx-<uid5>/<pid7>.pipe" = 23 chars, rounded up with margin.
 */
export const SOCKET_SUFFIX_BUDGET = 40;
/** Maximum session-dir length that keeps any socket path under sun_path. */
export const SESSION_DIR_MAX = UNIX_SOCKET_PATH_MAX - SOCKET_SUFFIX_BUDGET; // 64

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

/**
 * Short-base temp root: `/tmp/afk-<uid>` on darwin, `<os.tmpdir()>/afk-<uid>`
 * elsewhere.
 *
 * Contract: on darwin `os.tmpdir()` expands to a ~60-char var-folders path,
 * which blows the 104-byte sun_path limit before any nesting. `/tmp` is 4
 * chars and the kernel resolves the symlink to `/private/tmp` transparently,
 * so unix sockets created under `/tmp/afk-<uid>/<leaf>` use a short string.
 */
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
  const base = process.platform === 'darwin' ? '/tmp' : os.tmpdir();
  return path.join(base, `afk-${who}`);
}

/**
 * Whether `dir` is a real directory (not a symlink) owned by this process's uid.
 *
 * Windows note: `process.getuid` is undefined on Windows, so `currentUid()`
 * returns `undefined` and the uid ownership check is skipped. The symlink and
 * isDirectory checks still apply. A full ACL-based ownership check would
 * require native bindings (e.g. `icacls`) and is left as a future improvement.
 */
function isPrivateDir(dir: string): boolean {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) return false;
  const uid = currentUid();
  // uid === undefined on Windows — ownership check skipped (see comment above).
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
  /**
   * Cached "ensured" flag: true after the first successful `ensure()` call.
   * Avoids repeated `lstatSync` on every shell spawn. Reset to false by
   * `cleanup()` so a re-used instance does not skip re-creation after removal.
   */
  private ensured = false;

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
    if (this.ensured) return true;
    try {
      if (this.parent !== undefined) {
        if (!this.parent.ensure()) return false;
      } else {
        mkdirPrivate(this.root);
        if (!isPrivateDir(this.root)) return false;
      }
      if (mkdirPrivate(this.dir)) this.owned = true;
      const ok = isPrivateDir(this.dir);
      if (ok) this.ensured = true;
      return ok;
    } catch {
      return false;
    }
  }

  /**
   * Remove the directory iff owned and provably inside the root. Never throws.
   *
   * Invariant (TOCTOU window, residual risk, and mitigation strategy):
   * Node has no O_NOFOLLOW equivalent for recursive rm, so an attacker who
   * can write to the parent directory could swap this.dir for a symlink in
   * the gap between our lstat and the fs.promises.rm call. The previous
   * implementation operated directly on this.dir throughout, leaving that
   * window open.
   *
   * We close the window by renaming this.dir to a randomly-named sibling
   * before removing it. The sequence is:
   *   1. lstat(this.dir) to confirm it is a real directory, not a symlink.
   *   2. realpath containment check to confirm it sits inside this.root.
   *   3. rename(this.dir, sibling) where sibling is an unpredictable name
   *      in the same parent directory. The rename is atomic on POSIX local
   *      filesystems: once it succeeds, this.dir no longer exists, so an
   *      attacker cannot swap it. The renamed path is unguessable, so an
   *      attacker cannot pre-place a symlink at it.
   *   4. lstat(sibling) to re-confirm the renamed entry is still a real
   *      directory (not a symlink that somehow replaced it between steps 3
   *      and 4, which would require attacker knowledge of the random name
   *      before it is chosen, which is infeasible with 32 bits of entropy).
   *      Best-effort rm(sibling) on bail to avoid a dangling .rm entry.
   *   5. rm(sibling) with recursive+force.
   *
   * EXDEV (cross-device rename): On bind-mounted tmpdirs in containers, rename
   * can fail with EXDEV. We fall back to a direct rm in that case. The TOCTOU
   * window is not fully closed for the EXDEV path: a concurrent actor with
   * write access to the parent could swap this.dir for a symlink between the
   * fresh lstat and the rm call. However, the parent directory (afk-<uid>/) is
   * created with mode 0o700 and is owned by this process's uid, so the attacker
   * would need to already be running as this uid — at which point they have
   * full access to the session dir anyway. The residual exposure is therefore
   * negligible within the threat model (concurrent session isolation on a
   * developer machine or CI runner). A fresh lstat immediately before the rm
   * eliminates the window for any adversary who cannot predict the syscall gap.
   *
   * Residual risk: on network filesystems (NFS, SMB) or across mount points
   * rename may not be atomic, and the parent-directory write-access
   * prerequisite for this attack requires uid-level privilege in a
   * uid-restricted directory. The residual exposure is therefore negligible
   * in the threat model this module targets (concurrent session isolation on
   * a local developer machine or CI runner). The isOwned guard ensures we
   * only ever delete directories this process created.
   */
  async cleanup(): Promise<void> {
    if (!this.owned) return;
    this.owned = false;
    this.ensured = false;
    try {
      // Step 1: lstat the recorded path. If it is a symlink, bail immediately.
      const st = await fs.promises.lstat(this.dir);
      if (!st.isDirectory() || st.isSymbolicLink()) return;
      // Step 2: verify containment inside our root via realpath (resolves
      // ancestor symlinks in the root path itself, e.g. /tmp on macOS).
      const realRoot = await fs.promises.realpath(this.root);
      const realDir = await fs.promises.realpath(this.dir);
      if (!realDir.startsWith(realRoot + path.sep)) return;
      // Step 3: atomically rename this.dir to an unguessable sibling name.
      // After this succeeds, this.dir no longer exists, so a concurrent actor
      // cannot swap it for a symlink before the rm that follows.
      const siblingName = randomBytes(4).toString('hex') + '.rm';
      const sibling = path.join(path.dirname(this.dir), siblingName);
      try {
        await fs.promises.rename(this.dir, sibling);
      } catch (renameErr) {
        if ((renameErr as NodeJS.ErrnoException).code !== 'EXDEV') throw renameErr;
        // EXDEV: this.dir and its parent are on different mount points (e.g. a
        // bind-mounted tmpdir in a container). Rename cannot cross devices, so
        // fall back to a direct rm. Re-lstat immediately to close most of the
        // lstat-to-rm window; the 0o700 parent dir restricts who can race here
        // (see EXDEV comment in the docblock above).
        const st3 = await fs.promises.lstat(this.dir);
        if (!st3.isDirectory() || st3.isSymbolicLink()) return;
        // Containment check: re-verify the directory still sits inside our
        // root (mirrors step 2 of the happy path, closing the gap for the
        // EXDEV fallback where realDir/realRoot were computed before rename
        // was attempted).
        const realRootFb = await fs.promises.realpath(this.root);
        const realDirFb = await fs.promises.realpath(this.dir);
        if (!realDirFb.startsWith(realRootFb + path.sep)) return;
        // Uid check: ensure the directory is still owned by this process
        // (mirrors the isPrivateDir uid check on the happy path).
        const uid = currentUid();
        if (uid !== undefined && st3.uid !== uid) return;
        await fs.promises.rm(this.dir, { recursive: true, force: true });
        return;
      }
      // Step 4: re-verify the renamed entry is still a real directory.
      // If rename landed on a symlink (infeasible with 32-bit random suffix
      // on a local FS, but checked for defense-in-depth), bail. Best-effort
      // remove the sibling so it does not linger as a dangling .rm entry.
      const st2 = await fs.promises.lstat(sibling);
      if (!st2.isDirectory() || st2.isSymbolicLink()) {
        // Best-effort: remove the sibling we just created (unguessable name,
        // so attacker cannot pre-target it; rm is safe here).
        await fs.promises.rm(sibling, { recursive: true, force: true }).catch(() => undefined);
        return;
      }
      // Step 5: remove the renamed directory. The path is unguessable and
      // this.dir no longer exists, so the TOCTOU window is closed.
      await fs.promises.rm(sibling, { recursive: true, force: true });
    } catch {
      // Already gone, rename failed (non-EXDEV), or unreadable:
      // nothing this session can reclaim.
    }
  }
}

function register(dir: string, parent: SessionTmpdir | undefined): SessionTmpdir {
  const tmp = new SessionTmpdir(dir, parent?.root ?? sessionTmpdirRoot(), parent);
  registry.set(dir, tmp);
  return tmp;
}

/**
 * 8 random hex chars (4 bytes = ~4 billion values): short, unguessable, no PID
 * prefix. The `base` argument is intentionally ignored — keeping the leaf to
 * exactly 8 chars is what keeps session-dir lengths under SESSION_DIR_MAX.
 */
function uniqueName(_base: string): string {
  return randomBytes(4).toString('hex');
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
 *
 * When `ensure()` fails the temp-dir keys are silently dropped, falling back
 * to the inherited TMPDIR. A debugLog line is emitted so operators running
 * with AFK_DEBUG=1 can diagnose the root cause without spamming production.
 */
export function resolveSpawnTmpEnv(e: Env | undefined): Env | undefined {
  if (e === undefined || ensureSessionTmpdir(e)) return e;
  debugLog(`[session-tmpdir] ensure() failed for ${e['TMPDIR'] ?? '(none)'}; falling back to inherited TMPDIR`);
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
