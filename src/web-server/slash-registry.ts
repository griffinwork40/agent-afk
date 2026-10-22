/**
 * Shared slash-registry initialization memo.
 *
 * Both `routes.ts` (command universe) and `slash-dispatch.ts` (skill
 * classification) need `registerAll()` + `registerPluginSkillsForWeb()` to
 * run exactly once per process. Previously each module had its own guard,
 * creating a race where the second caller's `registerAll()` reset the
 * registry mid-flight after the first caller's `registerPluginSkillsForWeb()`.
 *
 * This module is the single source of truth for that initialization. Both
 * callers import `ensureSlashRegistry()` from here.
 *
 * Invariant: `registrationDone` is only set to `true` on success. On failure
 * the in-flight promise is cleared so the next call retries, but
 * `registrationDone` stays `false`. Concurrent calls in the retry window all
 * share the same new promise (idempotent).
 */

let registrationDone = false;
let registrationPromise: Promise<void> | null = null;

/**
 * Test seam: reset both the done flag and the in-flight promise so a test
 * can re-observe registration from scratch.
 */
export function resetSlashRegistry(): void {
  registrationDone = false;
  registrationPromise = null;
}

/**
 * Ensure `registerAll()` and `registerPluginSkillsForWeb()` have both run.
 *
 * Idempotent: fast-path on `registrationDone`. Concurrent callers share a
 * single promise so registration runs exactly once even under load.
 */
export async function ensureSlashRegistry(): Promise<void> {
  if (registrationDone) return;

  registrationPromise ??= (async () => {
    const [{ registerAll }, { registerPluginSkillsForWeb }] = await Promise.all([
      import('../cli/slash/index.js'),
      import('./register-plugin-skills.js'),
    ]);
    registerAll();
    // Invariant: registerAll() resets the process-global registry, wiping any
    // prior plugin registrations. Re-register plugin skills afterwards so
    // lookup() resolves them.
    await registerPluginSkillsForWeb();
    registrationDone = true;
  })().finally(() => {
    // Clear the in-flight promise so a failure allows retry via a fresh
    // promise. registrationDone stays false on failure so the next call
    // retries the full sequence.
    registrationPromise = null;
  });

  await registrationPromise;
}
