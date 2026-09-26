// Copied from the Pi implementation, intentionally independent of globe.js.
export const COLORS = [
  [10, 49000], [20, 48000], [30, 45000], [40, 41566],
  [50, 32000], [60, 16000], [70, 11086], [75, 7000],
  [80, 4351], [85, 2471], [90, 65507], [95, 57719],
];
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

export function colorForTemperature(temperature) {
  if (!Number.isFinite(temperature)) throw new Error('Invalid temperature');
  let hue = COLORS[0][1];
  for (let i = 0; i < COLORS.length; i++) {
    const [t, h] = COLORS[i];
    if (temperature >= t) hue = h;
    if (temperature < t && i > 0) {
      const [lowerT, lowerH] = COLORS[i - 1];
      const fraction = clamp((temperature - lowerT) / (t - lowerT), 0, 1);
      const delta = ((h - lowerH + 98304) % 65536) - 32768;
      hue = (Math.round(lowerH + delta * fraction) + 65536) % 65536;
      break;
    }
  }
  return { hue, sat: 254 };
}

export function daylightBrightness(now, sunrise, sunset) {
  const position = (now / 1000 - sunrise) / (sunset - sunrise);
  if (position < 0) return 0;
  if (position < 0.25) return position / 0.25;
  if (position < 0.75) return 1;
  if (position < 1) return 0.01 + (1 - (position - 0.75) / 0.25) * 0.99;
  return 0.01;
}

export function desiredState(light, sensors, weather, now, sensorMap) {
  const mapping = sensorMap[light.name];
  const sensor = mapping && Object.values(sensors).find(s => s.uniqueid === mapping.uniqueId);
  const level = sensor?.state?.lightlevel;
  const validSensor = sensor?.config?.reachable !== false && sensor?.state?.valid !== false;
  const fraction = Number.isFinite(level) && validSensor
    ? level / 25000 * (mapping.factor ?? 1)
    : daylightBrightness(now, weather.sunrise, weather.sunset);
  const bri = clamp(Math.round(fraction * (Number.isFinite(level) && validSensor ? 255 : 254)), 0, 254);
  if (bri === 0) return { on: false };
  return { on: true, ...colorForTemperature(weather.temperature), bri, effect: 'none', transitiontime: 0 };
}

export function needsUpdate(current, desired) {
  return Object.entries(desired).some(([key, value]) => key !== 'transitiontime' && current[key] !== value)
    || (desired.on && current.colormode !== 'hs');
}
