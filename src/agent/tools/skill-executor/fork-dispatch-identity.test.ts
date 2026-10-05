import { describe, expect, it, vi } from 'vitest';
import { withSkillIdentity } from './fork-identity.js';

describe('fork identity bridge', () => {
  it('attributes same-name concurrent calls by real parent ID, never grandchildren', () => {
    const sink = vi.fn();
    const first = withSkillIdentity(sink, 'call-a', { name: 'review', arguments: 'one' });
    const second = withSkillIdentity(sink, 'call-b', { name: 'review', arguments: 'two' });
    first?.({ type: 'done' }, { subagentId: 'child-a', parentId: 'call-a' });
    second?.({ type: 'done' }, { subagentId: 'child-b', parentId: 'call-b' });
    first?.({ type: 'done' }, { subagentId: 'grandchild', parentId: 'nested-call' });
    expect(sink.mock.calls[0]![1].skillIdentity.arguments).toBe('one');
    expect(sink.mock.calls[1]![1].skillIdentity.arguments).toBe('two');
    expect(sink.mock.calls[2]![1].skillIdentity).toBeUndefined();
  });
  it('does not fabricate a sink on unsupported surfaces', () => {
    expect(withSkillIdentity(undefined, 'call', { name: 'review' })).toBeUndefined();
  });
});
