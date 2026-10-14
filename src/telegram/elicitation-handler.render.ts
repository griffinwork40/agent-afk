/**
 * Choice-render helper for Telegram elicitation keyboards.
 *
 * Extracted from elicitation-handler.ts (issue #1865).
 *
 * @module telegram/elicitation-handler.render
 */

import { Markup } from 'telegraf';
import { renderTelegramChoices, buildChoiceMessages, type ChoiceMessages } from './elicitation-choice-list.js';

const MAX_CHOICES = 20;

/** Prepare rendered labels and split choice messages for a `choice` elicitation. */
export function prepareChoiceRender(
  choices: readonly string[],
  displayText: string,
  buildCallback: (i: number) => string,
): { choiceMsg: ChoiceMessages; buttons: ReturnType<typeof Markup.button.callback>[][] } {
  const cappedChoices = choices.slice(0, MAX_CHOICES);
  const rendered = renderTelegramChoices(cappedChoices);
  const choiceMsg = buildChoiceMessages(displayText, rendered, cappedChoices);
  const buttons = rendered.labels.map((label, i) => [Markup.button.callback(label, buildCallback(i))]);
  return { choiceMsg, buttons };
}
