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
 * Normalise plugin markdown before any frontmatter check.
 *
 * Contract: strips one leading UTF-8 BOM and converts CRLF to LF, so a
 * byte-exact `startsWith('---\n')` test behaves identically for a file
 * authored on Windows, exported by an editor that emits a BOM, or written on
 * a POSIX box. Callers MUST apply this to the raw `readFileSync` result before
 * inspecting the frontmatter delimiter — a `---\r\n` or `\uFEFF---\n` prefix
 * otherwise fails the test and the whole frontmatter block is mistaken for
 * prompt body.
 */
export function normalizeSkillSource(raw: string): string {
  return raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
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
 */
export function resolveContained(root: string, candidate: string): string | undefined {
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = realpathSync(root);
    realCandidate = realpathSync(candidate);
  } catch {
    return undefined;
  }
  if (realCandidate === realRoot) return realCandidate;
  return realCandidate.startsWith(realRoot + sep) ? realCandidate : undefined;
}
