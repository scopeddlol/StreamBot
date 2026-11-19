import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { allowedUrl, fetchAllowed } from './security.js';
import { ProviderError } from './types.js';

// Private per-play gateway: FFmpeg never receives a provider credential or follows
// a remote redirect itself. Every manifest child/key/segment is validated here.
export async function openGateway(base: URL, root: URL, headers: () => Record<string, string>, signal?: AbortSignal,
  renew?: () => Promise<URL>) {
  const key = randomBytes(32).toString('hex');
  const targets = new Map<string, URL>();
  let origin = '';
  let closed = false;
  let renewed = false;
  const active = new Set<AbortController>();
  const local = (url: URL): string => {
    allowedUrl(url.href, base);
    for (const [id, known] of targets) if (known.href === url.href) return `${origin}/${key}/${id}/${id === '0' || /\.m3u8$/i.test(url.pathname) ? 'stream.m3u8' : 'media.ts'}`;
    if (targets.size > 20000) throw new ProviderError('HLS manifest exceeds gateway resource limit');
    const id = String(targets.size);
    targets.set(id, url);
    return `${origin}/${key}/${id}/${id === '0' || /\.m3u8$/i.test(url.pathname) ? 'stream.m3u8' : 'media.ts'}`;
  };
  const server = createServer(async (req, res) => {
    const match = req.url?.match(new RegExp(`^/${key}/([0-9]+)(?:/(?:stream.m3u8|media.ts))?$`));
    const target = match && targets.get(match[1]);
    if (!target || !['GET', 'HEAD'].includes(req.method!)) { res.writeHead(404).end(); return; }
    const controller = new AbortController();
    active.add(controller);
    const abort = () => controller.abort();
    res.on('close', abort);
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 30000); // response headers deadline; long media bodies stream below
    try {
      let current = target;
      const request = () => fetchAllowed(current, base, {
        method: req.method, headers: { ...headers(), ...(req.headers.range ? { Range: req.headers.range } : {}) },
        signal: controller.signal,
      });
      let response = await request();
      if ([401, 403].includes(response.status) && match![1] === '0' && renew && !renewed) {
        renewed = true;
        await response.body?.cancel();
        current = allowedUrl((await renew()).href, base);
        targets.set('0', current);
        response = await request();
      }
      clearTimeout(timeout);
      if (!response.ok) { await response.body?.cancel(); res.writeHead(response.status).end(); return; }
      const contentType = response.headers.get('content-type') || '';
      const manifest = /mpegurl/i.test(contentType) || /\.m3u8$/i.test(current.pathname);
      if (manifest && req.method !== 'HEAD') {
        const timer = setTimeout(abort, 15000);
        let text: string;
        try {
          const chunks: Uint8Array[] = []; let size = 0;
          for await (const chunk of response.body!) {
            size += chunk.length;
            if (size > 2 * 1024 * 1024) throw new ProviderError('HLS manifest too large');
            chunks.push(chunk);
          }
          text = Buffer.concat(chunks).toString('utf8');
        } finally { clearTimeout(timer); }
        if (!text.trimStart().startsWith('#EXTM3U')) throw new ProviderError('Invalid HLS manifest');
        text = text.split('\n').map(line => {
          if (line.trim() && !line.startsWith('#')) return local(allowedUrl(new URL(line.trim(), current).href, base));
          if (/\b[A-Z0-9-]*URI=(?!")/.test(line)) throw new ProviderError('Unsupported HLS URI attribute');
          return line.replace(/\b([A-Z0-9-]*URI)="([^"]+)"/g, (_all, attribute, uri) => `${attribute}="${local(allowedUrl(new URL(uri, current).href, base))}"`);
        }).join('\n');
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' }).end(text);
      } else {
        for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
          const value = response.headers.get(header); if (value) res.setHeader(header, value);
        }
        res.setHeader('Cache-Control', 'no-store');
        res.writeHead(response.status);
        if (req.method === 'HEAD') { await response.body?.cancel(); res.end(); }
        else if (response.body) await pipeline(Readable.fromWeb(response.body as any), res, { signal: controller.signal });
        else res.end();
      }
    } catch { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); }
    finally {
      clearTimeout(timeout); active.delete(controller);
      signal?.removeEventListener('abort', abort); res.off('close', abort);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const inputUrl = local(root);
  const close = async () => {
    if (closed) return; closed = true;
    signal?.removeEventListener('abort', onAbort);
    for (const controller of active) controller.abort();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  const onAbort = () => { void close(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) await close();
  return { inputUrl, close };
}
