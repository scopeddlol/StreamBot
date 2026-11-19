import { JellyfinCompatibleClient } from './jellyfin-compatible-client.js';
// Separate adapter boundary. Silo uses its compatibility listener/session, never
// native v2 bearer/profile headers. Version-specific differences belong here.
export class SiloProvider extends JellyfinCompatibleClient {}
