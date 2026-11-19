import { Router } from 'express';
import { PlaybackController } from '../../services/playback.js';
import { ProviderRegistry } from '../../providers/registry.js';
import { MediaKind, PlayableReference, ProviderError } from '../../providers/types.js';
import { mediaId, safeError } from '../../providers/security.js';

export function mediaRoutes(providers: ProviderRegistry, playback?: PlaybackController) {
  const router = Router();
  router.get('/library', (_req, res) => res.render('pages/media-library', { showLogout: true }));
  router.get('/api/providers', async (_req, res) => {
    res.json(await Promise.all(providers.all().map(async provider => {
      try { const info = await provider.healthCheck(); return { id: provider.config.id, name: provider.config.name, kind: provider.config.kind, healthy: true, version: info.version }; }
      catch (error) { return { id: provider.config.id, name: provider.config.name, kind: provider.config.kind, healthy: false, error: safeError(error) }; }
    })));
  });
  router.get('/api/providers/:provider/libraries', async (req, res) => {
    res.json(await providers.get(String(req.params.provider)).libraries());
  });
  router.get('/api/media', async (req, res) => {
    const selection = typeof req.query.provider === 'string' ? req.query.provider : 'all';
    const selected = selection === 'all' ? providers.all() : [providers.get(selection)];
    const kind = typeof req.query.kind === 'string' && req.query.kind ? req.query.kind : undefined;
    if (kind && !['movie', 'series', 'season', 'episode'].includes(kind)) throw new ProviderError('Invalid media kind', 400);
    const integer = (value: unknown, fallback: number, max: number) => {
      if (value === undefined) return fallback;
      if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) > max) throw new ProviderError('Invalid pagination', 400);
      return Number(value);
    };
    const results = await Promise.all(selected.map(async provider => {
      try { return { providerId: provider.config.id, ...await provider.search(String(req.query.q || ''), {
        kind: kind as MediaKind, offset: integer(req.query.offset, 0, 1000000), limit: integer(req.query.limit, 24, 100),
        parentId: typeof req.query.library === 'string' && selection !== 'all' && req.query.library ? mediaId(req.query.library) : undefined,
      }) }; } catch (error) { return { providerId: provider.config.id, items: [], total: 0, error: safeError(error) }; }
    }));
    res.json(results);
  });
  router.get('/api/providers/:provider/items/:item', async (req, res) => {
    res.json(await providers.get(String(req.params.provider)).getItem(mediaId(req.params.item)));
  });
  router.get('/api/providers/:provider/items/:item/seasons', async (req, res) => {
    res.json(await providers.get(String(req.params.provider)).getSeasons(mediaId(req.params.item)));
  });
  router.get('/api/providers/:provider/items/:item/episodes', async (req, res) => {
    res.json(await providers.get(String(req.params.provider)).getEpisodes(mediaId(req.params.item), typeof req.query.season === 'string' ? mediaId(req.query.season) : undefined));
  });
  router.get('/api/providers/:provider/items/:item/artwork', async (req, res) => {
    const response = await providers.get(String(req.params.provider)).artwork(mediaId(req.params.item));
    try {
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of response.body!) {
        size += chunk.length;
        if (size > 5 * 1024 * 1024) throw new ProviderError('Artwork exceeds size limit');
        chunks.push(chunk);
      }
      res.set({ 'Content-Type': response.headers.get('content-type')!, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' });
      res.send(Buffer.concat(chunks));
    } catch { res.status(502).end(); }
  });
  router.get('/api/playback', (_req, res) => {
    if (!playback) throw new ProviderError('Playback requires the combined Discord process: bun start', 503);
    res.json(playback.status());
  });
  router.post('/api/playback/queue', async (req, res) => {
    if (!playback) throw new ProviderError('Discord playback controller unavailable', 503);
    const body = req.body || {};
    const reference: PlayableReference = {
      providerId: mediaId(body.providerId), itemId: mediaId(body.itemId),
      ...(body.mediaSourceId ? { mediaSourceId: mediaId(body.mediaSourceId) } : {}),
    };
    if (body.audioStreamIndex !== undefined || body.subtitleStreamIndex !== undefined) throw new ProviderError('Track selection is not supported in this MVP', 400);
    await playback.enqueueProvider(reference, `dashboard:${(req.session as any).user}`, body.play === true);
    res.status(201).json(playback.status());
  });
  router.post('/api/playback/:action', async (req, res) => {
    if (!playback) throw new ProviderError('Discord playback controller unavailable', 503);
    if (req.params.action === 'start') playback.start();
    else if (req.params.action === 'skip') await playback.skip();
    else if (req.params.action === 'stop') await playback.stopAndClearQueue();
    else throw new ProviderError('Unknown playback action', 404);
    res.json(playback.status());
  });
  router.use((error: unknown, _req: any, res: any, _next: any) => {
    res.status(error instanceof ProviderError ? error.status : 500).json({ error: safeError(error) });
  });
  return router;
}
