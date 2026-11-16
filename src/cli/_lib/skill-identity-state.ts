import { sanitizeSkillIdentity, type SkillIdentity } from './skill-identity-format.js';
import { wrapToWidth } from '../wrap.js';
import type { CommitCoordinator } from './commit-coordinator.js';
import type { TerminalCompositor } from '../terminal-compositor.js';
import type { Writer } from '../slash/types.js';
import { getTerminalWidth } from '../terminal-size.js';
import { palette } from '../palette.js';

/** Invocation-local bookkeeping, independent of line-writer deduplication. */
export class SkillIdentityState {
  current: SkillIdentity | undefined;
  private introduced = false;
  constructor(identity?: SkillIdentity) { this.current = identity ? sanitizeSkillIdentity(identity) : undefined; }
  async introduce(coordinator: CommitCoordinator, compositor: TerminalCompositor | null, out: Writer): Promise<void> {
    if (!this.current || this.introduced) return;
    this.introduced = true;
    // Scrollback is durable: wrap the sanitized field budgets rather than
    // applying the transient banner's single-line truncation.
    const { name, purpose } = this.current;
    // Call palette members at render time — never capture at module load
    // (palette identity is stable but its chalk members are rewritten on theme
    // swap, so capturing here rather than in a module-level const is required).
    const styled = purpose
      ? palette.brand(`/${name}`) + palette.dim(` · ${purpose}`)
      : palette.brand(`/${name}`);
    const text = wrapToWidth(styled, getTerminalWidth(), { breakLongWords: true });
    coordinator.schedule({ anchor: 'before-content', commits: [() => {
      if (compositor) compositor.commitAbove(text);
      else out.line(text);
    }] });
    // arm precedes all stream writers, so this drain cannot overtake content.
    await coordinator.flushAll();
  }
  clear(): void { this.current = undefined; this.introduced = false; }
}
