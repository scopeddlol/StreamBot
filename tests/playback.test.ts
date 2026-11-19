import { expect, test } from 'bun:test';
import { PlaybackController, PlaybackEngine } from '../src/services/playback.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { QueueService } from '../src/services/queue.js';
import type { StreamStatus } from '../src/types/index.js';

function setup() {
  const events: string[] = [];
  let release: (() => void) | undefined;
  const registry = new ProviderRegistry();
  const provider: any = { config: { id: 'jellyfin', name: 'Jellyfin', kind: 'jellyfin' },
    getItem: async (id: string) => ({ id, title: id, kind: 'movie', sources: [{ id: 'version' }] }),
    resolvePlayback: async (ref: any, signal: AbortSignal) => {
      events.push(`resolve:${ref.itemId}`);
      if (ref.itemId === 'broken') throw new Error('private signed URL');
      if (ref.itemId === 'slow') await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { inputUrl: 'http://private?token=secret', close: async () => { events.push(`close:${ref.itemId}`); } };
    } };
  (registry as any).providers.set('jellyfin', provider);
  (registry as any).providers.set('silo', { ...provider, config: { id: 'silo', name: 'Silo', kind: 'silo' } });
  const engine: PlaybackEngine = {
    resolveLegacy: async item => { events.push(`legacy:${item.type}`); return { title: item.title, url: 'local' }; },
    play: async (input, signal) => {
      events.push(`play:${input.title}`);
      await new Promise<void>(resolve => { release = resolve; signal.addEventListener('abort', () => { events.push(`abort:${input.title}`); resolve(); }, { once: true }); });
    }, disconnect: async () => { events.push('disconnect'); },
  };
  const status: StreamStatus = { joined: false, joinsucc: false, playing: false, manualStop: false, channelInfo: { guildId: '', channelId: '', cmdChannelId: '' }, queue: { items: [], currentIndex: -1, isPlaying: false } };
  return { controller: new PlaybackController(registry, engine, status), events, finish: () => release?.() };
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 100; i++) { if (condition()) return; await Bun.sleep(2); }
  throw new Error('Timed out waiting for playback event');
}

test('mixed queue resolves providers only at front; skip cleans before autoplay', async () => {
  const { controller: c, events, finish } = setup();
  await c.getQueueService().add('local', 'local', 'requester', 'local');
  await c.enqueueProvider({ providerId: 'jellyfin', itemId: 'movie' }, 'requester');
  await c.enqueueProvider({ providerId: 'silo', itemId: 'episode' }, 'requester');
  await c.getQueueService().add('youtube', 'youtube', 'requester', 'youtube');
  expect(events).toEqual([]); expect(JSON.stringify(c.status())).not.toContain('token');
  c.start(); c.start(); await until(() => events.includes('play:local'));
  finish(); await until(() => events.includes('play:movie'));
  await c.skip(); await until(() => events.includes('play:episode'));
  expect(events.indexOf('close:movie')).toBeLessThan(events.indexOf('resolve:episode'));
  finish(); await until(() => events.includes('play:youtube')); finish(); await c.waitForIdle();
  expect(c.status().items).toEqual([]); expect(c.status().playing).toBe(false);
});
test('stop during preparation closes resources without playing or restarting', async () => {
  const { controller: c, events } = setup();
  await c.enqueueProvider({ providerId: 'jellyfin', itemId: 'slow' }, 'requester', true);
  await until(() => events.includes('resolve:slow'));
  await c.enqueueProvider({ providerId: 'jellyfin', itemId: 'later' }, 'requester');
  await c.stopAndClearQueue();
  expect(events).toContain('close:slow'); expect(events.filter(x => x.startsWith('play:'))).toEqual([]);
  expect(c.status().items).toEqual([]); expect(c.status().playing).toBe(false);
});
test('failed provider advances to next and errors do not expose private input', async () => {
  const { controller: c, events, finish } = setup();
  await c.enqueueProvider({ providerId: 'jellyfin', itemId: 'broken' }, 'requester');
  await c.enqueueProvider({ providerId: 'jellyfin', itemId: 'good' }, 'requester');
  c.start(); await until(() => events.includes('play:good'));
  expect(c.lastError).not.toContain('signed'); finish(); await c.waitForIdle();
});
test('skip last item and stop active playback leave empty idle queue', async () => {
  const { controller: c, events } = setup();
  await c.enqueueProvider({ providerId: 'jellyfin', itemId: 'last' }, 'requester', true);
  await until(() => events.includes('play:last')); await c.skip(); await c.waitForIdle();
  expect(c.status().items).toEqual([]);
  await c.enqueueProvider({ providerId: 'jellyfin', itemId: 'second' }, 'requester', true);
  await until(() => events.includes('play:second')); await c.stopAndClearQueue(); expect(events).toContain('close:second');
});
test('idle queue has no current item and stable refs contain no resolved credentials', async () => {
  const q = new QueueService(); await q.add('local', 'local', 'name', 'local'); expect(q.getCurrent()).toBeNull();
  const { controller: c } = setup(); const item = await c.enqueueProvider({ providerId: 'silo', itemId: 'movie', mediaSourceId: 'version' }, 'user');
  expect(item).toMatchObject({ type: 'silo', reference: { providerId: 'silo', itemId: 'movie', mediaSourceId: 'version' } });
  expect(item).not.toHaveProperty('url'); expect(item).not.toHaveProperty('headers');
});
test('stop invalidates an in-flight enqueue lookup', async () => {
  const { controller: c } = setup();
  let release!: () => void;
  const lookup = new Promise<void>(resolve => release = resolve);
  const p = c.providers.get('jellyfin'); p.getItem = async () => { await lookup; return { id: 'late', title: 'late', kind: 'movie' } as any; };
  const enqueue = c.enqueueProvider({ providerId: 'jellyfin', itemId: 'late' }, 'user', true);
  await c.stopAndClearQueue(); release(); await expect(enqueue).rejects.toThrow('Queue changed');
  expect(c.status().items).toEqual([]);
});
