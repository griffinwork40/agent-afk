import { recoverExpiredLeases } from './queue-store.js';
import { errorMessage } from '../../utils/errors.js';

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
    const msg = errorMessage(err);
    // eslint-disable-next-line no-console
    console.error(`[daemon] lease-recovery: failed to recover expired leases: ${msg}`);
  }

  // Pending-handoff recovery (re-notify + expire) is NOT done here: it runs
  // for every trigger mode from handoff-maintenance.ts (#1416).
}
