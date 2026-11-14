import type { AgentSession } from '../session.js';
import type { SessionStats } from '../../cli/slash/types.js';
import { contextLimitFor } from '../model-limits.js';

export type ContextUsage = Awaited<ReturnType<AgentSession['getContextUsage']>>;
export interface LocalTokenUsage {
  kind: 'local';
  input: number;
  output: number;
  cache: number;
  total: number;
  contextUsed: number;
  contextLimit: number;
  percentage: number;
  model: SessionStats['model'];
}
export type TokenUsage = { kind: 'sdk'; usage: ContextUsage } | LocalTokenUsage;

export function readContextUsage(session: Pick<AgentSession, 'getContextUsage'>): Promise<ContextUsage> {
  return session.getContextUsage();
}

/** Last-round occupancy, NOT the sum of historical cache reads. */
export function readLocalTokenUsage(stats: SessionStats): LocalTokenUsage {
  const input = stats.turnTokens.reduce((sum, t) => sum + t.input, 0);
  const output = stats.turnTokens.reduce((sum, t) => sum + t.output, 0);
  const cache = stats.turnTokens.reduce((sum, t) => sum + t.cache, 0);
  const last = stats.turnTokens.at(-1);
  const contextUsed = last ? last.footprint ?? last.input + last.output + last.cache : 0;
  const contextLimit = contextLimitFor(stats.model);
  return {
    kind: 'local', input, output, cache, total: input + output, contextUsed,
    contextLimit, percentage: contextLimit > 0 ? Math.round(contextUsed / contextLimit * 100) : 0,
    model: stats.model,
  };
}

export async function readTokenUsage(
  session: Pick<AgentSession, 'getContextUsage'>,
  stats: SessionStats,
): Promise<TokenUsage> {
  try {
    return { kind: 'sdk', usage: await readContextUsage(session) };
  } catch {
    return readLocalTokenUsage(stats);
  }
}

export async function readMcpStatus(session: Pick<AgentSession, 'waitForInitialization'>) {
  const metadata = await session.waitForInitialization();
  return metadata.mcpServers ?? [];
}

export async function readMcpOauthPending() {
  const { readOauthPending } = await import('../mcp/oauth.js');
  return readOauthPending();
}
