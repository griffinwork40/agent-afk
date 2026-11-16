// Contract: queued framework context is drained into one harness envelope
// before the next outbound user message by TurnStreamRunner.withPendingContext.
// This includes hook output, plugin additionalContext and MCP notices.
//
//   <framework-context>
//   ...drained text...
//   </framework-context>
//
//   <user content>
//
// Consumers recover what the user typed by cutting through the FIRST closing
// tag. Hook output is untrusted, so literal closing tags in it are neutralized.
// When user content itself opens with the tag and no context is queued, an
// empty harness envelope protects that text from being mistaken for context.
// Exactly one envelope is peeled; any subsequent envelope belongs to the user.

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';

export const FRAMEWORK_CONTEXT_OPEN = '<framework-context>';
export const FRAMEWORK_CONTEXT_CLOSE = '</framework-context>';

/** Any closing-tag spelling a lenient consumer might honour. */
const CLOSE_TAG_VARIANTS_RE = /<\/\s*framework-context\s*>/gi;

/** Replace every closing tag inside untrusted text with an inert spelling. */
export function neutralizeFrameworkContext(text: string): string {
  return text.replace(CLOSE_TAG_VARIANTS_RE, '&lt;/framework-context&gt;');
}

/** Wrap nonblank drained context; blank input alone needs no envelope. */
export function wrapFrameworkContext(text: string): string {
  const body = text.trim();
  if (body.length === 0) return '';
  return `${FRAMEWORK_CONTEXT_OPEN}\n${neutralizeFrameworkContext(body)}\n${FRAMEWORK_CONTEXT_CLOSE}`;
}

/** Prepend one harness envelope when context exists or user text needs protection. */
export function prependFrameworkContext(
  pending: readonly string[],
  content: string | ContentBlockParam[],
): string | ContentBlockParam[] {
  // Readers join every text block, so the guard must judge the joined text.
  const joined = typeof content === 'string'
    ? content
    : content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  const prefix = wrapFrameworkContext(pending.join('\n\n'))
    || (joined.trimStart().startsWith(FRAMEWORK_CONTEXT_OPEN)
      ? `${FRAMEWORK_CONTEXT_OPEN}\n\n${FRAMEWORK_CONTEXT_CLOSE}` : '');
  if (!prefix) return content;
  if (typeof content === 'string') return `${prefix}\n\n${content}`;
  return [{ type: 'text', text: prefix }, ...content];
}

/**
 * Split text that opens with one complete harness envelope into the envelope
 * (through its closing tag) and the untrimmed rest; undefined otherwise.
 */
export function splitFrameworkContext(text: string): { envelope: string; rest: string } | undefined {
  const rest = text.trimStart();
  if (!rest.startsWith(FRAMEWORK_CONTEXT_OPEN)) return undefined;
  const closeIdx = rest.indexOf(FRAMEWORK_CONTEXT_CLOSE);
  if (closeIdx < 0) return undefined;
  const end = closeIdx + FRAMEWORK_CONTEXT_CLOSE.length;
  return { envelope: rest.slice(0, end), rest: rest.slice(end) };
}

/**
 * Return the trimmed text after exactly one leading harness envelope.
 * An unterminated envelope (such as a truncated journal preview) yields ''.
 * Return undefined only when text does not open with an envelope.
 */
export function textAfterFrameworkContext(text: string): string | undefined {
  const rest = text.trimStart();
  if (!rest.startsWith(FRAMEWORK_CONTEXT_OPEN)) return undefined;
  const closeIdx = rest.indexOf(FRAMEWORK_CONTEXT_CLOSE);
  if (closeIdx < 0) return '';
  return rest.slice(closeIdx + FRAMEWORK_CONTEXT_CLOSE.length).trim();
}
