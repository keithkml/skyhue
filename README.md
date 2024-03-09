# skyhue
Change a Philips Hue light based on the weather outside

This runs on the LAN. I run it via node.js on a Raspberry Pi in my home.

```
export VISUAL_CROSSING_API_KEY=da39a3ee5e6b4b0d3255bfef95601890afd80709
export HUE_USERNAME=
node globe.js
```

## Visual Crossing API key

Your Visual Crossing weather API Key is shown at https://www.visualcrossing.com/account.

## Hue username

 Generate username using instructions at https://developers.meethue.com/develop/get-started-2/#so-lets-get-started

 ## Troubleshooting

 If you get `An error occurred: Huejay: Failed to get results from meethue HuejayError: Huejay: Failed to get results from meethue` you're probably rate limited - see https://www.reddit.com/r/Hue/comments/wxi9wf/discoverymeethuecom_429_error/ - you probably have to wait 15 minutes.