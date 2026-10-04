import { sanitizeSkillIdentity, type SkillIdentity } from './skill-identity-format.js';
import { wrapToWidth } from '../wrap.js';
import type { CommitCoordinator } from './commit-coordinator.js';
import type { TerminalCompositor } from '../terminal-compositor.js';
import type { Writer } from '../slash/types.js';
import { getTerminalWidth } from '../terminal-size.js';

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
    const { name, purpose, arguments: args } = this.current;
    const text = wrapToWidth(
      [`/${name}`, purpose, args ? `args: ${args}` : undefined].filter(Boolean).join('\n'),
      getTerminalWidth(),
      { breakLongWords: true },
    );
    coordinator.schedule({ anchor: 'before-content', commits: [() => {
      if (compositor) compositor.commitAbove(text);
      else out.line(text);
    }] });
    // arm precedes all stream writers, so this drain cannot overtake content.
    await coordinator.flushAll();
  }
  clear(): void { this.current = undefined; this.introduced = false; }
}
