import { createHash, createPrivateKey, sign as nodeSign, verify as nodeVerify, createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bytesToHex, deriveTag, generateKeyPair, hexToBytes, importPrivateKey, randomMessageId, sign, verify, verifyMsg } from './crypto.js';
import { canonicalPost, type Msg } from './protocol.js';

describe('Web Crypto Ed25519', () => {
  it('round-trips serializable keys and interoperates with Node crypto', async () => {
    const stored = JSON.parse(JSON.stringify(await generateKeyPair()));
    expect(stored.pubkey).toMatch(/^[0-9a-f]{64}$/);
    const privateKey = await importPrivateKey(stored.privateKeyPkcs8);
    const nodeKey = createPrivateKey({ key: Buffer.from(stored.privateKeyPkcs8, 'hex'), format: 'der', type: 'pkcs8' });
    const message: Msg = { id: randomMessageId(), ts: 1234, pubkey: stored.pubkey, name: 'alice', text: 'Hi 🎉', sig: '' };
    const canonical = canonicalPost(message);
    message.sig = await sign(canonical, privateKey);
    expect(message.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(nodeVerify(null, Buffer.from(canonical), createPublicKey(nodeKey), Buffer.from(message.sig, 'hex'))).toBe(true);
    const nodeSignature = nodeSign(null, Buffer.from(canonical), nodeKey).toString('hex');
    expect(nodeSignature).toBe(message.sig);
    expect(await verifyMsg({ ...message, sig: nodeSignature })).toBe(true);
    for (const changed of [
      { text: 'tampered' }, { name: 'bob' }, { ts: 1235 }, { id: randomMessageId() },
      { pubkey: (await generateKeyPair()).pubkey },
    ]) expect(await verifyMsg({ ...message, ...changed })).toBe(false);
    expect(await verifyMsg({ ...message, badge: 'maintainer' })).toBe(true);
    expect(await deriveTag(stored.pubkey)).toBe(createHash('sha256').update(Buffer.from(stored.pubkey, 'hex')).digest('hex').slice(0, 4));
  });
  it('fails closed for malformed signatures and keys', async () => {
    for (const [signature, key] of [['', ''], ['ab'.repeat(64), 'zz'.repeat(32)], ['AA'.repeat(64), 'aa'.repeat(32)],
      ['ab'.repeat(63), 'ab'.repeat(32)], ['ab'.repeat(64), '00'.repeat(32)]]) {
      expect(await verify('test', signature!, key!)).toBe(false);
    }
    expect(await verifyMsg(null as unknown as Msg)).toBe(false);
    expect(await verify('test', undefined as unknown as string, 'ab'.repeat(32))).toBe(false);
    await expect(importPrivateKey('not hex')).rejects.toThrow();
    await expect(importPrivateKey('ab')).rejects.toThrow();
    await expect(deriveTag('ab')).rejects.toThrow();
  });
  it('handles byte and hex boundaries strictly', () => {
    expect(bytesToHex(new Uint8Array([0, 15, 255]))).toBe('000fff');
    expect(hexToBytes('000fff')).toEqual(new Uint8Array([0, 15, 255]));
    expect(hexToBytes('')).toEqual(new Uint8Array());
    for (const bad of ['a', 'AZ', '00\n', '-1', ' 00']) expect(() => hexToBytes(bad)).toThrow();
    const ids = new Set(Array.from({ length: 100 }, () => randomMessageId()));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});
