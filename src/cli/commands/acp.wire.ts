// Contract: the emitted/accepted AFK subset of ACP v1 at d98a032.
// Optional upstream features not advertised by AFK are intentionally absent.
import type { CanUseTool } from '../../agent/types/sdk-types.js';
import type { ChildToolOrigin } from '../../agent/tools/nesting.can-use-tool.js';
import type { ElicitationHandler } from '../../agent/elicitation-router.js';
import type { ResponseMetadata } from '../../agent/types/message-types.js';
export type { CanUseTool } from '../../agent/types/sdk-types.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type RequestId = string | number | null;
export interface RpcError { code: number; message: string; data?: JsonValue }
export interface RpcRequest { jsonrpc: '2.0'; id: Exclude<RequestId, null>; method: string; params?: unknown }
export interface RpcNotification { jsonrpc: '2.0'; method: string; params?: unknown }
export type RpcResponse = { jsonrpc: '2.0'; id: RequestId } & (
  { result: unknown; error?: never } | { error: RpcError; result?: never }
);
export type RpcFrame = RpcRequest | RpcNotification | RpcResponse;
export interface AcpClientPeer {
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
}
export interface AcpRpcPeer extends AcpClientPeer {
  /** True only when a live outbound request consumed this response. */
  handleResponse(frame: RpcResponse): boolean;
  /** Reject every pending outbound request, and prohibit new writes. */
  close(reason?: string): void;
}
export interface AcpRpcPeerOptions { write(frame: RpcFrame): Promise<void> }

export interface Implementation { name: string; version: string; title?: string }
export interface InitializeRequest {
  protocolVersion: number;
  clientInfo?: Implementation | null;
  clientCapabilities?: Record<string, unknown>;
}
export interface InitializeResponse {
  protocolVersion: 1;
  agentInfo: Implementation;
  authMethods: [];
  agentCapabilities: {
    loadSession: true;
    promptCapabilities: { image: false; audio: false; embeddedContext: true };
    mcpCapabilities: { http: false; sse: false };
    sessionCapabilities: { resume: Record<string, never>; close: Record<string, never> };
  };
}
export interface McpServerStdio {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}
export interface NewSessionRequest { cwd: string; mcpServers: McpServerStdio[] }
export interface NewSessionResponse { sessionId: string }
export interface LoadSessionRequest extends NewSessionRequest { sessionId: string }
export interface ResumeSessionRequest { sessionId: string; cwd: string; mcpServers?: McpServerStdio[] }
export interface CloseSessionRequest { sessionId: string }
export type CancelNotification = CloseSessionRequest;
export type EmptyResponse = Record<string, never>;
export type LoadSessionResponse = EmptyResponse;
export type ResumeSessionResponse = EmptyResponse;
export type CloseSessionResponse = EmptyResponse;

export interface TextContent { type: 'text'; text: string }
export interface ResourceLink {
  type: 'resource_link'; name: string; uri: string;
  title?: string | null; description?: string | null; mimeType?: string | null; size?: number | null;
}
export interface TextResourceContents { uri: string; text: string; mimeType?: string | null }
export interface BlobResourceContents { uri: string; blob: string; mimeType?: string | null }
export interface EmbeddedResource { type: 'resource'; resource: TextResourceContents | BlobResourceContents }
export type ContentBlock = TextContent | ResourceLink | EmbeddedResource;
export interface PromptRequest { sessionId: string; prompt: ContentBlock[] }
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';
export interface PromptResponse { stopReason: StopReason }
export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export interface ToolCallLocation { path: string; line?: number | null }
export interface DiffContent { type: 'diff'; path: string; oldText?: string | null; newText: string }
export type ToolCallContent = { type: 'content'; content: ContentBlock } | DiffContent;
export interface ToolCall {
  toolCallId: string;
  title: string;
  name?: string | null;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: JsonValue;
  rawOutput?: string;
}
export interface ToolCallUpdate {
  toolCallId: string;
  title?: string | null;
  name?: string | null;
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  content?: ToolCallContent[] | null;
  locations?: ToolCallLocation[] | null;
  rawInput?: JsonValue;
  rawOutput?: string;
}
export type ToolCallStart = ToolCall & { sessionUpdate: 'tool_call' };
export type ToolCallProgress = ToolCallUpdate & { sessionUpdate: 'tool_call_update' };
export interface UsageUpdate {
  sessionUpdate: 'usage_update'; used: number; size: number;
  cost?: { amount: number; currency: 'USD' };
}
export type SessionUpdate = ToolCallStart | ToolCallProgress | UsageUpdate | {
  sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk' | 'user_message_chunk';
  content: TextContent;
  messageId?: string;
};
export interface SessionNotification { sessionId: string; update: SessionUpdate }
export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
export interface PermissionOption { optionId: string; name: string; kind: PermissionOptionKind }
export interface RequestPermissionRequest { sessionId: string; toolCall: ToolCallUpdate; options: PermissionOption[] }
export type RequestPermissionOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };
export interface RequestPermissionResponse { outcome: RequestPermissionOutcome }

export interface TranslatorToolState {
  name: string;
  input?: JsonValue;
  /** Shared with emitToolCall so permission paints and stream paints deduplicate. */
  announced: boolean;
  content: ToolCallContent[];
  status: ToolCallStatus;
}
export interface TranslatorState {
  tools: Map<string, TranslatorToolState>;
  cancelled: boolean;
  /** A1 sets this from model info. Absent means omit usage updates. */
  contextWindowSize?: number;
  /** Sum of measured per-turn totalCostUsd values for this live session. */
  cumulativeCostUsd?: number;
  /** Once cost is missing, do not claim a complete cumulative cost. */
  costIncomplete?: boolean;
  /**
   * A1 sets this from the live gate. False means the call runs without asking
   * (auto-allow, remembered grant, skip), so its first start is in_progress.
   * Absent means only read/search kinds start in_progress. Never consulted for a missing name.
   */
  requiresConsent?: (toolName: string, input: Record<string, unknown>) => boolean;
}
export interface TranslatorContext { cwd: string }
export type TurnMetadata = ResponseMetadata;
export interface FinishedTurn { updates: SessionUpdate[]; stopReason: StopReason }
export interface AcpPermissionOptions {
  skip: boolean;
  /** Awaited before asking. A1 records announced before returning, no-op for duplicate pending starts.
   * A repeated start with in_progress becomes an update before execution, not another start.
   */
  emitToolCall(update: ToolCallStart): Promise<void>;
  /** Mark the turn cancelled and interrupt it when permission cancellation originates here. */
  onCancelled(): void;
  /** Session cwd for relative display locations; absent means relative paths are omitted. */
  cwd?: string;
  /**
   * D9: true while a prompt turn is live and not cancelled. A child that asks
   * outside a turn (a background job) is denied without a card, because no
   * update may follow the prompt response. Absent means always live.
   */
  turnActive?(): boolean;
}
export interface AcpPermissionGate {
  canUseTool: CanUseTool;
  /** Reserved and absent: path approval is replaced by the D10 outside-cwd policy. Do not install a path-approval GUI handler. */
  elicitationHandler?: ElicitationHandler;
  /** Deny pending asks; A1 owns interruption. Does not discard remembered grants. */
  cancelAll(): void;
  /** True when a call of this tool would ask the client now (policy, grants, skip). Pure. */
  wouldAsk?(toolName: string, input: Record<string, unknown>): boolean;
  /**
   * D9: approval callback for one forked child, used as the session's
   * `childCanUseTool` factory. Same policy, grants and client; labelled title;
   * the gate closes the child's card itself. Undefined/malformed origin still gates.
   */
  forChild?(origin: ChildToolOrigin | undefined): CanUseTool;
  /** D9: deny pending child asks and wait for every child card to close. Never rejects. */
  endTurn?(): Promise<void>;
}
