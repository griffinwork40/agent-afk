import { canonicalPost, type Msg } from './protocol.js';

export type SigningKey = Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>>;
export interface StoredKeyPair { pubkey: string; privateKeyPkcs8: string }

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
/** Accepts lowercase, even-length hex only; throws for invalid caller-owned data. */
export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/.test(hex)) throw new Error('Invalid hex');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
export async function generateKeyPair(): Promise<StoredKeyPair> {
  const pair = await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return {
    pubkey: bytesToHex(new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey))),
    privateKeyPkcs8: bytesToHex(new Uint8Array(await globalThis.crypto.subtle.exportKey('pkcs8', pair.privateKey))),
  };
}
export async function importPrivateKey(privateKeyPkcs8: string): Promise<SigningKey> {
  return globalThis.crypto.subtle.importKey('pkcs8', hexToBytes(privateKeyPkcs8), { name: 'Ed25519' }, false, ['sign']);
}
export async function sign(canonical: string, privateKey: SigningKey): Promise<string> {
  const bytes = new TextEncoder().encode(canonical);
  return bytesToHex(new Uint8Array(await globalThis.crypto.subtle.sign('Ed25519', privateKey, bytes)));
}
/** Malformed public keys and signatures fail closed, including import/verify errors. */
export async function verify(canonical: string, sig: string, pubkey: string): Promise<boolean> {
  try {
    if (pubkey.length !== 64 || sig.length !== 128 || !/^[0-9a-f]{64}$/.test(pubkey) || !/^[0-9a-f]{128}$/.test(sig)) return false;
    const key = await globalThis.crypto.subtle.importKey('raw', hexToBytes(pubkey), 'Ed25519', false, ['verify']);
    return await globalThis.crypto.subtle.verify('Ed25519', key, hexToBytes(sig), new TextEncoder().encode(canonical));
  } catch {
    return false;
  }
}
export async function deriveTag(pubkey: string): Promise<string> {
  if (pubkey.length !== 64 || !/^[0-9a-f]{64}$/.test(pubkey)) throw new Error('Invalid public key');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', hexToBytes(pubkey));
  return bytesToHex(new Uint8Array(digest)).slice(0, 4);
}
export function randomMessageId(): string {
  return bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}
/** Checks signed content only; badge is relay metadata and is deliberately unsigned. */
export async function verifyMsg(message: Msg): Promise<boolean> {
  try {
    return await verify(canonicalPost(message), message.sig, message.pubkey);
  } catch {
    return false;
  }
}
