import { recoverPendingHandoffs } from './handoff-wiring.js';
import { recoverExpiredLeases } from './queue-store.js';

export function recoverDaemonQueues(queueDir: string): void {
  // On startup, recover any leases that expired while the daemon was down.
  // Tasks with remaining attempts are re-enqueued; exhausted tasks are dead-lettered.
  try {
    const recovered = recoverExpiredLeases(queueDir);
    for (const record of recovered) {
      if (record.state === 'retrying') {
        // eslint-disable-next-line no-console
        console.error(`[daemon] lease-recovery: re-enqueued expired lease task ${record.id} (attempt ${record.attempts}/${record.maxAttempts})`);
      } else {
        // eslint-disable-next-line no-console
        console.error(`[daemon] lease-recovery: dead-lettered task ${record.id} (exhausted ${record.maxAttempts} attempt(s))`);
      }
    }
  } catch (err) {
    // Recovery is best-effort — a failure must not prevent the pull loop from starting.
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[daemon] lease-recovery: failed to recover expired leases: ${msg}`);
  }

  // Recover pending handoffs independently — must not be skipped if lease recovery throws.
  void recoverPendingHandoffs(undefined, queueDir)
    .then((r) => {
      if (r.renotified > 0 || r.expired > 0) {
        // eslint-disable-next-line no-console
        console.error(`[daemon] handoff-recovery: re-notified ${r.renotified}, expired ${r.expired}`);
      }
    })
    .catch((err: unknown) => {
      const hMsg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[daemon] handoff-recovery: recovery failed: ${hMsg}`);
    });
}
