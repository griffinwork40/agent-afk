/**
 * Allowlist of pre-existing cross-layer import violations for audit-layer-imports.ts.
 *
 * Contract: each entry identifies ONE (file, importContains) pair that violates
 * the three-layer contract but is allowlisted until fixed upstream.
 * Every entry must carry a rationale and a tracking issue.
 * Keep this list small — shrink it as violations are resolved.
 *
 * When adding a new entry:
 *   1. State which rule it violates (Rule 1 / 2 / 3).
 *   2. Link the tracking issue where the real fix is planned.
 *   3. Prefer fixing the violation over adding to this list.
 *
 * Pre-existing violations by rule:
 *   Rule 1 (Core/Infra → Surface): 63 sites (tracked in #4456 and #4457)
 *   Rule 2 (Foundation → Core/Infra): 4 sites (tracked in #4457)
 *   Rule 3 (Feature → Surface): 1 site (tracked in #4457, type-only, low severity)
 */

export interface AllowedPair {
  /** Repo-relative path of the importing file (e.g. "src/agent/foo.ts"). */
  file: string;
  /** Substring of the import specifier that identifies the violation. */
  importContains: string;
  reason: string;
}

export const ALLOWED_PAIRS: ReadonlyArray<AllowedPair> = [
  // ── Rule 1: Core/Infra → telegram/ (tracked in #4456) ──────────────────────
  {
    file: 'src/agent/tools/handlers/send-telegram.ts',
    importContains: 'telegram/',
    reason: 'Core→Surface: tracked in #4456 for extraction to a surface-layer adapter.',
  },
  {
    file: 'src/agent/tools/handlers/send-telegram.test.ts',
    importContains: 'telegram/',
    reason: 'Core→Surface test file: mirrors the production violation tracked in #4456.',
  },
  {
    file: 'src/agent/spine/spine-hook.ts',
    importContains: 'telegram/',
    reason: 'Core→Surface: tracked in #4456.',
  },
  {
    file: 'src/agent/elicitation-router.ts',
    importContains: 'telegram/',
    reason: 'Core→Surface: tracked in #4456.',
  },
  {
    file: 'src/agent/elicitation-router.test.ts',
    importContains: 'telegram/',
    reason: 'Core→Surface test file: mirrors the production violation tracked in #4456.',
  },
  {
    file: 'src/agent/manifest/startup-reconcile.ts',
    importContains: 'telegram/',
    reason: 'Core→Surface: tracked in #4456.',
  },
  {
    file: 'src/agent/manifest/startup-reconcile.test.ts',
    importContains: 'telegram/',
    reason: 'Core→Surface test file: mirrors the production violation tracked in #4456.',
  },
  {
    file: 'src/agent/daemon/telemetry-write-guard.ts',
    importContains: 'telegram/',
    reason: 'Core→Surface: tracked in #4456.',
  },
  {
    file: 'src/agent/daemon/telemetry-write-guard.test.ts',
    importContains: 'telegram/',
    reason: 'Core→Surface test file: mirrors the production violation tracked in #4456.',
  },
  {
    file: 'src/agent/daemon/scheduler.elicitation-notify.ts',
    importContains: 'telegram/',
    reason: 'Core→Surface: tracked in #4456.',
  },
  {
    file: 'src/agent/daemon/handoff-wiring.ts',
    importContains: 'telegram/',
    reason: 'Core→Surface: tracked in #4456.',
  },
  {
    file: 'src/agent/daemon/handoff-expiry.ts',
    importContains: 'telegram/',
    reason: 'Core→Surface: tracked in #4456.',
  },
  {
    file: 'src/agent/daemon/handoff-expiry.test.ts',
    importContains: 'telegram/',
    reason: 'Core→Surface test file: mirrors the production violation tracked in #4456.',
  },
  {
    file: 'src/agent/daemon/handoff-maintenance.test.ts',
    importContains: 'telegram/',
    reason: 'Core→Surface test file: mirrors the production violation tracked in #4456.',
  },
  {
    file: 'src/agent/ask-question-gate.ts',
    importContains: 'telegram/',
    reason: 'Core→Surface: tracked in #4456.',
  },
  // ── Rule 1: service/ → telegram/ ───────────────────────────────────────────
  {
    file: 'src/service/launchd/plist.ts',
    importContains: 'telegram/',
    reason:
      'Core→Surface: service/launchd/plist.ts references the telegram entrypoint to build the launchd plist. Tracked in #4457.',
  },
  // ── Rule 1: skills/ → cli/ and telegram/ ───────────────────────────────────
  {
    file: 'src/skills/_lib/emit-card.ts',
    importContains: 'cli/',
    reason: 'Core→Surface: skills emit-card uses CardSpec from cli/render. Tracked in #4457.',
  },
  {
    file: 'src/skills/score/digest-keyboard.ts',
    importContains: 'telegram/',
    reason:
      'Core→Surface: skills score/digest-keyboard builds Telegram farm callbacks. Tracked in #4457.',
  },
  // ── Rule 1: agent/ → cli/ ──────────────────────────────────────────────────
  {
    file: 'src/agent/session-control/reads.ts',
    importContains: 'cli/',
    reason: 'Core→Surface: SessionStats lives in cli/slash/types. Tracked in #4457.',
  },
  {
    file: 'src/agent/session-control/reads.test.ts',
    importContains: 'cli/',
    reason: 'Core→Surface test file: mirrors the production violation tracked in #4457.',
  },
  {
    file: 'src/agent/session-control/model.ts',
    importContains: 'cli/',
    reason: 'Core→Surface: SessionStats lives in cli/slash/types. Tracked in #4457.',
  },
  {
    file: 'src/agent/session-control/preferences.ts',
    importContains: 'cli/',
    reason: 'Core→Surface: imports cli/session-store and cli/session-name. Tracked in #4457.',
  },
  {
    file: 'src/agent/session-control/clear.ts',
    importContains: 'cli/',
    reason: 'Core→Surface: SessionStats/resetStats live in cli/slash. Tracked in #4457.',
  },
  {
    file: 'src/agent/session-control/control.test.ts',
    importContains: 'cli/',
    reason: 'Core→Surface test file: mirrors the production violation tracked in #4457.',
  },
  {
    file: 'src/agent/tools/operator-denied.ts',
    importContains: 'cli/',
    reason: 'Core→Surface: jsonConfigTierPaths lives in cli/config. Tracked in #4457.',
  },
  {
    file: 'src/agent/tools/operator-denied.test.ts',
    importContains: 'cli/',
    reason: 'Core→Surface test file: mirrors the production violation tracked in #4457.',
  },
  {
    file: 'src/agent/tools/operator-denied.slots.ts',
    importContains: 'cli/',
    reason: 'Core→Surface: jsonConfigTierPaths lives in cli/config. Tracked in #4457.',
  },
  {
    file: 'src/agent/tools/operator-denied.slots.test.ts',
    importContains: 'cli/',
    reason: 'Core→Surface test file: mirrors the production violation tracked in #4457.',
  },
  {
    file: 'src/agent/tools/operator-denied-dispatcher.test.ts',
    importContains: 'cli/',
    reason:
      'Core→Surface test file: parseToolsConfig lives in cli/config. Tracked in #4457.',
  },
  {
    file: 'src/agent/tools/skill-bridge.ts',
    importContains: 'cli/',
    reason: 'Core→Surface: loadJsonConfig lives in cli/config. Tracked in #4457.',
  },
  {
    file: 'src/agent/tools/skill-bridge.test.ts',
    importContains: 'cli/',
    reason: 'Core→Surface test file: mirrors the production violation tracked in #4457.',
  },
  {
    file: 'src/agent/tools/handlers/clipboard.ts',
    importContains: 'cli/',
    reason: 'Core→Surface: copyToClipboard lives in cli/clipboard. Tracked in #4457.',
  },
  {
    file: 'src/agent/tools/handlers/send-telegram.test.ts',
    importContains: 'cli/',
    reason:
      'Core→Surface test file: loadTelegramConfig lives in cli/config. Tracked in #4457.',
  },
  {
    file: 'src/agent/tools/skill-executor/fork-renderer-identity.test.ts',
    importContains: 'cli/',
    reason:
      'Core→Surface test file: StreamRenderer / ToolLane live in cli. Tracked in #4457.',
  },
  {
    file: 'src/agent/tools/subagent/child-config.test.ts',
    importContains: 'cli/',
    reason:
      'Core→Surface test file: DEFAULT_CLI_PERMISSION_MODE lives in cli/config/types. Tracked in #4457.',
  },
  {
    file: 'src/agent/tools/detach-registry-wiring.test.ts',
    importContains: 'cli/',
    reason: 'Core→Surface test file: buildSharedDeps lives in cli. Tracked in #4457.',
  },
  {
    file: 'src/agent/worktree/display.ts',
    importContains: 'cli/',
    reason: 'Core→Surface: palette lives in cli/palette. Tracked in #4457.',
  },
  {
    file: 'src/agent/usage/usage-formatter.ts',
    importContains: 'cli/',
    reason:
      'Core→Surface: formatResetCountdown lives in cli/quota-indicator. Tracked in #4457.',
  },
  {
    file: 'src/agent/usage/usage-core.test.ts',
    importContains: 'cli/',
    reason:
      'Core→Surface test file: STALE_AFTER_MS lives in cli/quota-indicator. Tracked in #4457.',
  },
  {
    file: 'src/agent/awareness/runtime-source.test.ts',
    importContains: 'cli/',
    reason:
      'Core→Surface test file: STALE_AFTER_MS lives in cli/quota-indicator. Tracked in #4457.',
  },
  {
    file: 'src/agent/content/image-blocks.test.ts',
    importContains: 'cli/',
    reason:
      'Core→Surface test file: ImageAttachment type lives in cli/input. Tracked in #4457.',
  },
  {
    file: 'src/agent/session/journal-lifecycle.ts',
    importContains: 'cli/',
    reason: 'Core→Surface: getVersion lives in cli/version. Tracked in #4457.',
  },
  {
    file: 'src/agent/session/session-id-trace.ts',
    importContains: 'cli/',
    reason: 'Core→Surface: getVersion lives in cli/version. Tracked in #4457.',
  },
  {
    file: 'src/agent/session/stream-consumer-display.test.ts',
    importContains: 'cli/',
    reason: 'Core→Surface test file: formatOutcome lives in cli. Tracked in #4457.',
  },
  {
    file: 'src/agent/shell-jobs/process-jobs-wiring.test.ts',
    importContains: 'cli/',
    reason: 'Core→Surface test file: buildSharedDeps lives in cli. Tracked in #4457.',
  },
  {
    file: 'src/agent/background-registry.result-persist.test.ts',
    importContains: 'cli/',
    reason: 'Core→Surface test file: bg-result-notifier lives in cli. Tracked in #4457.',
  },
  {
    file: 'src/agent/daemon/scheduler-gate-blocks.test.ts',
    importContains: 'cli/',
    reason:
      'Core→Surface test file: formatTaskCompletion lives in cli. Tracked in #4457.',
  },
  {
    file: 'src/agent/daemon/scheduler.test.ts',
    importContains: 'cli/',
    reason:
      'Core→Surface test file: parseTerminalState / DONE_EVIDENCE_TOOLS live in cli. Tracked in #4457.',
  },
  {
    file: 'src/agent/daemon/tool-health-task.test.ts',
    importContains: 'cli/',
    reason: 'Core→Surface test file: buildToolHealthTask lives in cli. Tracked in #4457.',
  },
  {
    file: 'src/agent/routing-directive.test.ts',
    importContains: 'cli/',
    reason: 'Core→Surface test file: parseTerminalState lives in cli. Tracked in #4457.',
  },
  {
    file: 'src/agent/providers/routing.test.ts',
    importContains: 'cli/',
    reason:
      'Core→Surface test file: getDefaultSubagentModel lives in cli. Tracked in #4457.',
  },
  {
    file: 'src/agent/providers/anthropic-direct/operator-denied.slots.test.ts',
    importContains: 'cli/',
    reason:
      'Core→Surface test file: jsonConfigTierPaths lives in cli/config. Tracked in #4457.',
  },
  {
    file: 'src/agent/providers/anthropic-direct/operator-denied.test.ts',
    importContains: 'cli/',
    reason:
      'Core→Surface test file: jsonConfigTierPaths lives in cli/config. Tracked in #4457.',
  },
  {
    file: 'src/agent/providers/anthropic-direct/slot-tool-deny.switch.test.ts',
    importContains: 'cli/',
    reason:
      'Core→Surface test file: jsonConfigTierPaths lives in cli/config. Tracked in #4457.',
  },
  {
    file: 'src/agent/providers/openai-compatible/slot-tool-deny.wire.test.ts',
    importContains: 'cli/',
    reason:
      'Core→Surface test file: jsonConfigTierPaths lives in cli/config. Tracked in #4457.',
  },
  // ── Rule 2: Foundation → Core/Infra ────────────────────────────────────────
  {
    file: 'src/config/mutate.ts',
    importContains: 'agent/',
    reason:
      'Foundation→Core: ModelSlotBinding type lives in agent/session/model-slots. Tracked in #4457.',
  },
  {
    file: 'src/config/mutate.test.ts',
    importContains: 'agent/',
    reason: 'Foundation→Core test file: mirrors the production violation tracked in #4457.',
  },
  {
    file: 'src/config/settable-keys.ts',
    importContains: 'agent/',
    reason:
      'Foundation→Core: coerceSlotBindingInput / ModelSlotBinding live in agent/session/model-slots. Tracked in #4457.',
  },
  {
    file: 'src/utils/sleep.ts',
    importContains: 'agent/',
    reason:
      'Foundation→Core: utils/sleep.ts re-exports from agent/providers/shared/sleep-with-abort. Tracked in #4457.',
  },
  // ── Rule 1: agent/ → telegram/ and agent/ → cli/ (files added to main after branch point) ──
  {
    file: 'src/agent/operator-notify.ts',
    importContains: 'telegram/',
    reason: 'Core→Surface: operator-notify re-exports PushResult from telegram/push. Tracked in #4456.',
  },
  {
    file: 'src/agent/tools/hooks/inline-image-render.ts',
    importContains: 'cli/',
    reason: 'Core→Surface: inline-image-render uses palette from cli/palette. Tracked in #4457.',
  },
  // ── Rule 3: Feature → Surface ──────────────────────────────────────────────
  {
    file: 'src/whatif/report.ts',
    importContains: 'cli/',
    reason:
      'Feature→Surface: type-only import of ThemePalette from cli/palette. Low severity; tracked in #4457.',
  },
];
