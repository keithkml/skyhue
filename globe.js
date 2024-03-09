let huejay = require("huejay")
let fetch = require("node-fetch")

// see readme
const USERNAME = process.env.HUE_USERNAME
const LIGHT_NAME_PATTERN = "Globe.*"
const address = "41.218217,-73.8720515"

const visualCrossingApiKey = process.env.VISUAL_CROSSING_API_KEY;

if (!USERNAME) {
  console.log("ERROR: $HUE_USERNAME is not set");
  process.exit(1);
}

if (!visualCrossingApiKey) {
  console.log("ERROR: $VISUAL_CROSSING_API_KEY is not set");
  process.exit(1);
}

const NIGHT_BRIGHTNESS = 0.01

const COLORS = {
  10: {
    hue: 49000,
  },
  20: {
    hue: 48000,
  },
  30: {
    hue: 45000,
  },
  40: {
    hue: 41566,
  },
  50: {
    hue: 32000,
  },
  60: {
    hue: 16000,
  },
  70: {
    hue: 11086,
  },
  75: {
    hue: 7000,
  },
  80: {
    hue: 4351,
  },
  85: {
    hue: 2471,
  },
  90: {
    hue: 65507,
  },
  95: {
    hue: 57719,
  },
}

// Global variables
let sunrise = 0
let sunset = 0
let temperature = 0
let client
let lightIds = []
let sensorIdsByUniqueId = {}
let SENSOR_UNIQUE_IDS_BY_LIGHT_NAME = {
  "Globe Keith office": "00:17:88:01:04:b6:89:68-02-0400",
  "Globe bedroom": "00:17:88:01:06:f5:f1:d5-02-0400",
}
let LIGHT_FACTORS = {
  "Globe Keith office": 0.7,
  "Globe bedroom": 1.1,
}

function exitHorribly() {
  setColor({ on: false }).then(() => process.exit(1))
  setTimeout(() => process.exit(1), 5 * 1000)
}

function convertLightLevelToBrightnessFraction(lightLevelFromSensor) {
  return lightLevelFromSensor / 25000
}

/**
 * @param obj {on: boolean, brightness: 0-254, hue: 0-65535, saturation: 0-254, transitionTime: 0-5}
 */
function setColor(obj) {
  return (
    client &&
    client.lights &&
    Promise.all(
      lightIds.map(lightId =>
        client.lights.getById(lightId).then(light => {
          console.log("light was", light)
          const sensorUniqueId = SENSOR_UNIQUE_IDS_BY_LIGHT_NAME[light.attributes.attributes.name]
          console.log("unique id: ", sensorUniqueId)
          const sensorId = sensorIdsByUniqueId[sensorUniqueId]
          console.log("sensor id: ", sensorId)
          if (sensorId) {
            return client.sensors.getById(sensorId).then(sensor => {
              light.effect = "none"
              light.transitionTime = 0
              Object.assign(light, obj)
              if ("lightlevel" in sensor.state.attributes.attributes) {
                const level = sensor.state.attributes.attributes.lightlevel
                console.log("light level for " + light.name + " is " + level)
                let b = convertLightLevelToBrightnessFraction(level) * 255
                if (light.name in LIGHT_FACTORS) {
                  b *= LIGHT_FACTORS[light.name]
                }
                b = Math.round(b)
                console.log("desired brightness before clamp ", b)
                if (b > 255) {
                  b = 255
                }
                if (b < 0) {
                  b = 0
                }
                light.on = b > 0
                light.brightness = b
              } else {
                console.log("sensor for " + light.name + " is missing lightlevel prop")
              }
              console.log("setting color after sensor", light)
              return client.lights.save(light)
            })
          } else {
            console.log("setting color without sensor", obj)
            light.effect = "none"
            light.transitionTime = 0
            Object.assign(light, obj)
            return client.lights.save(light)
          }
        })
      )
    )
  )
}

function getColorForTemperature(temp) {
  let lower, upper
  for (let i = 0; (!lower || !upper) && i < 100; i++) {
    if (!lower) {
      const tlower = Math.floor(temp - i)
      if (COLORS[tlower]) {
        lower = tlower
      }
    }
    if (!upper) {
      const tupper = Math.ceil(temp + i)
      if (COLORS[tupper]) {
        upper = tupper
      }
    }
  }
  if (!lower) return COLORS[upper]
  if (!upper) return COLORS[lower]
  const frac = (temp - lower) / (upper - lower)
  console.log(frac, lower, upper)
  return {
    hue: Math.round(interpolateColor(COLORS[lower].hue, COLORS[upper].hue, frac)),
    saturation: 254,
  }
}

function interpolateColor(h1, h2, frac) {
  frac = Math.max(0, Math.min(1, frac))
  if (h1 > h2) return interpolateColor(h2, h1, 1 - frac)
  if (h2 - h1 > 32000) return interpolate(h1 + 65536, h2, frac) % 65536
  return interpolate(h1, h2, frac)
}

function interpolate(a, b, frac) {
  return a * (1 - frac) + b * frac
}

function setColorForTemperature(temp, brightness) {
  setColor({
    ...getColorForTemperature(temp),
    brightness: Math.round(brightness * 254),
    on: true,
  })
}

const isBeforeWakeupTime = () => new Date().getHours() < 7
const isAfterBedtime = () => new Date().getHours() >= 21

function getBrightness(position) {
  if (position < 0) return 0
  if (position < 0.25) return position / 0.25
  if (position < 0.75) return 1
  if (position < 1)
    return NIGHT_BRIGHTNESS + (1 - (position - 0.75) / 0.25) * (1 - NIGHT_BRIGHTNESS)
  return NIGHT_BRIGHTNESS
}

function updateForecast() {
  console.log("updating forecast...")
  fetch(`https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${encodeURIComponent(
    address
  )}?unitGroup=us&include=current&key=${visualCrossingApiKey}&contentType=json`)
    .then(res => {
      if (!res.ok) {
        console.log("got non-200 response", res)
        setColor({ on: false })
        return
      }
      res.json().then(json => {
        console.log("got response: ", json);

        // console.log(weather)
        console.log("currently: " + json.currentConditions)
        //	    if (weather.precipProbability > 0 && weather.precipIntensity > 0) {
        //		setColorForRain()
        //	    } else {
        sunrise = json.currentConditions.sunriseEpoch
        sunset = json.currentConditions.sunsetEpoch
        temperature = json.currentConditions.temp
        updateGlobes()
      })
    })
    .catch(error => {
      console.error(error)
      setColor({ on: false })
    })
}

function updateGlobes() {
  const time = Math.floor(new Date().getTime() / 1000)
  // assume midnight if sunset/sunrise not set yet
  let positionInDaylightWindow = sunrise && sunset ? (time - sunrise) / (sunset - sunrise) : 0
  console.log("position in daylight window: " + positionInDaylightWindow)
  //		if (positionInDaylightWindow < 0
  setColorForTemperature(temperature, getBrightness(positionInDaylightWindow))
}

function startPolls() {
  console.log("Starting weather check loop")
  updateForecast()
  setInterval(updateForecast, 5 * 60 * 1000)
  setInterval(updateGlobes, 5 * 1000)
}

huejay
  .discover()
  .then(bridges => {
    let bridge = bridges[0]
    console.log("Using bridge " + bridge.ip)
    client = new huejay.Client({
      host: bridge.ip,
      username: USERNAME,
    })
    client.lights.getAll().then(lights => {
      const globes = lights.filter(l => l.name.match(LIGHT_NAME_PATTERN))
      lightIds = globes.map(l => l.id)
      console.log("Found lights", lights)
      startPolls()
    })
    client.sensors.getAll().then(sensors => {
      // Just print this to make it easier to manually update
      const lightSensors = sensors.filter(s => s.type == "ZLLLightLevel")
      console.log("all light sensors ")
      console.dir(lightSensors, { depth: null })
      lightSensors.forEach(
        s => (sensorIdsByUniqueId[s.attributes.attributes.uniqueid] = s.attributes.attributes.id)
      )
      console.log(sensorIdsByUniqueId)
    })
  })
  .catch(error => {
    console.log(`An error occurred: ${error.message}`, error)
    exitHorribly()
  })

module.exports = {
  setColor,
}
