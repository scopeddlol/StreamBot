import { createHash, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { AppStore } from './store.js';
import { AppError, text } from './errors.js';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export class Auth {
  private pairing?: { hash: string; expires: number };
  private attempts = new Map<string, { count: number; expires: number }>();
  constructor(readonly store: AppStore, private announce: (message: string) => void = console.info) { if (!this.hasOwner()) this.newPairing(); }
  renewPairing() { if (!this.pairing || this.pairing.expires < Date.now()) this.newPairing(); }
  hasOwner() { return !!this.store.get('SELECT id FROM users LIMIT 1'); }
  newPairing() {
    if (this.hasOwner()) throw new AppError('CLAIMED', 'Administrator already configured', 409);
    const code = randomBytes(18).toString('base64url'); this.pairing = { hash: digest(code), expires: Date.now() + 15 * 60000 };
    this.announce(`StreamBot TV local one-time pairing code (expires in 15 minutes): ${code}`);
  }
  throttle(key: string, limit = 10) {
    const old = this.attempts.get(key), now = Date.now();
    if (this.attempts.size > 5000) for (const [id, value] of this.attempts) if (value.expires < now) this.attempts.delete(id);
    const value = old && old.expires > now ? old : { count: 0, expires: now + 60000 };
    if (++value.count > limit || this.attempts.size > 10000) throw new AppError('RATE_LIMIT', 'Too many attempts; retry in one minute', 429);
    this.attempts.set(key, value);
  }
  async passwordHash(password: unknown) {
    if (typeof password !== 'string' || password.length < 16 || password.length > 1024 || /^(admin|password|change|replace)/i.test(password)) throw new AppError('WEAK_PASSWORD', 'Use a unique password of at least 16 characters');
    return argon2.hash(password, { type: argon2.argon2id });
  }
  async claim(code: unknown, username: unknown, password: unknown) {
    if (this.hasOwner() || !this.pairing || this.pairing.expires < Date.now() || typeof code !== 'string' || !timingSafeEqual(Buffer.from(digest(code)), Buffer.from(this.pairing.hash))) throw new AppError('PAIRING_INVALID', 'Pairing code invalid, expired or already consumed', 403);
    const name = text(username, 'username', 80), hash = await this.passwordHash(password);
    return this.store.db.transaction(() => {
      if (this.hasOwner() || !this.pairing || this.pairing.expires < Date.now()) throw new AppError('CLAIMED', 'Administrator already configured or pairing expired', 409);
      const id = randomUUID(); this.store.run('INSERT INTO users VALUES(?,?,?,?,?)', id, name, hash, 'owner', Date.now()); this.pairing = undefined;
      this.store.audit(id, 'bootstrap.claim', id); return this.session(id);
    })();
  }
  session(userId: string) {
    this.store.run('DELETE FROM sessions WHERE expires_at<? OR last_seen<?',Date.now(),Date.now()-30*60000);
    const token = randomBytes(32).toString('base64url'); this.store.run('INSERT INTO sessions VALUES(?,?,?,?)', digest(token), userId, Date.now() + 8 * 3600000, Date.now()); return token;
  }
  async login(username: unknown, password: unknown) {
    const user = typeof username === 'string' && this.store.get('SELECT * FROM users WHERE username=?', username);
    const hash = user?.password_hash || this.store.get('SELECT password_hash FROM users LIMIT 1')?.password_hash;
    const valid = typeof password === 'string' && password.length <= 1024 && hash && await argon2.verify(hash,password).catch(()=>false);
    if (!user || !valid) throw new AppError('LOGIN_FAILED', 'Invalid username or password', 401);
    return this.session(user.id);
  }
  user(token?: string) {
    if (!token) return undefined;
    const row = this.store.get('SELECT users.id,users.username,users.role,sessions.last_seen,sessions.expires_at FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.id=?', digest(token));
    if (!row || row.expires_at < Date.now() || row.last_seen < Date.now() - 30 * 60000) { this.logout(token); return undefined; }
    this.store.run('UPDATE sessions SET last_seen=? WHERE id=?', Date.now(), digest(token)); return { id: row.id, username: row.username, role: row.role };
  }
  logout(token: string) { this.store.run('DELETE FROM sessions WHERE id=?', digest(token)); }
}
