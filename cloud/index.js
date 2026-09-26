import { setTimeout as sleep } from 'node:timers/promises';
import { configFromEnv } from './config.js';
import { Hue } from './hue.js';
import { Controller } from './controller.js';
import { PostgresTokens } from './postgres-tokens.js';

const stop = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop.abort());
let store;
try {
  const config = configFromEnv();
  if (config.databaseUrl) {
    store = new PostgresTokens(config.databaseUrl);
    await store.initialize(stop.signal);
  }
  const hue = new Hue(config, fetch, store);
  await hue.initialize();
  const controller = new Controller(config, hue);
  console.log(JSON.stringify({ event: 'started', dryRun: config.dryRun, pollSeconds: config.pollMs / 1000 }));
  let failures = 0;
  while (!stop.signal.aborted) {
    let delay = config.pollMs;
    try { await controller.tick(); failures = 0; }
    catch (error) {
      if (error.fatal) throw error;
      delay = Math.max(error.retryAfterMs || 0, Math.min(300000, config.pollMs * 2 ** Math.min(++failures, 6)));
      console.error(JSON.stringify({ event: 'cycle_error', message: error.message, retryInSeconds: delay / 1000 }));
    }
    if (process.argv.includes('--once')) {
      if (failures) process.exitCode = 1;
      break;
    }
    try { await sleep(delay, undefined, { signal: stop.signal }); }
    catch (error) { if (error.name !== 'AbortError') throw error; }
  }
  console.log(JSON.stringify({ event: 'stopped' }));
} catch (error) {
  console.error(JSON.stringify({ event: 'startup_error', message: error.message }));
  process.exitCode = 1;
} finally {
  await store?.close();
}
