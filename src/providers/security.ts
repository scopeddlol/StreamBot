import { ProviderError } from './types.js';

export function validateBaseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ProviderError('Invalid provider baseUrl', 400); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ProviderError('Provider URL must be HTTP(S) without credentials, query or fragment', 400);
  }
  url.pathname = url.pathname.replace(/\/$/, '') + '/';
  return url;
}
export function allowedUrl(value: string, base: URL): URL {
  let url: URL;
  try { url = new URL(value, base); } catch { throw new ProviderError('Invalid provider media URL'); }
  if (url.origin !== base.origin || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) {
    throw new ProviderError('Provider returned a URL outside its configured origin');
  }
  return url;
}
export function mediaId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(value)) throw new ProviderError('Invalid media identifier', 400);
  return value;
}
export function safeError(error: unknown): string {
  return error instanceof ProviderError ? error.message : 'Operation failed; check server connectivity and configuration';
}
export async function fetchAllowed(url: URL, base: URL, init: RequestInit = {}): Promise<Response> {
  let target = allowedUrl(url.href, base);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetch(target, { ...init, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
        await response.body?.cancel();
        target = allowedUrl(new URL(response.headers.get('location')!, target).href, base);
        if (init.method && init.method !== 'GET' && init.method !== 'HEAD') throw new ProviderError('Provider redirected a negotiation request');
        continue;
      }
      return response;
    }
    throw new ProviderError('Too many provider redirects');
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (init.signal?.aborted) throw new ProviderError('Provider request cancelled or timed out', 504);
    throw new ProviderError('Provider unreachable; check container DNS, listener and TLS certificate');
  }
}
export function statusError(status: number): ProviderError {
  const messages: Record<number, string> = {
    401: 'Provider credential expired or invalid; update the token or compatibility login',
    403: 'Provider denied access; check account/profile and playback permissions',
    404: 'Media or endpoint unavailable; check item ID and compatibility listener',
    429: 'Provider rate limited requests; retry shortly',
  };
  return new ProviderError(messages[status] || 'Provider failed to serve this request', status >= 400 && status < 500 ? status : 502);
}
