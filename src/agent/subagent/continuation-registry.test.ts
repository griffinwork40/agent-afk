import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { ContinuationRegistry, formatContinuationLine, type ChainDispatchInputs } from './continuation-registry.js';
import { checkContinuationOverrides, checkWorkspaceDrift, captureWorkspaceCheckpoint } from './continuation-guards.js';

const inputs: ChainDispatchInputs = { agent_type: 'general-purpose', model: 'sonnet', writeCapable: true };

function initialChain(reg: ContinuationRegistry, roundCap = 50) {
  const chain = reg.createChain({ owner: 'root', rootSessionId: 'sess', inputs, roundCap });
  reg.recordTerminal(chain.chainId, { childId: 'child-1', journalUsable: true, roundsUsed: 50, checkpoint: undefined, endReason: 'capped' });
  return chain;
}

describe('ContinuationRegistry', () => {
  it('mints unguessable ids and refuses a model-invented id', () => {
    const reg = new ContinuationRegistry();
    const chain = initialChain(reg);
    expect(chain.chainId).toMatch(/^chain_[0-9a-f]{24}$/);
    const r = reg.admitContinuation('chain_made_up', 'root', 10, 50);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unknown continuation chain/);
  });

  it('refuses a non-owner and an in-flight chain', () => {
    const reg = new ContinuationRegistry();
    const chain = initialChain(reg);
    const other = reg.admitContinuation(chain.chainId, 'subagent-x', 10, 50);
    expect(other.ok).toBe(false);
    const first = reg.admitContinuation(chain.chainId, 'root', 10, 50);
    expect(first.ok).toBe(true);
    const concurrent = reg.admitContinuation(chain.chainId, 'root', 10, 50);
    expect(concurrent.ok).toBe(false);
    if (!concurrent.ok) expect(concurrent.reason).toMatch(/in flight/);
  });

  it('charges the initial cap, clips continuations, and refuses at the round limit', () => {
    const reg = new ContinuationRegistry({ maxRounds: 100, maxContinuations: 5 });
    const chain = initialChain(reg, 50);
    const a = reg.admitContinuation(chain.chainId, 'root', 80, 50);
    expect(a.ok && a.allowance).toBe(50);
    reg.recordTerminal(chain.chainId, { childId: 'child-2', journalUsable: true, roundsUsed: 50, checkpoint: undefined, endReason: 'capped' });
    const b = reg.admitContinuation(chain.chainId, 'root', 10, 50);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toMatch(/round limit/);
  });

  it('refuses at the continuation limit', () => {
    const reg = new ContinuationRegistry({ maxRounds: 1000, maxContinuations: 1 });
    const chain = initialChain(reg);
    expect(reg.admitContinuation(chain.chainId, 'root', 10, 50).ok).toBe(true);
    reg.recordTerminal(chain.chainId, { childId: 'c2', journalUsable: true, roundsUsed: 10, checkpoint: undefined, endReason: 'completed' });
    const r = reg.admitContinuation(chain.chainId, 'root', 10, 50);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/continuation limit/);
  });

  it('rollback undoes the charge and in-flight; abort keeps the charge', () => {
    const reg = new ContinuationRegistry();
    const chain = initialChain(reg);
    const before = chain.roundsCharged;
    const a = reg.admitContinuation(chain.chainId, 'root', 20, 50);
    if (!a.ok) throw new Error('expected admission');
    a.rollback();
    expect(chain.roundsCharged).toBe(before);
    expect(chain.inFlight).toBe(false);
    expect(chain.continuations).toBe(0);
    const b = reg.admitContinuation(chain.chainId, 'root', 20, 50);
    if (!b.ok) throw new Error('expected admission');
    reg.recordTerminal(chain.chainId, { childId: 'c3', journalUsable: false, roundsUsed: 3, checkpoint: undefined, endReason: 'aborted' });
    expect(chain.inFlight).toBe(false);
    expect(chain.roundsCharged).toBe(before + 20);
    expect(chain.latestChildId).toBe('child-1');
  });

  it('charges an uncapped initial run at runtime-counted rounds', () => {
    const reg = new ContinuationRegistry();
    const chain = reg.createChain({ owner: 'root', rootSessionId: 's', inputs, roundCap: 0 });
    reg.recordTerminal(chain.chainId, { childId: 'c', journalUsable: true, roundsUsed: 37, checkpoint: undefined, endReason: 'completed' });
    expect(chain.roundsCharged).toBe(37);
    expect(formatContinuationLine(chain)).toContain(`chain_id=${chain.chainId}, rounds 37/150 used, continuations 0/3 used`);
  });
});

describe('continuation guards', () => {
  it('refuses override conflicts, worktree chains, and remote host', () => {
    const reg = new ContinuationRegistry();
    const chain = initialChain(reg);
    expect(checkContinuationOverrides(chain, { agent_type: 'general-purpose' })).toBeUndefined();
    expect(checkContinuationOverrides(chain, { model: 'opus' })).toMatch(/model/);
    expect(checkContinuationOverrides(chain, { host: 'box' })).toMatch(/remote/);
    const iso = reg.createChain({ owner: 'root', rootSessionId: 's', inputs: { ...inputs, isolation: 'worktree' }, roundCap: 10 });
    expect(checkContinuationOverrides(iso, {})).toMatch(/worktree/);
  });

  it('refuses drift for write-capable chains and allows it for read-only ones', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-cont-drift-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      const reg = new ContinuationRegistry();
      const write = initialChain(reg);
      write.checkpoint = await captureWorkspaceCheckpoint(dir);
      expect(write.checkpoint.git).toBe(true);
      expect(await checkWorkspaceDrift(write)).toBeUndefined();
      fs.writeFileSync(path.join(dir, 'new.txt'), 'x');
      expect(await checkWorkspaceDrift(write)).toMatch(/uncommitted changes/);
      const ro = reg.createChain({ owner: 'root', rootSessionId: 's', inputs: { ...inputs, writeCapable: false }, roundCap: 10 });
      ro.checkpoint = write.checkpoint;
      expect(await checkWorkspaceDrift(ro)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caps held chains: evicts the oldest non-in-flight chain, which is then refused as unknown', () => {
    const reg = new ContinuationRegistry({ maxRounds: 150, maxContinuations: 3 }, 3);
    const done = (c: { chainId: string }) => reg.recordTerminal(c.chainId, { childId: 'c', journalUsable: true, roundsUsed: 1, checkpoint: undefined, endReason: 'capped' });
    const a = reg.createChain({ owner: 'root', rootSessionId: 's', inputs, roundCap: 5 }); // stays in flight
    const b = reg.createChain({ owner: 'root', rootSessionId: 's', inputs, roundCap: 5 }); done(b);
    const c = reg.createChain({ owner: 'root', rootSessionId: 's', inputs, roundCap: 5 }); done(c);
    const d = reg.createChain({ owner: 'root', rootSessionId: 's', inputs, roundCap: 5 });
    expect(reg.size).toBe(3);
    expect(reg.get(a.chainId)).toBeDefined(); // in flight: never evicted
    expect(reg.get(b.chainId)).toBeUndefined(); // oldest settled: evicted
    expect(reg.get(c.chainId)).toBeDefined();
    expect(reg.get(d.chainId)).toBeDefined();
    const refused = reg.admitContinuation(b.chainId, 'root', 5, 50);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toMatch(/unknown continuation chain/);
  });
});
