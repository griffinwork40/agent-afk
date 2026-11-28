import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchemaObject, ValidateFunction } from 'ajv';

const fixtureRoot = new URL('../../../tests/fixtures/acp/', import.meta.url);
const schema = JSON.parse(readFileSync(new URL('schema-v1.json', fixtureRoot), 'utf8')) as AnySchemaObject;
const ajv = new Ajv2020({ strict: false, allErrors: true });
for (const [name, min, max] of [
  ['uint16', 0, 65535], ['uint32', 0, 4294967295],
  ['uint64', 0, Number.MAX_SAFE_INTEGER], ['int32', -2147483648, 2147483647],
  ['int64', Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
] as const) {
  ajv.addFormat(name, { type: 'number', validate: (n: number) => Number.isInteger(n) && n >= min && n <= max });
}
ajv.addFormat('double', { type: 'number', validate: Number.isFinite });
ajv.addFormat('uri', { type: 'string', validate: (s: string) => URL.canParse(s) });
ajv.addSchema(schema, 'acp');
const validateRoot = ajv.getSchema('acp')!;
const validators = new Map<string, ValidateFunction>();
function validateDef(name: string, value: unknown): void {
  let validate = validators.get(name);
  if (!validate) {
    validate = ajv.compile({ $ref: `acp#/$defs/${name}` });
    validators.set(name, validate);
  }
  expect(validate(value), `${name}: ${ajv.errorsText(validate.errors)}`).toBe(true);
}

const methods: Record<string, readonly [string, string | null, string]> = {
  initialize: ['InitializeRequest', 'InitializeResponse', 'client_to_agent'],
  'session/new': ['NewSessionRequest', 'NewSessionResponse', 'client_to_agent'],
  'session/prompt': ['PromptRequest', 'PromptResponse', 'client_to_agent'],
  'session/load': ['LoadSessionRequest', 'LoadSessionResponse', 'client_to_agent'],
  'session/resume': ['ResumeSessionRequest', 'ResumeSessionResponse', 'client_to_agent'],
  'session/close': ['CloseSessionRequest', 'CloseSessionResponse', 'client_to_agent'],
  'session/cancel': ['CancelNotification', null, 'client_to_agent'],
  'session/update': ['SessionNotification', null, 'agent_to_client'],
};
interface Row { direction: 'client_to_agent' | 'agent_to_client'; frame: Record<string, unknown> }

// Contract: upstream envelopes accept arbitrary method strings and broad parameter unions.
// Validate the exact method-specific definition as well, so a permissive union or
// the ProtocolLevel branch cannot accidentally accept a malformed fixture frame.
function validateTranscript(rows: Row[]): void {
  const pending = new Map<string, { response: string; direction: string }>();
  for (const { direction, frame } of rows) {
    expect(['client_to_agent', 'agent_to_client']).toContain(direction);
    expect(frame['jsonrpc']).toBe('2.0');
    expect(validateRoot(frame), ajv.errorsText(validateRoot.errors)).toBe(true);
    const side = direction === 'client_to_agent' ? 'Client' : 'Agent';
    const method = frame['method'];
    const id = frame['id'];
    if (typeof method === 'string') {
      expect(frame).not.toHaveProperty('result');
      expect(frame).not.toHaveProperty('error');
      const entry = methods[method];
      expect(entry, `unknown method ${method}`).toBeDefined();
      if (!entry) throw new Error(`unknown method ${method}`);
      const [paramsDef, responseDef, expectedDirection] = entry;
      expect(direction).toBe(expectedDirection);
      validateDef(`${side}${responseDef ? 'Request' : 'Notification'}`, frame);
      validateDef(paramsDef, frame['params']);
      if (responseDef) {
        expect(typeof id === 'string' || typeof id === 'number').toBe(true);
        const key = `${direction}:${JSON.stringify(id)}`;
        expect(pending.has(key)).toBe(false);
        pending.set(key, { response: responseDef, direction });
      } else {
        expect(frame).not.toHaveProperty('id');
      }
    } else {
      validateDef(`${side}Response`, frame);
      const opposite = direction === 'client_to_agent' ? 'agent_to_client' : 'client_to_agent';
      const key = `${opposite}:${JSON.stringify(id)}`;
      const request = pending.get(key);
      expect(request, `unmatched response ${key}`).toBeDefined();
      if (!request) throw new Error(`unmatched response ${key}`);
      expect(Object.hasOwn(frame, 'result')).not.toBe(Object.hasOwn(frame, 'error'));
      if (Object.hasOwn(frame, 'error')) validateDef('Error', frame['error']);
      else validateDef(request.response, frame['result']);
      pending.delete(key);
    }
  }
  expect([...pending.keys()], 'all requests must receive a response').toEqual([]);
}

const transcriptDir = new URL('transcripts/', fixtureRoot);
const files = readdirSync(transcriptDir).filter(name => name.endsWith('.ndjson')).sort();
describe('frozen ACP v1 transcripts', () => {
  it('contains every required golden transcript', () => {
    for (const stem of [
      'text-turn', 'tool-read', 'tool-edit-diff', 'tool-bash-failed',
      'cancel-during-stream', 'load-replay', 'resume',
      'close-idempotent', 'bad-version-negotiation',
    ]) expect(files).toContain(`${stem}.ndjson`);
  });
  for (const file of files) {
    it(`validates both directions and method payloads: ${file}`, () => {
      const path = new URL(file, transcriptDir);
      const lines = readFileSync(path, 'utf8').trim().split('\n');
      expect(lines.length, fileURLToPath(path)).toBeGreaterThan(0);
      validateTranscript(lines.map(line => JSON.parse(line) as Row));
    });
  }
  it('rejects invalid method-specific payloads despite permissive upstream envelopes', () => {
    expect(() => validateTranscript([
      { direction: 'client_to_agent', frame: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1' } } },
    ])).toThrow();
    expect(() => validateTranscript([
      { direction: 'client_to_agent', frame: { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { sessionId: 's', prompt: [] } } },
      { direction: 'agent_to_client', frame: { jsonrpc: '2.0', id: 1, result: { stopReason: 'bogus' } } },
    ])).toThrow();
  });
});
