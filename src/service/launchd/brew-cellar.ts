import { existsSync, realpathSync } from 'fs';
import { join } from 'path';

// ─────────────────────────────────────────────────────────────────────────
// Homebrew Cellar execPath normalization (fix C)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Homebrew versioned Cellar regex.
 *
 * Homebrew stores the concrete binary under a versioned Cellar path:
 *   /opt/homebrew/Cellar/<formula>/<ver>/bin/node    (Apple Silicon)
 *   /usr/local/Cellar/<formula>/<ver>/bin/node       (Intel macOS)
 *
 * The formula name is typically `node` but can be a versioned tap like
 * `node@22`. After `brew upgrade node` Homebrew cleans the old versioned
 * path, but any LaunchAgent plist that baked in the old path keeps trying
 * to exec a now-deleted binary — the service crash-loops under KeepAlive.
 *
 * The stable opt-symlink lives at:
 *   <prefix>/opt/<formula>/bin/node
 *
 * and is kept alive across minor upgrades by Homebrew's link step.
 */
const BREW_CELLAR_RE =
  /^((?:\/opt\/homebrew|\/usr\/local)\/Cellar\/)([^/]+)\/[^/]+(\/.+)$/;

/**
 * Normalize a Homebrew Cellar-versioned `node` path to its stable
 * `opt/<formula>` symlink — only when the symlink exists AND resolves to
 * the same real binary, preventing stale plist paths after `brew upgrade`.
 *
 * Pure and injectable for tests. Applies to both `resolveServicePath`
 * (PATH prepend) and the telegram `ProgramArguments` argv[0].
 *
 * @param execPath  - Candidate node binary path (often `process.execPath`).
 * @param existsFn  - Injectable existence check (defaults to `existsSync`).
 * @param realpathFn - Injectable realpath resolver (defaults to `realpathSync`).
 * @returns The stable opt-symlink path when safe to use; `execPath` otherwise.
 */
export function normalizeBrewCellarExecPath(
  execPath: string,
  existsFn: (p: string) => boolean = existsSync,
  realpathFn: (p: string) => string = realpathSync,
): string {
  const m = BREW_CELLAR_RE.exec(execPath);
  if (!m) return execPath;
  // prefix is e.g. /opt/homebrew or /usr/local
  const prefix = m[1]!.replace(/\/Cellar\/$/, '');
  const formula = m[2]!;
  const suffix = m[3]!; // e.g. /bin/node
  const optPath = join(prefix, 'opt', formula, suffix);
  if (!existsFn(optPath)) return execPath;
  try {
    const optReal = realpathFn(optPath);
    const srcReal = realpathFn(execPath);
    if (optReal !== srcReal) return execPath;
    return optPath;
  } catch {
    return execPath;
  }
}
