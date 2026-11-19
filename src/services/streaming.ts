import { Client, Message } from 'discord.js-selfbot-v13';
import { Streamer, Utils, prepareStream, playStream } from '@dank074/discord-video-stream';
import fs from 'node:fs/promises';
import config from '../config.js';
import { MediaService } from './media.js';
import { PlaybackController, PlaybackEngine, PlaybackInput, PlaybackNotice } from './playback.js';
import { ProviderRegistry } from '../providers/registry.js';
import { QueueItem, StreamStatus } from '../types/index.js';
import { DiscordUtils } from '../utils/shared.js';
import { getVideoParams } from '../utils/ffmpeg.js';
import { ProviderError } from '../providers/types.js';

class DiscordPlaybackEngine implements PlaybackEngine {
  readonly streamer: Streamer;
  private media = new MediaService();
  constructor(client: Client, private status: StreamStatus) { this.streamer = new Streamer(client); }
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
  async play(input: PlaybackInput, signal: AbortSignal) {
    if (!this.streamer.client.isReady()) throw new ProviderError('Discord is not connected yet', 503);
    if (signal.aborted) return;
    if (!this.streamer.voiceConnection) await this.streamer.joinVoice(config.guildId, config.videoChannelId);
    this.status.joined = true;
    this.status.channelInfo = { guildId: config.guildId, channelId: config.videoChannelId, cmdChannelId: config.cmdChannelId };
    this.streamer.client.user?.setActivity(DiscordUtils.status_watch(input.title));
    // Voice readiness is cancellable, including during stop/restart.
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, 2000); signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
    if (signal.aborted) return;
    let params: Awaited<ReturnType<typeof getVideoParams>> | undefined;
    if (config.respect_video_params) params = await getVideoParams(input.url, input.headers).catch(() => undefined);
    if (signal.aborted) return;
    let width = params?.width || config.width, height = params?.height || config.height;
    const ratio = Math.min(1, config.maxWidth > 0 ? config.maxWidth / width : 1, config.maxHeight > 0 ? config.maxHeight / height : 1);
    width = Math.round(width * ratio / 2) * 2; height = Math.round(height * ratio / 2) * 2;
    const runController = new AbortController();
    const runSignal = AbortSignal.any([signal, runController.signal]);
    const { command, output, promise } = prepareStream(input.url, {
      width, height, frameRate: params?.fps || config.fps,
      bitrateVideo: params?.bitrate && !config.bitrateOverride ? Math.round(Number(params.bitrate) / 1000) : config.bitrateKbps,
      bitrateVideoMax: config.maxBitrateKbps, videoCodec: Utils.normalizeVideoCodec(config.videoCodec),
      hardwareAcceleratedDecoding: config.hardwareAcceleratedDecoding, minimizeLatency: false,
      customInputOptions: /^https?:/i.test(input.url) ? ['-rw_timeout', '15000000'] : [],
      includeAudio: true, customFfmpegFlags: /^H26/.test(config.videoCodec) ? ['-preset', config.h26xPreset] : [], ...(input.headers ? { customHeaders: input.headers } : {}),
    }, runSignal);
    // FFmpeg stderr/command text can contain authorization and signed URLs.
    let failed = false;
    command.on('error', () => { failed = true; output.destroy(new Error('Source stream failed')); });
    const tasks = [promise, playStream(output, this.streamer, undefined, runSignal)];
    try { await Promise.all(tasks); }
    catch { if (!signal.aborted) throw new ProviderError('Stream failed; check source file, expired grant, codecs and Discord connection'); }
    finally { runController.abort(); await Promise.allSettled(tasks); }
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
