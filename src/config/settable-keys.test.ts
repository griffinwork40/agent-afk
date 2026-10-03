import { describe, it, expect } from 'vitest';
import {
  classifyEnvKey,
  coerceEnvValue,
  classifyConfigKey,
  getConfigKeySpec,
  coerceConfigValue,
  getAtPath,
  setAtPath,
  unsetAtPath,
} from './settable-keys.js';
import { getEnvVarMeta } from './env.js';

describe('classifyEnvKey', () => {
  it('marks non-secret afk knobs settable', () => {
    expect(classifyEnvKey('AFK_MODEL')).toBe('settable');
    expect(classifyEnvKey('AFK_EFFORT')).toBe('settable');
    expect(classifyEnvKey('AFK_TEMPERATURE')).toBe('settable');
  });
  it('marks non-secret control vars protected (agent refused, human-gated)', () => {
    for (const k of [
      'AFK_SYSTEM_PROMPT',
      'AFK_MODEL_LARGE_BASE_URL',
      'AFK_MODEL_SMALL_BASE_URL',
      'AFK_OPENAI_BASE_URL',
      'AFK_LOCAL_BASE_URL',
      'AFK_DAEMON_TASK',
      'AFK_DAEMON_TASK_ID',
      'AFK_DAEMON_CWD',
      'AFK_DAEMON_HOST',
      'AFK_BROWSER_ALLOWED_DOMAINS',
      'AFK_BROWSER_BLOCKED_DOMAINS',
      'AFK_BROWSER_CONFIG',
      'AFK_ALLOW_PROJECT_MCP',
      'AFK_INTERNAL',
      'AFK_WORKTREE_BASE',
      'AFK_WORKTREE_BRANCH_PREFIX',
      'AFK_TELEGRAM_ALLOWED_CHAT_IDS',
      'AFK_TELEGRAM_TAG_ONLY_CHAT_IDS',
      'AFK_TELEGRAM_NOTIFY_MODE',
      'AFK_TELEGRAM_PRIMARY_CHAT_ID',
      'AFK_HOME',
      'AFK_STATE_DIR',
      'AFK_FRAMEWORK_DIR',
      'TELEGRAM_DATA_DIR',
      'AFK_TELEGRAM_CWD',
    ]) {
      expect(classifyEnvKey(k)).toBe('protected');
    }
  });
  it('marks credential vars as secret', () => {
    expect(classifyEnvKey('ANTHROPIC_API_KEY')).toBe('secret');
    expect(classifyEnvKey('TELEGRAM_BOT_TOKEN')).toBe('secret');
    expect(classifyEnvKey('EXA_API_KEY')).toBe('secret');
  });
  it('marks inherited/process vars as non-config', () => {
    expect(classifyEnvKey('PATH')).toBe('non-config');
    expect(classifyEnvKey('HOME')).toBe('non-config');
    expect(classifyEnvKey('NODE_ENV')).toBe('non-config');
  });
  it('marks unknown names as unknown', () => {
    expect(classifyEnvKey('TOTALLY_MADE_UP')).toBe('unknown');
  });
});

describe('coerceEnvValue', () => {
  const numberMeta = getEnvVarMeta('AFK_MAX_TOKENS')!;
  const boolMeta = getEnvVarMeta('AFK_DISABLE_PROMPT_CACHE')!;
  const strMeta = getEnvVarMeta('AFK_MODEL')!;

  it('accepts/rejects numbers', () => {
    expect(coerceEnvValue(numberMeta, '8192')).toEqual({ ok: true, value: '8192' });
    expect(coerceEnvValue(numberMeta, 'abc').ok).toBe(false);
  });
  it('normalises booleans and rejects junk', () => {
    expect(coerceEnvValue(boolMeta, 'TRUE')).toEqual({ ok: true, value: 'true' });
    expect(coerceEnvValue(boolMeta, '1')).toEqual({ ok: true, value: '1' });
    expect(coerceEnvValue(boolMeta, 'maybe').ok).toBe(false);
  });
  it('accepts any string for string vars but rejects newlines', () => {
    expect(coerceEnvValue(strMeta, 'sonnet')).toEqual({ ok: true, value: 'sonnet' });
    expect(coerceEnvValue(strMeta, 'a\nb').ok).toBe(false);
  });
});

describe('classifyConfigKey / specs', () => {
  it('classifies agent vs human vs unknown', () => {
    expect(classifyConfigKey('model')).toBe('agent');
    expect(classifyConfigKey('temperature')).toBe('agent');
    expect(classifyConfigKey('telegram.notify.mode')).toBe('human'); // notification-redirect vector
    expect(classifyConfigKey('telegram.notify.targets')).toBe('human');
    expect(classifyConfigKey('telegram.tagOnlyChats')).toBe('human'); // who-can-drive-the-bot / message-routing control
    expect(classifyConfigKey('telegram.verifyDone')).toBe('human'); // self-honesty gate — agent must not disable its own verification
    expect(classifyConfigKey('enforceDoneEvidence')).toBe('human'); // self-honesty gate — agent must not disable its own enforcement
    expect(classifyConfigKey('daemon.verifyDone')).toBe('human'); // daemon self-honesty gate — agent must not disable its own push verification
    expect(classifyConfigKey('updatePolicy')).toBe('human'); // auto self-update is scope-widening
    expect(classifyConfigKey('systemPrompt')).toBe('human');
    expect(classifyConfigKey('enableShellHooks')).toBe('human'); // trust gate — agent must not flip it
    expect(classifyConfigKey('hooks')).toBe('unknown'); // hooks intentionally not listed (no safe per-key validator)
    expect(classifyConfigKey('permissionMode')).toBe('human'); // self-escalation vector — agent must not set bypass on itself
    expect(classifyConfigKey('pluginHookEnv')).toBe('human'); // per-plugin env allowlist — agent must not expand its own hook env access
    expect(classifyConfigKey('interactive.worktreeBranchPrefix')).toBe('human');
    expect(classifyConfigKey('nonsense.key')).toBe('unknown');
  });
});

describe('coerceConfigValue', () => {
  it('booleans accept typed and string forms', () => {
    const spec = getConfigKeySpec('bgSummaries')!;
    expect(coerceConfigValue(spec, true)).toEqual({ ok: true, value: true });
    expect(coerceConfigValue(spec, 'off')).toEqual({ ok: true, value: false });
    expect(coerceConfigValue(spec, 'banana').ok).toBe(false);
  });
  it('daemon.verifyDone is a human-tier boolean (true/false/non-boolean)', () => {
    const spec = getConfigKeySpec('daemon.verifyDone')!;
    expect(spec.tier).toBe('human');
    expect(spec.type).toBe('boolean');
    expect(coerceConfigValue(spec, true)).toEqual({ ok: true, value: true });
    expect(coerceConfigValue(spec, false)).toEqual({ ok: true, value: false });
    expect(coerceConfigValue(spec, 'on')).toEqual({ ok: true, value: true });
    expect(coerceConfigValue(spec, 'off')).toEqual({ ok: true, value: false });
    expect(coerceConfigValue(spec, 'banana').ok).toBe(false);
  });
  it('numbers clamp and enforce integer', () => {
    const spec = getConfigKeySpec('maxSummaryCallsPerSession')!;
    expect(coerceConfigValue(spec, 9999)).toEqual({ ok: true, value: 500 });
    expect(coerceConfigValue(spec, 0)).toEqual({ ok: true, value: 1 });
    expect(coerceConfigValue(spec, 2.5).ok).toBe(false);
  });
  it('temperature allows fractional within range', () => {
    const spec = getConfigKeySpec('temperature')!;
    expect(coerceConfigValue(spec, 0.7)).toEqual({ ok: true, value: 0.7 });
    expect(coerceConfigValue(spec, '1.5')).toEqual({ ok: true, value: 1.5 });
    expect(coerceConfigValue(spec, 9)).toEqual({ ok: true, value: 2 }); // clamped
  });
  it('enums validate membership', () => {
    const spec = getConfigKeySpec('updatePolicy')!;
    expect(coerceConfigValue(spec, 'auto')).toEqual({ ok: true, value: 'auto' });
    expect(coerceConfigValue(spec, 'sometimes').ok).toBe(false);
  });
  it('permissionMode enum accepts the four modes and rejects others', () => {
    const spec = getConfigKeySpec('permissionMode')!;
    expect(spec.tier).toBe('human');
    expect(coerceConfigValue(spec, 'bypassPermissions')).toEqual({ ok: true, value: 'bypassPermissions' });
    expect(coerceConfigValue(spec, 'default')).toEqual({ ok: true, value: 'default' });
    expect(coerceConfigValue(spec, 'plan')).toEqual({ ok: true, value: 'plan' });
    expect(coerceConfigValue(spec, 'autonomous')).toEqual({ ok: true, value: 'autonomous' });
    expect(coerceConfigValue(spec, 'yolo').ok).toBe(false);
  });
  it('number arrays accept arrays and csv strings', () => {
    const spec = getConfigKeySpec('telegram.notify.targets')!;
    expect(coerceConfigValue(spec, [1, 2, 3])).toEqual({ ok: true, value: [1, 2, 3] });
    expect(coerceConfigValue(spec, '10, 20')).toEqual({ ok: true, value: [10, 20] });
    expect(coerceConfigValue(spec, ['a']).ok).toBe(false);
  });
  it('strings reject empty', () => {
    const spec = getConfigKeySpec('model')!;
    expect(coerceConfigValue(spec, 'opus')).toEqual({ ok: true, value: 'opus' });
    expect(coerceConfigValue(spec, '   ').ok).toBe(false);
  });

  describe('model-slot', () => {
    const spec = { path: 'models.large', tier: 'agent' as const, type: 'model-slot' as const, description: '' };

    it('accepts a bare id string', () => {
      expect(coerceConfigValue(spec, 'glm-5.2')).toEqual({ ok: true, value: 'glm-5.2' });
    });
    it('registered models.* specs are model-slot typed', () => {
      for (const path of ['models.local', 'models.small', 'models.medium', 'models.large']) {
        expect(getConfigKeySpec(path)!.type).toBe('model-slot');
      }
    });
    it('accepts a minimal object with just an id', () => {
      expect(coerceConfigValue(spec, { id: 'glm-5.2' })).toEqual({ ok: true, value: { id: 'glm-5.2' } });
    });
    it('accepts an object with id + provider and normalizes provider', () => {
      expect(coerceConfigValue(spec, { id: 'glm-5.2', provider: 'openai' })).toEqual({
        ok: true,
        value: { id: 'glm-5.2', provider: 'openai' },
      });
    });
    it('accepts an object with id + provider + name', () => {
      expect(coerceConfigValue(spec, { id: 'glm-5.2', provider: 'openai', name: 'fast' })).toEqual({
        ok: true,
        value: { id: 'glm-5.2', provider: 'openai', name: 'fast' },
      });
    });
    it('rejects an object carrying baseUrl (endpoint-redirect credential vector)', () => {
      const res = coerceConfigValue(spec, { id: 'glm-5.2', provider: 'openai', baseUrl: 'https://x/v1' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/AFK_MODEL_.*BASE_URL/);
    });
    it('rejects an unrecognized provider', () => {
      const res = coerceConfigValue(spec, { id: 'glm-5.2', provider: 'opencode-go' });
      expect(res.ok).toBe(false);
    });
    it('rejects a missing id', () => {
      expect(coerceConfigValue(spec, { provider: 'openai' }).ok).toBe(false);
      expect(coerceConfigValue(spec, {}).ok).toBe(false);
    });
    it('rejects an object carrying apiKey', () => {
      expect(coerceConfigValue(spec, { id: 'glm-5.2', apiKey: 'sk-secret' }).ok).toBe(false);
    });
    it('rejects snake_case base_url', () => {
      expect(coerceConfigValue(spec, { id: 'glm-5.2', base_url: 'https://x/v1' }).ok).toBe(false);
    });
    it('rejects a number', () => {
      expect(coerceConfigValue(spec, 42).ok).toBe(false);
    });
    it('rejects an array', () => {
      expect(coerceConfigValue(spec, ['glm-5.2']).ok).toBe(false);
    });

    // JSON-string model-slot fix: write-path handling
    it('accepts a JSON-encoded object string and stores it as an object (minimal)', () => {
      const res = coerceConfigValue(spec, '{"id":"gpt-oss-120b"}');
      expect(res).toEqual({ ok: true, value: { id: 'gpt-oss-120b' } });
    });
    it('accepts a JSON-encoded object string with name + provider', () => {
      const res = coerceConfigValue(spec, '{"id":"gpt-oss-120b","name":"Cerebras GPT-OSS 120B","provider":"openai-compatible"}');
      expect(res).toEqual({ ok: true, value: { id: 'gpt-oss-120b', name: 'Cerebras GPT-OSS 120B', provider: 'openai' } });
    });
    it('accepts the exact broken config shape from the observed bug', () => {
      // The real config had: "small": "{\"id\":\"gpt-oss-120b\",\"name\":\"Cerebras GPT-OSS 120B\"}"
      const jsonString = '{"id":"gpt-oss-120b","name":"Cerebras GPT-OSS 120B"}';
      const res = coerceConfigValue(spec, jsonString);
      expect(res).toEqual({ ok: true, value: { id: 'gpt-oss-120b', name: 'Cerebras GPT-OSS 120B' } });
    });
    it('rejects a JSON-encoded object string carrying baseUrl (human gate preserved)', () => {
      const res = coerceConfigValue(spec, '{"id":"gpt-oss-120b","baseUrl":"https://attacker.example/v1"}');
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/AFK_MODEL_.*BASE_URL/);
    });
    it('rejects a JSON-encoded object string carrying apiKey (human gate preserved)', () => {
      const res = coerceConfigValue(spec, '{"id":"gpt-oss-120b","apiKey":"sk-secret"}');
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/apiKey|api.*key/i);
    });
    it('rejects a JSON-encoded object string with missing id', () => {
      const res = coerceConfigValue(spec, '{"provider":"openai"}');
      expect(res.ok).toBe(false);
    });
    it('rejects a malformed {-prefixed string that is not valid JSON', () => {
      const res = coerceConfigValue(spec, '{not valid json}');
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/JSON|parse/i);
    });
    it('still accepts bare id strings unchanged (regression guard)', () => {
      expect(coerceConfigValue(spec, 'claude-haiku-4-5-20251001')).toEqual({ ok: true, value: 'claude-haiku-4-5-20251001' });
      expect(coerceConfigValue(spec, 'llama3.2:3b')).toEqual({ ok: true, value: 'llama3.2:3b' });
    });
  });
});

describe('coerceConfigValue — string-array type', () => {
  const spec = getConfigKeySpec('skills.hidden')!;

  it('accepts an array of strings', () => {
    const result = coerceConfigValue(spec, ['forge', 'mint']);
    expect(result).toEqual({ ok: true, value: ['forge', 'mint'] });
  });

  it('accepts a comma-separated string and splits it', () => {
    const result = coerceConfigValue(spec, 'forge,mint,ship');
    expect(result).toEqual({ ok: true, value: ['forge', 'mint', 'ship'] });
  });

  it('trims whitespace from comma-split entries', () => {
    const result = coerceConfigValue(spec, ' forge , mint ');
    expect(result).toEqual({ ok: true, value: ['forge', 'mint'] });
  });

  it('rejects a non-string element in the array', () => {
    const result = coerceConfigValue(spec, ['forge', 42]);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/non-string/);
  });

  it('rejects a non-string non-array input', () => {
    const result = coerceConfigValue(spec, 123);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/expects an array/);
  });

  it('returns an empty array for an empty comma-string', () => {
    const result = coerceConfigValue(spec, '');
    expect(result).toEqual({ ok: true, value: [] });
  });
});

describe('coerceConfigValue — object type', () => {
  const spec = getConfigKeySpec('pluginHookEnv')!;

  it('accepts a plain object', () => {
    const value = { 'my-plugin': ['SECRET_A', 'SECRET_B'] };
    const result = coerceConfigValue(spec, value);
    expect(result).toEqual({ ok: true, value });
  });

  it('rejects null (not an object)', () => {
    const result = coerceConfigValue(spec, null);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/expects an object/);
  });

  it('rejects an array (not a plain object)', () => {
    const result = coerceConfigValue(spec, ['foo', 'bar']);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/expects an object/);
  });

  it('rejects a string (not an object)', () => {
    const result = coerceConfigValue(spec, 'my-plugin=SECRET_A');
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/expects an object/);
  });
});

describe('dotted-path helpers', () => {
  it('setAtPath creates nested objects', () => {
    const obj: Record<string, unknown> = {};
    setAtPath(obj, 'telegram.notify.mode', 'primary');
    expect(obj).toEqual({ telegram: { notify: { mode: 'primary' } } });
  });
  it('getAtPath reads nested and returns undefined for missing', () => {
    const obj = { a: { b: 1 } };
    expect(getAtPath(obj, 'a.b')).toBe(1);
    expect(getAtPath(obj, 'a.c')).toBeUndefined();
    expect(getAtPath(obj, 'x.y.z')).toBeUndefined();
  });
  it('unsetAtPath removes leaf and prunes empty parents', () => {
    const obj: Record<string, unknown> = { telegram: { notify: { mode: 'primary' } }, model: 'opus' };
    expect(unsetAtPath(obj, 'telegram.notify.mode')).toBe(true);
    expect(obj).toEqual({ model: 'opus' }); // telegram + notify pruned
  });
  it('unsetAtPath keeps non-empty parents', () => {
    const obj: Record<string, unknown> = { autoRouting: { chat: true, telegram: false } };
    expect(unsetAtPath(obj, 'autoRouting.chat')).toBe(true);
    expect(obj).toEqual({ autoRouting: { telegram: false } });
  });
  it('unsetAtPath returns false for missing leaf', () => {
    expect(unsetAtPath({ a: 1 }, 'a.b.c')).toBe(false);
    expect(unsetAtPath({ a: 1 }, 'z')).toBe(false);
  });
});
