import fs from 'node:fs';
import { JellyfinProvider } from './jellyfin.js';
import { SiloProvider } from './silo.js';
import { MediaProvider, ProviderConfig, ProviderError } from './types.js';
import { mediaId, validateBaseUrl } from './security.js';

export class ProviderRegistry {
  private providers = new Map<string, MediaProvider>();
  constructor(configs: ProviderConfig[] = []) {
    for (const config of configs) {
      if (!config || typeof config !== 'object') throw new ProviderError('Each provider must be a configuration object', 400);
      if (Object.keys(config).some(key => !['id', 'name', 'kind', 'baseUrl', 'credentialEnv', 'userId', 'usernameEnv', 'passwordEnv'].includes(key))) throw new ProviderError('Unknown provider config field; store credentials in environment variables', 400);
      mediaId(config.id);
      if (this.providers.has(config.id)) throw new ProviderError('Duplicate provider ID', 400);
      if (!['jellyfin', 'silo'].includes(config.kind)) throw new ProviderError('Unknown provider kind', 400);
      if (typeof config.name !== 'string' || !config.name.trim()) throw new ProviderError('Provider requires a name', 400);
      validateBaseUrl(config.baseUrl);
      if (config.userId) mediaId(config.userId);
      for (const value of [config.credentialEnv, config.usernameEnv, config.passwordEnv]) {
        if (value !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(value)) throw new ProviderError('Credential fields must name environment variables', 400);
      }
      if (config.credentialEnv && (config.usernameEnv || config.passwordEnv)) throw new ProviderError('Choose token OR login authentication', 400);
      this.providers.set(config.id, config.kind === 'silo' ? new SiloProvider(config) : new JellyfinProvider(config));
    }
  }
  all() { return [...this.providers.values()]; }
  get(id: string) {
    const provider = this.providers.get(id);
    if (!provider) throw new ProviderError('Unknown provider; use a configured provider ID', 404);
    return provider;
  }
  static fromEnvironment() {
    const file = process.env.MEDIA_SERVERS_CONFIG;
    if (!file) return new ProviderRegistry();
    let data: any;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new ProviderError('Cannot read MEDIA_SERVERS_CONFIG; supply valid JSON', 400); }
    if (!Array.isArray(data.servers) || data.servers.length > 20) throw new ProviderError('Provider config requires a servers array (maximum 20)', 400);
    return new ProviderRegistry(data.servers);
  }
}
