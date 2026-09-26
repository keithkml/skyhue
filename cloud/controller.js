import { desiredState, needsUpdate } from './color.js';
import { getWeather } from './weather.js';

export class Controller {
  constructor(config, hue, { weather = getWeather, log = console.log, now = Date.now } = {}) {
    Object.assign(this, { config, hue, weather, log, now });
    this.nextWeatherAt = 0;
    this.weatherFailures = 0;
  }
  async tick() {
    let now = this.now();
    if (now >= this.nextWeatherAt) {
      try {
        this.forecast = await this.weather(this.config);
        this.nextWeatherAt = now + this.config.weatherMs;
        this.weatherFailures = 0;
        this.log(JSON.stringify({ event: 'weather', temperatureF: this.forecast.temperature }));
      } catch (error) {
        this.nextWeatherAt = now + Math.max(error.retryAfterMs || 0, Math.min(this.config.weatherMs, 30000 * 2 ** Math.min(++this.weatherFailures, 4)));
        this.log(JSON.stringify({ event: 'weather_error', message: error.message }));
      }
    }
    now = this.now();
    if (!this.forecast || now - this.forecast.observedAt > this.config.staleMs)
      throw new Error('No fresh weather; leaving lights unchanged');
    const { lights, sensors } = await this.hue.inventory();
    const globes = Object.entries(lights).filter(([, light]) => this.config.lightPattern.test(light.name));
    if (!globes.length) throw new Error('No globe lights matched LIGHT_NAME_PATTERN');
    let writes = 0;
    const failures = [];
    for (const [id, light] of globes) {
      try {
        if (light.state?.reachable === false) throw new Error(`Globe light ${id} is unreachable`);
        const desired = desiredState(light, sensors, this.forecast, now, this.config.sensorMap);
        if (needsUpdate(light.state ?? {}, desired)) {
          if (!this.config.dryRun) await this.hue.setLight(id, desired);
          writes++;
          this.log(JSON.stringify({ event: this.config.dryRun ? 'would_update' : 'updated', light: light.name, state: desired }));
        }
      } catch (error) {
        if (error.status === 429 || error.fatal) throw error;
        failures.push(error.message);
      }
    }
    if (failures.length) throw new Error(failures.join('; '));
    this.log(JSON.stringify({ event: 'cycle_ok', globes: globes.length, writes, dryRun: this.config.dryRun }));
  }
}
