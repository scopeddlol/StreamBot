import { ProviderRegistry } from '../providers/registry.js';
import { ProviderCredentials, ProviderConfig } from '../providers/types.js';
import { validateBaseUrl } from '../providers/security.js';
import { AppStore } from './store.js';
import { Vault } from './vault.js';
import { AppError, fields, text } from './errors.js';
import { randomUUID } from 'node:crypto';

export class RuntimeProviders {
  readonly registry = new ProviderRegistry();
  constructor(readonly store: AppStore, readonly vault: Vault) { this.refresh(); }
  snapshot(ids?:string[]) { return this.store.all('SELECT * FROM media_providers').filter(row=>row.secret_id&&(!ids||ids.includes(row.id))).map(row => ({ config: JSON.parse(row.config) as ProviderConfig, credentials: row.secret_id ? JSON.parse(this.vault.read(row.secret_id)) as ProviderCredentials : {} })); }
  refresh() { const snapshot = this.snapshot(); this.registry.replace(snapshot.map(row => row.config), config => () => snapshot.find(row => row.config.id === config.id)!.credentials); }
  list() { return this.store.all('SELECT * FROM media_providers').map(row => ({ ...JSON.parse(row.config), revision: row.revision, secret: this.vault.metadata(row.secret_id) })); }
  async save(input: any, id?: string) {
    fields(input, ['name','kind','baseUrl','userId','credentials','revision']);
    const old = id && this.store.get('SELECT * FROM media_providers WHERE id=?', id);
    if (id && !old) throw new AppError('NOT_FOUND', 'Provider not found', 404);
    if (old && input.revision !== old.revision) throw new AppError('CONFLICT', 'Provider changed; reload before saving', 409);
    const previous = old ? JSON.parse(old.config) : {};
    const config = { ...previous, id: id || randomUUID(), name: input.name === undefined ? previous.name : text(input.name, 'provider name', 80), kind: input.kind || previous.kind,
      baseUrl: input.baseUrl || previous.baseUrl, userId: input.userId === undefined ? previous.userId : input.userId || undefined } as ProviderConfig;
    validateBaseUrl(config.baseUrl);
    if(old&&!input.credentials&&new URL(previous.baseUrl).origin!==new URL(config.baseUrl).origin)throw new AppError('REENTER_CREDENTIAL','Re-enter credentials when changing a provider origin; stored credentials will not be forwarded to a new host');
    if (!['jellyfin','silo'].includes(config.kind)) throw new AppError('INVALID_PROVIDER', 'Choose Jellyfin or Silo');
    if (input.credentials) {
      fields(input.credentials, ['token','username','password']);
      if (input.credentials.token && (input.credentials.username || input.credentials.password)) throw new AppError('INVALID_AUTH', 'Choose token or username/password authentication');
      for (const value of Object.values(input.credentials)) if (typeof value !== 'string' || value.length > 16384) throw new AppError('INVALID_AUTH', 'Invalid credential');
    }
    const credentials = input.credentials || (old?.secret_id ? JSON.parse(this.vault.read(old.secret_id)) : {});
    new ProviderRegistry([config], () => () => credentials); // validate before any write
    this.store.db.transaction(() => {
      const secret = input.credentials ? this.vault.put('media-provider', config.id, JSON.stringify(credentials), old?.secret_id || undefined) : old.secret_id;
      this.store.run('INSERT INTO media_providers VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,secret_id=excluded.secret_id,revision=excluded.revision', config.id, JSON.stringify(config), secret, (old?.revision ?? -1) + 1);
    })(); this.refresh(); return this.list().find(row => row.id === config.id);
  }
  revoke(id:string){const row=this.store.get('SELECT * FROM media_providers WHERE id=?',id);if(!row)throw new AppError('NOT_FOUND','Provider not found',404);this.store.db.transaction(()=>{this.store.run('UPDATE media_providers SET secret_id=NULL,revision=revision+1 WHERE id=?',id);if(row.secret_id)this.store.run('DELETE FROM secret_records WHERE id=? AND owner=?',row.secret_id,id);})();this.refresh();}
  remove(id: string) {
    for (const row of this.store.all('SELECT source FROM playlist_entries UNION ALL SELECT source FROM queue_items')) if (JSON.parse(row.source).reference?.providerId === id) throw new AppError('PROVIDER_IN_USE', 'Remove this provider from queues/playlists first', 409);
    this.store.run('DELETE FROM media_providers WHERE id=?', id); this.refresh();
  }
}
