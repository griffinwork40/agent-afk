import { expect, expectTypeOf, it } from 'vitest';
import { NOTICE_VERSION, type ChatActionResult, type ChatClient, type ChatClientEvents,
  type ChatConnectionStatus, type ChatIdentity, type ChatPostResult, type ChatWelcome,
  type IdentityResult, type IdentityStore, type MuteStore } from './client-types.js';
import type { Msg } from './protocol.js';

it('starts the opt-in notice contract at version 1', () => expect(NOTICE_VERSION).toBe(1));
it('keeps the client, view, and stores on one platform-neutral contract', () => {
  expectTypeOf<ChatClient['connect']>().toEqualTypeOf<() => Promise<void>>();
  expectTypeOf<ChatClient['post']>().toEqualTypeOf<(text: string) => Promise<ChatPostResult>>();
  expectTypeOf<ChatClient['report']>().toEqualTypeOf<(id: string) => Promise<ChatActionResult>>();
  expectTypeOf<ChatClient['subscribe']>().toEqualTypeOf<(events: Partial<ChatClientEvents>) => () => void>();
  expectTypeOf<ChatWelcome['backlog']>().toEqualTypeOf<Msg[]>();
  expectTypeOf<ChatClientEvents['onMessage']>().toEqualTypeOf<(message: Msg) => void>();
  expectTypeOf<ChatClientEvents['onStatus']>().toEqualTypeOf<(status: ChatConnectionStatus) => void>();
  expectTypeOf<IdentityStore['sign']>().toEqualTypeOf<(canonical: string) => Promise<string>>();
  expectTypeOf<IdentityStore['load']>().toEqualTypeOf<() => Promise<ChatIdentity | null>>();
  expectTypeOf<IdentityStore['rename']>().toEqualTypeOf<(name: string) => Promise<IdentityResult>>();
  expectTypeOf<MuteStore['add']>().toEqualTypeOf<(pubkey: string, name: string) => Promise<void>>();
  expectTypeOf<MuteStore['has']>().toEqualTypeOf<(pubkey: string) => Promise<boolean>>();
});
it('represents local secret refusal spans without exposing key material', () => {
  const result: ChatPostResult = { ok: false, code: 'secret_detected', message: 'Secret detected',
    spans: [{ kind: 'openai', start: 0, end: 30 }] };
  expect(result.ok).toBe(false);
  expectTypeOf<Extract<ChatPostResult, { code: 'secret_detected' }>['spans']>()
    .toEqualTypeOf<import('./secret-detect.js').SecretSpan[]>();
  expectTypeOf<keyof ChatIdentity>().toEqualTypeOf<'pubkey' | 'tag' | 'name'>();
});
