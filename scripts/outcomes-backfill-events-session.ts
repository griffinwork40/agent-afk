/**
 * Events-session processing for the outcomes backfill.
 *
 * A thin adapter that feeds events.jsonl-sourced Turn[] data into the same
 * processSession pipeline used by the JSON-sidecar source, adding a closure
 * LF from the events 'closed' record (not available in M0's sidecar path).
 *
 * Source: outcomes-backfill-events.ts (parser)
 * Sibling: outcomes-backfill.session.ts (processSession for JSON sidecars)
 */

import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

import {
  recoverArtifacts,
  runImmediateLFs,
  lfPrFate,
  lfCommitSurvival,
  combine,
  lfClosure,
} from '../src/agent/outcomes/index.js';
import type { Vote, OutcomeLabel, SelfReport } from '../src/agent/outcomes/index.js';
import type { FetchPrState } from '../src/agent/outcomes/lf-delayed.js';
import type { ClosureInfo } from '../src/agent/outcomes/lf-immediate.js';
import {
  loadEventsSessionTurns,
  discoverEventsSessionsSync,
} from './outcomes-backfill-events.js';
import type { SessionResult } from './outcomes-backfill.session.js';

export { discoverEventsSessionsSync };

// ---------------------------------------------------------------------------
// Load session_kind from a facet file (if available)
// ---------------------------------------------------------------------------

function loadFacetKind(
  sessionId: string,
  facetCacheDir: string,
): 'mutating' | 'text' {
  const p = join(facetCacheDir, `${sessionId}.json`);
  if (!existsSync(p)) return 'text';
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as {
      world_changes?: { mutated?: boolean };
    };
    return raw.world_changes?.mutated === true ? 'mutating' : 'text';
  } catch {
    return 'text';
  }
}

// ---------------------------------------------------------------------------
// Process one events-based session
// ---------------------------------------------------------------------------

export async function processEventsSession(
  sessionId: string,
  opts: {
    sessionsDir: string;
    facetCacheDir: string;
    noGh: boolean;
    noGit: boolean;
    fetchPr: FetchPrState;
    checkAncestor: (sha: string, repo: string) => Promise<boolean>;
    checkRevert: (sha: string, repo: string) => Promise<boolean>;
    now: string;
  },
): Promise<SessionResult | null> {
  const {
    sessionsDir, facetCacheDir, noGh, noGit, fetchPr,
    checkAncestor, checkRevert, now,
  } = opts;

  const loaded = await loadEventsSessionTurns(sessionId, sessionsDir);
  if (loaded === null) return null;

  const { turns, meta } = loaded;
  const sessionKind = loadFacetKind(sessionId, facetCacheDir);
  const cwd = meta.cwd;
  const closureInfoFromEvents: ClosureInfo | null = meta.closureInfo;

  // Inject closure info from the 'closed' event record
  const loadClosure = (_id: string): ClosureInfo | null => closureInfoFromEvents;

  const artifacts = recoverArtifacts(turns);
  const { votes: immediateVotes, selfReport } = runImmediateLFs(
    sessionId,
    turns,
    loadClosure,
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
