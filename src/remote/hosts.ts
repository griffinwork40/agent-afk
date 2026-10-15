/**
 * Host registry for `remote_agent`: `$AFK_HOME/config/hosts.json`.
 *
 * Shape: `{ "<name>": { "ssh": "user@host", "cwd"?: "~/Projects/x", "afkPath"?: "/abs/afk" } }`.
 * The file is optional. A name absent from it is used as a literal ssh target,
 * so `~/.ssh/config` aliases (e.g. `mini`) work with no setup.
 *
 * Contract: the resolved ssh target is validated against
 * {@link SSH_TARGET_PATTERN} and may not start with `-`, so a model-supplied
 * host can never smuggle an ssh option such as `-oProxyCommand=...`.
 *
 * @module remote/hosts
 */

import { promises as fs } from 'node:fs';
import { getRemoteHostsPath } from '../paths.js';

export interface RemoteHost {
  name: string;
  ssh: string;
  cwd?: string;
  afkPath?: string;
}

/** Characters allowed in an ssh destination (user@host, IPv6 brackets, ssh://host:port). */
export const SSH_TARGET_PATTERN = /^[A-Za-z0-9._@:%+/[\]-]+$/;

export function isValidSshTarget(target: string): boolean {
  return target !== '' && !target.startsWith('-') && SSH_TARGET_PATTERN.test(target);
}

/** Load the registry. Missing file → empty map; malformed file → throws with the path. */
export async function loadHosts(path: string = getRemoteHostsPath()): Promise<Record<string, RemoteHost>> {
  let text: string;
  try {
    text = await fs.readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must be a JSON object mapping host names to { "ssh": "user@host" }`);
  }
  const hosts: Record<string, RemoteHost> = {};
  for (const [name, raw] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const ssh = entry['ssh'];
    if (typeof ssh !== 'string' || ssh.trim() === '') {
      throw new Error(`${path}: host "${name}" needs a non-empty "ssh" string`);
    }
    const host: RemoteHost = { name, ssh: ssh.trim() };
    if (typeof entry['cwd'] === 'string' && entry['cwd'] !== '') host.cwd = entry['cwd'];
    if (typeof entry['afkPath'] === 'string' && entry['afkPath'] !== '') host.afkPath = entry['afkPath'];
    hosts[name] = host;
  }
  return hosts;
}

/** Resolve a host name (registry entry, else literal ssh target). Throws on an invalid target. */
export function resolveHost(name: string, hosts: Record<string, RemoteHost>): RemoteHost {
  const host = Object.prototype.hasOwnProperty.call(hosts, name) ? hosts[name] : undefined;
  const resolved = host ?? { name, ssh: name };
  if (!isValidSshTarget(resolved.ssh)) {
    throw new Error(`invalid ssh target "${resolved.ssh}" for host "${name}"`);
  }
  return resolved;
}
