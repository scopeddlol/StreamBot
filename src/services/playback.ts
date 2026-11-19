import { QueueService } from './queue.js';
import { ProviderRegistry } from '../providers/registry.js';
import { PlayableReference, ProviderError } from '../providers/types.js';
import { safeError } from '../providers/security.js';
import { MediaSource, QueueItem, StreamStatus } from '../types/index.js';

export interface PlaybackInput { url: string; title: string; headers?: Record<string, string>; type?: MediaSource["type"]; close?: () => Promise<void> }
export interface PlaybackEngine {
  resolveLegacy(item: QueueItem, signal: AbortSignal): Promise<PlaybackInput>;
  play(input: PlaybackInput, signal: AbortSignal): Promise<void>;
  disconnect(): Promise<void>;
}
export type PlaybackNotice = (event: 'playing' | 'finished' | 'error', title: string) => Promise<void>;

// One worker owns advancement and teardown. skip/stop abort preparation AND
// playback; the next item cannot start before the previous input is closed.
export class PlaybackController {
  protected queueService = new QueueService();
  private controller?: AbortController;
  private worker?: Promise<void>;
  private stopping = false;
  private generation = 0;
  lastError?: string;
  constructor(readonly providers: ProviderRegistry, protected engine: PlaybackEngine, protected streamStatus: StreamStatus) {}
  getQueueService() { return this.queueService; }
  async enqueueProvider(reference: PlayableReference, requestedBy: string, play = false, notice?: PlaybackNotice) {
    const generation = this.generation;
    const provider = this.providers.get(reference.providerId);
    const item = await provider.getItem(reference.itemId);
    if (generation !== this.generation) throw new ProviderError("Queue changed during request; retry enqueue", 409);
    if (!['movie', 'episode'].includes(item.kind)) throw new ProviderError('Choose a movie or episode to play', 400);
    if (reference.mediaSourceId && !item.sources?.some(source => source.id === reference.mediaSourceId)) throw new ProviderError('Selected version is unavailable', 404);
    const queued = this.queueService.addProvider(provider, reference, item.title, requestedBy);
    if (play) this.start(notice);
    return queued;
  }
  start(notice?: PlaybackNotice): void {
    if (this.worker || this.stopping || this.queueService.isEmpty()) return;
    this.lastError = undefined;
    this.streamStatus.playing = true;
    this.queueService.setPlaying(true);
    this.worker = this.run(notice).finally(() => {
      this.worker = undefined; this.streamStatus.playing = false;
      this.queueService.setPlaying(false);
      if (!this.stopping && !this.queueService.isEmpty()) this.start(notice);
    });
  }
  private async run(notice?: PlaybackNotice) {
    try {
      let item: QueueItem | null;
      while (!this.stopping && (item = this.queueService.getNext())) {
        const current = item;
        const controller = new AbortController(); this.controller = controller;
        let input: PlaybackInput | undefined;
        const notify = async (event: Parameters<PlaybackNotice>[0], text: string) => { try { await notice?.(event, text); } catch { /* Discord notices must not halt playback. */ } };
        try {
          if ('reference' in current) {
            const resolved = await this.providers.get(current.reference.providerId).resolvePlayback(current.reference, controller.signal);
            input = { url: resolved.inputUrl, title: current.title, close: resolved.close };
          } else input = await this.engine.resolveLegacy(current, controller.signal);
          if (controller.signal.aborted || this.stopping) continue;
          current.title = input.title;
          if (!("reference" in current) && input.type) current.type = input.type;
          current.resolved = true;
          await notify('playing', current.title);
          await this.engine.play(input, controller.signal);
          if (!controller.signal.aborted) await notify('finished', current.title);
        } catch (error) {
          if (!controller.signal.aborted) {
            this.lastError = safeError(error);
            await notify('error', this.lastError);
          }
        } finally {
          try { await input?.close?.(); } catch { this.lastError = 'Playback session cleanup failed; check provider connectivity'; }
          this.queueService.removeFromQueue(current.id);
        }
      }
    } finally {
      this.controller = undefined;
      await this.engine.disconnect().catch(() => {});
      this.streamStatus.joined = false;
    }
  }
  async skip(): Promise<void> { this.controller?.abort(); }
  async stopAndClearQueue(): Promise<void> {
    this.stopping = true; this.generation++;
    this.queueService.clearQueue();
    this.controller?.abort();
    await this.worker;
    await this.engine.disconnect().catch(() => {});
    this.streamStatus.playing = false; this.streamStatus.joined = false;
    this.streamStatus.manualStop = false; this.stopping = false;
  }
  async cleanupStreamStatus() { await this.stopAndClearQueue(); }
  async waitForIdle() { await this.worker; }
  status() {
    const current = this.queueService.getCurrent();
    return { playing: this.streamStatus.playing, error: this.lastError,
      currentId: current?.id,
      items: this.queueService.getQueue().map(item => ({ id: item.id, title: item.title, type: item.type,
        source: 'providerName' in item ? item.providerName : item.type,
        requestedBy: item.requestedBy, resolved: item.resolved })) };
  }
}
