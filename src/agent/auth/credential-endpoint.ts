/**
 * Endpoint classification for credential provenance (#4882).
 *
 * Contract: given a configured base URL, decide whether it is a provider's own
 * official API host ('official': fall through to normal credential
 * resolution), a clearly self-hosted endpoint ('local': no cash cost), or
 * anything else ('custom': a hosted OpenAI-compatible service such as
 * OpenRouter or Together, billing unknown). Pure: no DNS, no I/O. An
 * unparseable URL is 'custom' (never guessed local).
 *
 * @module agent/auth/credential-endpoint
 */

import { BlockList, isIP } from 'node:net';

export type EndpointClass = 'official' | 'local' | 'custom';

/** Official API hosts per provider family (exact hostname match). */
export const OFFICIAL_API_HOSTS = {
  anthropic: ['api.anthropic.com'],
  openai: ['api.openai.com', 'chatgpt.com'],
  xai: ['api.x.ai', 'cli-chat-proxy.grok.com'],
} as const satisfies Record<string, readonly string[]>;

/** Self-hosted address space: loopback, RFC1918, link-local, CGNAT (Tailscale), ULA. */
const SELF_HOSTED = ((): BlockList => {
  const list = new BlockList();
  const v4: ReadonlyArray<readonly [string, number]> = [
    ['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16],
    ['169.254.0.0', 16], ['100.64.0.0', 10],
  ];
  for (const [addr, prefix] of v4) list.addSubnet(addr, prefix, 'ipv4');
  list.addAddress('::1', 'ipv6');
  list.addSubnet('fc00::', 7, 'ipv6');
  return list;
})();

const SELF_HOSTED_SUFFIXES = ['.local', '.lan', '.internal', '.home.arpa', '.ts.net', '.localhost'];

function hostnameOf(url: string): string | undefined {
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    const stripped = bare.replace(/\.$/, '');
    return stripped.length > 0 ? stripped : undefined;
  } catch {
    return undefined;
  }
}

/** Classify `url` against `officialHosts` (see module contract). */
export function classifyEndpoint(url: string, officialHosts: readonly string[]): EndpointClass {
  const host = hostnameOf(url);
  if (host === undefined) return 'custom';
  if (officialHosts.includes(host)) return 'official';
  const family = isIP(host);
  if (family !== 0) return SELF_HOSTED.check(host, family === 4 ? 'ipv4' : 'ipv6') ? 'local' : 'custom';
  if (host === 'localhost') return 'local';
  // Single-label names (`griffin-cm`, a tailnet MagicDNS short name) cannot be
  // public internet hosts.
  if (!host.includes('.')) return 'local';
  return SELF_HOSTED_SUFFIXES.some((s) => host.endsWith(s)) ? 'local' : 'custom';
}
