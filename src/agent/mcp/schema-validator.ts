/**
 * MCP JSON Schema validator factory.
 *
 * Returns an `AjvJsonSchemaValidator` instance (from the MCP SDK) pre-configured
 * with a custom Ajv instance that adds no-op format stubs for integer formats
 * that gRPC-style MCP servers commonly advertise in their tool schemas
 * (`uint32`, `uint64`, `int32`, `int64`).
 *
 * Without these stubs, Ajv 8's default instance emits one
 *   "unknown format "uint32" ignored in schema at path …"
 * warning to stderr on every tool schema compilation — once per unique
 * schema path, which in practice means once per MCP server connect and
 * again after each `notifications/tools/list_changed` refresh. The
 * warnings are harmless but noisy and alarm users.
 *
 * Resolution: register the formats as `true` (always-valid, no range
 * enforcement). The MCP protocol does not require range enforcement; the
 * stubs merely silence Ajv's "unknown format" diagnostic while preserving
 * all other schema validation behaviour.
 *
 * Implementation note: we import `AjvJsonSchemaValidator` from the MCP SDK's
 * own exported sub-path (`@modelcontextprotocol/sdk/validation/ajv`) and pass
 * it a custom Ajv instance. This reuses the SDK's class and its Ajv/ajv-formats
 * transitive dependencies — no additional direct deps are required.
 *
 * @see https://ajv.js.org/guide/formats.html#user-defined-formats
 * @module agent/mcp/schema-validator
 */

import { Ajv } from 'ajv';
import * as ajvFormats from 'ajv-formats';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

/**
 * Integer format names that appear in gRPC-transcoded tool schemas but are
 * not part of JSON Schema Draft 2020-12 or the `ajv-formats` bundle.
 * Registering them as `true` marks them as always-valid and prevents Ajv
 * from emitting "unknown format … ignored in schema" warnings.
 */
const GRPC_INTEGER_FORMATS = ['uint32', 'uint64', 'int32', 'int64'] as const;

/**
 * Build a `jsonSchemaValidator` instance suitable for use as the
 * `jsonSchemaValidator` option on MCP `Client` instances.
 *
 * The returned instance is the SDK's own `AjvJsonSchemaValidator` — it uses
 * the same Ajv options and ajv-formats as the SDK default — but is backed by
 * a custom Ajv instance that additionally registers no-op stubs for the gRPC
 * integer formats that would otherwise produce "unknown format … ignored"
 * warnings on every schema compilation (issue #2761).
 */
export function buildMcpSchemaValidator(): AjvJsonSchemaValidator {
  const ajv = new Ajv({
    strict: false,
    validateFormats: true,
    validateSchema: false,
    allErrors: true,
  });

  // Apply the same standard formats the SDK's default instance uses.
  // ajv-formats is a CJS module that ships one callable export; under NodeNext `import *`
  // the callable lands on `.default`, but under bundlers/CommonJS interop it IS the namespace.
  // The `?? ajvFormats` fallback + `as unknown as` double-cast handles both shapes safely.
  const applyFormats = (ajvFormats.default ?? ajvFormats) as unknown as (ajv: InstanceType<typeof Ajv>) => void;
  applyFormats(ajv);

  // Register no-op stubs for gRPC integer formats. `true` means
  // "always consider this format valid" — Ajv will not range-check values,
  // but it will no longer warn that the format is unknown.
  for (const fmt of GRPC_INTEGER_FORMATS) {
    ajv.addFormat(fmt, true);
  }

  return new AjvJsonSchemaValidator(ajv);
}
