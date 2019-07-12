let huejay = require('huejay')
let fetch = require('node-fetch')

// Generate username using instructions at:
// https://developers.meethue.com/develop/get-started-2/#so-lets-get-started
const USERNAME = process.env.HUE_USERNAME
const LIGHT_NAME = 'Globe'
const LOCATION = '40.6718891,-73.9728584'
// Get a free Dark Sky API key at https://darksky.net/dev/docs
const DARKSKY_API_KEY = process.env.DARKSKY_API_KEY

const NIGHT_BRIGHTNESS = .12

const COLORS = {
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
	hue: 57719,
    },
    95: {
	hue: 65507,
    }
}

// Global variables
let client;
let lightId;

function exitHorribly() {
    setColor({on: false}).then(() => process.exit(1))
    setTimeout(() => process.exit(1), 5 * 1000)
}

/**
 * @param obj {on: boolean, brightness: 0-254, hue: 0-65535, saturation: 0-254, transitionTime: 0-5}
 */
function setColor(obj) {
    return client.lights.getById(lightId).then(light => {
	console.log("light was", light)
	console.log("setting color", obj)
	light.effect = "none"
	light.transitionTime = 0
	Object.assign(light, obj)
	return client.lights.save(light)
    })
}

function getColorForTemperature(temp) {
    let lower, upper;
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
	saturation: 254
    }
}

function interpolateColor(h1, h2, frac) {
    frac = Math.max(0, Math.min(1, frac))
    if (h1 > h2)
	return interpolateColor(h2,h1, 1-frac)
    if (h2 - h1 > 32000)
	return interpolate(h1+65536, h2, frac) % 65536
    return interpolate(h1, h2, frac)
}

function interpolate(a, b, frac) {
    return a*(1-frac)+b*frac
}

function setColorForTemperature(temp, brightness) {
    setColor({
	...getColorForTemperature(temp),
	brightness: Math.round(brightness * 254),
	on: true
    })
}

const isAfterBedtime = () => new Date().getHours() >= 22

function getBrightness(position) {
    if (position < 0) return 0
    if (position < 0.25) return position / 0.25
    if (position < 0.75) return 1
    if (position < 1) return NIGHT_BRIGHTNESS + ((1 - ((position - 0.75) / 0.25)) * (1 - NIGHT_BRIGHTNESS))
    return NIGHT_BRIGHTNESS
}

function updateForecast() {
    console.log("updating forecast...");
    fetch('https://api.darksky.net/forecast/' + DARKSKY_API_KEY + '/'+LOCATION)
	.then(res => {
	    if (!res.ok) {
		console.log("got non-200 response", res)
		setColor({on: false})
		return
	    }
	    res.json().then(weather => {
		console.log(weather)
		console.log("currently: " + weather.currently.summary)
		console.log("minutely: " + weather.minutely.summary)
		console.log("daily: " + weather.daily.summary)
		//	    if (weather.precipProbability > 0 && weather.precipIntensity > 0) {
		//		setColorForRain()
		//	    } else {
		const today = weather.daily.data[0]
		const time = Math.floor(new Date().getTime()/1000)
		const sunrise = today.sunriseTime
		const sunset = today.sunsetTime
		let positionInDaylightWindow = (time - sunrise) / (sunset - sunrise)
		console.log("position in daylight window: " + positionInDaylightWindow)
		if (positionInDaylightWindow < 0 || isAfterBedtime()) {
		    console.log("light should be off")
		    setColor({on: false})
		} else {
		    setColorForTemperature(weather.currently.temperature, getBrightness(positionInDaylightWindow))
		}
	    })
	})
	.catch(error => {
	    console.error(error)
	    setColor({on: false})
	})
}

function startWeatherCheck() {
    console.log("Starting weather check loop")
    updateForecast()
    setInterval(updateForecast, 5 * 60 * 1000)
}
    
huejay.discover()
    .then(bridges => {
	let bridge = bridges[0]
	console.log("Using bridge " + bridge.ip)
	client = new huejay.Client({
	    host: bridge.ip,
	    username: USERNAME
	})
	client.lights.getAll()
	    .then(lights => {
		const light = lights.find(l => l.name == LIGHT_NAME)
		lightId = light.id;
		console.log("Found light", light)
		startWeatherCheck();
	    })
    })
    .catch(error => {
	console.log(`An error occurred: ${error.message}`)
	exitHorribly()
    });
