import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchemaObject } from 'ajv';
import { expect } from 'vitest';
import type { SessionUpdate } from '../acp.wire.js';

const schema = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/acp/schema-v1.json', import.meta.url), 'utf8')) as AnySchemaObject;
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
const validate = ajv.compile({ $ref: 'acp#/$defs/SessionUpdate' });

export function checked(updates: SessionUpdate[]): SessionUpdate[] {
  for (const update of updates) expect(validate(update), ajv.errorsText(validate.errors)).toBe(true);
  return updates;
}
