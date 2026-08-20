import { resolveMaxConcurrentBackgroundJobs } from '../config/concurrency.js';

export function resolveBackgroundJobCap(explicit: number | undefined): number {
  return explicit ?? resolveMaxConcurrentBackgroundJobs();
}

/** Raised when a background dispatch exceeds the session's running-job cap. */
export class BackgroundJobCapError extends Error {
  constructor(running: number, cap: number) {
    super(
      `Background job cap reached (${running}/${cap} running). ` +
        'Wait for existing jobs to finish or use cancel_background_job on a model-owned job before spawning more.',
    );
    this.name = 'BackgroundJobCapError';
  }
}
