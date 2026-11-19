import { beforeAll, afterAll, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import { ProviderRegistry } from '../src/providers/registry.js';
import { handleMessageCreate } from '../src/events/messageCreate.js';
import config from '../src/config.js';
import { dashboardSettings } from '../src/server/middleware/security.js';

let server: Server, base: string, cookie: string;
const password = 'fixture-strong-dashboard-passphrase';
const registry = new ProviderRegistry();
const calls: string[] = [];
beforeAll(async () => {
  process.env.SERVER_PASSWORD = password;
  process.env.SESSION_SECRET = 'fixture-random-session-secret-long-enough-123456789';
  process.env.SERVER_PUBLIC_ORIGIN = 'http://localhost:3000';
  config.server_password = password;
  const { createApp } = await import('../src/server/index.js');
  const app = createApp(registry);
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
const origin = { Origin: 'http://localhost:3000' };

test('health endpoint contains no media metadata or configuration', async () => {
  const response = await fetch(`${base}/healthz`); expect(await response.json()).toEqual({ status: 'ok' });
});
test('all media management endpoints require authentication', async () => {
  for (const route of ['/api/providers', '/api/media', '/api/providers/p/items/id', '/api/providers/p/items/id/artwork', '/api/playback']) {
    expect((await fetch(base + route)).status).toBe(401);
  }
  expect((await fetch(`${base}/api/playback/stop`, { method: 'POST', headers: origin })).status).toBe(401);
});
test('login and state changes reject missing/cross-site origin; password validation', async () => {
  expect((await fetch(`${base}/login`, { method: 'POST', body: '' })).status).toBe(403);
  expect((await fetch(`${base}/login`, { method: 'POST', headers: { Origin: 'https://evil.invalid' } })).status).toBe(403);
  expect((await fetch(`${base}/login`, { method: 'POST', headers: { ...origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: {} }) })).status).toBe(400);
});
test('login creates strict HTTP-only session; authenticated EJS and playback routes', async () => {
  const response = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { ...origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'admin', password }) });
  expect(response.status).toBe(302); expect(response.headers.get('location')).toBe('/library');
  const setCookie = response.headers.get('set-cookie')!;
  expect(setCookie).toContain('HttpOnly'); expect(setCookie).toContain('SameSite=Strict'); cookie = setCookie.split(';')[0];
  const html = await (await fetch(`${base}/library`, { headers: { Cookie: cookie } })).text();
  expect(html).toContain('Find your next watch'); expect(html).not.toContain(password);
  expect(await (await fetch(`${base}/api/providers`, { headers: { Cookie: cookie } })).json()).toEqual([]);
  expect((await fetch(`${base}/api/playback/start`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.invalid' } })).status).toBe(403);
  expect((await fetch(`${base}/api/playback/start`, { method: 'POST', headers: { Cookie: cookie, ...origin } })).status).toBe(503);
  expect((await fetch(`${base}/delete/anything`, { headers: { Cookie: cookie }, redirect: 'manual' })).status).toBe(404);
});
test('logout requires POST and invalidates session', async () => {
  const response = await fetch(`${base}/logout`, { method: 'POST', headers: { Cookie: cookie, ...origin }, redirect: 'manual' });
  expect(response.status).toBe(302); expect((await fetch(`${base}/api/providers`, { headers: { Cookie: cookie } })).status).toBe(401);
});
test('dashboard rejects weak secrets and derives secure cookie mode from external origin', () => {
  const original = process.env.SERVER_PASSWORD;
  process.env.SERVER_PASSWORD = 'admin'; expect(() => dashboardSettings()).toThrow('SERVER_PASSWORD');
  process.env.SERVER_PASSWORD = original;
  process.env.SERVER_PUBLIC_ORIGIN = 'https://dashboard.example.test'; expect(dashboardSettings().secure).toBe(true);
  process.env.SERVER_PUBLIC_ORIGIN = 'http://localhost:3000';
});
test('Discord authorization rejects wrong user, guild and channel before dispatch', async () => {
  config.guildId = 'guild'; config.cmdChannelId = 'channel'; config.prefix = '$'; config.adminIds = ['admin-user'];
  const manager: any = { executeCommand: async () => { calls.push('execute'); return true; } };
  const message: any = { author: { id: 'other', bot: false }, client: { user: { id: 'self' } }, content: '$media servers', guild: { id: 'guild' }, channel: { id: 'channel' } };
  await handleMessageCreate(message, [], {} as any, {}, manager); expect(calls).toHaveLength(0);
  message.author.id = 'admin-user'; message.channel.id = 'wrong';
  await handleMessageCreate(message, [], {} as any, {}, manager); expect(calls).toHaveLength(0);
  message.channel.id = 'channel'; message.guild.id = 'wrong';
  await handleMessageCreate(message, [], {} as any, {}, manager); expect(calls).toHaveLength(0);
  message.guild.id = 'guild'; await handleMessageCreate(message, [], {} as any, {}, manager); expect(calls).toHaveLength(1);
});
test('proxy trust accepts explicit addresses and rejects blanket/invalid trust', () => {
  process.env.SERVER_TRUST_PROXY = '172.20.0.5/32'; expect(() => dashboardSettings()).not.toThrow();
  process.env.SERVER_TRUST_PROXY = 'true'; expect(() => dashboardSettings()).toThrow('TRUST_PROXY');
  process.env.SERVER_TRUST_PROXY = '0.0.0.0/0'; expect(() => dashboardSettings()).toThrow('TRUST_PROXY');
  delete process.env.SERVER_TRUST_PROXY;
});
