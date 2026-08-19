/**
 * Workspace tool schemas and handlers.
 *
 * Single tool: `workspace_publish` — lets sub-agents share structured findings
 * with sibling agents within the same session. No query tool in v1; agents
 * receive workspace context via the preamble injected into their system prompt.
 *
 * Pattern mirrors `src/agent/memory/memory-tools.ts`.
 *
 * @module agent/workspace/workspace-tools
 */

import type { AnthropicToolDef, ToolHandler } from '../tools/types.js';
import type { WorkspacePublishInput, WorkspaceRelationType } from './workspace-store.js';
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
    'Use this to surface discoveries, evidence, hypotheses, decisions, artifacts, or status updates ' +
    'that other agents working on the same task should know about. ' +
    'Entries appear in the workspace context preamble injected into sibling agent system prompts.',
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

/** All workspace tool schemas (v1: publish only). */
export const workspaceToolSchemas: AnthropicToolDef[] = [workspacePublishTool];

/**
 * Create workspace tool handlers bound to a store + session.
 *
 * Returns a Map with one entry: `'workspace_publish'` → handler.
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

  handlers.set('workspace_publish', publishHandler);
  return handlers;
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
