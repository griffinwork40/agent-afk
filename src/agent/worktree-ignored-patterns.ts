/**
 * Classification policy for the worktree ignored-file probe.
 *
 * Contract: split out of `worktree-ignored-probe.ts` so that module holds only
 * IO (git invocation, line parsing, scoped expansion) while the policy — which
 * ignored paths a rebuild can restore — lives here as data. Pure and
 * synchronous; nothing here touches the filesystem.
 *
 * @module agent/worktree-ignored-patterns
 */

/** How the probe must treat one ignored entry git reported. */
export type IgnoredEntryClass =
  /** Reapable, and cheap enough to trust without looking inside. */
  | 'opaque'
  /** Reapable only if a scoped expansion finds nothing sensitive beneath it. */
  | 'inspectable'
  /** Never reapable — removing the checkout would destroy it. */
  | 'protected';

/**
 * Leaf filenames that are NEVER rebuildable, whatever directory holds them.
 *
 * Invariant: this list outranks every rebuildable pattern below, and the
 * precedence is load-bearing. `git status --ignored` collapses an ignored
 * directory to a single line, so a secret nested under `dist/` is invisible
 * until the probe expands that directory; once expanded, the leaf has to
 * protect the tree even though its parent matched a build-output pattern.
 * Without this table, `dist/secrets.env` reads "rebuildable" twice over — once
 * because git never listed it, and again because the directory prefix matches.
 * Matched case-insensitively against the final path segment only.
 */
const SENSITIVE_LEAF_PATTERNS: readonly RegExp[] = [
  // Any `*.env` leaf, not just a dot-prefixed one: `app.env` and `prod.env` are
  // as unrecoverable as `.env`, and the dot-anchored form let `dist/app.env`
  // survive expansion and be reaped with the checkout. Subsumes `/^\.env$/`.
  /\.env$/,
  /^\.env\./,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.keystore$/,
  /\.jks$/,
  /^id_rsa/,
  /^id_ed25519/,
  /^\.netrc$/,
  /\.sqlite3?$/,
  /\.db$/,
];

/**
 * Sensitive by NAME rather than by FORMAT, and the distinction is the whole
 * point: the table above says "this IS a credential", these say "this is ABOUT
 * credentials". Inside generated output the second claim is worthless, because
 * every build artifact echoes the name of the source file it came from.
 *
 * Invariant: suppressed only at the INTERSECTION of two conditions — the entry
 * sits under a rebuildable directory ({@link isUnderGeneratedOutput}) AND its
 * leaf carries a {@link GENERATED_ARTIFACT_EXTENSIONS} suffix. A repo holding
 * `src/agent/auth/credential-resolver.ts` emits
 * `dist/agent/auth/credential-resolver.d ts` and a coverage page of the same
 * name; both matched `/credential/`, protected the tree, and made every
 * worktree that had ever run a build or a coverage pass permanently unreapable
 * — the same immortality the module docblock exists to prevent, arriving
 * through the sensitivity table instead of the rebuildable one.
 *
 * Neither condition alone is enough. Directory alone would reap a hand-placed
 * `dist/nested/app-credentials.json`, which #759 deliberately protects and
 * pins with a test. Extension alone would reap an authored `credentials.html`
 * at the repo root. Requiring both isolates the actual false positive: a
 * compiled or rendered artifact whose name is an echo of the source module it
 * was generated from.
 */
const SENSITIVE_NAME_HINTS: readonly RegExp[] = [/credential/, /secret/];

/**
 * Suffixes a compiler or report generator produces. Paired with the directory
 * gate above, never used alone.
 *
 * Contract: data formats are deliberately absent. `.json`, `.yaml`, `.txt` and
 * friends are where a real credential file plausibly lives even inside `dist/`,
 * and no toolchain name-mirrors a source module into them — so excluding them
 * costs nothing against the false positive and keeps #759's guarantee intact.
 */
const GENERATED_ARTIFACT_EXTENSIONS =
  /\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts|map|html?|css|svg)$/;

/**
 * Dependency trees and caches: machine-owned, never hand-authored, and often
 * enormous. Reapable without inspection — expanding `node_modules/` to look for
 * a stray secret would walk tens of thousands of paths on every sweep tick,
 * which is exactly the cost the collapsed `--ignored` output exists to avoid.
 */
const OPAQUE_REBUILDABLE_DIRS: readonly RegExp[] = [
  /(?:^|\/)node_modules\//,
  /(?:^|\/)\.pnpm(-store)?\//,
  /(?:^|\/)\.yarn\//,
  /(?:^|\/)bower_components\//,
  /(?:^|\/)vendor\/bundle\//,
  /(?:^|\/)\.venv\//,
  /(?:^|\/)venv\//,
  /(?:^|\/)__pycache__\//,
  /(?:^|\/)\.turbo\//,
  /(?:^|\/)\.parcel-cache\//,
  /(?:^|\/)\.vite\//,
  /(?:^|\/)\.cache\//,
  /(?:^|\/)\.gradle\//,
  /(?:^|\/)\.pytest_cache\//,
  /(?:^|\/)\.mypy_cache\//,
  /(?:^|\/)\.ruff_cache\//,
  /(?:^|\/)\.nyc_output\//,
];

/**
 * Build output and log directories: small enough to enumerate, and plausibly
 * holding something a human put there by hand (a generated deliverable, a
 * scratch `.env` a script dropped next to the bundle, a captured transcript).
 * Reapable, but only after a scoped expansion confirms no sensitive leaf hides
 * inside.
 */
const INSPECTABLE_REBUILDABLE_DIRS: readonly RegExp[] = [
  /(?:^|\/)dist\//,
  /(?:^|\/)build\//,
  /(?:^|\/)out\//,
  /(?:^|\/)lib-cov\//,
  /(?:^|\/)\.next\//,
  /(?:^|\/)\.nuxt\//,
  /(?:^|\/)\.svelte-kit\//,
  /(?:^|\/)\.output\//,
  /(?:^|\/)target\//,
  /(?:^|\/)coverage\//,
  // Invariant: `logs/` must stay in THIS tier, never the opaque one. An opaque
  // verdict is never expanded, so `SENSITIVE_LEAF_PATTERNS` never runs on the
  // leaves and a `logs/.env` or `logs/prod.key` is force-deleted with the
  // checkout, unseen (#759). Here the scoped expansion classifies each leaf, so
  // a sensitive one protects the tree.
  //
  // What this does NOT do: a nested leaf re-matches this same directory regex,
  // so `logs/decisions.log` classifies `inspectable`, not `protected`, and stays
  // reapable — the presumption "files under a build-output dir are rebuildable
  // unless sensitive" is what keeps `dist/` from making every tree immortal, and
  // it applies here too. So a hand-kept log at the repo ROOT is protected by the
  // emitter allowlist below while the same filename under `logs/` is not. That
  // residual asymmetry is deliberate and bounded to non-sensitive names.
  /(?:^|\/)logs\//,
];

/**
 * Individual ignored FILES a rebuild restores.
 *
 * Invariant: every entry is matched against the final path segment ONLY (see
 * `classifyIgnoredEntry`), so each is anchored to a bare filename and never to
 * a path. Depth must not change the verdict for a machine-generated name.
 * Mixing anchoring styles here is what broke that: four entries were `^`-only
 * while the log emitters used `(?:^|\/)`, and the table was tested against the
 * whole path — so a nested `src/.DS_Store` matched nothing, fell through to
 * `protected`, and made the worktree permanently unreachable by the automatic
 * sweep, while the identical filename at the repo root was reaped. The
 * directory tables above are the deliberate opposite: they match the whole
 * path, because a directory pattern is only meaningful as a prefix.
 *
 * The log entries are deliberately an emitter allowlist rather than a bare
 * `/\.log$/`: that suffix matched every ignored `*.log`, so a captured agent
 * transcript or a hand-kept `decisions.log` was classified as build noise and
 * force-deleted along with the checkout.
 */
const REBUILDABLE_FILE_PATTERNS: readonly RegExp[] = [
  // AFK owns and recreates this bookkeeping marker.
  /^\.afk-worktree-meta\.json$/,
  // Deliberately unanchored at the front: the leaf is `<project>.tsbuildinfo`.
  /\.tsbuildinfo$/,
  /^\.eslintcache$/,
  /^\.stylelintcache$/,
  /^\.DS_Store$/,
  // No `Thumbs.db` entry: `/\.db$/` above is sensitive and tested first, so it
  // is already protected and a rebuildable entry here would be unreachable.
  // Known log emitters only.
  /^debug\.log$/,
  /^npm-debug\.log$/,
  /^yarn-error\.log$/,
  /^yarn-debug\.log$/,
  /^pnpm-debug\.log$/,
  /^lerna-debug\.log$/,
];

/**
 * Normalize the repo-relative path git reported: backslashes to forward
 * slashes, no `./` prefix, and no wrapping double quotes. The probe already
 * passes `-c core.quotePath=false`, so the quote strip is belt-and-braces for
 * any caller that does not.
 */
export function normalizeIgnoredPath(relPath: string): string {
  const slashed = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (slashed.length >= 2 && slashed.startsWith('"') && slashed.endsWith('"')) {
    return slashed.slice(1, -1);
  }
  return slashed;
}

/** Final path segment, with any trailing directory slash removed. */
export function leafOf(normalizedPath: string): string {
  const withoutTrailingSlash = normalizedPath.replace(/\/+$/, '');
  const lastSlash = withoutTrailingSlash.lastIndexOf('/');
  return lastSlash === -1
    ? withoutTrailingSlash
    : withoutTrailingSlash.slice(lastSlash + 1);
}

/**
 * True when the entry is a compiled or rendered artifact sitting inside build
 * output — the one place a credential-shaped NAME carries no information,
 * because the name was inherited from the source module it was generated from.
 * Both directory tables count: `dist/` (inspectable) and `node_modules/`
 * (opaque) are equally generated, differing only in expansion cost.
 */
function isGeneratedArtifact(normalizedPath: string, leaf: string): boolean {
  if (!GENERATED_ARTIFACT_EXTENSIONS.test(leaf)) return false;
  return (
    OPAQUE_REBUILDABLE_DIRS.some((re) => re.test(normalizedPath)) ||
    INSPECTABLE_REBUILDABLE_DIRS.some((re) => re.test(normalizedPath))
  );
}

/**
 * True when the entry's final segment names something unrecoverable, judged on
 * the leaf alone. Format anchors and name hints both count here — callers with
 * path context should prefer {@link classifyIgnoredEntry}, which additionally
 * suppresses the name hints inside generated output.
 */
export function isSensitiveLeaf(relPath: string): boolean {
  const leaf = leafOf(normalizeIgnoredPath(relPath)).toLowerCase();
  if (leaf === '') return false;
  return (
    SENSITIVE_LEAF_PATTERNS.some((re) => re.test(leaf)) ||
    SENSITIVE_NAME_HINTS.some((re) => re.test(leaf))
  );
}

/** Leaf matches a table entry naming a credential FORMAT, wherever it sits. */
function isSensitiveFormat(leaf: string): boolean {
  return SENSITIVE_LEAF_PATTERNS.some((re) => re.test(leaf));
}

/**
 * Classify one ignored entry. Precedence is deliberate: a sensitive leaf wins
 * over every rebuildable pattern, and anything unrecognised falls through to
 * `protected` so the default answer is always "leave it alone".
 *
 * Contract: entries ending in `/` are directories and cannot match the file
 * table. For files, that table is tested against the LEAF; the two directory
 * tables are always tested against the WHOLE path. That split is load-bearing
 * in both directions. A machine-generated filename is rebuildable wherever it
 * sits, so matching it on the full path made depth decide the verdict. A
 * directory name is only meaningful as a prefix, so leaf-matching those would
 * classify a bare file named `dist` as build output — and would collapse the
 * deliberate `logs/` asymmetry documented above.
 *
 * Sensitivity splits along the same seam. A credential FORMAT protects the tree
 * from anywhere; a credential-shaped NAME protects everywhere except on a
 * generated artifact, where the name is an echo of the source module it was
 * built from rather than evidence of a secret (see
 * {@link SENSITIVE_NAME_HINTS}).
 */
export function classifyIgnoredEntry(relPath: string): IgnoredEntryClass {
  const normalized = normalizeIgnoredPath(relPath);
  if (normalized === '') return 'protected';
  const leaf = leafOf(normalized).toLowerCase();
  if (isSensitiveFormat(leaf)) return 'protected';
  if (!isGeneratedArtifact(normalized, leaf) && SENSITIVE_NAME_HINTS.some((re) => re.test(leaf))) {
    return 'protected';
  }
  const isDirectory = normalized.endsWith('/');
  if (!isDirectory && REBUILDABLE_FILE_PATTERNS.some((re) => re.test(leafOf(normalized)))) {
    return 'opaque';
  }
  if (OPAQUE_REBUILDABLE_DIRS.some((re) => re.test(normalized))) return 'opaque';
  if (INSPECTABLE_REBUILDABLE_DIRS.some((re) => re.test(normalized))) return 'inspectable';
  return 'protected';
}
