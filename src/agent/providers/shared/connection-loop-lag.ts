import { monitorEventLoopDelay } from 'node:perf_hooks';

let histogram: ReturnType<typeof monitorEventLoopDelay> | undefined;

/** Process scope, started only by connection diagnostics. Node's histogram timer is unref'd. */
export function connectionLoopLag(): { loopLagP99Ms: number; loopLagMaxMs: number } {
  try {
    if (!histogram) {
      histogram = monitorEventLoopDelay({ resolution: 20 });
      histogram.enable();
    }
    // Keep process-lifetime samples: resetting here lets concurrent retries erase one another's evidence.
    return {
      loopLagP99Ms: histogram.count === 0 ? 0 : histogram.percentile(99) / 1e6,
      loopLagMaxMs: histogram.count === 0 ? 0 : histogram.max / 1e6,
    };
  } catch {
    return { loopLagP99Ms: 0, loopLagMaxMs: 0 };
  }
}
