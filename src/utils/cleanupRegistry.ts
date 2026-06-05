const cleanupFunctions = new Set<() => Promise<void>>();

export function registerCleanup(cleanupFn: () => Promise<void>): () => void {
  cleanupFunctions.add(cleanupFn);
  return () => {
    cleanupFunctions.delete(cleanupFn);
  };
}

export async function runCleanupFunctions(): Promise<void> {
  await Promise.all([...cleanupFunctions].map((fn) => fn()));
  cleanupFunctions.clear();
}
