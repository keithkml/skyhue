export class HttpError extends Error {
  constructor(service, status, retryAfterMs = 0) {
    super(`${service} HTTP ${status}`);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export async function requestJson(url, options = {}, service = 'API', fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
  } catch {
    // Do not log URLs, headers, response bodies, or errors that can contain credentials.
    throw new Error(`${service} network request failed`);
  }
  if (!response.ok) {
    const retry = response.headers.get('retry-after');
    const ms = retry ? (Number.isFinite(Number(retry)) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 0;
    throw new HttpError(service, response.status, Math.max(0, ms || 0));
  }
  try { return await response.json(); }
  catch { throw new Error(`${service} returned invalid JSON`); }
}
