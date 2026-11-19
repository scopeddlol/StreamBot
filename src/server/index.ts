import express from 'express';
import session from 'express-session';
import expressLayouts from 'express-ejs-layouts';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import config from '../config.js';
import logger from '../utils/logger.js';
import { stringify, prettySize } from './utils/helpers.js';
import { requireAuth } from './middleware/auth.js';
import { dashboardSettings, sameOrigin } from './middleware/security.js';
import authRoutes from './routes/auth.js';
import dashboardRoutes from './routes/dashboard.js';
import uploadRoutes from './routes/upload.js';
import previewRoutes from './routes/preview.js';
import { mediaRoutes } from './routes/media-library.js';
import { PlaybackController } from '../services/playback.js';
import { ProviderRegistry } from '../providers/registry.js';

export function createApp(providers: ProviderRegistry, playback?: PlaybackController) {
  const settings = dashboardSettings();
  const app = express();
  app.disable('x-powered-by');
  if (process.env.SERVER_TRUST_PROXY) app.set('trust proxy', process.env.SERVER_TRUST_PROXY);
  app.set('view engine', 'ejs'); app.set('views', path.join(process.cwd(), 'src/server/views'));
  app.use(expressLayouts); app.set('layout', 'layouts/main');
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' }); next();
  });
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.use(sameOrigin(settings.origin));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));
  app.use(express.json({ limit: '16kb' }));
  app.use(session({
    name: 'streambot.sid', secret: settings.secret, resave: false, saveUninitialized: false,
    cookie: { secure: settings.secure, httpOnly: true, sameSite: 'strict', maxAge: 8 * 60 * 60 * 1000 },
  }));
  app.use(express.static(path.join(process.cwd(), 'src/server/public')));
  app.use((_req, res, next) => { res.locals.stringify = stringify; res.locals.prettySize = prettySize; next(); });
  app.use(requireAuth);
  app.use('/', authRoutes);
  app.use('/', mediaRoutes(providers, playback));
  app.use('/', dashboardRoutes); app.use('/', uploadRoutes); app.use('/', previewRoutes);
  app.use((_error: unknown, _req: any, res: any, _next: any) => res.status(500).json({ error: 'Request failed' }));
  for (const dir of [config.videosDir, config.previewCacheDir]) fs.mkdirSync(dir, { recursive: true });
  return app;
}
export function startServer(providers: ProviderRegistry, playback?: PlaybackController) {
  const app = createApp(providers, playback);
  return app.listen(config.server_port, process.env.SERVER_HOST || '127.0.0.1', () => logger.info(`Dashboard listening on port ${config.server_port}`));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) startServer(ProviderRegistry.fromEnvironment());
