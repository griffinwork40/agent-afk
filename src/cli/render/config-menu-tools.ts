/**
 * `/config` → Tools: a checklist over the operator tool deny list
 * (`tools.disabled`). ◉ = on, ◯ = off; space toggles, enter saves, esc cancels.
 *
 * Contract:
 *   - Rows: the fixed groups, then every non-locked, non-grouped top-level
 *     built-in tool, then one `mcp__<server>__*` row per configured MCP server,
 *     then any entry already present in ANY config tier that none of the above
 *     covers (exact MCP tool names, custom/plugin tools, group members). So
 *     every entry an operator wrote is visible and can be turned back on; the
 *     menu never silently drops one on save.
 *   - Only the user tier is written. An entry disabled by the project or
 *     legacy file shows as off with a `← off in <tier>` note; checking it
 *     cannot enable it (tiers are unioned at enforcement), and the save
 *     reports which file still disables it.
 *   - Locked core tools (agent, skill, read_file, ...) are not listed; the
 *     header says they are always on.
 *   - Effects are injected ({@link MenuOverlays} / {@link ToolsMenuIo}) so the
 *     flow is unit-tested without a compositor or disk.
 *
 * @module cli/render/config-menu-tools
 */

import { palette } from '../palette.js';
import type { MenuOverlays } from './config-menu.js';
import { RESTART_NOTE } from '../../config/mutate.js';
import { loadMcpConfig } from '../../agent/mcp/config-loader.js';
import { LOCKED_TOOLS, TOOL_GROUP_NAMES, toolGroups } from '../../agent/tools/operator-denied.js';
import { topLevelSurfaceAllowedTools } from '../../agent/tools/top-level-allowlist.js';
import { readDisabledToolsByTier, writeUserDisabledTools, type TierDisabledTools } from '../config/tools-disabled.js';
import { errorMessage } from '../../utils/errors.js';

export interface ToolsMenuIo {
  /** Raw `tools.disabled` entries per existing config tier. */
  byTier(): readonly TierDisabledTools[];
  /** Replace the user-tier list. Throws on an unwritable/malformed file. */
  writeUser(entries: readonly string[]): void;
  /** Names of configured MCP servers (for `mcp__<server>__*` rows). */
  mcpServers(): readonly string[];
}

export interface ToolRow {
  entry: string;
  detail: string;
}

/** `group (5): a, b, …`, capped so a row never wraps a typical terminal. */
function groupDetail(members: readonly string[]): string {
  const list = members.join(', ');
  return `group (${members.length}): ${list.length > 48 ? `${list.slice(0, 47)}…` : list}`;
}

/** Ordered, de-duplicated checklist rows. Pure given its inputs. */
export function buildToolRows(mcpServers: readonly string[], configured: readonly string[]): ToolRow[] {
  const groups = toolGroups();
  const grouped = new Set(Object.values(groups).flat());
  const rows: ToolRow[] = TOOL_GROUP_NAMES.map((g) => ({ entry: g, detail: groupDetail(groups[g] ?? []) }));
  const builtins = topLevelSurfaceAllowedTools()
    .filter((n) => !LOCKED_TOOLS.has(n) && !grouped.has(n))
    .sort();
  for (const name of new Set(builtins)) rows.push({ entry: name, detail: '' });
  for (const s of [...mcpServers].sort()) rows.push({ entry: `mcp__${s}__*`, detail: `all tools from MCP server "${s}"` });
  const seen = new Set(rows.map((r) => r.entry));
  for (const e of configured) {
    if (seen.has(e)) continue;
    seen.add(e);
    rows.push({ entry: e, detail: LOCKED_TOOLS.has(e) ? 'locked core tool (entry ignored)' : 'from config' });
  }
  return rows;
}

/** Count of distinct raw entries across every tier (for the category label). */
export function disabledCount(io: ToolsMenuIo): number {
  return new Set(io.byTier().flatMap((t) => t.entries)).size;
}

function rowLabel(row: ToolRow, pad: number, forcedBy: readonly string[]): string {
  const detail = row.detail ? `  ${palette.dim(row.detail)}` : '';
  const forced = forcedBy.length > 0 ? `  ${palette.warning(`← off in ${forcedBy.join(', ')}`)}` : '';
  // Pad only when something follows, so bare rows carry no trailing spaces.
  return detail || forced ? `${row.entry.padEnd(pad)}${detail}${forced}` : row.entry;
}

/**
 * Run the Tools checklist once. Resolves after save, cancel (Esc), or when
 * the overlay surface cannot multi-select. Never throws: write failures are
 * echoed via `ov.emit`.
 */
export async function runToolsMenu(ov: MenuOverlays, io: ToolsMenuIo): Promise<void> {
  if (!ov.pickMany) return;
  const tiers = io.byTier();
  const user = tiers.find((t) => t.tier === 'user');
  const userOff = new Set(user?.entries ?? []);
  const others = tiers.filter((t) => t.tier !== 'user');
  const rows = buildToolRows(io.mcpServers(), tiers.flatMap((t) => t.entries));
  const forcedBy = rows.map((r) => others.filter((t) => t.entries.includes(r.entry)).map((t) => t.label));
  const pad = Math.min(28, Math.max(...rows.map((r) => r.entry.length)));

  const initial = new Set<number>();
  rows.forEach((r, i) => { if (!userOff.has(r.entry) && forcedBy[i]!.length === 0) initial.add(i); });

  const header = [
    palette.bold('Settings › Tools'),
    palette.dim('◉ on · ◯ off. Off = hidden from the model and blocked if called, including subagents.'),
    palette.dim('Core tools (agent, skill, compose, read/write/edit, grep, glob, ...) are always on.'),
    ...(user?.unreadable ? [palette.warning(`⚠ ${user.path} is not valid JSON; saving will fail until it is fixed.`)] : []),
    '',
  ];
  const selected = await ov.pickMany(header, rows.map((r, i) => rowLabel(r, pad, forcedBy[i]!)), initial);
  if (selected === null) return; // Esc: no changes

  const on = new Set(selected);
  // A row forced off by another tier is only kept in the USER list when the
  // user list already had it; otherwise it is off regardless and adding it
  // here would just duplicate the other tier's entry.
  const next = rows
    .filter((r, i) => !on.has(i) && (userOff.has(r.entry) || forcedBy[i]!.length === 0))
    .map((r) => r.entry);
  const stuck = rows.filter((_, i) => on.has(i) && forcedBy[i]!.length > 0);

  const unchanged = next.length === userOff.size && next.every((e) => userOff.has(e));
  if (unchanged) {
    ov.emit(palette.dim('  Tools: no changes.'));
  } else {
    try {
      io.writeUser(next);
      const shown = next.length === 0 ? '(none)' : next.join(', ');
      ov.emit(`${palette.success('  ✓')} tools.disabled = ${palette.bold(shown)}  ${palette.dim(`— ${RESTART_NOTE}`)}`);
    } catch (err) {
      ov.emit(`${palette.error('  ✗')} ${palette.error(errorMessage(err))}`);
      return;
    }
  }
  for (const r of stuck) {
    const where = others.filter((t) => t.entries.includes(r.entry)).map((t) => `${t.label} (${t.path})`).join(', ');
    ov.emit(`${palette.warning('  ⚠')} ${r.entry} stays off: disabled in ${where}. Edit that file to turn it on.`);
  }
}

/** Real io: user-tier store + MCP server names from the layered MCP config. */
export function defaultToolsIo(): ToolsMenuIo {
  return {
    byTier: () => readDisabledToolsByTier(),
    writeUser: (entries) => writeUserDisabledTools(entries),
    mcpServers: () => {
      try {
        return Object.keys(loadMcpConfig().mcpServers);
      } catch {
        return [];
      }
    },
  };
}
