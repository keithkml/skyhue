import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COLORS, colorForTemperature, daylightBrightness, desiredState, needsUpdate } from '../color.js';
import { Hue, normalizeTokens } from '../hue.js';
import { Controller } from '../controller.js';
import { getWeather } from '../weather.js';
import { configFromEnv } from '../config.js';

const epoch = Date.parse('2026-09-26T16:00:00Z');
const weather = { temperature: 60, sunrise: epoch / 1000 - 21600, sunset: epoch / 1000 + 21600, observedAt: epoch };
const sensorMap = { 'Globe Keith office': { uniqueId: 'office', factor: 0.7 } };
const config = { lightPattern: /^Globe/, sensorMap, dryRun: false, staleMs: 1800000, weatherMs: 300000 };
const light = { name: 'Globe Keith office', state: { on: true, hue: 1, sat: 1, bri: 1, effect: 'none', colormode: 'hs', reachable: true } };
const sensors = level => ({ '8': { uniqueid: 'office', state: { lightlevel: level }, config: { reachable: true } } });
const json = (data, status = 200, headers) => new Response(JSON.stringify(data), { status, headers });

test('all palette anchors, extremes, and circular interpolation are valid', () => {
  for (const [temperature, hue] of COLORS) assert.deepEqual(colorForTemperature(temperature), { hue, sat: 254 });
  assert.equal(colorForTemperature(-100).hue, 49000);
  assert.equal(colorForTemperature(150).hue, 57719);
  assert.equal(colorForTemperature(55).hue, 24000);
  assert.equal(colorForTemperature(87.5).hue, 1221);
  assert.throws(() => colorForTemperature(NaN));
});

test('brightness follows the sunrise/sunset curve and is independent of server timezone', () => {
  assert.equal(daylightBrightness(500, 1, 101), 0);
  assert.equal(daylightBrightness(13500, 1, 101), 0.5);
  assert.equal(daylightBrightness(51000, 1, 101), 1);
  assert.equal(daylightBrightness(88500, 1, 101), 0.505);
  assert.equal(daylightBrightness(110000, 1, 101), 0.01);
});

test('sensor factor, Hue limits, and dark-room switch-off match the live Pi intent', () => {
  assert.equal(desiredState(light, sensors(12500), weather, epoch, sensorMap).bri, 89);
  assert.equal(desiredState(light, sensors(65000), weather, epoch, sensorMap).bri, 254);
  assert.deepEqual(desiredState(light, sensors(0), weather, epoch, sensorMap), { on: false });
  assert.deepEqual(desiredState(light, sensors(-1), weather, epoch, sensorMap), { on: false });
});

test('missing or unreachable sensor uses daylight and absent bedroom mapping stays absent', () => {
  const bad = sensors(1); bad['8'].config.reachable = false;
  assert.equal(desiredState(light, bad, weather, epoch, sensorMap).bri, 254);
  assert.equal(desiredState(light, {}, weather, epoch, sensorMap).bri, 254);
  assert.equal(desiredState({ name: 'Globe bedroom' }, sensors(0), weather, epoch, sensorMap).bri, 254);
});

test('unchanged lights are not rewritten but a different color mode is corrected', () => {
  const desired = desiredState(light, sensors(12500), weather, epoch, sensorMap);
  assert.equal(needsUpdate({ ...desired, colormode: 'hs' }, desired), false);
  assert.equal(needsUpdate({ ...desired, colormode: 'xy' }, desired), true);
  assert.equal(needsUpdate({ on: false, hue: 100 }, { on: false }), false);
});

test('dry run reads real inputs but never writes; unrelated lights are never targeted', async () => {
  let writes = 0;
  const hue = { inventory: async () => ({ lights: { '1': light, '2': { name: 'Kitchen', state: {} } }, sensors: sensors(12500) }),
    setLight: async () => { writes++; } };
  const controller = new Controller({ ...config, dryRun: true }, hue, { weather: async () => weather, now: () => epoch, log() {} });
  await controller.tick(); assert.equal(writes, 0);
  controller.config = config;
  await controller.tick(); assert.equal(writes, 1);
});

test('failed weather uses fresh cache, then stops writes once observations are stale', async () => {
  let now = epoch, fail = false, writes = 0;
  const hue = { inventory: async () => ({ lights: { '1': light }, sensors: {} }), setLight: async () => { writes++; } };
  const controller = new Controller(config, hue, { weather: async () => { if (fail) throw new Error('Weather HTTP 503'); return weather; }, now: () => now, log() {} });
  await controller.tick(); fail = true; now += 300001;
  await controller.tick(); assert.equal(writes, 2);
  now += 1800000;
  await assert.rejects(controller.tick(), /No fresh weather/); assert.equal(writes, 2);
});

test('missing globes and unreachable bulbs do not report successful cycles', async () => {
  const controller = new Controller(config, { inventory: async () => ({ lights: {}, sensors: {} }) }, { weather: async () => weather, now: () => epoch, log() {} });
  await assert.rejects(controller.tick(), /No globe lights/);
  controller.hue.inventory = async () => ({ lights: { '1': { ...light, state: { reachable: false } } }, sensors: {} });
  await assert.rejects(controller.tick(), /unreachable/);
});

test('weather rejects stale/malformed data and masks credential-bearing network errors', async () => {
  const conf = { location: 'test', weatherKey: 'SECRET', staleMs: 1800000 };
  const data = { currentConditions: { temp: 50, sunriseEpoch: 1, sunsetEpoch: 100, datetimeEpoch: epoch / 1000 } };
  assert.equal((await getWeather(conf, async () => json(data), epoch)).temperature, 50);
  await assert.rejects(getWeather(conf, async () => json(data), epoch + 1800001), /stale/);
  await assert.rejects(getWeather(conf, async () => { throw new Error('https://example?key=SECRET'); }, epoch), /^Error: Weather network request failed$/);
  data.currentConditions.temp = null;
  await assert.rejects(getWeather(conf, async () => json(data), epoch), /invalid/);
});

test('one unplugged globe does not prevent the other globes from updating', async () => {
  const written = [];
  const hue = {
    inventory: async () => ({ lights: { '1': { ...light, state: { reachable: false } }, '2': light }, sensors: {} }),
    setLight: async id => written.push(id),
  };
  const controller = new Controller(config, hue, { weather: async () => weather, now: () => epoch, log() {} });
  await assert.rejects(controller.tick(), /unreachable/);
  assert.deepEqual(written, ['2']);
});

async function fixture(t, fetchImpl, expiresAt = Date.now() + 3600000) {
  const directory = await mkdtemp(join(tmpdir(), 'skyhue-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const conf = { clientId: 'client', clientSecret: 'secret', username: 'user', tokenFile: join(directory, 'tokens.json'),
    seedTokens: JSON.stringify({ access_token: 'old-access', refresh_token: 'old-refresh', expires_at: expiresAt, username: 'user' }) };
  const hue = new Hue(conf, fetchImpl); await hue.initialize();
  return hue;
}

test('rotating OAuth tokens are persisted and loaded instead of stale environment seeds', async t => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    if (url.pathname === '/v2/oauth2/token') {
      assert.equal(options.body.get('grant_type'), 'refresh_token');
      assert.equal(url.search, '');
      assert.equal(options.body.get('refresh_token'), 'old-refresh');
      assert.equal(options.headers.Authorization, `Basic ${Buffer.from('client:secret').toString('base64')}`);
      return json({ access_token: 'new-access', refresh_token: 'new-refresh', access_token_expires_in: '3600' });
    }
    assert.equal(options.headers.Authorization, 'Bearer new-access');
    return json({ lights: {}, sensors: {} });
  };
  const hue = await fixture(t, fetchImpl, 0);
  await hue.inventory(); assert.equal(calls, 2);
  const stored = JSON.parse(await readFile(hue.config.tokenFile, 'utf8'));
  assert.equal(stored.refresh_token, 'new-refresh');
  assert.equal(stored.username, 'user');
  assert.equal((await stat(hue.config.tokenFile)).mode & 0o777, 0o600);
  const restarted = new Hue(hue.config, fetchImpl); await restarted.initialize();
  await restarted.inventory(); assert.equal(calls, 3);
});

test('concurrent expiry checks share one refresh and expired access is retried only once', async t => {
  let refreshes = 0, requests = 0;
  const hue = await fixture(t, async url => {
    if (url.pathname === '/v2/oauth2/token') {
      refreshes++; return json({ access_token: 'new', refresh_token: 'new-refresh', access_token_expires_in: 3600 });
    }
    requests++; return json({ lights: {}, sensors: {} });
  }, 0);
  await Promise.all([hue.inventory(), hue.inventory()]);
  assert.equal(refreshes, 1); assert.equal(requests, 2);
  hue.fetch = async url => url.pathname === '/v2/oauth2/token'
    ? json({ access_token: 'newer', refresh_token: 'newer-refresh', access_token_expires_in: 3600 })
    : json({}, 401);
  await assert.rejects(hue.inventory(), /Hue HTTP 401/);
});

test('Hue HTTP-200 error bodies, empty acknowledgements, and rate limiting propagate', async t => {
  const hue = await fixture(t, async () => json([{ error: { type: 201, description: 'private response' } }]));
  await assert.rejects(hue.setLight('1', { on: true }), /^Error: Hue API error 201$/);
  hue.fetch = async () => json([]);
  await assert.rejects(hue.setLight('1', { on: true }), /acknowledge/);
  hue.fetch = async () => json({}, 429, { 'Retry-After': '90' });
  await assert.rejects(hue.inventory(), error => error.retryAfterMs === 90000);
});

test('corrupt persistent tokens fail closed instead of reusing obsolete seed tokens', async t => {
  const hue = await fixture(t, async () => json({}));
  await writeFile(hue.config.tokenFile, '{SECRET');
  await assert.rejects(new Hue(hue.config).initialize(), /^Error: Cannot read Hue token file$/);
});

test('configuration defaults to read-only and rejects invalid control settings', () => {
  const env = { HUE_CLIENT_ID: 'id', HUE_CLIENT_SECRET: 'secret', HUE_USERNAME: 'user', VISUAL_CROSSING_API_KEY: 'key' };
  assert.equal(configFromEnv(env).dryRun, true);
  assert.equal(configFromEnv(env).sensorMap['Globe bedroom'], undefined);
  assert.throws(() => configFromEnv({ ...env, DRY_RUN: 'FALSE' }));
  assert.throws(() => configFromEnv({ ...env, POLL_SECONDS: '0' }));
  assert.throws(() => normalizeTokens({ access_token: 'x', refresh_token: 'y', access_token_expires_in: 0 }));
});

test('database token rotation is durable before API use and a restart loads the new token', async () => {
  let stored = { access_token: 'old', refresh_token: 'old-refresh', expires_at: 0, username: 'user' };
  let active = true, refreshes = 0;
  const store = {
    async load() { return structuredClone(stored); },
    async save(tokens) { stored = structuredClone(tokens); },
    async assertActive() { if (!active) throw Object.assign(new Error('lock lost'), { fatal: true }); },
  };
  const conf = { clientId: 'client', clientSecret: 'secret', username: 'user' };
  const fetchImpl = async (url, options) => {
    if (url.pathname === '/v2/oauth2/token') {
      refreshes++;
      return json({ access_token: 'new', refresh_token: 'new-refresh', expires_in: 3600 });
    }
    assert.equal(stored.refresh_token, 'new-refresh');
    assert.equal(options.headers.Authorization, 'Bearer new');
    return json({ lights: {}, sensors: {} });
  };
  const hue = new Hue(conf, fetchImpl, store); await hue.initialize(); await hue.inventory();
  const restarted = new Hue(conf, fetchImpl, store); await restarted.initialize(); await restarted.inventory();
  assert.equal(refreshes, 1); assert.equal(stored.username, 'user');
  active = false;
  await assert.rejects(restarted.inventory(), error => error.fatal);
  await assert.rejects(restarted.refresh(), error => error.fatal);
  assert.equal(refreshes, 1);
});

test('failed token persistence blocks API writes and retries saving the rotated token', async () => {
  let saves = 0, refreshes = 0, requests = 0;
  const store = {
    async load() { return { access_token: 'old', refresh_token: 'old-refresh', expires_at: 0 }; },
    async assertActive() {},
    async save(tokens) { assert.equal(tokens.refresh_token, 'new-refresh'); if (++saves === 1) throw new Error('storage failed'); },
  };
  const hue = new Hue({ clientId: 'client', clientSecret: 'secret', username: 'user' }, async url => {
    if (url.pathname === '/v2/oauth2/token') {
      refreshes++;
      return json({ access_token: 'new', refresh_token: 'new-refresh', expires_in: 3600 });
    }
    requests++; return json([{ success: { on: true } }]);
  }, store);
  await hue.initialize();
  await assert.rejects(hue.setLight('1', { on: true }), /storage failed/);
  assert.equal(requests, 0);
  await hue.setLight('1', { on: true });
  assert.equal(requests, 1); assert.equal(refreshes, 1); assert.equal(saves, 2);
});

test('loss of the database lock aborts a cycle before another globe is written', async () => {
  let writes = 0;
  const controller = new Controller(config, {
    inventory: async () => ({ lights: { '1': light, '2': light }, sensors: {} }),
    async setLight() { writes++; throw Object.assign(new Error('lock lost'), { fatal: true }); },
  }, { weather: async () => weather, now: () => epoch, log() {} });
  await assert.rejects(controller.tick(), error => error.fatal);
  assert.equal(writes, 1);
});
