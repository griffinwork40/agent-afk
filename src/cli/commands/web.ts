import { Command } from 'commander';
import { palette } from '../palette.js';
import { handleCommandError } from '../errors/index.js';
import { openInBrowser } from '../../insights/open.js';
import { startWebServer } from '../../web-server/server.js';
import { resolveWebHost, resolveWebPort, resolveWebToken } from '../web-options.js';

/**
 * `afk web` — serve the browser surface for live agent sessions.
 *
 * Contract: this command owns the process for as long as the server runs. It
 * registers SIGINT/SIGTERM handlers so the elicitation handler is uninstalled
 * on the way out; leaving it installed would strand any in-flight approval.
 */
export function registerWebCommand(program: Command): void {
  program
    .command('web')
    .description('Serve a local web UI for live agent sessions')
    .option('-p, --port <port>', 'port to listen on (default 4141, or AFK_WEB_PORT)')
    .option('-H, --host <host>', 'bind address (default 127.0.0.1, or AFK_WEB_HOST)')
    .option('--token <token>', 'bearer token (default: randomly minted per run)')
    .option('--no-open', 'do not open a browser window')
    .action(async (options: { port?: string; host?: string; token?: string; open?: boolean }) => {
      try {
        const port = resolveWebPort(options.port);
        const host = resolveWebHost(options.host);
        const { token } = resolveWebToken(options.token);

        const handle = await startWebServer({
          port,
          host,
          ...(token !== undefined ? { token } : {}),
        });

        console.log(palette.success(`✔ afk web listening on http://${handle.host}:${handle.port}`));
        console.log(palette.info(`  ${handle.url}`));
        if (handle.port !== port) {
          console.log(palette.warning(`  (port ${port} was busy; using ${handle.port})`));
        }
        if (handle.host !== '127.0.0.1' && handle.host !== 'localhost') {
          console.log(
            palette.warning(
              `  Bound to a non-loopback address. This surface can run tools and edit files — ` +
                `keep the token secret and prefer a tunnel over exposing the port.`,
            ),
          );
        }
        console.log(palette.meta('  Press Ctrl+C to stop.'));

        if (options.open !== false) openInBrowser(handle.url);

        // Invariant: teardown is registered BEFORE the process is allowed to
        // idle, so a signal arriving immediately after listen() still unwinds
        // the elicitation handler rather than leaving it installed.
        let stopping = false;
        const shutdown = (): void => {
          if (stopping) return;
          stopping = true;
          void handle.stop().then(() => process.exit(0));
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        // Hold the event loop open.
        await new Promise<void>(() => {});
      } catch (error) {
        handleCommandError(error);
      }
    });
}
