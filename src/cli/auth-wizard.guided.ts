import { env } from '../config/env.js';
import { promptSecret } from '../utils/prompt-secret.js';
import { UsageLimitError } from '../utils/errors.js';
import { classifyError } from './errors/classifier.js';
import { palette } from './palette.js';
import { checkCredential } from './auth-wizard.check.js';

/** Services have no portable common marker; require BOTH terminal streams. */
export function canPromptForAuth(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && !env.AFK_DAEMON_TASK);
}

// Prefix hints only, never a format allowlist. Gateways can use arbitrary keys.
const OTHER_PROVIDER_PREFIXES = [
  { prefix: 'sk-', provider: 'OpenAI' },
  { prefix: 'xai-', provider: 'xAI' },
] as const;

function credentialWarning(token: string): string | undefined {
  if (token.startsWith('sk-ant-api') || token.startsWith('sk-ant-oat')) return undefined;
  const other = OTHER_PROVIDER_PREFIXES.find(({ prefix }) => token.startsWith(prefix));
  return other
    ? `This looks like an ${other.provider} key, not an Anthropic key.`
    : 'This does not look like an Anthropic credential. Some gateways use other formats.';
}

async function confirmSave(question: string): Promise<boolean> {
  // Reuse the no-echo reader so an accidental second paste never echoes a key.
  const answer = await promptSecret(`${question} Type yes to confirm (input hidden): `);
  return answer.toLowerCase() === 'yes';
}

function nothingSaved(message: string): never {
  console.error(palette.error(`${message} Nothing saved.`));
  process.exit(1);
}

function showGuidance(): void {
  console.log(palette.info('To use Claude, afk needs an Anthropic API key or OAuth token.'));
  console.log(palette.info('Create an API key in the Anthropic console: https://console.anthropic.com'));
  console.log(palette.info('afk is free. Anthropic bills for API usage, including this tiny sign-in check.'));
  console.log(palette.info('An existing Claude Code login is detected automatically; you do not need to paste it.'));
  console.log(palette.info('Other provider or local model? See https://docs.agentafk.com/configuration/api-keys'));
  console.log(palette.info('Nothing will appear while you paste. This is normal. Press Enter when finished.'));
}

/** The only interactive sign-in flow, shared by first-run, login and setup. */
export async function guidedToken(readToken: () => Promise<string>): Promise<string> {
  if (!canPromptForAuth()) {
    return nothingSaved('Sign-in needs stdin and stdout to be interactive terminals. Run afk login in a terminal.');
  }
  showGuidance();
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = await readToken();
    if (!token) return nothingSaved('No token provided.');
    const warning = credentialWarning(token);
    if (warning) {
      console.log(palette.warning(warning));
      if (!await confirmSave('Save this as an Anthropic key?')) continue;
    }
    // OAuth needs the subscription-specific handshake, not API-key validation.
    if (token.startsWith('sk-ant-oat')) {
      console.log(palette.warning('OAuth token was not checked here. It will be checked on your first message.'));
      return token;
    }
    console.log(palette.info('Checking with the provider...'));
    const result = await checkCredential(token);
    if (result.kind === 'rejected') {
      console.log(palette.warning('The provider rejected this credential. Check that you copied the whole key and try again.'));
      continue;
    }
    if (result.kind === 'credit') {
      const info = classifyError(new UsageLimitError('No API credit', { provider: 'anthropic', kind: 'credit' }));
      console.log(palette.warning(`Credential recognized, but ${info.userMessage}`));
      if (info.hint) console.log(palette.warning(info.hint));
      return token;
    }
    if (result.kind === 'accepted') {
      console.log(palette.success('Provider accepted the credential.'));
      return token;
    }
    console.log(palette.warning('Could not verify the credential. The provider could not be reached or returned an unknown result.'));
    if (await confirmSave('Save anyway and try it on your first message?')) return token;
    return nothingSaved('Sign-in cancelled.');
  }
  return nothingSaved('Sign-in stopped after three attempts. Run afk login to try again.');
}
