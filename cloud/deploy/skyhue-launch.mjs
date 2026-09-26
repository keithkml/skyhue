import { readFile } from 'node:fs/promises';

// Load only in this child so Nest never receives Hue or database credentials.
try {
  const globe = JSON.parse(await readFile(process.env.SKYHUE_CONFIG_FILE || '/etc/secrets/skyhue.json', 'utf8'));
  const allowed = /^(HUE_|VISUAL_CROSSING_API_KEY$|WEATHER_|LIGHT_NAME_PATTERN$|SENSOR_MAP_JSON$|DRY_RUN$|POLL_SECONDS$)/;
  if (!globe || typeof globe !== 'object' || Array.isArray(globe) ||
      Object.keys(globe).some(key => !allowed.test(key)) ||
      Object.values(globe).some(value => typeof value !== 'string')) throw new Error();
  Object.assign(process.env, globe);
} catch {
  console.error(JSON.stringify({ event: 'startup_error', message: 'Missing or invalid Skyhue secret configuration' }));
  process.exit(1);
}
await import('../index.js');
