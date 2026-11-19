import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openGateway } from '../src/providers/gateway.js';
const executable = process.env.FFMPEG_TEST_PATH || (existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : path.resolve('node_modules/node-av/binary/ffmpeg'));
const available = existsSync(executable);
async function run(args: string[]) {
  const child = Bun.spawn([executable, '-hide_banner', '-loglevel', 'error', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), 20000);
  const stderr = await new Response(child.stderr).text(); const code = await child.exited; clearTimeout(timer);
  if (code !== 0) throw new Error(`FFmpeg fixture failed: ${stderr}`);
}
// These generated tones/color bars are local test data, never user media.
(available ? test : test.skip)('real FFmpeg decodes audio and video through progressive and HLS gateway', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'streambot-av-'));
  const token = 'fixture-source-authorization';
  let fetched = 0;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    await run(['-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(dir, 'video.mp4')]);
    await run(['-i', path.join(dir, 'video.mp4'), '-c', 'copy', '-hls_time', '0.5', '-hls_list_size', '0', path.join(dir, 'master.m3u8')]);
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
      if (req.headers.get('X-Emby-Token') !== token) return new Response('', { status: 401 });
      fetched++;
      const name = new URL(req.url).pathname.slice(1);
      if (!readdirSync(dir).includes(name)) return new Response('', { status: 404 });
      const file = Bun.file(path.join(dir, name));
      return new Response(file, { headers: { 'Content-Type': name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : name.endsWith('.ts') ? 'video/mp2t' : 'video/mp4' } });
    } });
    const base = new URL(`http://127.0.0.1:${server.port}/`);
    for (const name of ['video.mp4', 'master.m3u8']) {
      const gateway = await openGateway(base, new URL(name, base), () => ({ 'X-Emby-Token': token }));
      try {
        // Required maps fail if either audio or video is missing.
        await run(['-i', gateway.inputUrl, '-map', '0:v:0', '-map', '0:a:0', '-t', '1', '-f', 'null', '-']);
        expect(gateway.inputUrl).not.toContain(token);
      } finally { await gateway.close(); }
    }
    expect(fetched).toBeGreaterThan(2);
  } finally { server?.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 60000);
