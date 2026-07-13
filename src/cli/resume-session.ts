import type { AgentConfig } from '../agent/types.js';
import { findSession, listSessions, loadSession, type StoredSession } from './session-store.js';

export interface ResumeCliOptions {
  resume?: string;
  continue?: boolean;
}

export interface ResolvedResumeTarget {
  id: string;
  resumeId: string;
  stored?: StoredSession;
}

export function resolveResumeTarget(options: ResumeCliOptions): ResolvedResumeTarget | undefined {
  if (options.resume && options.continue) {
    throw new Error('Use either --resume <id> or --continue, not both.');
  }

  if (options.resume) {
    const found = findSession(options.resume);
    if (found) {
      return {
        id: found.id,
        resumeId: found.data.sessionId ?? found.id,
        stored: found.data,
      };
    }
    return { id: options.resume, resumeId: options.resume };
  }

  if (options.continue) {
    const latest = listSessions()[0];
    if (!latest) {
      throw new Error('No saved sessions found for --continue. Run a session first — sessions autosave automatically.');
    }
    const stored = loadSession(latest.path);
    if (!stored) {
      throw new Error(`Could not load latest saved session: ${latest.id}`);
    }
    return {
      id: latest.id,
      resumeId: stored.sessionId ?? latest.id,
      stored,
    };
  }

  return undefined;
}

export function resumeConfigFor(target: ResolvedResumeTarget | undefined): Partial<AgentConfig> {
  if (!target) return {};
  return {
    resume: target.resumeId,
    sessionId: target.resumeId,
    ...(target.stored
      ? {
          resumeHistory: target.stored.turns.map((turn) => ({
            user: turn.user,
            assistant: turn.assistant,
          })),
        }
      : {}),
  };
}
