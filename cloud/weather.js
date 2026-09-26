import { requestJson } from './http.js';

export async function getWeather(config, fetchImpl = fetch, now = Date.now()) {
  const url = new URL(`https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${encodeURIComponent(config.location)}`);
  url.search = new URLSearchParams({ unitGroup: 'us', include: 'current', key: config.weatherKey, contentType: 'json' });
  const data = await requestJson(url, {}, 'Weather', fetchImpl);
  const current = data?.currentConditions;
  if (!current || ![current.temp, current.sunriseEpoch, current.sunsetEpoch, current.datetimeEpoch].every(Number.isFinite)
      || current.sunsetEpoch <= current.sunriseEpoch || Math.abs(now - current.datetimeEpoch * 1000) > config.staleMs)
    throw new Error('Weather returned invalid or stale current conditions');
  return { temperature: current.temp, sunrise: current.sunriseEpoch, sunset: current.sunsetEpoch, observedAt: current.datetimeEpoch * 1000 };
}
