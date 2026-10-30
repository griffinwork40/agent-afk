/** Probe each attributed commit in its own repository, not the session root. */
import { existsSync } from 'node:fs';
import type { Artifacts, Vote } from './schema.js';
import { lfCommitSurvival, type CheckAncestor, type CheckRevert } from './lf-delayed.js';

export async function commitSurvivalForArtifacts(
  artifacts: Artifacts,
  deps: { checkAncestor: CheckAncestor; checkRevert: CheckRevert },
  now: string,
): Promise<Vote[]> {
  const groups = new Map<string, string[]>();
  for (const sha of artifacts.commits) {
    const repo = artifacts.commitRepos?.[sha] ?? artifacts.repo;
    if (!repo || !existsSync(repo)) continue;
    const shas = groups.get(repo) ?? [];
    shas.push(sha);
    groups.set(repo, shas);
  }
  const votes: Vote[] = [];
  for (const [repo, shas] of groups) {
    votes.push(...await lfCommitSurvival(shas, repo, deps.checkAncestor, deps.checkRevert, now));
  }
  return votes;
}
