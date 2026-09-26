import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { requestJson } from './http.js';

const ORIGIN = 'https://api.meethue.com';

export async function saveTokens(path, tokens) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  const file = await open(temporary, 'w', 0o600);
  try { await file.writeFile(JSON.stringify(tokens)); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
}

export function normalizeTokens(data, now = Date.now()) {
  const expires = Number(data.access_token_expires_in ?? data.expires_in);
  if (!data.access_token || !data.refresh_token || !Number.isFinite(expires) || expires <= 0)
    throw new Error('Hue returned invalid OAuth tokens');
  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: now + expires * 1000 };
}

export async function exchangeTokens(config, parameters, fetchImpl = fetch) {
  const url = new URL('/v2/oauth2/token', ORIGIN);
  const body = new URLSearchParams(parameters);
  const started = Date.now();
  const data = await requestJson(url, {
    method: 'POST', body,
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json',
    },
  }, 'Hue OAuth', fetchImpl);
  return normalizeTokens(data, started);
}

export function checkHueResponse(data) {
  if (Array.isArray(data)) {
    const error = data.find(entry => entry.error)?.error;
    if (error) throw new Error(`Hue API error ${Number(error.type) || 'unknown'}`);
  }
  return data;
}

export class Hue {
  constructor(config, fetchImpl = fetch, store) { this.config = config; this.fetch = fetchImpl; this.store = store; }
  async initialize() {
    if (this.store) this.tokens = await this.store.load();
    else {
      try { this.tokens = JSON.parse(await readFile(this.config.tokenFile, 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw new Error('Cannot read Hue token file');
        if (!this.config.seedTokens) throw new Error('Authorize Hue first: no saved OAuth tokens');
        try { this.tokens = JSON.parse(this.config.seedTokens); }
        catch { throw new Error('Invalid HUE_TOKENS_JSON'); }
        await saveTokens(this.config.tokenFile, this.tokens);
      }
    }
    if (!this.tokens?.access_token || !this.tokens?.refresh_token || !Number.isFinite(this.tokens?.expires_at))
      throw new Error('Invalid saved Hue tokens');
  }
  async refresh() {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        await this.store?.assertActive();
        const tokens = await exchangeTokens(this.config, {
          grant_type: 'refresh_token', refresh_token: this.tokens.refresh_token,
        }, this.fetch);
        // Keep the newest rotating token in memory even if persistence temporarily fails.
        this.tokens = { ...this.tokens, ...tokens };
        this.unsaved = true;
        await this.persist();
        this.unsaved = false;
      })().finally(() => { this.refreshing = null; });
    }
    await this.refreshing;
  }
  async persist() {
    if (this.store) await this.store.save(this.tokens);
    else await saveTokens(this.config.tokenFile, this.tokens);
  }
  async request(path, method = 'GET', body, retry = true) {
    await this.store?.assertActive();
    if (this.unsaved) { await this.persist(); this.unsaved = false; }
    if (this.tokens.expires_at < Date.now() + 60000) await this.refresh();
    const url = new URL(`/route/api/${encodeURIComponent(this.config.username)}${path}`, ORIGIN);
    try {
      const data = await requestJson(url, {
        method, headers: { Authorization: `Bearer ${this.tokens.access_token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, 'Hue', this.fetch);
      return checkHueResponse(data);
    } catch (error) {
      if (retry && error.status === 401) {
        await this.refresh();
        return this.request(path, method, body, false);
      }
      throw error;
    }
  }
  async inventory() {
    // One request per poll obtains consistent lights and sensor readings.
    const data = await this.request('');
    if (!data?.lights || !data?.sensors || Array.isArray(data)) throw new Error('Hue returned invalid bridge inventory');
    return { lights: data.lights, sensors: data.sensors };
  }
  async setLight(id, state) {
    const data = await this.request(`/lights/${encodeURIComponent(id)}/state`, 'PUT', state);
    if (!Array.isArray(data) || data.length === 0 || data.some(item => !item.success))
      throw new Error('Hue did not acknowledge light update');
  }
}
