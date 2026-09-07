/**
 * Constants for workspace subscription delivery.
 *
 * @module agent/workspace/workspace-subscription-constants
 */

/** Ring buffer capacity for pending workspace deliveries on a SubagentHandleImpl. */
export const WORKSPACE_DELIVERY_RING_CAPACITY = 10;

/** Maximum byte size for a single workspace delivery XML envelope (16 KiB). */
export const WORKSPACE_DELIVERY_MAX_BYTES = 16384;
