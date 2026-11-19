import { Client, Message } from 'discord.js-selfbot-v13';
import { Streamer, Utils, prepareStream, playStream } from '@dank074/discord-video-stream';
import fs from 'node:fs/promises';
import config from '../config.js';
import { MediaService } from './media.js';
import { PlaybackController, PlaybackEngine, PlaybackTransport, PlaybackInput, PlaybackNotice } from './playback.js';
import { ProviderRegistry } from '../providers/registry.js';
import { QueueItem, StreamStatus } from '../types/index.js';
import { DiscordUtils } from '../utils/shared.js';
import { getVideoParams } from '../utils/ffmpeg.js';
import { ProviderError } from '../providers/types.js';

export class DiscordPlaybackEngine implements PlaybackTransport {
  readonly streamer: Streamer;
  ffmpegRunning = false;
  onStarted?: () => void;
  private media = new MediaService();
  constructor(client: Client, private status: StreamStatus, private settings = config) { this.streamer = new Streamer(client); }
  async resolveLegacy(item: QueueItem, signal: AbortSignal): Promise<PlaybackInput> {
    if ('reference' in item) throw new Error('Provider item sent to legacy resolver');
    const pending = this.media.resolveMediaSource(item.originalInput || item.url, item.headers);
    const source = await new Promise<Awaited<typeof pending>>((resolve, reject) => {
      const abort = () => reject(new ProviderError('Playback cancelled', 499));
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => reject(new ProviderError('Media source resolution timed out', 504)), 30000);
      pending.then(resolve, reject).finally(() => { clearTimeout(timer); signal.removeEventListener('abort', abort); });
      if (signal.aborted) abort();
    });
    if (signal.aborted) throw new ProviderError('Playback cancelled', 499);
    if (!source) throw new ProviderError('Could not resolve media source');
    if (source.type === 'youtube' && !source.isLive) {
      const file = await this.media.downloadYouTubeVideo(source.url, signal);
      if (!file) throw new ProviderError('YouTube download failed');
      return { url: file, title: source.title, type: source.type, close: () => fs.unlink(file) };
    }
    return { url: source.url, headers: source.headers, title: source.title, type: source.type };
  }
  async connect(guildId = this.settings.guildId, channelId = this.settings.videoChannelId) {
    const guild = await this.streamer.client.guilds.fetch(guildId).catch(() => null);
    const channel = guild && await guild.channels.fetch(channelId).catch(() => null);
    const me = guild?.me || await guild?.members.fetchMe().catch(() => null);
    if (!channel || !['GUILD_VOICE','GUILD_STAGE_VOICE'].includes(channel.type) || !me || !channel.permissionsFor(me)?.has(['VIEW_CHANNEL','CONNECT','SPEAK'])) throw new ProviderError('Voice destination unavailable or account lacks View/Connect/Speak permission',403);
    if (this.streamer.voiceConnection) this.streamer.leaveVoice();
    await this.streamer.joinVoice(guildId, channelId);
    this.settings.guildId = guildId; this.settings.videoChannelId = channelId; this.status.joined = true;
  }
  capabilities() { return { video: true, audio: true, voiceJoin: true, experimental: true }; }
  async play(input: PlaybackInput, signal: AbortSignal) {
    if (!this.streamer.client.isReady()) throw new ProviderError('Discord is not connected yet', 503);
    if (signal.aborted) return;
    if (!this.streamer.voiceConnection) await this.connect();
    this.status.joined = true;
    this.status.channelInfo = { guildId: this.settings.guildId, channelId: this.settings.videoChannelId, cmdChannelId: this.settings.cmdChannelId };
    this.streamer.client.user?.setActivity(DiscordUtils.status_watch(input.title));
    // Voice readiness is cancellable, including during stop/restart.
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, 2000); signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
    if (signal.aborted) return;
    let params: Awaited<ReturnType<typeof getVideoParams>> | undefined;
    if (this.settings.respect_video_params) params = await getVideoParams(input.url, input.headers).catch(() => undefined);
    if (signal.aborted) return;
    let width = params?.width || this.settings.width, height = params?.height || this.settings.height;
    const ratio = Math.min(1, this.settings.maxWidth > 0 ? this.settings.maxWidth / width : 1, this.settings.maxHeight > 0 ? this.settings.maxHeight / height : 1);
    width = Math.round(width * ratio / 2) * 2; height = Math.round(height * ratio / 2) * 2;
    const runController = new AbortController();
    const runSignal = AbortSignal.any([signal, runController.signal]);
    const { command, output, promise } = prepareStream(input.url, {
      width, height, frameRate: params?.fps || this.settings.fps,
      bitrateVideo: params?.bitrate && !this.settings.bitrateOverride ? Math.round(Number(params.bitrate) / 1000) : this.settings.bitrateKbps,
      bitrateVideoMax: this.settings.maxBitrateKbps, videoCodec: Utils.normalizeVideoCodec(this.settings.videoCodec),
      hardwareAcceleratedDecoding: this.settings.hardwareAcceleratedDecoding, minimizeLatency: false,
      customInputOptions: /^https?:/i.test(input.url) ? ['-rw_timeout', '15000000'] : [],
      includeAudio: true, customFfmpegFlags: /^H26/.test(this.settings.videoCodec) ? ['-preset', this.settings.h26xPreset] : [], ...(input.headers ? { customHeaders: input.headers } : {}),
    }, runSignal);
    command.on('start',()=>{this.ffmpegRunning=true;this.onStarted?.();});
    // FFmpeg stderr/command text can contain authorization and signed URLs.
    let failed = false;
    command.on('error', () => { failed = true; output.destroy(new Error('Source stream failed')); });
    const tasks = [promise, playStream(output, this.streamer, undefined, runSignal)];
    try { await Promise.all(tasks); }
    catch { if (!signal.aborted) throw new ProviderError('Stream failed; check source file, expired grant, codecs and Discord connection'); }
    finally { this.ffmpegRunning=false;runController.abort(); await Promise.allSettled(tasks); }
    if (failed && !signal.aborted) throw new ProviderError('FFmpeg could not read or encode this source');
  }
  async disconnect() {
    this.streamer.stopStream(); this.streamer.leaveVoice();
    this.streamer.client.user?.setActivity(DiscordUtils.status_idle());
  }
}

export class StreamingService extends PlaybackController {
  private discordEngine: DiscordPlaybackEngine;
  constructor(client: Client, status: StreamStatus, providers = ProviderRegistry.fromEnvironment()) {
    const engine = new DiscordPlaybackEngine(client, status);
    super(providers, engine, status); this.discordEngine = engine;
  }
  getStreamer() { return this.discordEngine.streamer; }
  private notice(message: Message): PlaybackNotice {
    return async (event, text) => {
      if (event === 'playing') await DiscordUtils.sendPlaying(message, text);
      else if (event === 'finished') await DiscordUtils.sendFinishMessage(message);
      else await DiscordUtils.sendError(message, text);
    };
  }
  async addToQueue(message: Message, input: string, title?: string, headers?: Record<string, string>) {
    let type: 'youtube' | 'twitch' | 'local' | 'url' = 'url';
    if (/youtube\.com\/|youtu\.be\//i.test(input)) type = 'youtube';
    else if (/twitch\.tv\//i.test(input)) type = 'twitch';
    else if (!/^https?:/i.test(input) && await fs.stat(input).then(s => s.isFile()).catch(() => false)) type = 'local';
    await this.queueService.add(input, title || (type === 'url' ? 'URL or search' : input), message.author.username, type, false, input, headers);
    await DiscordUtils.sendSuccess(message, 'Added to queue');
    return true;
  }
  async playFromQueue(message: Message) { this.start(this.notice(message)); }
  async skipCurrent(_message: Message) { await this.skip(); }
  async playProvider(message: Message, providerId: string, itemId: string) {
    return this.enqueueProvider({ providerId, itemId }, message.author.username, true, this.notice(message));
  }
}
