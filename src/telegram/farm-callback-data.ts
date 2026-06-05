/**
 * Wire format for Telegram inline-button callbacks emitted by the farm digest.
 *
 * Telegram enforces a hard 64-byte limit on `callback_data`. The shape here is
 * the smallest stable encoding that:
 *
 *   1. Namespaces under `afk:` so future surfaces (e.g. daemon, ship) can
 *      coexist without colliding.
 *   2. Identifies the channel (`f` = farm) in a single byte so we can route
 *      with a regex at the bot level.
 *   3. Uses single-letter action codes (`p|d|r|x`) — readable in `tg.getUpdates`
 *      logs and cheap to extend.
 *   4. Trails the `taskSlug` verbatim so the dispatcher can `loadFarm(slug)`
 *      without a side table mapping ids → slugs.
 *
 * The `taskSlug` grammar is defined in `src/agent/worktree.ts` via `slugify` +
 * `isoCompact` + 4-hex suffix: lowercase a-z, 0-9, `T`, and `-`. The parser
 * enforces that grammar explicitly — anything else is rejected before the
 * dispatcher ever touches the filesystem.
 *
 * @module telegram/farm-callback-data
 */

export const FARM_CALLBACK_PREFIX = 'afk:f:';

/** Hard limit imposed by Telegram on `callback_data`. */
export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

/**
 * Single-letter action codes. Keep this list tight — every new action chews
 * into the 64-byte budget and the dispatcher's switch statement.
 *
 * - `p` — Open PR from winning branch (no merge).
 * - `d` — Full diff: respond with `git log` + `--stat` of the winning branch.
 * - `r` — Respawn from winner: spawn a fresh farm seeded from the winning branch.
 * - `x` — Discard all: mark the farm rejected. GC is intentionally NOT
 *         performed here — that's Day 4c.
 */
export type FarmCallbackAction = 'p' | 'd' | 'r' | 'x';

const VALID_ACTIONS = new Set<FarmCallbackAction>(['p', 'd', 'r', 'x']);

/**
 * `taskSlug` grammar produced by `slugify` + `isoCompact` + hex suffix.
 *
 * Matters because the dispatcher uses the parsed slug as a path component
 * (via `getFarmDir(slug)`). A regex tighter than the path-traversal threat
 * model is the defense in depth — even if `getFarmDir` ever changed shape,
 * a `..` slug would never reach it.
 */
const TASK_SLUG_RE = /^[a-z0-9T][a-z0-9T-]{0,62}$/;

export interface ParsedFarmCallback {
  action: FarmCallbackAction;
  taskSlug: string;
}

/**
 * Parse a `callback_data` string into a structured farm callback.
 *
 * Returns `null` for any input that doesn't match the exact `afk:f:<a>:<slug>`
 * shape, has an unknown action code, or carries a slug that fails the slug
 * grammar regex. Callers should treat `null` as "not for us" — Telegram will
 * have routed the callback here via a regex match, but bad payloads still
 * happen on schema-mismatched clients or hand-crafted requests.
 *
 * Pure function — no I/O, no exceptions.
 */
export function parseFarmCallback(data: string | undefined | null): ParsedFarmCallback | null {
  if (!data) return null;
  if (!data.startsWith(FARM_CALLBACK_PREFIX)) return null;
  // Length check up front — anything over the wire limit is corruption.
  if (Buffer.byteLength(data, 'utf8') > TELEGRAM_CALLBACK_DATA_MAX_BYTES) return null;

  const rest = data.slice(FARM_CALLBACK_PREFIX.length);
  const colonIdx = rest.indexOf(':');
  if (colonIdx < 1) return null;

  const action = rest.slice(0, colonIdx);
  const taskSlug = rest.slice(colonIdx + 1);

  if (!VALID_ACTIONS.has(action as FarmCallbackAction)) return null;
  if (!TASK_SLUG_RE.test(taskSlug)) return null;

  return { action: action as FarmCallbackAction, taskSlug };
}

/**
 * Build a callback_data string for a given action + taskSlug.
 *
 * Throws if the result would exceed Telegram's 64-byte limit — this is a
 * programmer error (slug format changed without updating the budget), not
 * runtime input, so loud failure is correct.
 */
export function buildFarmCallback(action: FarmCallbackAction, taskSlug: string): string {
  if (!TASK_SLUG_RE.test(taskSlug)) {
    throw new Error(`buildFarmCallback: invalid taskSlug ${JSON.stringify(taskSlug)}`);
  }
  const data = `${FARM_CALLBACK_PREFIX}${action}:${taskSlug}`;
  const bytes = Buffer.byteLength(data, 'utf8');
  if (bytes > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
    throw new Error(
      `buildFarmCallback: payload ${bytes} bytes exceeds Telegram's ${TELEGRAM_CALLBACK_DATA_MAX_BYTES}-byte limit (slug=${taskSlug})`,
    );
  }
  return data;
}
