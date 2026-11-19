import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { AppStore } from './store.js';
import { RuntimeProviders } from './providers.js';
import { Vault } from './vault.js';
import { AppError, fields, text, integer } from './errors.js';
import { PlayableReference } from '../providers/types.js';
export interface Source { title: string; durationMs?:number; reference?: PlayableReference; local?: string; inputSecretId?: string }
export class Playlists {
  constructor(readonly store: AppStore, readonly providers: RuntimeProviders, readonly vault: Vault) {}
  playlist(instanceId: string) {
    let row = this.store.get("SELECT * FROM playlists WHERE instance_id=? ORDER BY coalesce(json_extract(config,'$.selected'),1) DESC,rowid ASC LIMIT 1", instanceId);
    if (!row) {
      const id=randomUUID(); this.store.run('INSERT INTO playlists VALUES(?,?,?,0)',id,instanceId,JSON.stringify({ name:'Channel playlist',repeat:'off',shuffle:false,seed:randomUUID(),active:true,selected:true }));
      row=this.store.get('SELECT * FROM playlists WHERE id=?',id);
    }
    return { id:row.id, instanceId:row.instance_id, config:JSON.parse(row.config),revision:row.revision,
      entries:this.store.all('SELECT * FROM playlist_entries WHERE playlist_id=? ORDER BY position',row.id).map(entry=>({id:entry.id,position:entry.position,source:JSON.parse(entry.source)})) };
  }
  saved(instanceId:string){return this.store.all('SELECT * FROM playlists WHERE instance_id=? ORDER BY rowid',instanceId).map(row=>({id:row.id,...JSON.parse(row.config),revision:row.revision}));}
  duplicate(instanceId:string,name:string){const original=this.playlist(instanceId),id=randomUUID();this.store.db.transaction(()=>{this.store.run('INSERT INTO playlists VALUES(?,?,?,0)',id,instanceId,JSON.stringify({...original.config,name:text(name,'playlist name',100),selected:false,active:false}));for(const entry of original.entries)this.store.run('INSERT INTO playlist_entries VALUES(?,?,?,?)',randomUUID(),id,entry.position,JSON.stringify(entry.source));})();return{id};}
  select(instanceId:string,id:string){const row=this.store.get('SELECT * FROM playlists WHERE id=? AND instance_id=?',id,instanceId);if(!row)throw new AppError('PLAYLIST_MISSING','Playlist not found in this room',404);this.store.db.transaction(()=>{for(const playlist of this.store.all('SELECT * FROM playlists WHERE instance_id=?',instanceId)){const config=JSON.parse(playlist.config);config.selected=playlist.id===id;if(config.selected)config.active=true;this.store.run('UPDATE playlists SET config=?,revision=revision+1 WHERE id=?',JSON.stringify(config),playlist.id);}this.store.run('DELETE FROM playback_checkpoints WHERE instance_id=?',instanceId);})();return this.playlist(instanceId);}
  exportReferences(instanceId:string){const playlist=this.playlist(instanceId);return{format:'streambot-playlist-v1',name:playlist.config.name,repeat:playlist.config.repeat,shuffle:playlist.config.shuffle,items:playlist.entries.filter(e=>!e.source.inputSecretId).map(e=>e.source.reference?{...e.source.reference,providerId:e.source.reference.providerId,itemId:e.source.reference.itemId}: {local:e.source.local}),excludedPrivateInputs:playlist.entries.filter(e=>e.source.inputSecretId).length};}
  async expand(input: any, instanceId: string): Promise<Source[]> {
    fields(input,['providerId','itemId','mediaSourceId','includeSpecials','local','input','title']);
    const instance=JSON.parse(this.store.get('SELECT config FROM instances WHERE id=?',instanceId)?.config || '{}');
    if (input.local) {
      const file=text(input.local,'local filename',255); if(path.basename(file)!==file || file.includes('\\'))throw new AppError('INVALID_PATH','Choose a file in local videos');
      const root=fs.realpathSync(path.join(this.store.dir,'videos')), full=fs.realpathSync(path.join(root,file));
      if(!full.startsWith(root+path.sep)||!fs.statSync(full).isFile())throw new AppError('INVALID_PATH','Local file unavailable');
      return [{title:file,local:file}];
    }
    if(input.input) {
      const value=text(input.input,'URL or search query',2000);
      if (/^[a-z]+:/i.test(value) && !/^https?:\/\//i.test(value)) throw new AppError('INVALID_SOURCE','Only HTTP(S), local files or search queries are supported');
      if (/^https?:/i.test(value)) { const u=new URL(value); if(u.username||u.password)throw new AppError('INVALID_SOURCE','Credentials in URLs are not supported');const host=u.hostname.toLowerCase();if(!['youtube.com','youtu.be','twitch.tv'].some(domain=>host===domain||host.endsWith('.'+domain))&&!this.store.setting<string[]>('source-origins',[]).includes(u.origin))throw new AppError('SOURCE_ORIGIN_DENIED','Allow this exact direct-media origin in System settings before queueing it',403); }
      const secret=this.vault.put('legacy-input',instanceId,value); return [{title:text(input.title||'URL / YouTube search','title'),inputSecretId:secret}];
    }
    const provider=this.providers.registry.get(text(input.providerId,'provider ID'));
    if(instance.providerIds?.length&&!instance.providerIds.includes(provider.config.id))throw new AppError('PROVIDER_DENIED','Provider not enabled for this room',403);
    const item=await provider.getItem(text(input.itemId,'item ID'));
    if(item.kind==='movie'||item.kind==='episode') {
      if(input.mediaSourceId&&!item.sources?.some(s=>s.id===input.mediaSourceId))throw new AppError('VERSION_MISSING','Selected version unavailable');
      return [{title:item.title,durationMs:item.durationMs,reference:{providerId:provider.config.id,itemId:item.id,...(input.mediaSourceId?{mediaSourceId:input.mediaSourceId}:{})}}];
    }
    const seriesId=item.kind==='series'?item.id:item.seriesId;
    if(!seriesId)throw new AppError('SERIES_MISSING','Series identity unavailable');
    const seasons=item.kind==='season'?[item]:(await provider.getSeasons(seriesId)).sort((a,b)=>(a.episodeNumber||0)-(b.episodeNumber||0));
    const result:Source[]=[];
    for(const season of seasons) {
      if(!input.includeSpecials && item.kind==='series' && (season.episodeNumber===0 || /specials/i.test(season.title)))continue;
      const episodes=(await provider.getEpisodes(seriesId,season.id)).sort((a,b)=>(a.seasonNumber||0)-(b.seasonNumber||0)||(a.episodeNumber||0)-(b.episodeNumber||0)||a.id.localeCompare(b.id));
      for(const episode of episodes)result.push({title:episode.title,durationMs:episode.durationMs,reference:{providerId:provider.config.id,itemId:episode.id}});
      if(result.length>2000)throw new AppError('EXPANSION_LIMIT','Show exceeds 2,000 episode expansion limit; add seasons separately');
    }
    if(!result.length)throw new AppError('EMPTY_SEASON','No accessible episodes found'); return result;
  }
  add(instanceId:string,sources:Source[], actor:string, live=false) {
    const existing=this.store.get(live?'SELECT count(*) AS n FROM playlist_entries WHERE playlist_id IN (SELECT id FROM playlists WHERE instance_id=?)':'SELECT count(*) AS n FROM queue_items WHERE instance_id=?',instanceId).n;if(existing+sources.length>10000)throw new AppError('QUEUE_LIMIT','Room queue/playlist entry cap reached');
    if(!sources.length||sources.length>2000)throw new AppError('BATCH_LIMIT','Add between 1 and 2,000 items');
    const ids:string[]=[];
    this.store.db.transaction(()=>{
      if(live){const playlist=this.playlist(instanceId);let pos=playlist.entries.length;
        for(const source of sources){const id=randomUUID();ids.push(id);this.store.run('INSERT INTO playlist_entries VALUES(?,?,?,?)',id,playlist.id,pos++,JSON.stringify(source));}
        this.store.run('UPDATE playlists SET revision=revision+1 WHERE id=?',playlist.id);
      } else {let pos=this.store.get('SELECT coalesce(max(position),-1)+1 AS n FROM queue_items WHERE instance_id=?',instanceId).n;
        for(const source of sources){const id=randomUUID();ids.push(id);this.store.run('INSERT INTO queue_items(id,instance_id,position,source,actor,created_at) VALUES(?,?,?,?,?,?)',id,instanceId,pos++,JSON.stringify(source),actor,Date.now());}}
      this.store.set('queue-revision:'+instanceId,this.store.setting('queue-revision:'+instanceId,0)+1);
    })();return ids;
  }
  edit(instanceId:string,input:any) {
    fields(input,['revision','name','repeat','shuffle','order','remove','clear','active']);
    return this.store.db.transaction(()=>{
      const playlist=this.playlist(instanceId);if(input.revision!==playlist.revision)throw new AppError('CONFLICT','Playlist changed; refresh before editing',409);
      if(input.repeat!==undefined&&!['off','one','all'].includes(input.repeat))throw new AppError('INVALID_REPEAT','Choose off, one or all');
      for(const key of ['shuffle','clear','active'])if(input[key]!==undefined&&typeof input[key]!=='boolean')throw new AppError('INVALID_FIELD',`Invalid ${key}`);
      if(input.name!==undefined)playlist.config.name=text(input.name,'playlist name',100);
      for(const key of ['repeat','shuffle','active'])if(input[key]!==undefined)playlist.config[key]=input[key];
      if(input.clear)this.store.run('DELETE FROM playlist_entries WHERE playlist_id=?',playlist.id);
      if(input.remove){if(!Array.isArray(input.remove)||input.remove.length>2000)throw new AppError('INVALID_ORDER','Invalid removal list');for(const id of input.remove)this.store.run('DELETE FROM playlist_entries WHERE id=? AND playlist_id=?',id,playlist.id);}
      if(input.order){const rows=this.store.all('SELECT id FROM playlist_entries WHERE playlist_id=?',playlist.id);if(!Array.isArray(input.order)||new Set(input.order).size!==rows.length||input.order.length!==rows.length||rows.some(r=>!input.order.includes(r.id)))throw new AppError('INVALID_ORDER','Reorder must include each playlist entry exactly once');input.order.forEach((id:string,index:number)=>this.store.run('UPDATE playlist_entries SET position=? WHERE id=? AND playlist_id=?',index,id,playlist.id));}
      this.store.run('UPDATE playlists SET config=?,revision=revision+1 WHERE id=?',JSON.stringify(playlist.config),playlist.id);return this.playlist(instanceId);
    })();
  }
  next(instanceId:string,live:boolean) {
    const queued=this.store.get("SELECT * FROM queue_items WHERE instance_id=? ORDER BY CASE status WHEN 'playing' THEN 0 ELSE 1 END,position LIMIT 1",instanceId);
    if(queued)return {id:queued.id,source:JSON.parse(queued.source) as Source,kind:'queue' as const,attempts:queued.attempts};
    if(!live)return undefined;
    const playlist=this.playlist(instanceId);if(!playlist.config.active||!playlist.entries.length)return undefined;
    const checkpoint=this.store.get('SELECT * FROM playback_checkpoints WHERE instance_id=?',instanceId);
    const cycle=checkpoint?.cycle||0;
    const entries=playlist.config.shuffle?[...playlist.entries].sort((a,b)=>createHash('sha256').update(`${playlist.config.seed}:${cycle}:${a.id}`).digest('hex').localeCompare(createHash('sha256').update(`${playlist.config.seed}:${cycle}:${b.id}`).digest('hex'))):playlist.entries;
    let cursor=checkpoint?.cursor||0;
    if(checkpoint?.item_id){const restored=entries.findIndex(e=>e.id===checkpoint.item_id);if(restored>=0)cursor=restored;}
    if(cursor>=entries.length){if(playlist.config.repeat==='off')return undefined;cursor=0;}
    const entry=entries[cursor];return {id:entry.id,source:entry.source as Source,kind:'playlist' as const,playlistId:playlist.id,cursor,cycle};
  }
  begin(instanceId:string,item:NonNullable<ReturnType<Playlists['next']>>) {
    this.store.db.transaction(()=>{
      if(item.kind==='queue')this.store.run("UPDATE queue_items SET status='playing' WHERE id=? AND instance_id=?",item.id,instanceId);
      this.store.run('INSERT INTO playback_checkpoints VALUES(?,?,?,?,?,?,?) ON CONFLICT(instance_id) DO UPDATE SET item_id=excluded.item_id,'+(item.kind==='playlist'?'playlist_id=excluded.playlist_id,cursor=excluded.cursor,cycle=excluded.cycle,':'')+'generation=playback_checkpoints.generation+1,updated_at=excluded.updated_at',instanceId,item.id,item.kind==='playlist'?item.playlistId:null,item.kind==='playlist'?item.cursor:0,item.kind==='playlist'?item.cycle:0,0,Date.now());
    })();
  }
  finish(instanceId:string,item:NonNullable<ReturnType<Playlists['next']>>,skip=false) {
    this.store.db.transaction(()=>{
      if(item.kind==='queue'){this.store.run('DELETE FROM queue_items WHERE id=? AND instance_id=?',item.id,instanceId);this.store.run('UPDATE playback_checkpoints SET item_id=NULL WHERE instance_id=?',instanceId);}
      else {const playlist=this.playlist(instanceId), same=playlist.config.repeat==='one'&&!skip;
        const present=playlist.entries.findIndex(e=>e.id===item.id);
        const cursor=same&&present>=0?present:present>=0?present+1:Math.min(item.cursor,playlist.entries.length), wrapped=cursor>=playlist.entries.length;
        this.store.run('UPDATE playback_checkpoints SET item_id=NULL,cursor=?,cycle=?,updated_at=? WHERE instance_id=?',wrapped&&playlist.config.repeat==='all'?0:cursor,item.cycle+(wrapped?1:0),Date.now(),instanceId);}
      this.store.set('queue-revision:'+instanceId,this.store.setting('queue-revision:'+instanceId,0)+1);
    })();
  }
  queue(instanceId:string){return this.store.all('SELECT id,source,actor,status,attempts FROM queue_items WHERE instance_id=? ORDER BY position',instanceId).map(row=>({...row,source:JSON.parse(row.source)}));}
}
