/**
 * Session loading and processing helpers for the outcomes backfill.
 * Split from outcomes-backfill.ts to stay within the 350-line ceiling.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { StoredSessionInputSchema } from '../src/agent/facets/schema.js';
import {
  recoverArtifacts,
  runImmediateLFs,
  lfPrFate,
  lfCommitSurvival,
  combine,
} from '../src/agent/outcomes/index.js';
import type { Vote, OutcomeLabel, SelfReport } from '../src/agent/outcomes/index.js';
import type { FetchPrState, PrState } from '../src/agent/outcomes/lf-delayed.js';
import type { Turn } from '../src/agent/outcomes/artifacts.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Session loading
// ---------------------------------------------------------------------------

export function loadSessionTurns(sessionId: string, sessionsDir: string): Turn[] | null {
  const path = join(sessionsDir, `${sessionId}.json`);
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const parsed = StoredSessionInputSchema.safeParse(raw);
    if (!parsed.success) return null;
    return parsed.data.turns as Turn[];
  } catch {
    return null;
  }
}

export function loadSessionKind(
  sessionId: string,
  facetCacheDir: string,
): 'mutating' | 'text' {
  const path = join(facetCacheDir, `${sessionId}.json`);
  if (!existsSync(path)) return 'text';
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      world_changes?: { mutated?: boolean };
    };
    return raw.world_changes?.mutated === true ? 'mutating' : 'text';
  } catch {
    return 'text';
  }
}

export function loadSessionCwd(sessionId: string, sessionsDir: string): string | null {
  const path = join(sessionsDir, `${sessionId}.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { cwd?: string };
    return raw.cwd ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// gh and git implementations
// ---------------------------------------------------------------------------

export function makeCachedGhFetch(enabled: boolean): FetchPrState {
  const cache = new Map<string, PrState | null>();
  return async (url: string): Promise<PrState | null> => {
    if (!enabled) return null;
    if (cache.has(url)) return cache.get(url) ?? null;

    const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
    if (m === null || m[1] === undefined || m[2] === undefined) {
      cache.set(url, null);
      return null;
    }
    try {
      const { stdout } = await execFileAsync('gh', [
        'pr', 'view', m[2], '--repo', m[1], '--json', 'state,mergedAt',
      ]);
      const data = JSON.parse(stdout) as { state?: string; mergedAt?: string | null };
      const result: PrState = {
        state: (data.state ?? 'OPEN') as PrState['state'],
        mergedAt: data.mergedAt ?? null,
      };
      cache.set(url, result);
      return result;
    } catch {
      cache.set(url, null);
      return null;
    }
  };
}

export async function checkAncestor(sha: string, repoPath: string): Promise<boolean> {
  if (!existsSync(repoPath)) return false;
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', sha, 'origin/HEAD'], {
      cwd: repoPath,
    });
    return true;
  } catch {
    return false;
  }
}

export async function checkRevert(sha: string, repoPath: string): Promise<boolean> {
  if (!existsSync(repoPath)) return false;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', '--oneline', `--grep=This reverts commit ${sha}`],
      { cwd: repoPath },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session result type
// ---------------------------------------------------------------------------

export interface SessionResult {
  sessionId: string;
  label: OutcomeLabel;
  confidence: number;
  sessionKind: 'mutating' | 'text';
  selfReport: SelfReport;
  votes: Vote[];
  hasPr: boolean;
  hasCommit: boolean;
}

// ---------------------------------------------------------------------------
// Process one session
// ---------------------------------------------------------------------------

export async function processSession(
  sessionId: string,
  opts: {
    sessionsDir: string;
    facetCacheDir: string;
    noGh: boolean;
    noGit: boolean;
    fetchPr: FetchPrState;
    now: string;
  },
): Promise<SessionResult | null> {
  const { sessionsDir, facetCacheDir, noGh, noGit, fetchPr, now } = opts;
  const turns = loadSessionTurns(sessionId, sessionsDir);
  if (turns === null) return null;

  const sessionKind = loadSessionKind(sessionId, facetCacheDir);
  const cwd = loadSessionCwd(sessionId, sessionsDir);
  const artifacts = recoverArtifacts(turns);

  // Closure LF: not joined to witness traces in M0 — see report caveats.
  const { votes: immediateVotes, selfReport } = runImmediateLFs(
    sessionId,
    turns,
    () => null,
    now,
  );

  const delayedVotes: Vote[] = [];

  if (!noGh && artifacts.prs.length > 0) {
    const prVotes = await lfPrFate(artifacts.prs, fetchPr, now);
    delayedVotes.push(...prVotes);
  }

  if (!noGit && artifacts.commits.length > 0 && cwd !== null) {
    const survivalVotes = await lfCommitSurvival(
      artifacts.commits,
      cwd,
      checkAncestor,
      checkRevert,
      now,
    );
    delayedVotes.push(...survivalVotes);
  }

  const allVotes = [...immediateVotes, ...delayedVotes];
  const { label, confidence } = combine({ votes: allVotes, selfReport, artifacts });

  return {
    sessionId,
    label,
    confidence,
    sessionKind,
    selfReport,
    votes: allVotes,
    hasPr: artifacts.prs.length > 0,
    hasCommit: artifacts.commits.length > 0,
  };
}
