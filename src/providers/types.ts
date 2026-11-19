export interface ProviderCredentials { token?: string; username?: string; password?: string }
export type ProviderKind = 'jellyfin' | 'silo';
export type MediaKind = 'movie' | 'series' | 'season' | 'episode';
export interface ProviderConfig {
  id: string; name: string; kind: ProviderKind; baseUrl: string;
  credentialEnv?: string; userId?: string;
  usernameEnv?: string; passwordEnv?: string;
}
export interface MediaItem {
  providerId: string; id: string; kind: MediaKind; title: string;
  overview?: string; posterUrl: string; year?: number; durationMs?: number;
  seriesId?: string; seasonNumber?: number; episodeNumber?: number;
  sources?: { id: string; name: string; video?: string; audio?: string }[];
}
export interface PlayableReference {
  providerId: string; itemId: string; mediaSourceId?: string;
  audioStreamIndex?: number; subtitleStreamIndex?: number;
}
export interface ResolvedPlayback {
  inputUrl: string; protocol: 'progressive' | 'hls';
  close: () => Promise<void>;
}
export interface SearchOptions { kind?: MediaKind; limit?: number; offset?: number; parentId?: string }
export interface MediaProvider {
  readonly config: ProviderConfig;
  healthCheck(signal?: AbortSignal): Promise<{ version: string }>;
  search(query: string, options?: SearchOptions): Promise<{ items: MediaItem[]; total: number }>;
  libraries(): Promise<{ id: string; title: string }[]>;
  getItem(id: string): Promise<MediaItem>;
  getSeasons(id: string): Promise<MediaItem[]>;
  getEpisodes(id: string, seasonId?: string): Promise<MediaItem[]>;
  artwork(id: string): Promise<Response>;
  resolvePlayback(ref: PlayableReference, signal?: AbortSignal): Promise<ResolvedPlayback>;
}
export class ProviderError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}
