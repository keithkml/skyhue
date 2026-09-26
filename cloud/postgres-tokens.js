import pg from 'pg';
import { setTimeout as sleep } from 'node:timers/promises';

function storageError() {
  const error = new Error('Hue token database connection unavailable; stopping this controller');
  error.fatal = true;
  return error;
}

// A session lock also prevents two deployments from rotating the same tokens.
// This uses a dedicated role limited to the skyhue.oauth_tokens table.
export class PostgresTokens {
  constructor(connectionString, { key = 'globes', log = console.log } = {}) {
    const url = new URL(connectionString);
    if ([...url.searchParams.keys()].some(key => key.startsWith('ssl')))
      throw new Error('HUE_DATABASE_URL must not override TLS verification');
    this.client = new pg.Client({
      connectionString, ssl: { rejectUnauthorized: true },
      connectionTimeoutMillis: 15000, query_timeout: 15000,
      keepAlive: true, keepAliveInitialDelayMillis: 10000,
      application_name: 'skyhue',
    });
    this.key = key;
    this.log = log;
    this.client.on('error', () => { this.failed = true; });
    this.client.on('end', () => { if (!this.closing) this.failed = true; });
  }
  async initialize(signal) {
    try {
      await this.client.connect();
      let reported = false;
      while (!signal?.aborted) {
        const result = await this.client.query('SELECT pg_try_advisory_lock(1397442632, hashtext($1)) AS acquired', [this.key]);
        if (result.rows[0].acquired) {
          this.locked = true;
          this.log(JSON.stringify({ event: 'controller_lock_acquired' }));
          return;
        }
        if (!reported) this.log(JSON.stringify({ event: 'waiting_for_previous_controller' }));
        reported = true;
        await sleep(3000, undefined, { signal });
      }
      throw new Error('Controller stopped before acquiring database lock');
    } catch {
      await this.close();
      if (signal?.aborted) throw new Error('Controller stopped during startup');
      throw storageError();
    }
  }
  async assertActive() {
    if (this.failed || !this.locked) throw storageError();
    try { await this.client.query('SELECT 1'); }
    catch { this.failed = true; throw storageError(); }
  }
  async load() {
    await this.assertActive();
    const result = await this.query('SELECT tokens FROM skyhue.oauth_tokens WHERE id=$1', [this.key]);
    if (!result.rowCount) throw new Error('Hue token database is not initialized');
    return result.rows[0].tokens;
  }
  async save(tokens) {
    await this.assertActive();
    const result = await this.query(
      'UPDATE skyhue.oauth_tokens SET tokens=$2::jsonb, updated_at=now() WHERE id=$1',
      [this.key, JSON.stringify(tokens)],
    );
    if (result.rowCount !== 1) throw new Error('Hue token database row missing');
  }
  async query(sql, values) {
    try { return await this.client.query(sql, values); }
    catch { this.failed = true; throw storageError(); }
  }
  async close() {
    this.closing = true;
    this.locked = false;
    await this.client.end().catch(() => {});
  }
}
