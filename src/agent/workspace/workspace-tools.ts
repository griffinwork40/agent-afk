/**
 * Workspace tool schemas and handlers.
 *
 * Two tools:
 *   - `workspace_publish` — lets sub-agents share structured findings with
 *     sibling agents within the same session.
 *   - `workspace_query` — lets a running agent poll the shared workspace
 *     mid-execution for findings published by siblings, without waiting for
 *     the next fork-time preamble injection.
 *
 * Pattern mirrors `src/agent/memory/memory-tools.ts`.
 *
 * @module agent/workspace/workspace-tools
 */

import type { AnthropicToolDef, ToolHandler } from '../tools/types.js';
import type { WorkspaceEntry, WorkspacePublishInput, WorkspaceRelationType } from './workspace-store.js';
import { WorkspaceStore } from './workspace-store.js';

/**
 * workspace_publish: Publish a structured finding to the shared session workspace.
 * Sibling agents will see this entry in their workspace context preamble.
 */
export const workspacePublishTool: AnthropicToolDef = {
  name: 'workspace_publish',
  category: 'write',
  concurrencySafe: false,
  description:
    'Publish a structured finding to the shared session workspace so sibling agents can see it. ' +
    'Call after: confirming a module\'s key exports or invariants, ruling out a hypothesis, ' +
    'or reading a file another sibling will likely need (publish the insight, not raw content). ' +
    'Entries are visible immediately to siblings via workspace_query and injected into ' +
    'new siblings\' system prompts at fork time. Free to batch with other tools.',
  input_schema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['finding', 'evidence', 'hypothesis', 'decision', 'artifact', 'status'],
        description: 'The kind of entry being published.',
      },
      subject: {
        type: 'string',
        description:
          'Optional short label for relevance routing — e.g. "auth refresh", "DB schema". ' +
          'Agents querying the workspace by task keywords will match on this field.',
      },
      content: {
        type: 'string',
        description: 'The full text of the finding, evidence, or decision.',
      },
      evidence: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional file:line references backing this entry (e.g. ["src/auth.ts:141"]).',
      },
      confidence: {
        type: 'number',
        description: 'Confidence level 0–1 (default 1.0).',
      },
      relates_to: {
        type: 'array',
        items: { type: 'number' },
        description: 'Optional IDs of related workspace entries.',
      },
      relation_type: {
        type: 'string',
        enum: ['supports', 'contradicts', 'depends_on', 'supersedes'],
        description: 'Relationship to the entries listed in relates_to.',
      },
    },
    required: ['type', 'content'],
  },
};

/**
 * workspace_query: Poll the shared workspace for findings from sibling agents.
 * Unlike the fork-time preamble (cold-start), this runs mid-execution so a
 * child can see entries published after it was forked.
 */
export const workspaceQueryTool: AnthropicToolDef = {
  name: 'workspace_query',
  category: 'read',
  concurrencySafe: true,
  description:
    'Query the shared session workspace for findings published by sibling agents. ' +
    'Call before reading a file or grepping a module — a sibling may have already ' +
    'analyzed it. Returns entries matching the search keywords, ordered by recency. ' +
    'A workspace hit saves a tool round by avoiding redundant file reads.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Search keywords to match against workspace entry subjects and content. ' +
          'E.g. "provider streaming" or "auth error handling".',
      },
      type: {
        type: 'string',
        enum: ['finding', 'evidence', 'hypothesis', 'decision', 'artifact', 'status'],
        description: 'Optional: filter results to a specific entry type.',
      },
      limit: {
        type: 'number',
        description: 'Max entries to return (default 20, max 50).',
      },
    },
    required: ['query'],
  },
};

/** All workspace tool schemas. */
export const workspaceToolSchemas: AnthropicToolDef[] = [workspacePublishTool, workspaceQueryTool];

/**
 * Create workspace tool handlers bound to a store + session.
 *
 * Returns a Map with two entries:
 *   - `'workspace_publish'` → write handler (publish a finding)
 *   - `'workspace_query'`  → read handler (poll sibling findings mid-run)
 *
 * The `agent_id` field is auto-filled from the optional `agentId` parameter.
 */
export function createWorkspaceHandlers(
  store: WorkspaceStore,
  sessionId: string,
  agentId?: string,
): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  const publishHandler: ToolHandler = async (input: unknown) => {
    try {
      const parsed = parsePublishInput(input);
      const entry: WorkspacePublishInput = {
        session_id: sessionId,
        type: parsed.type,
        content: parsed.content,
        subject: parsed.subject,
        evidence: parsed.evidence,
        confidence: parsed.confidence,
        agent_id: agentId,
        relates_to: parsed.relates_to,
        relation_type: parsed.relation_type,
      };
      const id = store.publish(entry);
      return { content: JSON.stringify({ published: true, id }) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `workspace_publish error: ${message}`, isError: true };
    }
  };

  const queryHandler: ToolHandler = async (input: unknown) => {
    try {
      const parsed = parseQueryInput(input);
      // Invariant: pass `null` as sessionId — the store is scoped to one root
      // session, and children publish under their own IDs (same rationale as
      // the fork-child-config preamble injection path).
      let entries = store.queryRelevant(null, parsed.query, parsed.limit);
      if (parsed.type !== undefined) {
        entries = entries.filter((e) => e.type === parsed.type);
      }
      return { content: JSON.stringify({ entries: entries.map(formatEntry), count: entries.length }) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `workspace_query error: ${message}`, isError: true };
    }
  };

  handlers.set('workspace_publish', publishHandler);
  handlers.set('workspace_query', queryHandler);
  return handlers;
}

/** Format a WorkspaceEntry for the query response — parse JSON fields back to arrays. */
function formatEntry(entry: WorkspaceEntry): Record<string, unknown> {
  return {
    id: entry.id,
    type: entry.type,
    subject: entry.subject,
    content: entry.content,
    evidence: entry.evidence !== null ? JSON.parse(entry.evidence) : null,
    confidence: entry.confidence,
    agent_id: entry.agent_id,
    relates_to: entry.relates_to !== null ? JSON.parse(entry.relates_to) : null,
    relation_type: entry.relation_type,
    created_at: entry.created_at,
  };
}

// ── Input parsing ─────────────────────────────────────────────────────────────

/** Max chars for workspace entry content before truncation at ingest. */
const CONTENT_MAX_CHARS = 8192;
/** Max chars for workspace entry subject before truncation at ingest. */
const SUBJECT_MAX_CHARS = 256;
const TRUNCATION_MARKER = ' … [truncated]';

const VALID_TYPES = new Set([
  'finding',
  'evidence',
  'hypothesis',
  'decision',
  'artifact',
  'status',
]);

const VALID_RELATION_TYPES = new Set([
  'supports',
  'contradicts',
  'depends_on',
  'supersedes',
]);

interface ParsedPublishInput {
  type: WorkspacePublishInput['type'];
  content: string;
  subject?: string;
  evidence?: string[];
  confidence?: number;
  relates_to?: number[];
  relation_type?: WorkspaceRelationType;
}

// ── Query input parsing ──────────────────────────────────────────────────────

const QUERY_MAX_LIMIT = 50;
const QUERY_DEFAULT_LIMIT = 20;

interface ParsedQueryInput {
  query: string;
  type?: WorkspacePublishInput['type'];
  limit: number;
}

function parseQueryInput(input: unknown): ParsedQueryInput {
  if (!input || typeof input !== 'object') {
    throw new Error('workspace_query: input must be an object');
  }
  const raw = input as Record<string, unknown>;

  const query = raw['query'];
  if (typeof query !== 'string' || query.length === 0) {
    throw new Error('workspace_query: query is required');
  }

  const typeRaw = raw['type'];
  const type =
    typeof typeRaw === 'string' && VALID_TYPES.has(typeRaw)
      ? (typeRaw as WorkspacePublishInput['type'])
      : undefined;

  const limitRaw = raw['limit'];
  const limit =
    typeof limitRaw === 'number' && limitRaw > 0
      ? Math.min(Math.floor(limitRaw), QUERY_MAX_LIMIT)
      : QUERY_DEFAULT_LIMIT;

  return { query, type, limit };
}

// ── Publish input parsing ────────────────────────────────────────────────────

function parsePublishInput(input: unknown): ParsedPublishInput {
  if (!input || typeof input !== 'object') {
    throw new Error('workspace_publish: input must be an object');
  }
  const raw = input as Record<string, unknown>;

  const type = raw['type'];
  if (typeof type !== 'string' || !VALID_TYPES.has(type)) {
    throw new Error(
      `workspace_publish: type must be one of ${[...VALID_TYPES].join(', ')}`,
    );
  }

  const contentRaw = raw['content'];
  if (typeof contentRaw !== 'string' || contentRaw.length === 0) {
    throw new Error('workspace_publish: content is required');
  }
  const content = contentRaw.length > CONTENT_MAX_CHARS
    ? contentRaw.slice(0, CONTENT_MAX_CHARS) + TRUNCATION_MARKER
    : contentRaw;

  const subject =
    typeof raw['subject'] === 'string'
      ? raw['subject'].length > SUBJECT_MAX_CHARS
        ? raw['subject'].slice(0, SUBJECT_MAX_CHARS) + TRUNCATION_MARKER
        : raw['subject']
      : undefined;

  const evidence =
    Array.isArray(raw['evidence']) &&
    (raw['evidence'] as unknown[]).every((e) => typeof e === 'string')
      ? (raw['evidence'] as string[])
      : undefined;

  const confidence =
    typeof raw['confidence'] === 'number' ? raw['confidence'] : undefined;

  const relates_to =
    Array.isArray(raw['relates_to']) &&
    (raw['relates_to'] as unknown[]).every((n) => typeof n === 'number')
      ? (raw['relates_to'] as number[])
      : undefined;

  const relationTypeRaw = raw['relation_type'];
  const relation_type =
    typeof relationTypeRaw === 'string' && VALID_RELATION_TYPES.has(relationTypeRaw)
      ? (relationTypeRaw as WorkspaceRelationType)
      : undefined;

  return {
    type: type as WorkspacePublishInput['type'],
    content,
    subject,
    evidence,
    confidence,
    relates_to,
    relation_type,
  };
}
