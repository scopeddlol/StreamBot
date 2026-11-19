import { isIP } from 'node:net';
import { RequestHandler } from 'express';

export function dashboardSettings() {
  const password = process.env.SERVER_PASSWORD || '';
  if (!/^\$argon2|^\$2[aby]\$/.test(password) && (password.length < 16 || /^(admin|password|change|replace)/i.test(password))) {
    throw new Error('SERVER_PASSWORD must be a strong password of at least 16 characters or a bcrypt/Argon2 hash');
  }
  const secret = process.env.SESSION_SECRET || '';
  if (secret.length < 32 || /^(change|replace)/i.test(secret)) throw new Error('SESSION_SECRET must contain at least 32 random characters');
  const value = process.env.SERVER_PUBLIC_ORIGIN || 'http://localhost:3000';
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || value !== url.origin) throw new Error('SERVER_PUBLIC_ORIGIN must be an HTTP(S) origin without path');
  const proxy = process.env.SERVER_TRUST_PROXY;
  if (proxy && proxy !== 'loopback') {
    for (const entry of proxy.split(',').map(x => x.trim())) {
      const [ip, prefix, extra] = entry.split('/');
      const bits = isIP(ip) === 4 ? 32 : isIP(ip) === 6 ? 128 : 0;
      if (!bits || extra || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > bits))) throw new Error('SERVER_TRUST_PROXY must name explicit proxy IPs/CIDRs or loopback');
    }
  }
  return { secret, origin: url.origin, secure: url.protocol === 'https:' };
}
export function sameOrigin(origin: string): RequestHandler {
  return (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && (req.get('origin') !== origin || req.get('sec-fetch-site') === 'cross-site')) {
      res.status(403).json({ error: 'Request origin rejected' }); return;
    }
    next();
  };
}
