import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { AppStore } from './store.js';
import { AppError } from './errors.js';
import { registerSecret } from '../utils/redact.js';
interface Keyring { active: string; keys: Record<string, string> }
export class Vault {
  private ring: Keyring;
  private file: string;
  constructor(private store: AppStore) {
    const folder = path.join(store.dir, 'security'); fs.mkdirSync(folder, { recursive: true, mode: 0o700 }); fs.chmodSync(folder, 0o700);
    this.file = path.join(folder, 'vault-keys.json');
    if (!fs.existsSync(this.file)) {
      if (store.get('SELECT count(*) AS count FROM secret_records').count) throw new AppError('VAULT_KEY_LOST', 'Vault key missing: restore the matching security directory from backup. Secrets cannot be recovered without it.', 503);
      const id = randomUUID(); this.ring = { active: id, keys: { [id]: randomBytes(32).toString('base64') } }; this.write();
    } else {
      try { this.ring = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.validate(this.ring); fs.chmodSync(this.file, 0o600); }
      catch { throw new AppError('VAULT_KEY_INVALID', 'Vault key invalid; restore matching key material. No replacement was generated.', 503); }
    }
    for (const row of store.all('SELECT id FROM secret_records')) this.read(row.id);
  }
  validate(ring: Keyring) {
    if (!ring?.keys?.[ring.active] || Object.values(ring.keys).some(key => typeof key !== 'string' || Buffer.from(key, 'base64').length !== 32)) throw new Error('Invalid keyring');
  }
  private write() {
    const temp = this.file + '.next'; fs.writeFileSync(temp, JSON.stringify(this.ring), { mode: 0o600 }); fs.chmodSync(temp, 0o600);
    const fd = fs.openSync(temp, 'r'); fs.fsyncSync(fd); fs.closeSync(fd); fs.renameSync(temp, this.file);
  }
  private encrypt(value: string, purpose: string, owner: string, version: number, id: string, keyId = this.ring.active) {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(this.ring.keys[keyId], 'base64'), nonce);
    cipher.setAAD(Buffer.from(JSON.stringify({ id, purpose, owner, version })));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { nonce, ciphertext, tag: cipher.getAuthTag(), keyId };
  }
  put(purpose: string, owner: string, value: string, id = randomUUID()) {
    if (typeof value !== 'string' || !value || value.length > 32768) throw new AppError('INVALID_SECRET', 'Invalid credential');
    const old = this.store.get('SELECT * FROM secret_records WHERE id=?', id);
    if (old && (old.purpose !== purpose || old.owner !== owner)) throw new AppError('SECRET_OWNER', 'Credential ownership mismatch', 403);
    const version = (old?.version || 0) + 1;
    const encrypted = this.encrypt(value, purpose, owner, version, id);
    this.store.run(`INSERT INTO secret_records VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,key_id=excluded.key_id,nonce=excluded.nonce,ciphertext=excluded.ciphertext,tag=excluded.tag,updated_at=excluded.updated_at`, id, purpose, owner, version, encrypted.keyId, encrypted.nonce, encrypted.ciphertext, encrypted.tag, Date.now());
    registerSecret(value); return id;
  }
  read(id: string): string {
    const row = this.store.get('SELECT * FROM secret_records WHERE id=?', id);
    if (!row) throw new AppError('SECRET_MISSING', 'Credential not configured', 409);
    try {
      const key = this.ring.keys[row.key_id]; if (!key) throw new Error();
      const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), row.nonce);
      cipher.setAAD(Buffer.from(JSON.stringify({ id:row.id,purpose: row.purpose, owner: row.owner, version: row.version }))); cipher.setAuthTag(row.tag);
      const value = Buffer.concat([cipher.update(row.ciphertext), cipher.final()]).toString('utf8'); registerSecret(value); return value;
    } catch { throw new AppError('SECRET_INTEGRITY', 'Credential integrity/key check failed. Restore a matching backup.', 503); }
  }
  metadata(id?: string) { const row = id && this.store.get('SELECT updated_at FROM secret_records WHERE id=?', id); return { configured: !!row, lastUpdated: row?.updated_at }; }
  rotate() {
    const rows = this.store.all('SELECT * FROM secret_records').map(row => ({ ...row, value: this.read(row.id) }));
    const id = randomUUID(); this.ring.keys[id] = randomBytes(32).toString('base64'); this.write(); // persist BOTH keys before DB commit
    this.store.db.transaction(() => {
      for (const row of rows) {
        const encrypted = this.encrypt(row.value, row.purpose, row.owner, row.version, row.id, id);
        this.store.run('UPDATE secret_records SET key_id=?,nonce=?,ciphertext=?,tag=? WHERE id=?', id, encrypted.nonce, encrypted.ciphertext, encrypted.tag, row.id);
      }
    })();
    this.ring.active = id; this.write(); // retain old keys for crash safety / old encrypted records
  }
  exportKeys() { return structuredClone(this.ring); } // ONLY encrypted backup service, never an API response
  restoreKeys(ring: Keyring) { this.validate(ring); this.ring = ring; this.write(); }
}
