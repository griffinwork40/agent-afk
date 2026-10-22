/**
 * TypeScript types matching the web-server API responses.
 *
 * These are client-side mirrors of the server types. They are NOT imported
 * from src/web-server/ to avoid coupling the browser bundle to Node.js code.
 */

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionSummary {
  id: string;
  mode: 'live' | 'readonly';
  cwd?: string;
  surface?: string;
  updatedAt?: string;
  title?: string;
  alive?: boolean;
  model?: string;
}

export interface SessionsResponse {
  sessions: SessionSummary[];
}

// ---------------------------------------------------------------------------
// Session status classification
// ---------------------------------------------------------------------------

export type SessionStatusGroup = 'needs-input' | 'active' | 'completed';

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

export interface ScheduleConfig {
  id: string;
  name: string;
  command: string;
  cron: string;
  trigger?: 'cron' | 'sessionstart' | 'both';
  enabled: boolean;
  notifyOn?: 'failure' | 'always' | 'never';
  createdAt: string;
  updatedAt?: string;
}

export interface DaemonStatus {
  running: boolean;
  tasks?: number;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export interface MemorySearchResult {
  type: 'fact' | 'procedure';
  content: string;
  category?: 'preference' | 'convention' | 'decision' | 'learning';
  created_at: string;
  source_session?: string | null;
  confidence?: number;
}

export interface HotMemoryResponse {
  content: string | null;
  usage: {
    chars: number;
    tokens: number;
    maxTokens: number;
    pct: number;
    truncated: boolean;
  };
}

// ---------------------------------------------------------------------------
// Background Jobs
// ---------------------------------------------------------------------------

export interface BgJobMeta {
  jobId: string;
  subagentId: string;
  label: string;
  model: string;
  startedAt: number;
  /** PID of the owning process — present when the job was started by a live session */
  ownerPid?: number;
  endedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  parentSessionId?: string;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface ModelInfo {
  id: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ConfigInfo {
  version: string;
  nodeVersion: string;
  model: string;
  stateDir: string;
  configDir: string;
  afkHome: string;
  webPort: number;
  webHost: string;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface SlashCommand {
  name: string;
  summary: string;
  hint?: string;
  /** 'skill' = dispatched as a structured invocation; 'native' = runs via /commands route */
  kind: 'skill' | 'native';
  /** Whether the command is available on the web surface */
  web: 'ok' | 'gated';
  /** Human-readable reason when web === 'gated' */
  gateReason?: string;
}

// ---------------------------------------------------------------------------
// Approvals / Elicitation
// ---------------------------------------------------------------------------

export interface PendingApproval {
  id: string;
  sessionId?: string;
  createdAt?: string;
  request: {
    message?: string;
    title?: string;
    description?: string;
    serverName?: string;
    type?: 'text' | 'confirm' | 'choice' | 'multi_choice' | 'number';
    choices?: string[];
    questionDefault?: string | boolean | number;
    /** Inclusive lower bound for number-type elicitations. */
    questionMin?: number;
    /** Inclusive upper bound for number-type elicitations. */
    questionMax?: number;
  };
}

// ---------------------------------------------------------------------------
// Daemon handoffs
// ---------------------------------------------------------------------------

export interface HandoffQuestion {
  message?: string;
  type?: string;
  choices?: unknown[];
}

export interface HandoffSummary {
  taskId: string;
  sessionId: string;
  createdAt: string;
  status: 'pending';
  question: HandoffQuestion;
}

export interface HandoffsResponse {
  handoffs: HandoffSummary[];
}

// ---------------------------------------------------------------------------
// Tool results (message journal)
// ---------------------------------------------------------------------------

/** `GET /api/sessions/:id/tool-results/:toolUseId` — mirrors ToolResultResponse in src/web-server/routes.tool-results.ts. */
export interface ToolResultResponse {
  toolUseId: string;
  isError: boolean;
  subagentId?: string;
  text: string;
  totalChars: number;
  truncated: boolean;
}
