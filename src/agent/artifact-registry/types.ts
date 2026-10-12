/**
 * Types for the content-addressed artifact registry (#1415).
 *
 * An artifact is an immutable, content-hashed record of an agent output
 * (screenshot, report, patch, dataset, etc.). Once written, an artifact
 * record is never mutated — new versions are new artifacts with lineage.
 *
 * @module agent/artifact-registry/types
 */

// ---------------------------------------------------------------------------
// Retention policy
// ---------------------------------------------------------------------------

/**
 * How long an artifact should be kept.
 *
 * - `permanent` — never evicted by the witness sweep or any TTL policy.
 * - `session`   — may be evicted when the originating session is swept.
 * - `ttl:<ms>`  — evict after the given number of milliseconds from
 *                 `created_at`.  The string form allows the value to be
 *                 serialised to JSON without a wrapper object.
 */
export type ArtifactRetention = 'permanent' | 'session' | `ttl:${number}`;

// ---------------------------------------------------------------------------
// Core record
// ---------------------------------------------------------------------------

/**
 * An immutable artifact record as stored in the registry index.
 *
 * All fields are required so that a partial write is detectable by schema
 * validation.  `inputs` and `tags` default to empty arrays at creation time.
 */
export interface ArtifactRecord {
  /** Stable opaque identifier: `art_<first-32-hex-chars-of-sha256>`. */
  id: string;

  /**
   * Canonical filesystem path where the content lives.
   *
   * For `artifact_publish(path)` calls this is the path inside the artifact
   * store directory.  It is always absolute so that callers can open the file
   * without knowing the store root.
   */
  uri: string;

  /** MIME type, e.g. `image/png`, `text/markdown`, `application/json`. */
  media_type: string;

  /**
   * Hex-encoded SHA-256 of the artifact content.
   *
   * Used for integrity verification and as the basis for the stable `id`.
   * Content-identical artifacts share the same hash and the same stable ID
   * (the ID is derived solely from the content hash, not from metadata).
   */
  hash: string;

  /** Content length in bytes. */
  size: number;

  /**
   * Origin metadata.  All sub-fields are optional — the registry imposes no
   * requirement on callers to supply them, but they improve queryability.
   */
  producer: {
    session_id?: string;
    subagent_id?: string;
    tool_name?: string;
    task_id?: string;
  };

  /**
   * Stable IDs of artifacts that this artifact was derived from.
   * Empty array when there is no traceable lineage.
   */
  inputs: string[];

  /** Free-form key/value tags for ad-hoc filtering. */
  tags: Record<string, string>;

  /** Unix epoch milliseconds when the artifact was registered. */
  created_at: number;

  /** Retention policy — drives sweep behaviour. */
  retention: ArtifactRetention;
}

// ---------------------------------------------------------------------------
// Put / publish options
// ---------------------------------------------------------------------------

/**
 * Options passed to `artifactPut()`.
 *
 * Either `path` (register an existing file) or `content` (register inline
 * bytes) must be supplied — not both.
 */
export type ArtifactPutOptions = (
  | { path: string; content?: never }
  | { content: Buffer | string; path?: never }
) & {
  media_type?: string;
  producer?: ArtifactRecord['producer'];
  inputs?: string[];
  tags?: Record<string, string>;
  retention?: ArtifactRetention;
};

// ---------------------------------------------------------------------------
// List filter
// ---------------------------------------------------------------------------

/**
 * Filter criteria for `artifactList()`.
 *
 * All fields are optional; omitting a field means "no restriction on that
 * dimension".  Multiple fields are ANDed.
 */
export interface ArtifactListFilter {
  session_id?: string;
  subagent_id?: string;
  tool_name?: string;
  media_type?: string;
  /** Inclusive lower bound (epoch ms). */
  since?: number;
  /** Inclusive upper bound (epoch ms). */
  until?: number;
  retention?: ArtifactRetention;
  /** Arbitrary tag key/value that must be present on the record. */
  tag?: { key: string; value: string };
  /** Maximum number of results (default: 100, hard cap: 1000). */
  limit?: number;
}
