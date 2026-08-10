/**
 * Shared guards for reading plugin-authored markdown off disk.
 *
 * Both plugin loaders — `extractPluginSkills` (SKILL.md) and
 * `extractPluginCommands` (commands/*.md) — read third-party files that the
 * user installed but did not write. The two helpers here are the properties
 * both loaders must agree on, extracted so they cannot drift.
 *
 * @module agent/plugins/source-guard
 */

import { realpathSync } from 'fs';
import { sep } from 'path';

/**
 * Hard cap on normalised skill/command source, in characters. Mirrors the
 * char-cap-with-truncation shape of `MAX_PRIMER_CHARS` (companion/primer-loader.ts).
 */
export const MAX_SKILL_SOURCE_CHARS = 64 * 1024;

/**
 * Normalise plugin markdown before any frontmatter check.
 *
 * Contract: strips one leading UTF-8 BOM, converts both CRLF and a lone CR to
 * LF, strips NUL and other C0 control chars (keeping `\n` and `\t`), then
 * truncates to {@link MAX_SKILL_SOURCE_CHARS}. Order is load-bearing: newline
 * normalisation must run before control stripping (a lone CR is folded to
 * `\n` before the control-char pass, so it survives instead of being
 * dropped), and truncation must run last so the cap is measured on the
 * already-normalised text. Callers MUST apply this to the raw `readFileSync`
 * result before inspecting the frontmatter delimiter — a `---\r\n` or
 * `\uFEFF---\n` prefix otherwise fails a byte-exact `startsWith('---\n')` test
 * and the whole frontmatter block is mistaken for prompt body.
 *
 * Invariant: both third-party markdown loaders — `extractPluginCommands`
 * (command-files.ts, plain-body path) and `parseSkillMetadata`
 * (tool-injector.ts, SKILL.md frontmatter+body) — read untrusted plugin files
 * through this one function, so the cap and control-char strip apply
 * uniformly to `commands/*.md` and `SKILL.md` alike. Truncation, not
 * rejection, is the failure mode for an oversized body: file length is not a
 * security signal, and refusing to load a long-but-legitimate prompt would
 * silently disable a plugin's skill/command with no diagnostic path for the
 * user. A bounded prefix keeps the frontmatter (always at the top) intact and
 * simply caps the unbounded tail, so this function never throws and never
 * collapses a non-empty input to `''`.
 */
export function normalizeSkillSource(raw: string): string {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  // Strip NUL and every other C0 control char, keeping \t (0x09) and \n (0x0A).
  const controlStripped = normalized.replace(/[\x00-\x08\x0B-\x1F]/g, '');
  return controlStripped.length > MAX_SKILL_SOURCE_CHARS
    ? controlStripped.slice(0, MAX_SKILL_SOURCE_CHARS)
    : controlStripped;
}

/**
 * Resolve `candidate` and return its real path only when it stays inside `root`.
 *
 * Contract: returns `undefined` for a broken link, an unreadable path, or any
 * entry whose resolved target escapes `root` — so a plugin shipping
 * `commands/help.md -> ~/.ssh/id_rsa` is skipped rather than registered as a
 * dispatchable prompt body. Symlinks that stay *within* the plugin tree are
 * deliberately still followed: sharing one prompt across two command names is
 * legitimate authoring, and banning links outright would break it.
 *
 * @param root - The containment root, as a raw (not-yet-resolved) path.
 * @param candidate - The path being checked for containment within `root`.
 * @param preResolvedRoot - Optional `realpathSync(root)` result, computed once
 *   by the caller. When a caller walks many candidates under the same root
 *   (e.g. a directory tree), resolving `root` fresh on every call lets a
 *   symlink swap mid-walk silently shift the containment baseline between
 *   entries; passing the root's realpath once up front pins it for the whole
 *   walk. Callers that omit it keep today's per-call `realpathSync(root)`
 *   behavior.
 */
export function resolveContained(
  root: string,
  candidate: string,
  preResolvedRoot?: string,
): string | undefined {
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = preResolvedRoot ?? realpathSync(root);
    realCandidate = realpathSync(candidate);
  } catch {
    return undefined;
  }
  if (realCandidate === realRoot) return realCandidate;
  return realCandidate.startsWith(realRoot + sep) ? realCandidate : undefined;
}
