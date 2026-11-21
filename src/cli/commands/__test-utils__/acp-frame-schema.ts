import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchemaObject, ValidateFunction } from 'ajv';

export type Frame = Record<string, unknown>;
export interface Row { direction: 'client_to_agent' | 'agent_to_client'; frame: Frame }
export const fixtureRoot = new URL('../../../../tests/fixtures/acp/', import.meta.url);
const ajv = new Ajv2020({ strict: false, allErrors: true });
for (const [name, min, max] of [
  ['uint16', 0, 65535], ['uint32', 0, 4294967295], ['uint64', 0, Number.MAX_SAFE_INTEGER],
  ['int32', -2147483648, 2147483647], ['int64', Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
] as const) ajv.addFormat(name, { type: 'number', validate: (n: number) => Number.isInteger(n) && n >= min && n <= max });
ajv.addFormat('double', { type: 'number', validate: Number.isFinite });
ajv.addFormat('uri', { type: 'string', validate: (s: string) => URL.canParse(s) });
ajv.addSchema(JSON.parse(readFileSync(new URL('schema-v1.json', fixtureRoot), 'utf8')) as AnySchemaObject, 'acp');
const validators = new Map<string, ValidateFunction>();
export function schemaErrors(def: string, value: unknown): string | undefined {
  let validate = validators.get(def);
  if (!validate) {
    validate = ajv.compile({ $ref: def === '$root' ? 'acp' : `acp#/$defs/${def}` });
    validators.set(def, validate);
  }
  return validate(value) ? undefined : `${def}: ${ajv.errorsText(validate.errors)}`;
}

const responses: Record<string, string> = {
  initialize: 'InitializeResponse', 'session/new': 'NewSessionResponse',
  'session/load': 'LoadSessionResponse', 'session/resume': 'ResumeSessionResponse',
  'session/close': 'CloseSessionResponse', 'session/prompt': 'PromptResponse',
};
/** Direction-specific correlation plus exact payload validation, not just permissive root unions. */
export class AgentFrameValidator {
  private pending = new Map<unknown, string>();
  client(frame: Frame): void {
    const method = frame['method'];
    if (typeof method === 'string' && responses[method]) this.pending.set(frame['id'], responses[method]);
  }
  errors(frame: Frame): string[] {
    const failures: Array<string | undefined> = [schemaErrors('$root', frame)];
    const method = frame['method'];
    if (method === 'session/update') {
      failures.push(schemaErrors('AgentNotification', frame), schemaErrors('SessionNotification', frame['params']));
      if ('id' in frame) failures.push('session/update must not have id');
    } else if (method === 'session/request_permission') {
      failures.push(schemaErrors('AgentRequest', frame), schemaErrors('RequestPermissionRequest', frame['params']));
    } else if (method !== undefined) failures.push(`Unadvertised agent method ${String(method)}`);
    else {
      failures.push(schemaErrors('AgentResponse', frame));
      const def = this.pending.get(frame['id']);
      if (!def) failures.push(`Unmatched agent response ${String(frame['id'])}`);
      if ('error' in frame) failures.push(schemaErrors('Error', frame['error']));
      else if (def) failures.push(schemaErrors(def, frame['result']));
      this.pending.delete(frame['id']);
    }
    return failures.filter((value): value is string => value !== undefined);
  }
}
