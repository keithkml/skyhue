export function configFromEnv(env = process.env) {
  const required = name => {
    if (!env[name]) throw new Error(`Missing ${name}`);
    return env[name];
  };
  const positive = (name, fallback, min = 1) => {
    const n = Number(env[name] ?? fallback);
    if (!Number.isFinite(n) || n < min) throw new Error(`Invalid ${name}`);
    return n;
  };
  let sensorMap;
  try { sensorMap = JSON.parse(env.SENSOR_MAP_JSON ?? JSON.stringify({
    // Matches the live Pi configuration as of September 2026.
    'Globe Keith office': { uniqueId: '00:17:88:01:04:b6:89:68-02-0400', factor: 0.7 },
  })); } catch { throw new Error('Invalid SENSOR_MAP_JSON'); }
  if (!sensorMap || typeof sensorMap !== 'object' || Array.isArray(sensorMap)) throw new Error('Invalid SENSOR_MAP_JSON');
  for (const mapping of Object.values(sensorMap)) {
    if (!mapping || typeof mapping.uniqueId !== 'string' || !mapping.uniqueId ||
        !Number.isFinite(mapping.factor ?? 1) || (mapping.factor ?? 1) < 0) throw new Error('Invalid SENSOR_MAP_JSON');
  }
  if (env.DRY_RUN && !['true', 'false'].includes(env.DRY_RUN)) throw new Error('DRY_RUN must be true or false');
  return {
    clientId: required('HUE_CLIENT_ID'), clientSecret: required('HUE_CLIENT_SECRET'),
    username: required('HUE_USERNAME'), weatherKey: required('VISUAL_CROSSING_API_KEY'),
    tokenFile: env.HUE_TOKEN_FILE ?? './data/hue.tokens.json', seedTokens: env.HUE_TOKENS_JSON,
    databaseUrl: env.HUE_DATABASE_URL,
    location: env.WEATHER_LOCATION ?? '41.218217,-73.8720515',
    lightPattern: new RegExp(env.LIGHT_NAME_PATTERN ?? '^Globe'), sensorMap,
    pollMs: positive('POLL_SECONDS', 30, 5) * 1000,
    weatherMs: positive('WEATHER_POLL_SECONDS', 300, 60) * 1000,
    staleMs: positive('WEATHER_MAX_AGE_SECONDS', 1800, 300) * 1000,
    dryRun: env.DRY_RUN !== 'false',
  };
}
