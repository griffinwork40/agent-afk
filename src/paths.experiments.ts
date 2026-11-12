/** Workspace A/B experiment state paths; exported through the paths barrel. */
import { join } from 'node:path';
import { getAfkStateDir } from './paths.js';

/** Resolve one run below the canonical state tier, without creating directories. */
export function getWorkspaceExperimentDir(runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(runId)) {
    throw new Error(`Invalid workspace experiment run id: ${JSON.stringify(runId)}`);
  }
  return join(getAfkStateDir(), 'experiments', 'workspace-ab', runId);
}
