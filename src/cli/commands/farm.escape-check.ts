/**
 * FarmIsolationViolation error class for the `afk farm` escape-check step.
 *
 * Extracted from farm.ts to stay under the 350-code-line ceiling (#832).
 * Exports: `FarmIsolationViolation`.
 */

// ---------------------------------------------------------------------------
// FarmIsolationViolation
// ---------------------------------------------------------------------------

export class FarmIsolationViolation extends Error {
  public readonly dirtyFiles: string[];
  constructor(dirtyFiles: string[]) {
    super(
      `Source repository has uncommitted changes after farm run. ` +
        `Dirty files:\n${dirtyFiles.map((f) => `  ${f}`).join('\n')}`,
    );
    this.name = 'FarmIsolationViolation';
    this.dirtyFiles = dirtyFiles;
  }
}
