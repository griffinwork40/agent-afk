/**
 * Plugin source parser.
 *
 * Turns a user-supplied source string into a discriminated union that the
 * installer uses to decide whether to clone, symlink, or reject outright.
 *
 * Resolution order (first match wins):
 *   1. input looks like a path (starts with `./`, `../`, `/`, or `~`) →
 *      resolve + existsSync → local source or error
 *   2. input matches a git URL (`https://`, `git://`, `ssh://`, `git@host:`) → git
 *   3. input matches `<marketplace>:<plugin>` shorthand → marketplace-ref
 *   4. input matches `owner/repo` shorthand → github (expands to https git URL)
 *   5. input is an existing absolute path outside the cases above → local
 *   6. else → error
 *
 * Pure function aside from an `existsSync` probe. No FS writes, no network.
 *
 * @module agent/plugins/source
 */

import { existsSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { homedir } from 'os';

export interface GitSource {
  type: 'git';
  url: string;
}

export interface GitHubSource {
  type: 'github';
  owner: string;
  repo: string;
  url: string;
}

export interface LocalSource {
  type: 'local';
  path: string;
}

export interface MarketplaceRefSource {
  type: 'marketplace-ref';
  /** Canonical marketplace name (the install key under `~/.afk/plugins/cache/`). */
  marketplace: string;
  /** Plugin name as listed in the marketplace's `marketplace.json`. */
  plugin: string;
}

export type ParsedSource = GitSource | GitHubSource | LocalSource | MarketplaceRefSource;

const GIT_URL_RE = /^(?:https?:\/\/|git:\/\/|ssh:\/\/|git\+ssh:\/\/|file:\/\/|git@[^:]+:)/;
const GITHUB_SHORTHAND_RE = /^([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/([a-zA-Z0-9][a-zA-Z0-9._-]*?)(?:\.git)?$/;
const MARKETPLACE_SHORTHAND_RE = /^([a-zA-Z0-9][a-zA-Z0-9_.-]*):([a-zA-Z0-9][a-zA-Z0-9_.-]*)$/;

/**
 * Expand a leading `~` or `~/` to the user's home directory. Leaves all
 * other inputs untouched.
 */
export function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return resolve(homedir(), input.slice(2));
  return input;
}

/**
 * Assert that a git URL uses the https:// scheme.
 *
 * Security invariant: only HTTPS allows transport-layer authentication and
 * certificate verification. Accepting git://, http://, ssh://, file://, or
 * git@host: shortcuts would allow:
 *   - git://  → unauthenticated plaintext clone (trivially MITMed)
 *   - http://  → unauthenticated plaintext clone
 *   - ssh://   → host-key based; not pinned, exposes SSH agent, requires key setup
 *   - file://  → local filesystem traversal outside intended plugin dirs
 *   - git@host → SSH shorthand; same risks as ssh://
 *
 * @throws when the URL does not start with "https://".
 */
export function assertHttpsUrl(url: string): void {
  if (!url.startsWith('https://')) {
    throw new Error(
      `Plugin source must use https:// (got: ${url}). ` +
        `git://, http://, ssh://, file://, and git@ are rejected to avoid ` +
        `downgrade attacks and unauthenticated clones.`,
    );
  }
}

/**
 * Parse a plugin source string.
 *
 * @throws when the input does not match any known source type or references
 *   a local path that doesn't exist.
 */
export function parseSource(input: string): ParsedSource {
  const raw = input.trim();
  if (!raw) {
    throw new Error(
      'plugin source is required (examples: "owner/repo", "https://github.com/owner/repo.git", "./my-plugin")',
    );
  }

  if (looksLikePath(raw)) {
    const abs = toAbsolute(raw);
    if (!existsSync(abs)) {
      throw new Error(
        `could not resolve plugin source: "${raw}" looks like a local path but does not exist on disk`,
      );
    }
    return { type: 'local', path: abs };
  }

  if (GIT_URL_RE.test(raw)) {
    return { type: 'git', url: raw };
  }

  // Marketplace shorthand `<mp>:<plugin>`. Checked after git URLs so
  // `git@host:owner/repo` (which contains `:` and `/`) cannot match.
  const mp = MARKETPLACE_SHORTHAND_RE.exec(raw);
  if (mp && mp[1] && mp[2]) {
    return { type: 'marketplace-ref', marketplace: mp[1], plugin: mp[2] };
  }

  const m = GITHUB_SHORTHAND_RE.exec(raw);
  if (m && m[1] && m[2]) {
    const owner = m[1];
    const repo = m[2];
    return {
      type: 'github',
      owner,
      repo,
      url: `https://github.com/${owner}/${repo}.git`,
    };
  }

  // Last-ditch: if it happens to be an absolute-ish path that exists, honor
  // it. Shorthand took precedence above so `owner/repo` cannot hit this.
  if (existsSync(raw)) {
    return { type: 'local', path: toAbsolute(raw) };
  }

  throw new Error(
    `could not resolve plugin source: "${raw}". ` +
      'Use a git URL (https://…/repo.git), GitHub shorthand (owner/repo), ' +
      'or a local path to a directory that exists on disk.',
  );
}

function looksLikePath(raw: string): boolean {
  return (
    raw.startsWith('./') ||
    raw.startsWith('../') ||
    raw.startsWith('~') ||
    raw.startsWith('/')
  );
}

function toAbsolute(raw: string): string {
  const expanded = expandHome(raw);
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}
