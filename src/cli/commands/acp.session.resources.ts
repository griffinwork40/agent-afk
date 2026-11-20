/** Reverse-order, best-effort ownership for partially built ACP sessions. */
export class AcpSessionResources {
  private readonly disposers: Array<() => unknown> = [];
  private released: Promise<void> | undefined;

  add(dispose: () => unknown): void {
    this.disposers.push(dispose);
  }

  release(): Promise<void> {
    this.released ??= this.releaseAll();
    return this.released;
  }

  private async releaseAll(): Promise<void> {
    for (const dispose of this.disposers.reverse()) {
      try { await dispose(); } catch { /* Release all owners even if one fails. */ }
    }
  }
}

/** Session shutdown and construction rollback share one drain/disposal receipt. */
export function onceAcpShutdown<T>(shutdown: (reason: string) => Promise<T>): (reason: string) => Promise<T> {
  let pending: Promise<T> | undefined;
  return (reason) => { pending ??= shutdown(reason); return pending; };
}
