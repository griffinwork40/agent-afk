import type { PeerEnvelope } from '../../../agent/peer/envelope.js';
import { sanitizeForDisplay } from '../../../utils/terminal-sanitize.js';
import { displayWidth, truncateDisplayWidth } from '../../display.js';
import { palette } from '../../palette.js';

function singleLine(text: string): string {
  return sanitizeForDisplay(text).replace(/\s+/gu, ' ').trim();
}

/** Select identity only after sanitizing, including the abbreviated fallback. */
export function safePeerSender(from: PeerEnvelope['from']): string {
  return singleLine(from.name ?? '') || singleLine(from.id.slice(0, 8));
}

/** Presentation only: no indentation, envelope mutation, or terminal lookup. */
export function formatPeerArrival(e: Pick<PeerEnvelope, 'from' | 'body'>, width: number): string {
  const budget = Math.max(0, Math.floor(width));
  if (budget === 0) return '';
  const attribution = `↘ peer message from ${safePeerSender(e.from)}`;
  const label = truncateDisplayWidth(attribution, budget);
  const body = singleLine(e.body);
  // Reserve the separator and BOTH quotation marks before allocating preview.
  const previewWidth = budget - displayWidth(label) - displayWidth(' · “”');
  const preview = body && previewWidth > 0 ? truncateDisplayWidth(body, previewWidth) : '';
  return palette.dim(preview ? `${label} · “${preview}”` : label);
}
