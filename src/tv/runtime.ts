import fs from 'node:fs';import path from 'node:path';
import { AppStore } from './store.js';import { Vault } from './vault.js';import { Auth } from './auth.js';import { RuntimeProviders } from './providers.js';import { Permissions } from './permissions.js';import { Playlists } from './playlists.js';import { InstanceManager } from './instances.js';import { Catalog } from './catalog.js';import { Requests } from './requests.js';import { Concierge } from './ai.js';import { DiscordApplications } from './discord.js';import { Backups } from './backups.js';import { LegacyImport } from './migration.js';
export class TVRuntime {
  store:AppStore;vault:Vault;auth:Auth;providers:RuntimeProviders;policy:Permissions;playlists:Playlists;instances:InstanceManager;catalog:Catalog;requests:Requests;ai:Concierge;discord:DiscordApplications;backups:Backups;migration:LegacyImport;
  constructor(readonly dir:string,announce?:(message:string)=>void,workerFile?:string){
    for(const child of ['videos','preview-cache','security','database'])fs.mkdirSync(path.join(dir,child),{recursive:true,mode:0o700});
    this.store=new AppStore(dir);this.vault=new Vault(this.store);this.auth=new Auth(this.store,announce);this.providers=new RuntimeProviders(this.store,this.vault);this.policy=new Permissions(this.store);this.playlists=new Playlists(this.store,this.providers,this.vault);this.instances=new InstanceManager(this.store,this.vault,this.providers,this.playlists,workerFile);this.catalog=new Catalog(this.policy,this.providers,this.instances);this.requests=new Requests(this.store,this.policy,this.playlists,this.instances);this.ai=new Concierge(this.store,this.vault,this.catalog,this.policy);this.discord=new DiscordApplications(this.store,this.vault,this.policy,this.instances,this.catalog,this.requests,this.ai);this.backups=new Backups(this.store,this.vault);this.migration=new LegacyImport(this.store,this.vault,this.providers,this.instances);
    this.instances.commandHandler=async(id,message)=>{
      const actor:any={id:message.userId,guildId:message.guildId,roleIds:Array.isArray(message.roleIds)?message.roleIds:[],source:'discord',verified:true};
      const [command,...args]=message.content.trim().split(/ +/);const input=args.join(' ');
      if(command==='queue'){this.policy.require(actor,'queue.view',id);return this.playlists.queue(id).map((q,i)=>`${i+1}. ${q.source.title}`).join('\n')||'Queue is empty';}
      if(command==='skip'){this.policy.require(actor,'queue.skip',id);await this.instances.skip(id);this.store.audit(actor.id,'queue.skip',id);return 'Skip requested';}
      if(command==='stop'){this.policy.require(actor,'instance.stop',id);this.store.audit(actor.id,'instance.stop',id);void this.instances.stop(id);return 'Stop requested';}
      if(command==='status'){this.policy.require(actor,'instance.view',id);const room=this.instances.get(id);return `${room.name}: ${room.state}`;}
      if(command==='media'&&args[0]==='search'){const groups=await this.catalog.search(actor,args.slice(2).join(' '),id,{provider:args[1],limit:8});return groups.flatMap(g=>g.items.map(item=>`${item.title} — ${item.providerId}:${item.id}`)).join('\n')||'No results';}
      if(command==='play'){
        const ref=input.match(/^([a-zA-Z0-9_-]+):([a-zA-Z0-9_-]+)$/);const local=fs.readdirSync(path.join(this.dir,'videos')).find(file=>path.parse(file).name.toLowerCase()===input.toLowerCase()||file.toLowerCase()===input.toLowerCase());
        const selection=ref?{providerId:ref[1],itemId:ref[2]}:local?{local}:{input,title:'URL / search request'};
        const request=await this.requests.submit(actor,id,selection,true,message.voiceChannelId);return `Request ${request.id}: ${request.state}`;
      }
      this.policy.require(actor,'instance.view',id);return 'Commands: play <provider:item | local name | URL | search>, media search <provider> <title>, queue, skip, stop, status. Use official /watch for guided selection.';
    };
  }
  async recover(){await this.instances.recover();for(const id of this.store.setting<string[]>('discord-autostart',[]))await this.discord.start(id).catch(()=>{});}
  async shutdown(){await this.discord.shutdown();await this.instances.shutdown();this.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');this.store.close();}
}
