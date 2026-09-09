import { describe, it, expect } from 'vitest';
import type { ServerResponse } from 'node:http';
import { handleListModels } from './routes.models.js';

// ---- helpers ---------------------------------------------------------------

function makeRes(): { res: ServerResponse; json: () => { status: number; body: unknown } } {
  let status = 0;
  const chunks: string[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
    },
    end(payload: string) {
      chunks.push(payload);
    },
  } as unknown as ServerResponse;
  return {
    res,
    json: () => ({ status, body: JSON.parse(chunks.join('')) as unknown }),
  };
}

// ---- tests -----------------------------------------------------------------

describe('routes.models', () => {
  describe('handleListModels', () => {
    it('returns 200', () => {
      const { res, json } = makeRes();
      handleListModels(res);
      expect(json().status).toBe(200);
    });

    it('returns a models array', () => {
      const { res, json } = makeRes();
      handleListModels(res);
      const body = json().body as { models: unknown[] };
      expect(body).toHaveProperty('models');
      expect(Array.isArray(body.models)).toBe(true);
    });

    it('includes the expected tier ids (sonnet, haiku, opus)', () => {
      const { res, json } = makeRes();
      handleListModels(res);
      const { models } = json().body as { models: Array<{ id: string; label: string }> };
      const ids = models.map((m) => m.id);
      expect(ids).toContain('sonnet');
      expect(ids).toContain('haiku');
      expect(ids).toContain('opus');
    });

    it('every entry has an id (string) and a label (string)', () => {
      const { res, json } = makeRes();
      handleListModels(res);
      const { models } = json().body as { models: Array<{ id: string; label: string }> };
      for (const m of models) {
        expect(typeof m.id).toBe('string');
        expect(m.id.length).toBeGreaterThan(0);
        expect(typeof m.label).toBe('string');
        expect(m.label.length).toBeGreaterThan(0);
      }
    });

    it('returns the same list on repeated calls (static, no side effects)', () => {
      const { res: res1, json: json1 } = makeRes();
      const { res: res2, json: json2 } = makeRes();
      handleListModels(res1);
      handleListModels(res2);
      expect(json1().body).toEqual(json2().body);
    });
  });
});
