/**
 * Regression test for issue #2761:
 * Ajv "unknown format uint32/uint64 ignored in schema" warnings on every run.
 *
 * Verifies that `buildMcpSchemaValidator()` produces a validator that:
 *   1. Does not emit any "unknown format … ignored" stderr warnings when
 *      compiling tool schemas that contain gRPC integer format annotations.
 *   2. Still validates correctly (accepts valid data, rejects invalid data).
 *   3. Handles the four gRPC integer formats: uint32, uint64, int32, int64.
 *   4. Returns the SDK's own AjvJsonSchemaValidator instance.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { buildMcpSchemaValidator } from './schema-validator.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

describe('buildMcpSchemaValidator', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('returns an AjvJsonSchemaValidator instance from the MCP SDK', () => {
    const validator = buildMcpSchemaValidator();
    expect(validator).toBeDefined();
    expect(validator).toBeInstanceOf(AjvJsonSchemaValidator);
    expect(typeof validator.getValidator).toBe('function');
  });

  it.each(['uint32', 'uint64', 'int32', 'int64'] as const)(
    'compiles schema with format "%s" without emitting "unknown format" warnings',
    (format) => {
      const validator = buildMcpSchemaValidator();
      const schema = {
        type: 'object' as const,
        properties: {
          value: { type: 'integer' as const, format },
        },
      };

      // Capture console.warn as well, since Ajv can also log there
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      // getValidator() triggers Ajv schema compilation — this is where the
      // "unknown format … ignored" warning would be emitted if the format is
      // not registered.
      const validate = validator.getValidator(schema);
      expect(validate).toBeDefined();

      // No "unknown format" warnings should have been written to stderr or
      // console.warn during compilation.
      const stderrOutput = stderrSpy.mock.calls.map(([s]) => String(s)).join('');
      const warnOutput = warnSpy.mock.calls.map((args) => args.join(' ')).join('');
      expect(stderrOutput).not.toMatch(/unknown format/i);
      expect(warnOutput).not.toMatch(/unknown format/i);

      warnSpy.mockRestore();
    },
  );

  it('validates data correctly against a schema with uint32 format', () => {
    const validator = buildMcpSchemaValidator();
    const schema = {
      type: 'object' as const,
      properties: {
        count: { type: 'integer' as const, format: 'uint32' },
      },
      required: ['count'],
    };
    const validate = validator.getValidator<{ count: number }>(schema);

    // Valid: integer value
    const valid = validate({ count: 42 });
    expect(valid.valid).toBe(true);

    // Invalid: string where integer required
    const invalid = validate({ count: 'not-a-number' });
    expect(invalid.valid).toBe(false);
    expect(invalid.errorMessage).toBeTruthy();
  });

  it('validates data correctly against a schema with multiple gRPC formats', () => {
    const validator = buildMcpSchemaValidator();
    const schema = {
      type: 'object' as const,
      properties: {
        u32: { type: 'integer' as const, format: 'uint32' },
        u64: { type: 'integer' as const, format: 'uint64' },
        i32: { type: 'integer' as const, format: 'int32' },
        i64: { type: 'integer' as const, format: 'int64' },
      },
    };
    const validate = validator.getValidator(schema);

    const valid = validate({ u32: 1, u64: 2, i32: -1, i64: -2 });
    expect(valid.valid).toBe(true);
  });

  it('still validates standard formats (e.g. email) correctly', () => {
    const validator = buildMcpSchemaValidator();
    const schema = {
      type: 'object' as const,
      properties: {
        email: { type: 'string' as const, format: 'email' },
      },
    };
    const validate = validator.getValidator(schema);

    // Standard formats should still be enforced
    const validEmail = validate({ email: 'user@example.com' });
    expect(validEmail.valid).toBe(true);

    const invalidEmail = validate({ email: 'not-an-email' });
    expect(invalidEmail.valid).toBe(false);
  });
});
