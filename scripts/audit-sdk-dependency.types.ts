// Shared types and constants for audit-sdk-dependency.
// Kept in a dedicated module so scan, lock, and render concerns can all import
// without forming circular dependencies.

export const TRACKED_PACKAGES = ['@anthropic-ai/sdk'] as const;
export type TrackedPackage = (typeof TRACKED_PACKAGES)[number];

export const SCAN_ROOTS = ['src', 'tests'];

export type ImportKind = 'type-only' | 'runtime';

export interface SymbolUsage {
  kind: ImportKind;
  files: Set<string>;
  callSites: number;
}

export interface LockEntry {
  kind: ImportKind;
  reason: string;
}

export interface LockFile {
  generated_at: string;
  symbols: Record<string, Record<string, LockEntry>>;
}

export interface TelemetryEntry {
  timestamp: string;
  surface: 'afk';
  sdk_version: string | null;
  total_files: number;
  per_package: Record<
    string,
    {
      files: number;
      runtime_symbols: number;
      type_only_symbols: number;
    }
  >;
  symbol_hash: string;
  new_symbols_since_last_run: Array<{ package: string; symbol: string; kind: ImportKind }>;
  dropped_symbols_since_last_run: Array<{ package: string; symbol: string }>;
  kind_changes_since_last_run: Array<{
    package: string;
    symbol: string;
    from: ImportKind;
    to: ImportKind;
  }>;
}

export interface Diff {
  added: Array<{ package: string; symbol: string; kind: ImportKind }>;
  dropped: Array<{ package: string; symbol: string }>;
  kindChanges: Array<{ package: string; symbol: string; from: ImportKind; to: ImportKind }>;
}

export type Inventory = Map<TrackedPackage, Map<string, SymbolUsage>>;
