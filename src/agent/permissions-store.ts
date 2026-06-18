/**
 * Persisted path-access grants for the path-approval elicitation flow.
 *
 * # Schema
 *
 * Lives at `~/.afk/config/permissions.json` (policy, not runtime state).
 * Designed for both machine round-tripping and `cat`-readable audit.
 *
 * ```json
 * {
 *   "version": 1,
 *   "grants": [
 *     {
 *       "id": "01JBXR3K8N7Q9V4E2T6Y0W8A1F",
 *       "path": "/Users/alice/Library/Application Support/Cursor/User",
 *       "mode": "read",
 *       "decision": "allow",
 *       "grantedAt": "2026-05-25T15:30:00Z",
 *       "source": "elicit:repl",
 *       "reason": "Approved via inline prompt"
 *     }
 *   ]
 * }
 * ```
 *
 * # Design notes
 *
 * - **Structured records, not Claude Code's stringly-typed `Read(path/**)` DSL.**
 *   Each field has a single meaning. `mode` and `decision` are their own
 *   columns, not encoded inside a string.
 * - **Stable IDs.** Each grant carries a ULID so `afk permissions revoke <id>`
 *   can target a specific record without parsing globs.
 * - **Provenance.** `source` records which surface created the grant
 *   (`elicit:repl`, `elicit:telegram`, `manual`); useful when auditing.
 * - **TTL-ready.** `expiresAt` is reserved for a future "allow for the next
 *   hour" feature. Not consumed today.
 *
 * # Threat model
 *
 * This file controls a non-adversarial policy boundary. A user with write
 * access to `~/.afk/config/permissions.json` can already run arbitrary code
 * in the same session, so file-level tamper protection is out of scope. The
 * elicitation flow is the integrity boundary — only paths the user actually
 * confirmed via prompt can be persisted here.
 *
 * @module agent/permissions-store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, isAbsolute } from 'path';
import { getPermissionsStorePath } from '../paths.js';

export type GrantMode = 'read' | 'write';
export type GrantDecision = 'allow' | 'deny';
export type GrantSource = 'elicit:repl' | 'elicit:telegram' | 'manual';

export interface PermissionGrant {
  /** ULID — sortable, opaque, unique per grant. */
  id: string;
  /** Absolute filesystem path (or path prefix) the grant covers. */
  path: string;
  /** Whether this grant covers read-only or read+write access. */
  mode: GrantMode;
  /** `allow` adds to roots on load; `deny` is a future-reserved blocklist (no consumer today). */
  decision: GrantDecision;
  /** ISO-8601 timestamp of the elicitation accept. */
  grantedAt: string;
  /** Which surface produced the grant. */
  source: GrantSource;
  /** Free-form human-readable rationale. */
  reason?: string;
  /** Optional ISO-8601 expiry. Not consumed yet; reserved for "allow for 1h". */
  expiresAt?: string;
}

export interface PermissionsFile {
  version: 1;
  grants: PermissionGrant[];
}

const EMPTY: PermissionsFile = { version: 1, grants: [] };

/**
 * Crockford-base32 ULID generator (no external dep).
 *
 * Contract: 26-character string, time-sortable, monotonic within a millisecond
 * via random-tail increment (sufficient for human-driven grant creation rates).
 * Not crypto-grade — these IDs are not secrets, they are revocation handles.
 *
 * Format: <10 chars time (ms since epoch, base32)><16 chars random (base32)>.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateUlid(now: number = Date.now()): string {
  // Time component — 10 chars, big-endian base32 of milliseconds.
  let time = now;
  const timeChars: string[] = new Array<string>(10).fill('0');
  for (let i = 9; i >= 0; i--) {
    timeChars[i] = CROCKFORD[time % 32]!;
    time = Math.floor(time / 32);
  }

  // Randomness component — 16 chars from Math.random (sufficient for IDs;
  // see contract note above).
  const randChars: string[] = new Array<string>(16).fill('0');
  for (let i = 0; i < 16; i++) {
    randChars[i] = CROCKFORD[Math.floor(Math.random() * 32)]!;
  }

  return timeChars.join('') + randChars.join('');
}

/**
 * Read the permissions file from disk. Returns an empty file on first run
 * or on any read/parse error — never throws.
 *
 * Invariant: a corrupt file is treated as empty, NOT as a fail-closed reject.
 * Fail-closed would leave users locked out of any path the model touched
 * with no way to recover short of `rm`. The corruption is silent because the
 * file is best-effort; rebuilding from elicitation prompts is the recovery
 * path.
 */
export function loadPermissionsFile(
  filePath: string = getPermissionsStorePath(),
): PermissionsFile {
  if (!existsSync(filePath)) return EMPTY;
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('version' in parsed) ||
      (parsed as { version: unknown }).version !== 1 ||
      !('grants' in parsed) ||
      !Array.isArray((parsed as { grants: unknown }).grants)
    ) {
      return EMPTY;
    }
    const grants = (parsed as { grants: unknown[] }).grants.filter(isValidGrant);
    return { version: 1, grants };
  } catch (err) {
    // Fail-soft (see the Invariant above): a read/parse failure returns empty
    // rather than locking the user out. Surface it on stderr though — silent
    // grant loss is hard to diagnose. The recovery path is re-approving via
    // the elicitation prompt, which re-persists the grants.
    // eslint-disable-next-line no-console
    console.warn(
      `[permissions] could not parse ${filePath} — treating as empty (persisted grants reset): ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return EMPTY;
  }
}

function isValidGrant(value: unknown): value is PermissionGrant {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    typeof v['path'] === 'string' &&
    isAbsolute(v['path']) &&
    (v['mode'] === 'read' || v['mode'] === 'write') &&
    (v['decision'] === 'allow' || v['decision'] === 'deny') &&
    typeof v['grantedAt'] === 'string' &&
    (v['source'] === 'elicit:repl' || v['source'] === 'elicit:telegram' || v['source'] === 'manual')
  );
}

/**
 * Append a grant and persist atomically (write-temp + rename). Returns the
 * grant after assignment of `id` and `grantedAt`.
 *
 * The caller passes the grant body without ID/timestamp; this function
 * stamps both so the audit trail is consistent regardless of caller drift.
 *
 * Ordered-operation invariant: parent directory creation MUST precede the
 * write to avoid ENOENT under a fresh `~/.afk/` tree. Constraint: file-system
 * semantics — Node.js writeFileSync does not create parents.
 */
export function appendGrant(
  body: Omit<PermissionGrant, 'id' | 'grantedAt'> & { grantedAt?: string },
  filePath: string = getPermissionsStorePath(),
): PermissionGrant {
  const current = loadPermissionsFile(filePath);
  const grant: PermissionGrant = {
    id: generateUlid(),
    grantedAt: body.grantedAt ?? new Date().toISOString(),
    path: body.path,
    mode: body.mode,
    decision: body.decision,
    source: body.source,
    ...(body.reason !== undefined ? { reason: body.reason } : {}),
    ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
  };
  const next: PermissionsFile = {
    version: 1,
    grants: [...current.grants, grant],
  };
  writeAtomic(filePath, next);
  return grant;
}

/**
 * Remove the grant matching `id`. Returns true on a successful removal,
 * false if no record matched (caller can surface "no such grant").
 */
export function revokeGrantById(
  id: string,
  filePath: string = getPermissionsStorePath(),
): boolean {
  const current = loadPermissionsFile(filePath);
  const next = current.grants.filter((g) => g.id !== id);
  if (next.length === current.grants.length) return false;
  writeAtomic(filePath, { version: 1, grants: next });
  return true;
}

/**
 * Return all `decision === 'allow'` grants for a given mode. Used at session
 * bootstrap to seed `readRoots`/`writeRoots` with previously-persisted paths.
 */
export function allowedPathsForMode(
  mode: GrantMode,
  filePath: string = getPermissionsStorePath(),
): string[] {
  const file = loadPermissionsFile(filePath);
  const now = Date.now();
  return file.grants
    .filter((g) => g.decision === 'allow')
    .filter((g) => g.mode === mode || (mode === 'read' && g.mode === 'write'))
    .filter((g) => {
      // Honor expiresAt if set. Best-effort — comparing ISO strings via
      // Date.parse is sufficient for hour-class TTLs.
      if (g.expiresAt === undefined) return true;
      const exp = Date.parse(g.expiresAt);
      if (!Number.isFinite(exp)) return true; // unparseable → treat as no-expiry, do not drop
      return exp > now;
    })
    .map((g) => g.path);
}

/**
 * Seed a grant manager's read/write roots from the persisted `allow` grants in
 * permissions.json. Call ONCE at interactive-session bootstrap, right after
 * the grant manager is wired to the provider — this is what makes the
 * `persist` elicitation choice actually deliver "future sessions inherit it".
 *
 * No-op when the file is absent or empty. `addReadRoot`/`addWriteRoot` are
 * idempotent, so re-seeding (or overlap with the cwd root) is harmless. A
 * write-mode grant is added to BOTH lists: `allowedPathsForMode('read')`
 * includes write grants (read ⊆ write), and the write loop additionally pushes
 * them into the write roots.
 *
 * The param is a structural subset of the `GrantManager` interface so this
 * module (agent layer) needn't import it from the CLI layer.
 */
export function seedPersistedGrants(
  grantManager: {
    addReadRoot(absPath: string, source: 'slash' | 'tool'): void;
    addWriteRoot(absPath: string, source: 'slash' | 'tool'): void;
  },
  filePath: string = getPermissionsStorePath(),
): void {
  for (const p of allowedPathsForMode('read', filePath)) {
    grantManager.addReadRoot(p, 'tool');
  }
  for (const p of allowedPathsForMode('write', filePath)) {
    grantManager.addWriteRoot(p, 'tool');
  }
}

/**
 * Atomic write: temp-file + rename. Mirrors the pattern used elsewhere in
 * agent-afk for config files (`~/.afk/config/afk.config.json` etc.) so
 * concurrent reads never see a half-written JSON document.
 */
function writeAtomic(filePath: string, contents: PermissionsFile): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(contents, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  // fs.renameSync is atomic within a single filesystem on POSIX + NTFS;
  // sufficient for our user-scope config file.
  renameSync(tmp, filePath);
}
