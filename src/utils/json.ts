import { debugLog } from './debug.js';

export function safeParseJSON(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    debugLog('JSON parse error:', e);
    return null;
  }
}
