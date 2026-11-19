import { Actor, Permissions } from './permissions.js';
import { RuntimeProviders } from './providers.js';
import { InstanceManager } from './instances.js';
import { AppError } from './errors.js';
import { MediaItem } from '../providers/types.js';
export class Catalog {
  constructor(readonly policy:Permissions,readonly providers:RuntimeProviders,readonly instances:InstanceManager){}
  accessible(actor:Actor,room?:string){this.policy.require(actor,'media.search',room);if(actor.source==='discord'&&!room)throw new AppError('ROOM_REQUIRED','Select an authorized room',403);const config=room?this.instances.config(room):undefined;return this.providers.registry.all().filter(p=>!config?.providerIds.length||config.providerIds.includes(p.config.id));}
  provider(actor:Actor,id:string,room?:string){const result=this.accessible(actor,room).find(p=>p.config.id===id);if(!result)throw new AppError('PROVIDER_DENIED','Provider unavailable in this room',403);return result;}
  async search(actor:Actor,query:string,room?:string,options:any={}){const providers=this.accessible(actor,room).filter(p=>!options.provider||options.provider==='all'||options.provider===p.config.id);return Promise.all(providers.map(async p=>{try{return {providerId:p.config.id,...await p.search(query,{kind:options.kind,limit:Math.min(100,Number(options.limit)||24),offset:Math.max(0,Number(options.offset)||0),parentId:options.library})};}catch{return {providerId:p.config.id,items:[] as MediaItem[],total:0,error:'Provider unavailable; check connection/profile'};}}));}
}
