## Summary

Fixes #1507

PR #1500 introduced a compact 7-line tail-first preview for bash output in the TUI outcome row. This PR makes the tail count configurable and adds an optional head block — without breaking the existing default behaviour.

## Changes

### New env vars (registered in `src/config/env.ts` ENV_REGISTRY)

| Var | Default | Range | Description |
|-----|---------|-------|-------------|
| `AFK_BASH_PREVIEW_TAIL_LINES` | `7` | 0–200 | Trailing non-empty lines shown in the outcome preview |
| `AFK_BASH_PREVIEW_HEAD_LINES` | `0` | 0–200 | Leading non-empty lines shown above the tail block |

Both vars are read through the canonical `env` read-point in `src/config/env.ts` — never raw `process.env`.

### New module: `src/agent/session/bash-preview.ts`

- `selectPreviewLines(lines, headCount, tailCount)` — pure function; no duplication when head and tail overlap (returns all lines split at the overlap boundary)
- `parseLineCount(raw, default)` — validates and clamps env var strings to [0, 200]; falls back to default on non-integer, negative, or out-of-range input
- `readPreviewConfig()` — reads both env vars and returns a validated `PreviewConfig`

### Updated: `src/agent/session/stream-consumer.preview.ts`

Replaces the hardcoded `TAIL_PREVIEW_LINES = 7` with a call to `readPreviewConfig()` + `selectPreviewLines()`. The `hiddenLineCount` is now computed from the actual displayed selection (head + tail together) so the "N earlier lines hidden" label is always accurate.

### Docs

`docs/env-registry.{json,md}` regenerated via `pnpm scan:env` (181 vars total).

## Acceptance criteria

- [x] Retains 7-line tail as the default
- [x] Supports validated, bounded tail (0–200) and optional head (0–200) counts
- [x] Uses `ENV_REGISTRY` in `src/config/env.ts` — never raw `process.env`
- [x] No duplicated lines when head and tail overlap; hidden-line count derived from actual displayed selection
- [x] Preview preferences separate from model-context caps and capture retention limits
- [x] Tests: defaults, custom values, invalid inputs, zero/boundary, overlap, short output, empty output (30 tests in `bash-preview.test.ts`)
- [x] `pnpm lint` — passes (tsc --noEmit clean)
- [x] `pnpm scan:env:check` — passes
- [x] `pnpm audit:env:check` — 0 violations
- [x] `pnpm audit:filesize:check` — no new violations (4 pre-existing unrelated)

## Testing

```
pnpm test src/agent/session/bash-preview.test.ts
# 30 tests, all pass
```
