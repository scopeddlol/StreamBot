import { BaseCommand } from './base.js';
import { CommandContext } from '../types/index.js';
import { safeError } from '../providers/security.js';
import { ProviderRegistry } from '../providers/registry.js';

export default class MediaCommand extends BaseCommand {
  name = 'media';
  description = 'List media servers or search Jellyfin/Silo';
  usage = 'media servers | search <provider-id> <query> | seasons <provider-id> <series-id> | episodes <provider-id> <series-id> [season-id]';
  async execute(context: CommandContext) {
    const registry: ProviderRegistry = context.streamingService.providers;
    const [action, id, ...args] = context.args;
    if (action === 'servers') {
      const lines = await Promise.all(registry.all().map(async provider => {
        try { await provider.healthCheck(); return `${provider.config.id} (${provider.config.kind}): connected`; }
        catch (error) { return `${provider.config.id}: ${safeError(error)}`; }
      }));
      await this.sendInfo(context.message, 'Sources', lines.join('\n') || 'No providers configured');
      return;
    }
    try {
      const provider = registry.get(id);
      const items = action === 'search' ? (await provider.search(args.join(' ').replace(/^"|"$/g, ''), { limit: 10 })).items
        : action === 'seasons' ? await provider.getSeasons(args[0])
        : action === 'episodes' ? await provider.getEpisodes(args[0], args[1]) : undefined;
      if (!items) { await this.sendError(context.message, this.usage); return; }
      const lines = items.slice(0, 10).map(item => `${item.title} (${item.kind}) — ${id}:${item.id}`);
      await this.sendInfo(context.message, provider.config.name, (lines.join('\n') || 'No results').slice(0, 1800));
    } catch (error) { await this.sendError(context.message, safeError(error)); }
  }
}
