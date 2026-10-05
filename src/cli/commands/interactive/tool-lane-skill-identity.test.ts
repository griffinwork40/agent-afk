import { describe, expect, it } from 'vitest';
import { ToolLane } from './tool-lane.js';
import { stripAnsi } from '../../display.js';

describe('resolved skill entry identity', () => {
  it('keeps concurrent same-name calls and nested parent attribution separate', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('a', 'skill', '(review)', 'parent');
    lane.addStartWithAgentContext('b', 'skill', '(review)', undefined);
    lane.setSkillIdentity('a', { name: 'review', purpose: 'First purpose', arguments: '--token=short' });
    lane.setSkillIdentity('b', { name: 'review', purpose: 'Second purpose', arguments: 'safe' });
    const entries = (lane as unknown as { entries: Map<string, { toolInput: string; agentContext?: string }> }).entries;
    expect(entries.get('a')?.agentContext).toBe('parent');
    expect(entries.get('a')?.toolInput).toContain('First purpose');
    expect(entries.get('a')?.toolInput).not.toContain('short');
    expect(entries.get('b')?.toolInput).toContain('Second purpose');
    expect(stripAnsi(lane.getOverlay())).toContain('Second purpose');
  });
  it('never updates an unrelated non-skill tool', () => {
    const lane = new ToolLane();
    lane.addStart('a', 'bash', '(echo safe)');
    const before = lane.getOverlay();
    lane.setSkillIdentity('a', { name: 'review' });
    expect(lane.getOverlay()).toBe(before);
  });
});
