/**
 * Pre-session memory loader.
 *
 * Loads HOT.md and injects it into the system prompt in AgentConfig
 * before session construction. Must be called before new AgentSession().
 *
 * The system prompt is baked at provider construction time and cannot be
 * modified after session construction, so memory injection must happen
 * in the AgentConfig before the session is created.
 *
 * @module agent/memory/memory-loader
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getMemoryDir } from '../../paths.js';
import type { AgentConfig } from '../types/config-types.js';

/**
 * Load HOT.md from memory store.
 *
 * Returns null if the file doesn't exist, can't be read, or contains
 * only whitespace.
 */
export function loadHotMemory(): string | null {
  const path = join(getMemoryDir(), 'HOT.md');
  if (!existsSync(path)) return null;

  try {
    const content = readFileSync(path, 'utf-8');
    return content.trim().length > 0 ? content : null;
  } catch {
    // File unreadable (permissions, I/O error) — treat as empty
    return null;
  }
}

/**
 * Inject HOT.md into an AgentConfig as the dedicated `hotMemory` field.
 *
 * If HOT.md doesn't exist or is empty, returns the config unchanged.
 * Otherwise, wraps the hot memory in `<cross-session-memory>` tags and stores
 * it on `config.hotMemory` — a field the provider places in the
 * cross-session-memory region of the assembled system prompt (after the memory
 * instructions).
 *
 * Invariant: hot memory is carried as its own field rather than prepended into
 * `systemPrompt`. `systemPrompt` holds the `# Agent AFK` doctrine + operator
 * overlay + routing/end-of-turn directives, which the provider now places
 * EARLY (right after the tool conventions); welding hot memory onto the front
 * of that string would drag the cross-session-memory block ahead of the
 * doctrine. Keeping the two separate lets the assembler order them
 * independently. See `providers/anthropic-direct/query/system-prompt.ts`.
 *
 * Does not mutate the original config — returns a shallow copy.
 */
export function injectHotMemory(config: AgentConfig): AgentConfig {
  const hot = loadHotMemory();
  if (!hot) return config;

  const sanitized = hot.replace(/<\/?cross-session-memory\b[^>]*>/gi, '');
  const memoryBlock = `<cross-session-memory>\n${sanitized}\n</cross-session-memory>`;
  return { ...config, hotMemory: memoryBlock };
}
