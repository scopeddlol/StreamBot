import { randomUUID } from 'node:crypto';
import { AppStore } from './store.js';
import { Playlists } from './playlists.js';
import { InstanceManager } from './instances.js';
import { Actor, Permissions } from './permissions.js';
import { AppError, integer } from './errors.js';
export class Requests {
  constructor(readonly store:AppStore,readonly policy:Permissions,readonly playlists:Playlists,readonly instances:InstanceManager){}
  async submit(actor:Actor,instanceId:string,input:any,confirmed:boolean,voiceChannelId?:string){
    this.policy.require(actor,'media.request',instanceId);this.policy.require(actor,'queue.add',instanceId);this.policy.require(actor,'media.search',instanceId);
    if(!confirmed)throw new AppError('CONFIRM_REQUIRED','Select a real catalog result and confirm the target room before queueing');
    const instance=this.instances.get(instanceId);if(instance.mode!=='on-demand'||!instance.enabled)throw new AppError('ROOM_UNAVAILABLE','Choose an enabled on-demand room');
    const policy=JSON.parse(this.store.get('SELECT config FROM request_policies WHERE instance_id=?',instanceId)?.config||'{}');
    if(policy.requireVoice&&actor.source==='discord'&&voiceChannelId!==instance.voiceChannelId)throw new AppError('VOICE_REQUIRED','Join this room’s voice channel before requesting',403);
    const sources=await this.playlists.expand(input,instanceId);
    if(sources.length>integer(policy.maxItemsPerRequest,1,2000,100))throw new AppError('REQUEST_SIZE','Selection exceeds this room’s per-request item limit; choose a smaller season',429);
    const now=Date.now();
    const id=this.store.db.transaction(()=>{
      const itemCount=this.store.all('SELECT source FROM requests WHERE actor=? AND created_at>?',actor.id,now-86400000).reduce((n,row)=>n+(JSON.parse(row.source).sources?.length||0),0);if(itemCount+sources.length>integer(policy.dailyItems,1,10000,500))throw new AppError('ITEM_LIMIT','Daily requested item limit reached',429);
      const daily=this.store.get('SELECT count(*) AS n FROM requests WHERE actor=? AND created_at>?',actor.id,now-86400000).n;
      if(daily>=integer(policy.dailyLimit,1,1000,30))throw new AppError('REQUEST_LIMIT','Daily request limit reached',429);
      if(this.store.get('SELECT id FROM requests WHERE actor=? AND created_at>?',actor.id,now-integer(policy.cooldownSeconds,0,3600,15)*1000))throw new AppError('COOLDOWN','Wait before submitting another request',429);
      const signature=JSON.stringify(sources);
      if(this.store.all("SELECT source FROM requests WHERE instance_id=? AND state IN ('pending','queued','playing')",instanceId).some(row=>JSON.stringify(JSON.parse(row.source).sources)===signature))throw new AppError('DUPLICATE_REQUEST','This selection is already pending or queued',409);
      const requestId=randomUUID();
      const queueIds=policy.approval?[]:this.playlists.add(instanceId,sources,actor.id);
      this.store.run('INSERT INTO requests VALUES(?,?,?,?,?,?,?)',requestId,instanceId,actor.id,actor.guildId||instance.guildId,JSON.stringify({sources,queueIds}),policy.approval?'pending':'queued',now);
      this.store.audit(actor.id,'media.request',instanceId);return requestId;
    })();void this.instances.pump(instanceId);return {id,state:policy.approval?'pending':'queued',count:sources.length};
  }
  decide(actor:Actor,id:string,decision:'approve'|'reject'|'cancel'){
    const request=this.store.get('SELECT * FROM requests WHERE id=?',id);if(!request)throw new AppError('NOT_FOUND','Request not found',404);
    if(decision==='cancel'&&request.actor===actor.id){this.policy.require(actor,'media.request',request.instance_id);}
    else this.policy.require(actor,'requests.approve',request.instance_id);
    return this.store.db.transaction(()=>{
      if(!['pending','queued'].includes(request.state))throw new AppError('REQUEST_FINISHED','Request is no longer pending',409);
      const data=JSON.parse(request.source);
      if(decision==='approve'){
        if(request.state!=='pending')throw new AppError('ALREADY_QUEUED','Request already queued',409);
        data.queueIds=this.playlists.add(request.instance_id,data.sources,request.actor);
        this.store.run("UPDATE requests SET state='queued',source=? WHERE id=?",JSON.stringify(data),id);void this.instances.pump(request.instance_id);
      }else {
        for(const queueId of data.queueIds||[]){if(this.store.get("SELECT id FROM queue_items WHERE id=? AND status='playing'",queueId))throw new AppError('ALREADY_PLAYING','Use authorized skip controls for a playing request',409);this.store.run('DELETE FROM queue_items WHERE id=? AND instance_id=?',queueId,request.instance_id);}
        this.store.run('UPDATE requests SET state=? WHERE id=?',decision==='reject'?'rejected':'cancelled',id);
      }
      this.store.audit(actor.id,`request.${decision}`,request.instance_id);return {state:decision};
    })();
  }
}
