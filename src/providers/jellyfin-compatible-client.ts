import { randomUUID } from 'node:crypto';
import { registerSecret } from '../utils/redact.js';
import { allowedUrl, fetchAllowed, mediaId, statusError, validateBaseUrl } from './security.js';
import { ProviderCredentials, MediaItem, MediaKind, MediaProvider, PlayableReference, ProviderConfig, ProviderError, ResolvedPlayback, SearchOptions } from './types.js';
import { openGateway } from './gateway.js';

const kinds: Record<string, MediaKind> = { Movie: 'movie', Series: 'series', Season: 'season', Episode: 'episode' };
const apiKinds: Record<MediaKind, string> = { movie: 'Movie', series: 'Series', season: 'Season', episode: 'Episode' };

export class JellyfinCompatibleClient implements MediaProvider {
  readonly base: URL;
  private readonly deviceId = 'streambot-' + randomUUID();
  private get deviceAuth() { return `MediaBrowser Client="StreamBot", Device="StreamBot", DeviceId="${this.deviceId}", Version="1.0"`; }
  private token: string;
  private userId?: string;
  private loginPending?: Promise<void>;
  private credentials: () => ProviderCredentials;
  constructor(readonly config: ProviderConfig, credentials?: () => ProviderCredentials) {
    this.credentials = credentials || (() => ({ token: config.credentialEnv ? process.env[config.credentialEnv] : undefined,
      username: config.usernameEnv ? process.env[config.usernameEnv] : undefined, password: config.passwordEnv ? process.env[config.passwordEnv] : undefined }));
    this.base = validateBaseUrl(config.baseUrl);
    this.token = this.credentials().token || '';
    this.userId = config.userId;
    registerSecret(this.token);
    for (const value of Object.values(this.credentials())) if (value) registerSecret(value);
    if (this.token && /[\r\n]/.test(this.token)) throw new ProviderError('Credential contains invalid characters', 400);
    if (!this.token && !(this.credentials().username && this.credentials().password)) {
      throw new ProviderError(`Missing credential environment variables for provider ${config.id}`, 400);
    }
  }
  private headers(): Record<string, string> {
    return { 'X-Emby-Authorization': this.deviceAuth, ...(this.token ? { 'X-Emby-Token': this.token } : {}) };
  }
  private async login(signal?: AbortSignal): Promise<void> {
    if (!this.credentials().username || !this.credentials().password) throw statusError(401);
    if (!this.loginPending) {
      this.loginPending = (async () => {
        const response = await fetchAllowed(new URL('Users/AuthenticateByName', this.base), this.base, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': this.deviceAuth },
          body: JSON.stringify({ Username: this.credentials().username, Pw: this.credentials().password }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
        });
        const data = await this.readJson(response);
        if (!data.AccessToken || !data.User?.Id) throw new ProviderError('Compatibility login returned no token or user');
        if (this.config.userId && this.config.userId !== data.User.Id) throw new ProviderError('Login profile does not match configured userId', 403);
        this.token = data.AccessToken; registerSecret(this.token); this.userId = mediaId(data.User.Id);
      })().finally(() => { this.loginPending = undefined; });
    }
    await this.loginPending;
  }
  private async readJson(response: Response): Promise<any> {
    if (!response.ok) { await response.body?.cancel(); throw statusError(response.status); }
    try {
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of response.body!) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw new ProviderError('Provider response exceeds size limit');
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('Provider returned an invalid or incomplete response');
    }
  }
  private async request(route: string, options: { query?: Record<string, string>; body?: any; method?: string; signal?: AbortSignal } = {}): Promise<any> {
    if (!this.token) await this.login(options.signal);
    const url = new URL(route, this.base);
    for (const [key, value] of Object.entries(options.query || {})) url.searchParams.set(key, value);
    const method = options.method || (options.body ? 'POST' : 'GET');
    for (let attempt = 0; attempt < 3; attempt++) {
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
      const response = await fetchAllowed(url, this.base, {
        method, headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: options.body ? JSON.stringify(options.body) : undefined, signal,
      });
      if (response.status === 401 && attempt === 0 && this.credentials().username) {
        await response.body?.cancel(); await this.login(options.signal); continue;
      }
      if (method === 'GET' && [429, 502, 503, 504].includes(response.status) && attempt < 2) {
        const retry = Math.min(2000, Math.max(100, Number(response.headers.get('retry-after') || 0) * 1000 || 200 * (attempt + 1)));
        await response.body?.cancel();
        await new Promise<void>((resolve, reject) => {
          if (options.signal?.aborted) { reject(new ProviderError('Provider request cancelled', 499)); return; }
          const timer = setTimeout(() => { options.signal?.removeEventListener('abort', abort); resolve(); }, retry);
          const abort = () => { clearTimeout(timer); reject(new ProviderError('Provider request cancelled', 499)); };
          options.signal?.addEventListener('abort', abort, { once: true });
        });
        continue;
      }
      if (response.status === 204) return undefined;
      return this.readJson(response);
    }
    throw new ProviderError('Provider retry limit reached');
  }
  private async identity(signal?: AbortSignal): Promise<string> {
    if (!this.userId) {
      const user = await this.request('Users/Me', { signal });
      this.userId = mediaId(user.Id);
    }
    return this.userId;
  }
  async healthCheck(signal?: AbortSignal) {
    const info = await this.request('System/Info/Public', { signal });
    const userId = await this.identity(signal);
    await this.request(`Users/${mediaId(userId)}`, { signal });
    return { version: typeof info.Version === 'string' ? info.Version.slice(0, 80) : 'unknown' };
  }
  private normalize(item: any): MediaItem {
    const id = mediaId(item.Id);
    if (!kinds[item.Type]) throw new ProviderError('Unsupported media type; choose a movie or TV item', 400);
    return {
      providerId: this.config.id, id, kind: kinds[item.Type], title: String(item.Name || 'Untitled'),
      overview: typeof item.Overview === 'string' ? item.Overview : undefined,
      posterUrl: `/api/providers/${this.config.id}/items/${id}/artwork`,
      year: item.ProductionYear, durationMs: item.RunTimeTicks ? item.RunTimeTicks / 10000 : undefined,
      seriesId: item.SeriesId, seasonNumber: item.ParentIndexNumber, episodeNumber: item.IndexNumber,
      sources: item.MediaSources?.map((source: any) => ({
        id: mediaId(source.Id), name: String(source.Name || source.Container || 'Default'),
        video: source.MediaStreams?.find((stream: any) => stream.Type === 'Video')?.Codec,
        audio: source.MediaStreams?.find((stream: any) => stream.Type === 'Audio')?.Codec,
      })),
    };
  }
  async libraries() {
    const userId = await this.identity();
    const data = await this.request(`Users/${userId}/Views`);
    return (data.Items || []).map((item: any) => ({ id: mediaId(item.Id), title: String(item.Name || 'Library') }));
  }
  async search(query: string, options: SearchOptions = {}) {
    const userId = await this.identity();
    const data = await this.request('Items', { query: {
      UserId: userId, SearchTerm: query.slice(0, 300), Recursive: 'true',
      IncludeItemTypes: options.kind ? apiKinds[options.kind] : 'Movie,Series',
      Fields: 'Overview', SortBy: 'SortName', SortOrder: 'Ascending',
      Limit: String(Math.max(1, Math.min(100, options.limit || 24))),
      StartIndex: String(Math.max(0, options.offset || 0)),
      ...(options.parentId ? { ParentId: mediaId(options.parentId) } : {}),
    } });
    return { items: (data.Items || []).filter((item: any) => kinds[item.Type]).map((item: any) => this.normalize(item)), total: data.TotalRecordCount || 0 };
  }
  async getItem(id: string) {
    const userId = await this.identity();
    return this.normalize(await this.request(`Users/${userId}/Items/${mediaId(id)}`, { query: { Fields: 'Overview,MediaSources' } }));
  }
  private async pages(route:string,query:Record<string,string>,max=2000):Promise<MediaItem[]> {
    const items:MediaItem[]=[];const seen=new Set<string>();
    for(let offset=0;offset<max;offset+=100){const data=await this.request(route,{query:{...query,StartIndex:String(offset),Limit:'100'}});const page=data.Items||[];for(const raw of page){const item=this.normalize(raw);if(seen.has(item.id))throw new ProviderError('Provider repeated a catalog page; verify server pagination support');seen.add(item.id);items.push(item);}if(!page.length||typeof data.TotalRecordCount!=='number'||items.length>=data.TotalRecordCount)return items;}
    throw new ProviderError('Catalog expansion exceeds the bounded item limit; add smaller seasons instead');
  }
  async getSeasons(id: string) { return this.pages(`Shows/${mediaId(id)}/Seasons`,{UserId:await this.identity()},500); }
  async getEpisodes(id: string, seasonId?: string) { return this.pages(`Shows/${mediaId(id)}/Episodes`,{UserId:await this.identity(),...(seasonId?{SeasonId:mediaId(seasonId)}:{})}); }
  async artwork(id: string) {
    if (!this.token) await this.login();
    const response = await fetchAllowed(new URL(`Items/${mediaId(id)}/Images/Primary?maxWidth=400`, this.base), this.base,
      { headers: this.headers(), signal: AbortSignal.timeout(15000) });
    if (!response.ok) { await response.body?.cancel(); throw statusError(response.status); }
    if (!/^image\/(jpeg|png|webp)(;|$)/i.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel(); throw new ProviderError('Unsupported artwork format');
    }
    return response;
  }
  async resolvePlayback(ref: PlayableReference, signal?: AbortSignal): Promise<ResolvedPlayback> {
    if (ref.providerId !== this.config.id) throw new ProviderError('Provider reference mismatch', 400);
    if (ref.audioStreamIndex !== undefined || (ref.subtitleStreamIndex !== undefined && ref.subtitleStreamIndex !== -1)) {
      throw new ProviderError('Track selection is not supported in this MVP; choose the default audio and disable subtitles', 400);
    }
    const userId = await this.identity(signal);
    let sessionId: string | undefined;
    let sourceId: string | undefined;
    let protocol: 'progressive' | 'hls' = 'progressive';
    const closeSession = async () => {
      if (!sessionId) return;
      const current = sessionId; sessionId = undefined;
      // Teardown only: no progress, watched state, or library mutations.
      await this.request('Videos/ActiveEncodings', { method: 'DELETE', query: { DeviceId: this.deviceId, PlaySessionId: current } });
    };
    const negotiate = async () => {
      await closeSession().catch(() => {});
      const data = await this.request(`Items/${mediaId(ref.itemId)}/PlaybackInfo`, { signal, body: {
        UserId: userId, MediaSourceId: ref.mediaSourceId ? mediaId(ref.mediaSourceId) : undefined,
        IsPlayback: true, AutoOpenLiveStream: false, EnableDirectPlay: true, EnableDirectStream: true,
        EnableTranscoding: true, SubtitleStreamIndex: -1,
        DeviceProfile: {
          Name: 'StreamBot FFmpeg', MaxStreamingBitrate: 120000000,
          DirectPlayProfiles: [{ Type: 'Video', Container: 'mp4,mkv,mov,webm,avi,mpegts', VideoCodec: 'h264,hevc,vp8,vp9,av1,mpeg2video', AudioCodec: 'aac,ac3,eac3,opus,vorbis,mp3,flac,dts,truehd' }],
          TranscodingProfiles: [{ Type: 'Video', Container: 'ts', Protocol: 'hls', VideoCodec: 'h264', AudioCodec: 'aac', MaxAudioChannels: '2' }],
          SubtitleProfiles: [],
        },
      } });
      sessionId = typeof data.PlaySessionId === 'string' ? data.PlaySessionId : undefined;
      if (data.ErrorCode) throw new ProviderError('Playback unavailable; check profile permissions, source file and server transcoding');
      const sources = (data.MediaSources || []).filter((source: any) => !ref.mediaSourceId || source.Id === ref.mediaSourceId);
      const source = sources.find((s: any) => s.DirectStreamUrl || (s.SupportsDirectPlay && this.config.kind === 'jellyfin')) || sources.find((s: any) => s.TranscodingUrl);
      if (!source) throw new ProviderError('No playable source; check version, codecs, file availability and profile permissions');
      sourceId = mediaId(source.Id);
      let value = source.DirectStreamUrl;
      if (!value && source.SupportsDirectPlay && this.config.kind === 'jellyfin') {
        // Jellyfin does not always emit DirectStreamUrl. Use its documented static
        // Videos route, only after PlaybackInfo authorizes this exact media source.
        const direct = new URL(`Videos/${mediaId(ref.itemId)}/stream`, this.base);
        direct.searchParams.set('Static', 'true'); direct.searchParams.set('MediaSourceId', sourceId);
        if (sessionId) direct.searchParams.set('PlaySessionId', sessionId);
        value = direct.href;
      }
      value ||= source.TranscodingUrl;
      if (!value) throw new ProviderError('Compatibility server returned no negotiated media URL; verify deployed release');
      const url = allowedUrl(value, this.base);
      protocol = /\.m3u8$/i.test(url.pathname) || (!source.DirectStreamUrl && value === source.TranscodingUrl) ? 'hls' : 'progressive';
      return url;
    };
    try {
      const url = await negotiate();
      const gateway = await openGateway(this.base, url, () => this.headers(), signal, negotiate);
      return { inputUrl: gateway.inputUrl, protocol, close: async () => { await gateway.close(); await closeSession(); } };
    } catch (error) { await closeSession().catch(() => {}); throw error; }
  }
}
