/**
 * Attribute safety for `git-snapshot.ts`: does this git honour
 * `--attr-source`, and which attribute files could make `git add` store bytes
 * that differ from the working tree (clean filters such as git-lfs, eol/text
 * conversion, ident, working-tree-encoding)?
 *
 * Invariant: a snapshot blob must be the exact on-disk bytes, because a rewind
 * writes it back verbatim. When git can be told to ignore in-tree attributes
 * (`--attr-source=<empty tree>`) only `info/attributes` still applies; when it
 * cannot, every attribute file git would consult must be free of converting
 * attributes or the capture is refused (`unsafe-attributes`).
 *
 * @module agent/file-checkpoint/git-snapshot.attrs
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyFailure, isOk, runIn, type Failure, type GitCtx } from './git-snapshot.exec.js';

/**
 * Attribute names treated as converting in ANY form (set, -unset,
 * !unspecified, =value). Deliberately conservative: an unset `-text` does not
 * itself convert, but matching every form keeps the rule simple to audit.
 */
const CONVERTING = new Set(['filter', 'text', 'eol', 'crlf', 'working-tree-encoding', 'ident']);

/** Probe result cache: one answer per process (the git binary does not change under us). */
let attrSourceSupport: Promise<boolean | null> | undefined;
let attrSourceOverride: boolean | undefined;

/** Test seam: force the probe result (`undefined` restores the real probe and clears the cache). */
export function _setAttrSourceSupportForTests(value: boolean | undefined): void {
  attrSourceOverride = value;
  attrSourceSupport = undefined;
}

/**
 * Whether git accepts `--attr-source`. Probed by behaviour, not version: an
 * older git rejects the unknown global option (exit 129). Only a definitive
 * answer is cached; a timeout yields `null` and is retried next time.
 */
export async function attrSourceSupported(ctx: GitCtx, cwd: string, emptyTree: string): Promise<boolean | null> {
  if (attrSourceOverride !== undefined) return attrSourceOverride;
  attrSourceSupport ??= runIn(ctx, cwd, [`--attr-source=${emptyTree}`, 'version']).then((run) => {
    if (run.timedOut || run.spawnError !== undefined) return null;
    return run.code === 0;
  });
  const answer = await attrSourceSupport;
  if (answer === null) attrSourceSupport = undefined;
  return answer;
}

/** Strip a leading (possibly C-quoted) pattern; returns the attribute tokens. */
function attributeTokens(line: string): string[] {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return [];
  let rest: string;
  if (trimmed.startsWith('"')) {
    const close = /^"(?:[^"\\]|\\.)*"/.exec(trimmed);
    rest = close === null ? '' : trimmed.slice(close[0].length);
  } else {
    rest = trimmed.replace(/^\S+/, '');
  }
  return rest.split(/\s+/).filter((t) => t !== '');
}

/** True when the attribute file text names a converting attribute in any form (macro definitions included). */
export function hasConvertingAttribute(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    for (const token of attributeTokens(line)) {
      const name = token.replace(/^[-!]/, '').split('=')[0] ?? '';
      if (CONVERTING.has(name)) return true;
    }
  }
  return false;
}

async function readIfExists(file: string): Promise<string> {
  try { return await fs.readFile(file, 'utf8'); } catch { return ''; }
}

/** First file (absolute path) carrying a converting attribute, or null. */
export async function findConverting(files: readonly string[]): Promise<string | null> {
  for (const file of files) {
    if (hasConvertingAttribute(await readIfExists(file))) return file;
  }
  return null;
}

/**
 * Every `.gitattributes` in the work tree at any depth: tracked (from the
 * user's index, read-only) and untracked non-ignored. Absolute paths.
 */
export async function workTreeAttributeFiles(ctx: GitCtx, repoRoot: string): Promise<string[] | Failure> {
  const run = await runIn(ctx, repoRoot, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.gitattributes']);
  if (!isOk(run)) return classifyFailure(run, 'git ls-files (attributes)');
  return run.stdout.toString('utf8').split('\0')
    .filter((p) => p !== '' && path.posix.basename(p) === '.gitattributes')
    .map((p) => path.join(repoRoot, ...p.split('/')));
}

/** `git var <name>` output, or null when this git does not know the variable. */
async function gitVar(ctx: GitCtx, cwd: string, name: string): Promise<string | null> {
  const run = await runIn(ctx, cwd, ['var', name]);
  const out = run.stdout.toString('utf8').trim();
  return isOk(run) && out !== '' ? path.resolve(cwd, out) : null;
}

/**
 * The global attributes file(s) the user's own git reads. Newer git reports it
 * via `git var GIT_ATTR_GLOBAL`; older git does not, so fall back to the
 * configured `core.attributesFile` plus the XDG default (conservative union).
 */
export async function globalAttributeFiles(ctx: GitCtx, cwd: string): Promise<string[]> {
  const reported = await gitVar(ctx, cwd, 'GIT_ATTR_GLOBAL');
  if (reported !== null) return [reported];
  const files: string[] = [];
  const configured = await runIn(ctx, cwd, ['config', '--path', '--get', 'core.attributesFile']);
  const value = configured.stdout.toString('utf8').trim();
  if (isOk(configured) && value !== '') files.push(path.resolve(cwd, value));
  const xdg = ctx.env['XDG_CONFIG_HOME'];
  files.push(path.join(xdg !== undefined && xdg !== '' ? xdg : path.join(os.homedir(), '.config'), 'git', 'attributes'));
  return files;
}

/**
 * The system attributes file the user's own git reads (snapshots set
 * GIT_ATTR_NOSYSTEM, but the user's index was built with it). `undefined`
 * when this git cannot report it, so callers must treat it as unknown.
 */
export async function systemAttributeFile(ctx: GitCtx, cwd: string): Promise<string | undefined> {
  const env = { ...ctx.env };
  delete env['GIT_ATTR_NOSYSTEM'];
  return (await gitVar({ ...ctx, env }, cwd, 'GIT_ATTR_SYSTEM')) ?? undefined;
}

/**
 * Capture-time check. Returns a Failure when `add` would convert content.
 * Contract: `supported` is the `--attr-source` probe result; when true only
 * `info/attributes` can still apply (global is off via `core.attributesFile=`
 * and system via GIT_ATTR_NOSYSTEM).
 *
 * System attribute file omission: the snapshot environment sets
 * `GIT_ATTR_NOSYSTEM=1` (see `buildSnapshotEnv` in git-snapshot.exec.ts),
 * which causes git to skip the system-wide attributes file entirely during
 * `git add`. The system file therefore cannot influence blob content and does
 * not need to be checked here. `systemAttributeFile` is intentionally not
 * included in `files`.
 */
export async function captureAttributeCheck(
  ctx: GitCtx, repoRoot: string, infoAttributes: string, supported: boolean,
): Promise<Failure | null> {
  const files = [infoAttributes];
  if (!supported) {
    const tree = await workTreeAttributeFiles(ctx, repoRoot);
    if (!Array.isArray(tree)) return tree;
    files.push(...tree, ...(await globalAttributeFiles(ctx, repoRoot)));
  }
  const hit = await findConverting(files);
  if (hit === null) return null;
  const why = supported ? '' : ' (this git cannot ignore in-tree attributes)';
  return { ok: false, reason: 'unsafe-attributes', detail: `content-converting attributes in ${hit}${why}`.slice(0, 200) };
}
