/** Browser-safe ephemeral choice/progress wire. Never written to the session ledger. */
export type { ChoiceRequest, ProgressEvent as ChoiceProgressEvent } from '../../cli/slash/interaction.js';
import type { ChoiceRequest, ProgressEvent } from '../../cli/slash/interaction.js';

export type ChoiceSsePayload =
  | { type: 'choice_request'; request: ChoiceRequest }
  | ({ type: 'progress' } & ProgressEvent)
  | { type: 'choice_settled'; corrId: string };
