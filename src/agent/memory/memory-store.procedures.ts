/**
 * Procedure read/write helpers for the cross-session memory store.
 *
 * Procedures are markdown files in a `procedures/` subdirectory of the memory
 * dir. They persist across sessions and are searchable via memory_search.
 *
 * Extracted from memory-store.ts to keep that file under the 350-code-line
 * ceiling. All functions take an explicit `dir` parameter; no closures over
 * MemoryStore internals.
 *
 * @module agent/memory/memory-store.procedures
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join, resolve, relative, isAbsolute } from 'path';
import type { Procedure } from './types.js';

const PROCEDURES_DIR = 'procedures';
const SAFE_PROCEDURE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export function validateProcedureName(name: string): string {
  if (!name || name.length > 100 || !SAFE_PROCEDURE_NAME.test(name)) {
    throw new Error(
      `Invalid procedure name "${name}": must be 1-100 chars, alphanumeric/hyphens/underscores only`,
    );
  }
  return name;
}

function assertWithinDir(filePath: string, dir: string): void {
  const rel = relative(dir, filePath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Path traversal detected');
  }
}

function parseProcedureFile(filename: string, raw: string): Procedure | null {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    return {
      name: basename(filename, '.md'),
      content: raw,
      created: '',
      source_session: null,
      access_count: 0,
    };
  }
  const fm = fmMatch[1] ?? '';
  const body = fmMatch[2] ?? '';

  const getName = (s: string) => s.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? basename(filename, '.md');
  const getCreated = (s: string) => s.match(/^created:\s*(.+)$/m)?.[1]?.trim() ?? '';
  const getSession = (s: string) => s.match(/^source_session:\s*(.+)$/m)?.[1]?.trim() ?? null;
  const getCount = (s: string) => {
    const m = s.match(/^access_count:\s*(\d+)$/m);
    return m ? parseInt(m[1]!, 10) : 0;
  };

  return {
    name: getName(fm),
    content: body.trim(),
    created: getCreated(fm),
    source_session: getSession(fm),
    access_count: getCount(fm),
  };
}

/** Write (or overwrite) a named procedure file under `dir/procedures/`. */
export function writeProcedure(dir: string, name: string, content: string, sessionId?: string): void {
  const safeName = validateProcedureName(name);
  const procDir = resolve(join(dir, PROCEDURES_DIR));
  const filePath = resolve(procDir, `${safeName}.md`);
  assertWithinDir(filePath, procDir);

  const frontmatter = [
    '---',
    `name: ${safeName}`,
    `created: ${new Date().toISOString()}`,
    `source_session: ${sessionId ?? 'unknown'}`,
    `access_count: 0`,
    '---',
    '',
  ].join('\n');
  writeFileSync(filePath, frontmatter + content, 'utf-8');
}

/** Load a named procedure file from `dir/procedures/`. Returns null if absent or unparseable. */
export function loadProcedure(dir: string, name: string): Procedure | null {
  const safeName = validateProcedureName(name);
  const procDir = resolve(join(dir, PROCEDURES_DIR));
  const path = resolve(procDir, `${safeName}.md`);
  assertWithinDir(path, procDir);
  if (!existsSync(path)) return null;
  try {
    return parseProcedureFile(path, readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/** Search all procedure files in `dir/procedures/` for any term in `query`. */
export function searchProcedures(dir: string, query: string): Procedure[] {
  const procDir = join(dir, PROCEDURES_DIR);
  if (!existsSync(procDir)) return [];
  const terms = query.toLowerCase().split(/\s+/);
  const results: Procedure[] = [];

  for (const file of readdirSync(procDir)) {
    if (!file.endsWith('.md')) continue;
    const raw = readFileSync(join(procDir, file), 'utf-8');
    const lower = raw.toLowerCase();
    if (terms.some((t) => lower.includes(t))) {
      const proc = parseProcedureFile(file, raw);
      if (proc) results.push(proc);
    }
  }
  return results;
}
