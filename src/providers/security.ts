import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
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
      const response = await pinnedFetch(target, init);
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

export async function networkAddresses(url: URL, allowPrivate = true) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(metadata|metadata\.google\.internal|instance-data)(\.|$)/i.test(host)) throw new ProviderError('Metadata destinations are not allowed');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  for (const { address } of addresses) {
    const ip = address.toLowerCase();
    let mapped = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    if(ip.startsWith('::ffff:')&&mapped.includes(':')){const parts=mapped.split(':').map(p=>parseInt(p,16));if(parts.length===2)mapped=[parts[0]>>8,parts[0]&255,parts[1]>>8,parts[1]&255].join('.');}
    if (/^(169\.254\.|0\.|2(2[4-9]|[3-5][0-9])\.)/.test(mapped) || mapped === '100.100.100.200' || /^(fe[89ab]|ff)/.test(ip) || ip === '::' || ip==='fd00:ec2::254') throw new ProviderError('Link-local, metadata and multicast destinations are not allowed');
    if (!allowPrivate && (/^(10\.|127\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(mapped) || ip === '::1' || /^f[cd]/.test(ip))) throw new ProviderError('Private AI endpoints require explicit private-network permission');
  }
  if (!addresses.length) throw new ProviderError('Provider DNS returned no addresses');
  return addresses;
}
async function pinnedFetch(url: URL, init: RequestInit) {
  if (init.signal?.aborted) throw new ProviderError('Provider request cancelled or timed out',504);
  const addresses = await networkAddresses(url);
  return new Promise<Response>((resolve, reject) => {
    const target = addresses[0];
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: init.method || 'GET', headers: Object.fromEntries(new Headers(init.headers).entries()),
      lookup: ((_hostname: string, options: any, callback: any) => options.all ? callback(null, [target]) : callback(null, target.address, target.family)) as any,
    }, incoming => {
      const headers = new Headers(); for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      const empty = init.method === 'HEAD' || [204,304].includes(incoming.statusCode!);
      const response = new Response(empty ? null : Readable.toWeb(incoming) as any, { status: incoming.statusCode, headers });
      Object.defineProperty(response, 'url', { value: url.href });
      if (empty) incoming.resume(); resolve(response);
    });
    const abort = () => { request.destroy(); reject(new ProviderError('Provider request cancelled or timed out',504)); };
    init.signal?.addEventListener('abort', abort, { once: true });
    request.once('close', () => init.signal?.removeEventListener('abort', abort));
    request.once('error', reject);
    if (init.signal?.aborted) { abort(); return; }
    if (init.body) request.write(init.body); request.end();
  });
}
