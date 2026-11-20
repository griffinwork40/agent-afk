import type { OutputEvent } from '../../agent/types/session-types.js';
import type {
  FinishedTurn, SessionUpdate, TranslatorContext, TranslatorState, TurnMetadata,
} from './acp.wire.js';

export function createTranslatorState(): TranslatorState {
  throw new Error('not implemented');
}

export function translateOutputEvent(
  _ev: OutputEvent, _st: TranslatorState, _ctx: TranslatorContext,
): SessionUpdate[] {
  throw new Error('not implemented');
}

export function finishTurn(_st: TranslatorState, _meta?: TurnMetadata): FinishedTurn {
  throw new Error('not implemented');
}
