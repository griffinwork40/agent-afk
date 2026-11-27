import type { Telegraf } from 'telegraf';

/** Split polling readiness from the lifetime promise returned by Telegraf's launch(). */
export function launchTelegramPolling(bot: Telegraf, config: Pick<Telegraf.LaunchOptions, 'allowedUpdates'>) {
  const telegram = bot.telegram;
  const callApi = telegram.callApi;
  let markReady!: () => void;
  const firstPoll = new Promise<void>((resolve) => { markReady = resolve; });
  const restore = () => {
    if (telegram.callApi === observeFirstPoll) telegram.callApi = callApi;
  };
  // onLaunch runs before deleteWebhook. The first getUpdates call is the
  // earliest signal that both startup RPCs succeeded and stop() can abort
  // polling. Don't wait for its response: an idle poll can take 50 seconds.
  const observeFirstPoll: typeof callApi = (method, payload, options) => {
    if (method === 'getUpdates') {
      restore();
      markReady();
    }
    return callApi.call(telegram, method, payload, options) as ReturnType<typeof callApi<typeof method>>;
  };
  telegram.callApi = observeFirstPoll;
  const polling = bot.launch(config).finally(restore);
  const ready = Promise.race([
    firstPoll,
    polling.then(() => { throw new Error('Telegram polling ended before startup completed'); }),
  ]);
  return { ready, polling };
}
