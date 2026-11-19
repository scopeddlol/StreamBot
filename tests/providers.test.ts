import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { JellyfinProvider } from '../src/providers/jellyfin.js';
import { SiloProvider } from '../src/providers/silo.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { allowedUrl, validateBaseUrl } from '../src/providers/security.js';
import { redact } from '../src/utils/redact.js';

let server: ReturnType<typeof Bun.serve>;
let base: string;
let mode = 'normal', negotiations = 0, stopped = 0, queries: URL[] = [];
const credential = 'fixture-provider-secret-only';
const dto = (id: string, Type = 'Movie') => ({ Id: id, Type, Name: `Title ${id}`, Overview: 'Description', ProductionYear: 2025, RunTimeTicks: 600000000, SeriesId: 'series', IndexNumber: 1, ParentIndexNumber: 2, MediaSources: [{ Id: 'version', Name: '1080p', Path: '/private/media.mkv', MediaStreams: [{ Type: 'Video', Codec: 'h264' }, { Type: 'Audio', Codec: 'aac' }] }] });
beforeAll(() => {
  process.env.TEST_PROVIDER_KEY = credential;
  process.env.TEST_SILO_USER = 'account#profile'; process.env.TEST_SILO_PASSWORD = 'fixture-password#1234';
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const url = new URL(req.url); queries.push(url);
    if (url.pathname === '/Users/AuthenticateByName') {
      const body = await req.json();
      if (body.Username !== 'account#profile') return new Response('', { status: 401 });
      return Response.json({ AccessToken: credential, User: { Id: 'user' } });
    }
    if (req.headers.get('X-Emby-Token') !== credential) return new Response('do not relay body containing fixture-secret', { status: 401 });
    if (url.pathname === '/System/Info/Public') { if (mode === 'timeout') await Bun.sleep(100); return Response.json({ Version: 'fixture-1' }); }
    if (url.pathname === '/Users/Me' || url.pathname === '/Users/user') return Response.json({ Id: 'user' });
    if (url.pathname === '/Users/user/Views') return Response.json({ Items: [{ Id: 'library', Name: 'Movies' }] });
    if (url.pathname === '/Items') {
      if (url.searchParams.get('SearchTerm') === 'retry' && queries.filter(q => q.pathname === '/Items' && q.searchParams.get('SearchTerm') === 'retry').length < 2) return new Response('', { status: 503 });
      if (url.searchParams.get('SearchTerm') === 'denied') return new Response('SECRET_BODY', { status: 403 });
      return Response.json({ Items: url.searchParams.get('SearchTerm') === 'none' ? [] : [dto('movie')], TotalRecordCount: 100 });
    }
    if (url.pathname === '/Users/user/Items/missing') return new Response('', { status: 404 });
    if (/^\/Users\/user\/Items\//.test(url.pathname)) return Response.json(dto(url.pathname.split('/').pop()!, url.pathname.endsWith('series') ? 'Series' : 'Movie'));
    if (url.pathname.endsWith('/Seasons')) return Response.json({ Items: [dto('season', 'Season')] });
    if (url.pathname.endsWith('/Episodes')) return Response.json({ Items: [dto('episode', 'Episode')] });
    if (url.pathname.endsWith('/Images/Primary')) return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg' } });
    if (url.pathname.endsWith('/PlaybackInfo')) {
      negotiations++;
      const body = await req.json();
      if (body.MediaSourceId && body.MediaSourceId !== 'version') return Response.json({ MediaSources: [] });
      return Response.json({ PlaySessionId: `session-${negotiations}`, MediaSources: mode === 'unsupported' ? [] : [{ Id: 'version', SupportsDirectPlay: true,
        ...(mode === 'static' ? {} : { DirectStreamUrl: mode === 'evil' ? 'http://127.0.0.1:1/private' : mode === 'hls' || mode === 'evil-hls' ? '/master.m3u8' : `/stream?grant=${negotiations}` }) }] });
    }
    if (url.pathname === '/Videos/ActiveEncodings') { stopped++; return new Response(null, { status: 204 }); }
    if (url.pathname === '/stream') {
      if (mode === 'expired' && url.searchParams.get('grant') === String(negotiations)) { mode = 'normal'; return new Response('', { status: 403 }); }
      if (mode === 'redirect') return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1:1/private' } });
      const range = req.headers.get('range'); return new Response('video-audio', { status: range ? 206 : 200, headers: { 'content-type': 'video/mp4', ...(range ? { 'content-range': 'bytes 0-10/11' } : {}) } });
    }
    if (url.pathname === '/master.m3u8') return new Response(mode === 'evil-hls' ? '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="http://127.0.0.1:1/private"\n' : '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nchild.m3u8\n', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
    if (url.pathname === '/child.m3u8') return new Response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key?secret=grant"\n#EXTINF:1,\nsegment.ts?secret=grant\n#EXT-X-ENDLIST\n', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
    if (url.pathname === '/key' || url.pathname === '/segment.ts') return new Response('segment', { headers: { 'content-type': 'video/mp2t' } });
    if (url.pathname.includes('/Videos/')) return new Response('video-audio');
    return new Response('', { status: 404 });
  } });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));
function provider(kind: 'silo' | 'jellyfin' = 'jellyfin') {
  const config = { id: kind, name: kind, kind, baseUrl: base, credentialEnv: 'TEST_PROVIDER_KEY' };
  return kind === 'silo' ? new SiloProvider(config) : new JellyfinProvider(config);
}

describe('provider contracts', () => {
  test('identity, libraries, normalized items and paginated filters', async () => {
    mode = 'normal'; queries = [];
    const p = provider(); expect(await p.healthCheck()).toEqual({ version: 'fixture-1' });
    expect(await p.libraries()).toEqual([{ id: 'library', title: 'Movies' }]);
    const data = await p.search('title', { offset: 24, kind: 'movie', limit: 24, parentId: 'library' });
    expect(data.items[0]).toMatchObject({ providerId: 'jellyfin', kind: 'movie', title: 'Title movie', durationMs: 60000 });
    expect(data.total).toBe(100);
    const query = queries.find(q => q.pathname === '/Items')!;
    expect(query.searchParams.get('StartIndex')).toBe('24'); expect(query.searchParams.get('IncludeItemTypes')).toBe('Movie');
    expect(query.searchParams.get('ParentId')).toBe('library');
    const serialized = JSON.stringify(data); expect(serialized).not.toContain(credential); expect(serialized).not.toContain('Path');
    expect((await p.search('none')).items).toEqual([]);
  });
  test('seasons, episodes, details and authenticated artwork', async () => {
    const p = provider('silo');
    expect((await p.getSeasons('series'))[0].kind).toBe('season'); expect((await p.getEpisodes('series', 'season'))[0].kind).toBe('episode');
    expect((await p.getItem('movie')).sources?.[0]).toEqual({ id: 'version', name: '1080p', video: 'h264', audio: 'aac' });
    expect((await p.artwork('movie')).headers.get('content-type')).toBe('image/jpeg');
  });
  test('bad credentials, forbidden content, missing items and retryable reads', async () => {
    process.env.BAD_TEST_KEY = 'wrong';
    const p = new JellyfinProvider({ id: 'bad', name: 'bad', kind: 'jellyfin', baseUrl: base, credentialEnv: 'BAD_TEST_KEY' });
    await expect(p.healthCheck()).rejects.toThrow('credential');
    await expect(provider().search('denied')).rejects.toThrow('profile');
    await expect(provider().getItem('missing')).rejects.toThrow('unavailable');
    queries = []; expect((await provider().search('retry')).items).toHaveLength(1);
  });
  test('Silo compatibility login preserves profile semantics', async () => {
    const p = new SiloProvider({ id: 'silo', name: 'Silo', kind: 'silo', baseUrl: base, usernameEnv: 'TEST_SILO_USER', passwordEnv: 'TEST_SILO_PASSWORD' });
    expect((await p.healthCheck()).version).toBe('fixture-1');
  });
  test('fresh playback negotiation, chosen source and range proxy, idempotent cleanup', async () => {
    mode = 'normal'; stopped = 0; const before = negotiations;
    const stream = await provider().resolvePlayback({ providerId: 'jellyfin', itemId: 'movie', mediaSourceId: 'version' });
    expect(negotiations).toBe(before + 1); expect(stream.inputUrl).not.toContain(credential);
    const response = await fetch(stream.inputUrl, { headers: { Range: 'bytes=0-10' } });
    expect(response.status).toBe(206); expect(await response.text()).toBe('video-audio');
    await stream.close(); await stream.close(); expect(stopped).toBe(1);
  });
  test('one expired initial grant is renewed at fetch time', async () => {
    mode = 'expired'; const before = negotiations;
    const stream = await provider('silo').resolvePlayback({ providerId: 'silo', itemId: 'movie' });
    try { expect(await (await fetch(stream.inputUrl)).text()).toBe('video-audio'); expect(negotiations).toBe(before + 2); }
    finally { await stream.close(); mode = 'normal'; }
  });
  test('Jellyfin static route uses negotiated source, never server filesystem Path', async () => {
    mode = 'static'; const stream = await provider().resolvePlayback({ providerId: 'jellyfin', itemId: 'movie' });
    try { expect(await (await fetch(stream.inputUrl)).text()).toBe('video-audio'); }
    finally { await stream.close(); mode = 'normal'; }
  });
  test('HLS master, child manifest, keys and segments stay behind gateway', async () => {
    mode = 'hls'; const stream = await provider('silo').resolvePlayback({ providerId: 'silo', itemId: 'episode' });
    try {
      const master = await (await fetch(stream.inputUrl)).text();
      expect(master).not.toContain(base); const childUrl = master.trim().split('\n').pop()!;
      const child = await (await fetch(childUrl)).text(); expect(child).not.toContain('grant');
      const keyUrl = child.match(/URI="([^"]+)"/)![1]; expect(await (await fetch(keyUrl)).text()).toBe('segment');
      const segment = child.split('\n').find(line => line.startsWith('http'))!; expect(await (await fetch(segment)).text()).toBe('segment');
    } finally { await stream.close(); mode = 'normal'; }
  });
  test('reject uncontrolled playback origins, redirects and HLS keys', async () => {
    mode = 'evil'; await expect(provider().resolvePlayback({ providerId: 'jellyfin', itemId: 'movie' })).rejects.toThrow('origin');
    mode = 'redirect'; let stream = await provider().resolvePlayback({ providerId: 'jellyfin', itemId: 'movie' });
    try { expect((await fetch(stream.inputUrl)).status).toBe(502); } finally { await stream.close(); }
    mode = 'evil-hls'; stream = await provider().resolvePlayback({ providerId: 'jellyfin', itemId: 'movie' });
    try { expect((await fetch(stream.inputUrl)).status).toBe(502); } finally { await stream.close(); mode = 'normal'; }
  });
  test('cancelled negotiation and unsupported playback fail safely', async () => {
    mode = 'unsupported'; await expect(provider().resolvePlayback({ providerId: 'jellyfin', itemId: 'movie' })).rejects.toThrow('No playable source'); mode = 'normal';
    await expect(provider().resolvePlayback({ providerId: 'jellyfin', itemId: 'movie', audioStreamIndex: 2 })).rejects.toThrow('Track selection');
    const abort = new AbortController(); abort.abort();
    await expect(provider().healthCheck(abort.signal)).rejects.toThrow();
  });
  test('bounded cancellation, offline errors and duplicate titles preserve source identity', async () => {
    mode = 'timeout';
    await expect(provider().healthCheck(AbortSignal.timeout(10))).rejects.toThrow('timed out');
    mode = 'normal';
    const offline = new JellyfinProvider({ id: 'offline', name: 'offline', kind: 'jellyfin', baseUrl: 'http://127.0.0.1:1', credentialEnv: 'TEST_PROVIDER_KEY' });
    await expect(offline.healthCheck()).rejects.toThrow('unreachable');
    const [a, b] = await Promise.all([provider().search('same'), provider('silo').search('same')]);
    expect(a.items[0].title).toBe(b.items[0].title); expect(a.items[0].providerId).not.toBe(b.items[0].providerId);
  });
  test('config and identifier validation; exact origin policy and redaction', () => {
    expect(() => validateBaseUrl('file:///etc/passwd')).toThrow(); expect(() => validateBaseUrl('https://user:pw@host')).toThrow();
    expect(() => allowedUrl('//evil.invalid/video', new URL(base))).toThrow();
    expect(() => new ProviderRegistry([{ id: '../evil', kind: 'jellyfin', name: 'bad', baseUrl: base, credentialEnv: 'TEST_PROVIDER_KEY' }])).toThrow();
    expect(redact(`Failed https://host/video?grant=signed Authorization: Bearer abc ${credential}`)).not.toContain('signed');
    expect(redact(credential)).not.toContain(credential);
  });
});
