# Skyhue on Render

Standalone cloud replacement for the Raspberry Pi globe service. The original
`../globe.js` and its dependencies remain unchanged. This directory intentionally
copies the needed behavior instead of sharing code with the Pi implementation.
Node 22 or later; `pg` supplies PostgreSQL token persistence.

Uses HTTPS requests to the Hue Remote API's `/route/api` v1 bridge endpoints, retaining the
original hue/saturation palette and Hue sensor lightlevel values. A single bridge
snapshot is read every 30 seconds; only changed globe states are written. Weather
is refreshed every five minutes. Only names starting with `Globe` are controlled.

The default sensor mapping matches the live Pi in September 2026: `Globe Keith
office` uses its existing sensor and factor 0.7. Other globes follow the original
sunrise/sunset brightness curve. Set `SENSOR_MAP_JSON` to override mappings, e.g.
`{"Globe Keith office":{"uniqueId":"sensor-unique-id","factor":0.7}}`.

Fixes exact-temperature-anchor interpolation, clamps brightness to Hue's 0–254
range, turns off a globe at zero calculated brightness, and avoids overlapping
polls. Unreachable/invalid sensors fall back to daylight brightness. Failed weather
requests retain fresh cached conditions; after 30 minutes without current weather,
lights are left unchanged. Errors back off, including HTTP Retry-After responses.
Shutdown finishes the current bounded cycle and leaves the lights as they are.

## Authorize Hue once

1. Register a Remote Hue API app in the Hue developer portal, with callback
   `http://localhost:8787/callback`.
2. Set `HUE_CLIENT_ID`, `HUE_CLIENT_SECRET`, and `HUE_APP_ID` locally. Run
   `npm run authorize` and open `http://localhost:8787`. Approve the app in Hue.
3. Authorization saves private `data/hue.tokens.json`, including a dedicated Hue
   username. The callback validates OAuth state; tokens never appear in logs or
   browser responses. The local listener expires after 15 minutes.
4. Set `HUE_USERNAME` to the generated username. Seed the selected token store
   with the file's JSON once. Set the weather API key from the Pi service.

OAuth uses the current `/v2/oauth2` endpoints, PKCE, and Basic authentication over HTTPS (Hue has retired Digest auth). Rotated
tokens are persisted before further Hue requests. Do not run a second local copy
against tokens already in use on Render; the original authorization file becomes
stale after a token refresh.

## Existing Render worker deployment

The selected deployment shares `dailey-nest-logger` and the existing `keithdb`
database, avoiding another paid worker or disk. All globe code and deployment
configuration live in `keithkml/skyhue` on `master`. Nest's source stays in
`keithkml/nest-logger`; `deploy/build.sh` fetches a pinned revision into an ignored
build directory. Neither repository contains a copy of the other app's source.

Render uses root directory `cloud`, build command `bash deploy/build.sh`, and
start command `.runtime/bin/node deploy/shared-worker.cjs`, with a 120-second
shutdown delay. The supervisor restarts each app independently. Build scripts
install checksum-verified Node 14.17.0 for Nest and Node 22.22.3 for the globe.

`HUE_DATABASE_URL` selects PostgreSQL storage. Use the external database address
with certificate verification; URL options that override TLS are rejected. A
dedicated `skyhue_runtime` login has only schema usage and SELECT/UPDATE on
`skyhue.oauth_tokens` (columns `id text PRIMARY KEY`, `tokens jsonb NOT NULL`,
`updated_at timestamptz NOT NULL DEFAULT now()`). Seed row `globes` once using an
administrative connection. The app holds a session advisory lock while running,
so a replacement deployment waits for the previous controller to stop before
reading or rotating credentials. Lost database connections stop the controller.

Configuration goes in Render secret file `skyhue.json`: a JSON object of string
values including `HUE_CLIENT_ID`, `HUE_CLIENT_SECRET`, `HUE_USERNAME`,
`HUE_DATABASE_URL`, `VISUAL_CROSSING_API_KEY`, and `DRY_RUN`. The supervisor loads
these only in the globe child; the existing Nest secret file remains separate.

Start with `DRY_RUN=true` (the default). Verify logs show `weather`, the correct
globe names in `would_update`, and repeated `cycle_ok` events. Then set
`DRY_RUN=false` and deploy. After Hue acknowledges a real update, stop and disable
only the Pi's `globe.service`:

```sh
ssh raspberrypi.local sudo systemctl disable --now globe.service
```

Verify several more successful Render cycles and the Pi's inactive/disabled state.
Do not power off the Pi or remove its code. To roll back, restore the shared
worker's original `keithkml/nest-logger` repository and `master` branch, clear its
root directory, restore build `npm install` and start `npm start`,
then run `sudo systemctl enable --now globe.service` on the Pi. Suspending the
shared worker would also stop Nest, so restore its original deployment instead.

## Optional standalone deployment

`render.yaml` is an optional template for a separate paid worker and disk; it is
not used by the shared deployment. In file-storage mode, set
`HUE_TOKEN_FILE=/var/data/hue.tokens.json` and `HUE_TOKENS_JSON` to the initial
authorization JSON. Atomic writes to that persistent disk take precedence over
the seed. Keep one instance; losing the disk after rotation requires fresh
authorization.

For a local read-only check, load the environment and run `node index.js --once`
with `DRY_RUN=true`. `npm test` exercises colors, sensor fallback, failure handling,
token rotation, and write acknowledgements with fake APIs.

References: [Hue remote setup](https://developers.meethue.com/develop/hue-api/remote-api-quick-start-guide/),
[Hue Digest retirement](https://developers.meethue.com/deprecation-of-support-for-digest-authentication/),
[Render workers](https://render.com/docs/background-workers), and
[persistent disks](https://render.com/docs/disks).
