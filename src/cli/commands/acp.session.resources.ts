/** D17: how long one external owner (MCP disconnect, store close, ...) may take at teardown. */
export const RESOURCE_DISPOSE_DEADLINE_MS = 2_000;

/** Resolve when `work` settles or after `ms`, whichever is first; never rejects, never holds the loop. */
export function withDeadline(work: () => unknown, ms: number): Promise<'done' | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
    Promise.resolve().then(work).then(
      () => { clearTimeout(timer); resolve('done'); },
      () => { clearTimeout(timer); resolve('done'); },
    );
  });
}

/** Reverse-order, best-effort ownership for partially built ACP sessions. */
export class AcpSessionResources {
  private readonly disposers: Array<() => unknown> = [];
  private released: Promise<void> | undefined;

  constructor(private readonly deadlineMs = RESOURCE_DISPOSE_DEADLINE_MS) {}

  add(dispose: () => unknown): void {
    this.disposers.push(dispose);
  }

  release(): Promise<void> {
    this.released ??= this.releaseAll();
    return this.released;
  }

  private async releaseAll(): Promise<void> {
    // D17: a hung owner is abandoned after its deadline so the rest still release.
    // Iterate a reversed copy so the registration order of this.disposers is never
    // mutated: a caller or subclass that inspects the array after release sees it
    // in its original order.
    for (const dispose of [...this.disposers].reverse()) await withDeadline(dispose, this.deadlineMs);
  }
}

/** Session shutdown and construction rollback share one drain/disposal receipt. */
export function onceAcpShutdown<T>(shutdown: (reason: string) => Promise<T>): (reason: string) => Promise<T> {
  let pending: Promise<T> | undefined;
  return (reason) => { pending ??= shutdown(reason); return pending; };
}
