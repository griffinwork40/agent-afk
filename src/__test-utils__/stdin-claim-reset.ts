// Global test setup: the stdin-claim guard (src/cli/input/stdin-claim.ts) is a
// process-wide singleton. Vitest isolates module state per test FILE, but within
// a file multiple tests may arm a TerminalCompositor / reader that acquires the
// claim. Reset it before every test so an un-disarmed claim in one test cannot
// leak into the next (e.g. autocomplete-state.test.ts arms without disarm).
import { beforeEach } from 'vitest';
import { __resetStdinClaimForTests } from '../cli/input/stdin-claim.js';

beforeEach(() => {
  __resetStdinClaimForTests();
});
