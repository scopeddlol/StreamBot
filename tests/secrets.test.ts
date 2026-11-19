import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppStore } from '../src/tv/store.js';
import { Vault } from '../src/tv/vault.js';

test('SQLite migration is idempotent; vault encrypts, authenticates metadata, rotates and fails closed on key loss', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'streambot-vault-'));
  let store = new AppStore(dir);
  try {
    const vault = new Vault(store), secret = 'fixture-dynamic-private-credential';
    const id = vault.put('provider','owner',secret);
    expect(vault.read(id)).toBe(secret); expect(JSON.stringify(store.all('SELECT * FROM secret_records'))).not.toContain(secret);
    expect(fs.statSync(path.join(dir,'security/vault-keys.json')).mode & 0o777).toBe(0o600);
    const before = store.get('SELECT nonce FROM secret_records').nonce;
    vault.put('provider','owner',secret,id); expect(store.get('SELECT nonce FROM secret_records').nonce).not.toEqual(before);
    vault.rotate(); expect(vault.read(id)).toBe(secret);
    store.run("UPDATE secret_records SET owner='tampered'"); expect(() => vault.read(id)).toThrow('integrity');
    store.run("UPDATE secret_records SET owner='owner'"); store.close(); store = new AppStore(dir);
    expect(store.all('SELECT * FROM schema_migrations')).toHaveLength(1); expect(new Vault(store).read(id)).toBe(secret);
    fs.unlinkSync(path.join(dir,'security/vault-keys.json')); expect(() => new Vault(store)).toThrow('missing');
  } finally { store.close(); fs.rmSync(dir,{recursive:true,force:true}); }
});
