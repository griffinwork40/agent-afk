/**
 * Workspace subscription types, filter logic, and XML delivery formatter.
 *
 * Subscription records are held in-memory on the WorkspaceStore. When a new
 * entry is published, notifySubscribers() iterates active subscriptions and
 * pushes matching entries to each subscriber's delivery function.
 *
 * Delivery is formatted as a single `<workspace-delivery>` XML envelope that
 * batches all pending entries accumulated since the last inter-round drain.
 *
 * @module agent/workspace/workspace-subscription
 */

import type { WorkspaceEntry, WorkspaceEntryType } from './workspace-store.js';

// ── Types ────────────────────────────────────────────────────────────────────

/** A single active subscription record, held in the WorkspaceStore. */
export interface WorkspaceSubscription {
  /** Unique subscription ID, "sub_<8 hex chars>". */
  id: string;
  /** The subscribing child's agent/session ID. */
  agentId: string;
  /** Case-insensitive substring filter on entry subject. Undefined = match any. */
  subject: string | undefined;
  /** Optional type filter. Undefined = match any type. */
  type: WorkspaceEntryType | undefined;
  /** Watermark: only entries with seq > this are delivered. */
  lastDeliveredSeq: number;
  /** Push one entry to the subscriber's pending delivery queue. */
  deliveryFn: (entry: WorkspaceEntry) => void;
}

// ── Filter / matching ────────────────────────────────────────────────────────

/**
 * Evaluate subscriptions against a newly-published entry and call each
 * matching subscription's deliveryFn.
 *
 * Algorithm (per spec §4, "Filter / matching algorithm"):
 * 1. Iterate all subscriptions.
 * 2. Skip if entry.seq <= sub.lastDeliveredSeq (watermark guard).
 * 3. Skip if sub.type is set and entry.type !== sub.type.
 * 4. Skip if sub.subject is set and entry.subject doesn't include it
 *    (case-insensitive substring).
 * 5. Call deliveryFn; update lastDeliveredSeq.
 *
 * Pure in-memory JS — zero I/O in the hot path.
 */
export function notifySubscribers(
  subscriptions: Map<string, WorkspaceSubscription>,
  entry: WorkspaceEntry,
): void {
  for (const sub of subscriptions.values()) {
    // Watermark guard (protects against replay)
    if (entry.seq <= sub.lastDeliveredSeq) continue;
    // Type filter
    if (sub.type !== undefined && entry.type !== sub.type) continue;
    // Subject substring filter (case-insensitive)
    if (sub.subject !== undefined) {
      const entrySubjectLower = (entry.subject ?? '').toLowerCase();
      if (!entrySubjectLower.includes(sub.subject.toLowerCase())) continue;
    }
    sub.deliveryFn(entry);
    sub.lastDeliveredSeq = entry.seq;
  }
}

// ── XML formatting ────────────────────────────────────────────────────────────

/**
 * Format a batch of WorkspaceEntry objects into a single `<workspace-delivery>`
 * XML envelope.
 *
 * Each entry is rendered as an `<entry>` element with id, type, subject
 * (if present), and confidence attributes. Content is XML-escaped.
 *
 * Returns undefined when entries is empty (callers should short-circuit).
 *
 * The envelope is truncated at WORKSPACE_DELIVERY_MAX_BYTES via the ring
 * buffer cap upstream; no additional byte truncation is applied here.
 */
export function formatWorkspaceDeliveryEnvelope(
  entries: WorkspaceEntry[],
): string | undefined {
  if (entries.length === 0) return undefined;

  const timestamp = new Date().toISOString();
  const count = entries.length;

  const entriesXml = entries
    .map((e) => {
      const subjectAttr =
        e.subject !== null && e.subject !== undefined
          ? ` subject="${escapeAttr(e.subject)}"`
          : '';
      const confidenceAttr = ` confidence="${e.confidence.toFixed(2)}"`;
      return (
        `<entry id="${e.id}" type="${escapeAttr(e.type)}"${subjectAttr}${confidenceAttr}>` +
        escapeXmlBody(e.content) +
        `</entry>`
      );
    })
    .join('\n  ');

  return (
    `<workspace-delivery count="${count}" timestamp="${timestamp}">\n  ` +
    entriesXml +
    `\n</workspace-delivery>`
  );
}

// ── XML helpers ───────────────────────────────────────────────────────────────

/** Escape XML attribute values (double-quotes and ampersands). */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Escape XML body text (`&`, `<`, `>`). */
function escapeXmlBody(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Subscription ID generation ────────────────────────────────────────────────

/**
 * Generate a subscription ID using 8 hex chars from crypto.randomBytes.
 * Returns "sub_<hex8>" — short, URL-safe, and collision-resistant for the
 * number of subscriptions active in any single session.
 */
export function generateSubscriptionId(): string {
  // Use crypto.getRandomValues for browser compat; Node has it via globalThis.
  const arr = new Uint8Array(4);
  crypto.getRandomValues(arr);
  const hex = Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sub_${hex}`;
}
