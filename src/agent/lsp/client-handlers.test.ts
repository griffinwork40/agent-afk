import { describe, it, expect } from 'vitest';
import { answerServerRequest } from './client-handlers.js';
import { TYPESCRIPT_SERVER_DEFINITION } from './typescript-default.js';

const def = { ...TYPESCRIPT_SERVER_DEFINITION, settings: { typescript: { a: 1 } } };

describe('answerServerRequest', () => {
  it('answers workspace/configuration per item from settings, null otherwise', () => {
    const res = answerServerRequest(def, 'workspace/configuration', {
      items: [{ section: 'typescript' }, { section: 'nope' }, {}],
    });
    expect(res).toEqual([{ a: 1 }, null, null]);
  });

  it('refuses workspace/applyEdit', () => {
    expect(answerServerRequest(def, 'workspace/applyEdit', {})).toEqual({ applied: false });
  });

  it.each(['window/workDoneProgress/create', 'client/registerCapability', 'client/unregisterCapability', 'x/unknown'])(
    'answers %s with null', (method) => {
      expect(answerServerRequest(def, method, {})).toBeNull();
    },
  );
});
