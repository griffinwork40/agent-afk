/**
 * Shared types for the Telegram elicitation handler and its extracted helpers.
 *
 * @module telegram/elicitation-handler.types
 */

import type { Telegraf } from 'telegraf';
import type { ElicitationRequest, ElicitationResult } from '../agent/types/sdk-types.js';
import type { MessageHandler } from './handlers/message.js';

/** Sentinel returned by the custom-entry wildcard handler to the dispatch table. */
export const CUSTOM_ENTRY_SENTINEL_INDEX = -1;

/** Context threaded into per-question-type handlers instead of capturing locals. */
export interface ElicitationCtx {
  chatId: number;
  threadOpts: object;
  request: ElicitationRequest;
  signal: AbortSignal;
  bot: Telegraf;
  setPending: (resolver: (text: string) => void) => void;
  deletePending: () => void;
  key: string;
  messageHandler: Pick<MessageHandler, 'pendingElicitations'>;
}

/** The mutable resolve-once guard threaded into handlers. */
export interface ResolveGuard {
  resolved: boolean;
}

export type Resolve = (result: ElicitationResult) => void;
