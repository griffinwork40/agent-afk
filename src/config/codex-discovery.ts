import { readFileSync } from 'fs';
import { join } from 'path';
import type { SourceEnabledMap } from './import-sources.js';

export function readCodexEnabledPlugins(home: string): SourceEnabledMap {
  const enabled = new Map<string, boolean>();
  let content: string;
  try {
    content = readFileSync(join(home, 'config.toml'), 'utf8');
  } catch {
    return enabled;
  }
  let key: string | undefined;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      key = undefined;
      const match = /^\[plugins\.("(?:[^"\\]|\\.)*"|'[^']*'|[\w-]+)\]\s*(?:#.*)?$/.exec(trimmed);
      const raw = match?.[1];
      if (raw) {
        try {
          key = raw.startsWith('"') ? JSON.parse(raw) : raw.replace(/^'|'$/g, '');
        } catch {
          key = undefined;
        }
      }
    } else if (key !== undefined) {
      const match = /^enabled\s*=\s*(true|false)\s*(?:#.*)?$/.exec(trimmed);
      if (match) enabled.set(key, match[1] === 'true');
    }
  }
  return enabled;
}
