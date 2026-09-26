/**
 * Content operators: append, file, hot.
 *
 * @module whatif/operators/content-ops
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import type { ChangeOperator, Change, Environment } from '../types.js';
import { assertInsideSandbox } from './sandbox-guard.js';

// ---------------------------------------------------------------------------
// append operator
// ---------------------------------------------------------------------------

function appendTarget(
  change: Extract<Change, { kind: 'append' }>,
  env: Environment,
): string {
  return change.target === 'user-afk-md'
    ? join(env.home, 'AFK.md')
    : join(env.cwd, 'AFK.md');
}

export const appendOperator: ChangeOperator<'append'> = {
  kind: 'append',

  touchesProject(change) {
    return change.target === 'project-afk-md';
  },

  homePathsToCopy(_change) {
    // AFK.md is at home root, not under skills/ or plugins/ — no pre-copy needed
    return [];
  },

  async apply(change, env, _ctx) {
    const target = appendTarget(change, env);
    assertInsideSandbox(dirname(target), env);
    const existing = existsSync(target) ? readFileSync(target, 'utf8') : '';
    const newContent = existing + '\n\n' + change.text;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, newContent, 'utf8');
  },

  describe(change) {
    const scope = change.target === 'user-afk-md' ? 'personal' : 'project';
    const lines = change.text.trim().split('\n').length;
    return `Append ${lines} line${lines === 1 ? '' : 's'} to your ${scope} AFK.md`;
  },
};

// ---------------------------------------------------------------------------
// file operator
// ---------------------------------------------------------------------------

// Matches home:<rel> or project:<rel>
const FILE_PATH_RE = /^(home|project):(.+)$/;

function parseFilePath(
  path: string,
): { scope: 'home' | 'project'; rel: string } {
  const m = FILE_PATH_RE.exec(path);
  if (!m || !m[1] || !m[2]) {
    throw new Error(
      `file change path must be "home:<rel>" or "project:<rel>"; got: ${JSON.stringify(path)}`,
    );
  }
  const rel = m[2];
  if (isAbsolute(rel)) {
    throw new Error(`file change rel path must not be absolute; got: ${JSON.stringify(rel)}`);
  }
  if (rel.includes('..')) {
    throw new Error(`file change rel path must not contain ".."; got: ${JSON.stringify(rel)}`);
  }
  return { scope: m[1] as 'home' | 'project', rel };
}

/** Top-level segment under skills/ or plugins/ for the pre-copy rule. */
function topLevelSegment(rel: string): string | null {
  const parts = rel.split('/');
  if (
    parts.length >= 2 &&
    parts[0] !== undefined &&
    (parts[0] === 'skills' || parts[0] === 'plugins') &&
    parts[1] !== undefined
  ) {
    return `${parts[0]}/${parts[1]}`;
  }
  return null;
}

export const fileOperator: ChangeOperator<'file'> = {
  kind: 'file',

  touchesProject(change) {
    return parseFilePath(change.path).scope === 'project';
  },

  homePathsToCopy(change) {
    const { scope, rel } = parseFilePath(change.path);
    if (scope !== 'home') return [];
    const seg = topLevelSegment(rel);
    return seg ? [seg] : [];
  },

  async apply(change, env, _ctx) {
    const { scope, rel } = parseFilePath(change.path);
    const base = scope === 'home' ? env.home : env.cwd;
    const target = join(base, rel);
    assertInsideSandbox(dirname(target), env);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, change.content, 'utf8');
  },

  describe(change) {
    return `Write file ${change.path} (${change.content.length} chars)`;
  },
};

// ---------------------------------------------------------------------------
// hot operator
// ---------------------------------------------------------------------------

export const hotOperator: ChangeOperator<'hot'> = {
  kind: 'hot',

  touchesProject(_change) {
    return false;
  },

  homePathsToCopy(_change) {
    return [];
  },

  async apply(change, env, _ctx) {
    const target = join(env.home, 'state', 'memory', 'HOT.md');
    assertInsideSandbox(dirname(target), env);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, change.content, 'utf8');
  },

  describe(change) {
    const lines = change.content.trim().split('\n').length;
    return `Overwrite HOT.md with ${lines} line${lines === 1 ? '' : 's'}`;
  },
};
