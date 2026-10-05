/**
 * Terminal-state gate — cli re-export shim.
 *
 * The implementation has been moved to `src/agent/terminal-state-gate.ts` so
 * the session layer can register the gate on every top-level surface (REPL,
 * Telegram, daemon, one-shot chat), not only the REPL bootstrap. This module
 * re-exports everything for backward compatibility — all existing importers
 * (bootstrap-hooks.ts) continue to work unchanged.
 *
 * See `src/agent/terminal-state-gate.ts` for the full design rationale.
 */

export {
  DEFAULT_MAX_TERMINAL_STATE_INJECTIONS,
  TERMINAL_STATE_GATE_CORRECTION,
  type TerminalStateGateOptions,
  createTerminalStateGate,
} from '../../../agent/terminal-state-gate.js';
