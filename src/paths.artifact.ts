/**
 * Path helpers for the content-addressed artifact registry (#1415).
 *
 * Layout under `$AFK_STATE_DIR/artifacts/`:
 *
 *   artifacts/
 *     store/        immutable content blobs, named <sha256>.<ext>
 *     index.jsonl   append-only NDJSON index (last record per id wins)
 *
 * All helpers accept an optional `_stateDir` override so unit tests can
 * operate under a temp directory without touching `~/.afk`.
 *
 * @module paths.artifact
 */

import { join } from 'path';
import { getAfkStateDir } from './paths.js';

/**
 * Root directory for the artifact registry.
 * Default: `$AFK_STATE_DIR/artifacts/`
 */
export function getArtifactRegistryDir(_stateDir?: string): string {
  return join(_stateDir ?? getAfkStateDir(), 'artifacts');
}

/**
 * Immutable content-blob store directory.
 * Default: `$AFK_STATE_DIR/artifacts/store/`
 */
export function getArtifactStoreDir(_stateDir?: string): string {
  return join(getArtifactRegistryDir(_stateDir), 'store');
}

/**
 * Append-only NDJSON index file.
 * Default: `$AFK_STATE_DIR/artifacts/index.jsonl`
 */
export function getArtifactIndexPath(_stateDir?: string): string {
  return join(getArtifactRegistryDir(_stateDir), 'index.jsonl');
}
