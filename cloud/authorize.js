import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { exchangeTokens, checkHueResponse, saveTokens } from './hue.js';
import { requestJson } from './http.js';

const clientId = process.env.HUE_CLIENT_ID;
const clientSecret = process.env.HUE_CLIENT_SECRET;
const appId = process.env.HUE_APP_ID;
if (!clientId || !clientSecret || !appId) throw new Error('Set HUE_CLIENT_ID, HUE_CLIENT_SECRET, and HUE_APP_ID');
const state = randomBytes(32).toString('hex');
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const authUrl = new URL('https://api.meethue.com/v2/oauth2/authorize');
authUrl.search = new URLSearchParams({ client_id: clientId, appid: appId, code_challenge: challenge, code_challenge_method: 'S256',
  deviceid: 'skyhue-render', devicename: 'Skyhue on Render', state, response_type: 'code' });
const tokenFile = process.env.HUE_TOKEN_FILE ?? './data/hue.tokens.json';
let completing = false;
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const url = new URL(req.url, 'http://localhost:8787');
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  if (url.pathname === '/') { res.writeHead(302, { Location: authUrl.href }).end(); return; }
  if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
  const received = Buffer.from(url.searchParams.get('state') ?? '');
  if (received.length !== state.length || !timingSafeEqual(received, Buffer.from(state))) {
    res.writeHead(400).end('Invalid OAuth state. Start again from http://localhost:8787.'); return;
  }
  const code = url.searchParams.get('code');
  if (!code || completing) { res.writeHead(400).end('Missing or already used authorization code.'); return; }
  completing = true;
  try {
    const tokens = await exchangeTokens({ clientId, clientSecret }, { grant_type: 'authorization_code', code, ...(url.searchParams.get('pkce') === 'false' ? {} : { code_verifier: verifier }) });
    // Save immediately, before making any other requests.
    await saveTokens(tokenFile, tokens);
    let username = process.env.HUE_USERNAME;
    if (!username) {
      const headers = { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' };
      checkHueResponse(await requestJson('https://api.meethue.com/route/api/0/config', {
        method: 'PUT', headers, body: JSON.stringify({ linkbutton: true }),
      }, 'Hue pairing'));
      const paired = checkHueResponse(await requestJson('https://api.meethue.com/route/api', {
        method: 'POST', headers, body: JSON.stringify({ devicetype: 'skyhue#render' }),
      }, 'Hue pairing'));
      username = paired?.[0]?.success?.username;
      if (!username) throw new Error('Hue pairing did not return a username');
    }
    await saveTokens(tokenFile, { ...tokens, username });
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Hue authorized. Credentials saved locally. You can close this tab.');
    console.log('Hue authorized; tokens and username saved. No lights were changed.');
    server.close();
  } catch (error) {
    console.error(error.message);
    res.writeHead(500).end('Authorization setup failed. Check the local terminal; no credentials are shown here.');
  }
});
server.listen(8787, '127.0.0.1', () => console.log('Register callback http://localhost:8787/callback, then open http://localhost:8787'));
server.requestTimeout = 60000;
setTimeout(() => { server.close(); process.exitCode = 1; }, 15 * 60 * 1000).unref();
