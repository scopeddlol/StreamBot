import { fork, ChildProcess } from 'node:child_process';
import { randomUUID, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { AppStore } from './store.js';
import { Vault } from './vault.js';
import { RuntimeProviders } from './providers.js';
import { Playlists } from './playlists.js';
import { AppError, fields, text, snowflake, integer } from './errors.js';
export type InstanceState='stopped'|'starting'|'connecting'|'ready'|'streaming'|'reconnecting'|'stopping'|'failed'|'disabled';
export interface InstanceConfig {id:string;name:string;mode:'live'|'on-demand';transport:'experimental-selfbot'|'official-control-only';guildId:string;voiceChannelId:string;enabled:boolean;autostart:boolean;autojoin:boolean;riskAccepted:boolean;prefix:string;commandChannelId:string;encoder:Record<string,unknown>;providerIds:string[];maxRetries:number;mediaRetries:number}
interface Handle {accountId?:string;proc:ChildProcess;nonce?:string;state:InstanceState;current?:any;skipping?:boolean;metrics?:any;connectResolve?:()=>void;connectReject?:(e:Error)=>void;ready?:()=>void;reject?:(e:Error)=>void;timer?:ReturnType<typeof setTimeout>;retries:number;generation:number; stopping:boolean;failureCount:number;retryTimer?:ReturnType<typeof setTimeout>;startedAt?:number;lastMetrics?:number;cpuSample?:{user:number;system:number}}
const encoderDefaults={width:1280,height:720,fps:30,bitrateKbps:2000,maxBitrateKbps:2500,videoCodec:'H264',h26xPreset:'ultrafast',hardwareAcceleratedDecoding:false};
export class InstanceManager extends EventEmitter {
  private handles=new Map<string,Handle>();private generation=0;private timers=new Set<ReturnType<typeof setTimeout>>();private closing=false;private watchdog:ReturnType<typeof setInterval>;
  commandHandler?: (id:string, message:any)=>Promise<string>;
  constructor(readonly store:AppStore,readonly vault:Vault,readonly providers:RuntimeProviders,readonly playlists:Playlists,private workerFile=fileURLToPath(new URL('./worker.ts',import.meta.url))){super();store.run("UPDATE instance_runtime SET state='stopped'");this.watchdog=setInterval(()=>{for(const [id,h]of this.handles)if(!h.stopping&&Date.now()-(h.lastMetrics||Date.now())>25000){this.state(id,'failed','Worker heartbeat lost; restarting within retry budget');try{process.kill(-h.proc.pid!,'SIGKILL');}catch{}}},10000);this.watchdog.unref();}
  list(){return this.store.all('SELECT * FROM instances').map(row=>this.summary(row));}
  private summary(row:any){const handle=this.handles.get(row.id),runtime=this.store.get('SELECT * FROM instance_runtime WHERE instance_id=?',row.id);return {...JSON.parse(row.config),revision:row.revision,secret:this.vault.metadata(row.secret_id),state:handle?.state||runtime?.state||'stopped',error:runtime?.error,metrics:handle?.metrics,current:handle?.current?{id:handle.current.id,title:handle.current.source.title,durationMs:handle.current.source.durationMs,startedAt:handle.startedAt,elapsedMs:handle.startedAt?Math.max(0,Date.now()-handle.startedAt):0}:undefined};}
  get(id:string){const row=this.store.get('SELECT * FROM instances WHERE id=?',id);if(!row)throw new AppError('NOT_FOUND','Instance not found',404);return this.summary(row);}
  config(id:string):InstanceConfig{return this.get(id);}
  save(input:any,id?:string){
    fields(input,['name','mode','transport','guildId','voiceChannelId','enabled','autostart','autojoin','riskAccepted','encoder','providerIds','credential','revision','maxRetries','mediaRetries','prefix','commandChannelId']);
    const old=id?this.store.get('SELECT * FROM instances WHERE id=?',id):undefined;if(id&&!old)throw new AppError('NOT_FOUND','Instance not found',404);
    if(old&&input.revision!==old.revision)throw new AppError('CONFLICT','Instance changed; refresh before saving',409);
    if(id&&this.handles.has(id))throw new AppError('INSTANCE_RUNNING','Stop this instance before changing its account or destination',409);
    const config={...(old?JSON.parse(old.config):{id:randomUUID(),enabled:true,autostart:false,autojoin:false,riskAccepted:false,mode:'on-demand',transport:'official-control-only',providerIds:[],maxRetries:3,mediaRetries:1,prefix:'$',commandChannelId:'',encoder:encoderDefaults}),...input};delete config.credential;delete config.revision;
    config.name=text(config.name,'instance name',80);config.prefix=text(config.prefix||'$','prefix',5);if(config.commandChannelId)config.commandChannelId=snowflake(config.commandChannelId);config.guildId=snowflake(config.guildId);config.voiceChannelId=snowflake(config.voiceChannelId);
    if(!['live','on-demand'].includes(config.mode)||!['experimental-selfbot','official-control-only'].includes(config.transport))throw new AppError('INVALID_INSTANCE','Invalid mode or transport');
    for(const key of ['enabled','autostart','autojoin','riskAccepted'])if(typeof config[key]!=='boolean')throw new AppError('INVALID_INSTANCE',`Invalid ${key}`);
    config.maxRetries=integer(config.maxRetries,0,10,3);config.mediaRetries=integer(config.mediaRetries,0,3,1);
    if(!Array.isArray(config.providerIds)||config.providerIds.length>100||config.providerIds.some((v:any)=>typeof v!=='string'||!this.providers.registry.all().some(p=>p.config.id===v)))throw new AppError('INVALID_PROVIDERS','Choose configured media providers');
    fields(config.encoder,Object.keys(encoderDefaults));config.encoder={...encoderDefaults,...config.encoder};
    for(const [key,min,max] of [['width',160,3840],['height',90,2160],['fps',1,60],['bitrateKbps',128,20000],['maxBitrateKbps',128,30000]] as const)config.encoder[key]=integer(config.encoder[key],min,max,encoderDefaults[key]);
    if(!['H264','H265','VP8'].includes(config.encoder.videoCodec)||!['ultrafast','superfast','veryfast','faster','fast','medium','slow','slower','veryslow'].includes(config.encoder.h26xPreset)||typeof config.encoder.hardwareAcceleratedDecoding!=='boolean')throw new AppError('INVALID_ENCODER','Invalid encoder settings');
    this.store.db.transaction(()=>{
      const secret=input.credential?this.vault.put('playback-account',config.id,text(input.credential,'credential',16384),old?.secret_id||undefined):old?.secret_id||null;
      this.store.run('INSERT INTO instances VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,secret_id=excluded.secret_id,revision=excluded.revision',config.id,JSON.stringify(config),secret,(old?.revision??-1)+1);
      this.store.run("INSERT INTO instance_runtime VALUES(?,'stopped',NULL,0,?) ON CONFLICT(instance_id) DO UPDATE SET state=excluded.state,error=NULL,updated_at=excluded.updated_at",config.id,Date.now());
      this.playlists.playlist(config.id);
    })();this.emit('change');return this.get(config.id);
  }
  duplicate(id:string){const item=this.get(id);const copy:any={};for(const key of ['mode','transport','guildId','voiceChannelId','encoder','providerIds','maxRetries'])copy[key]=item[key];return this.save({...copy,name:`${item.name} copy`,autostart:false,autojoin:false,riskAccepted:false});}
  private state(id:string,state:InstanceState,error?:string){const handle=this.handles.get(id);if(handle)handle.state=state;this.store.run('UPDATE instance_runtime SET state=?,error=?,updated_at=? WHERE instance_id=?',state,error||null,Date.now(),id);this.emit('change');}
  async start(id:string){
    if(this.closing)throw new AppError('SHUTTING_DOWN','Application is stopping',503);
    const existing=this.handles.get(id);if(existing){if(['ready','streaming','connecting','starting'].includes(existing.state))return;throw new AppError('INSTANCE_BUSY','Instance is recovering/stopping; retry shortly',409);}
    const row=this.store.get('SELECT * FROM instances WHERE id=?',id);if(!row)throw new AppError('NOT_FOUND','Instance not found',404);const config:InstanceConfig=JSON.parse(row.config);
    if(!config.enabled)throw new AppError('DISABLED','Enable this instance before starting');
    if(config.transport!=='experimental-selfbot')throw new AppError('TRANSPORT_UNSUPPORTED','Official bots support control commands, not native Go Live video. Configure the experimental account transport explicitly.');
    if(!config.riskAccepted)throw new AppError('RISK_ACK_REQUIRED','Acknowledge the Discord self-bot account risk before starting');
    if(!row.secret_id)throw new AppError('CREDENTIAL_MISSING','Configure a playback account credential');
    const limits=this.store.setting('limits',{maxWorkers:8,maxFfmpeg:8});if(this.handles.size>=limits.maxWorkers)throw new AppError('RESOURCE_LIMIT','Active worker limit reached',409);
    const credential=this.vault.read(row.secret_id), identity=createHmac('sha256','streambot-account-identity').update(credential).digest('hex');
    for(const [otherId,h]of this.handles){const other=this.store.get('SELECT * FROM instances WHERE id=?',otherId), c=JSON.parse(other.config);if(c.guildId===config.guildId&&c.voiceChannelId===config.voiceChannelId)throw new AppError('DESTINATION_BUSY','Another active instance owns this voice destination',409);if(other.secret_id&&createHmac('sha256','streambot-account-identity').update(this.vault.read(other.secret_id)).digest('hex')===identity)throw new AppError('ACCOUNT_BUSY','This playback account is already running',409);}
    const env:Record<string,string>={};for(const key of ['PATH','HOME','TMPDIR','YTDLP_PATH','FFMPEG_PATH','FFPROBE_PATH','NODE_EXTRA_CA_CERTS'])if(process.env[key])env[key]=process.env[key]!;
    env.YTDLP_AUTO_UPDATE='false';
    const proc=fork(this.workerFile,[],{execPath:process.execPath,env,stdio:['ignore','ignore','ignore','ipc'],detached:true,serialization:'json'});
    const h:Handle={proc,state:'starting',retries:0,generation:++this.generation,stopping:false,failureCount:0,lastMetrics:Date.now()};this.handles.set(id,h);this.state(id,'starting');
    const ready=new Promise<void>((resolve,reject)=>{h.ready=resolve;h.reject=reject;h.timer=setTimeout(()=>{reject(new AppError('CONNECT_TIMEOUT','Worker connection timed out',504));void this.stop(id);},30000);});
    proc.on('message',(message:any)=>{
      if(this.handles.get(id)!==h||!message||typeof message.nonce!=='string'||typeof message.event!=='string')return;
      if(message.event==='hello'&&!h.nonce){h.nonce=message.nonce;this.state(id,'connecting');this.send(h,'init',{config,credential,providers:[],dataDir:this.store.dir});return;}
      if(message.nonce!==h.nonce)return;if(h.stopping&&['done','playing','ready','error'].includes(message.event))return;
      if(message.event==='identity'){
        if(typeof message.accountId!=='string'||!/^\d{16,22}$/.test(message.accountId)){h.reject?.(new AppError('IDENTITY_INVALID','Worker identity could not be verified'));void this.stop(id,true);return;}
        if([...this.handles.values()].some(other=>other!==h&&other.accountId===message.accountId)){h.stopping=true;this.state(id,'failed','This account identity is already assigned to an active worker');h.reject?.(new AppError('ACCOUNT_BUSY','This account identity is already assigned to an active worker',409));this.send(h,'stop');return;}
        h.accountId=message.accountId;this.send(h,'activate');return;
      }
      if(message.event==='ready'){clearTimeout(h.timer);this.state(id,'ready');h.ready?.();void this.pump(id);}
      else if(message.event==='playing'&&message.entryId===h.current?.id){h.startedAt=Date.now();this.state(id,'streaming');}
      else if(message.event==='command'&&this.commandHandler){if(typeof message.content!=='string'||message.content.length>2000||message.guildId!==config.guildId)return;void this.commandHandler(id,message).then(content=>this.send(h,'reply',{content,channelId:message.channelId})).catch(()=>this.send(h,'reply',{content:'Request denied or unavailable. Check permissions, room and source.',channelId:message.channelId}));}
      else if(message.event==='metrics'){if(typeof message.rss==='number'){const now=Date.now(),cpu=message.cpu;let percent=0;if(h.lastMetrics&&h.cpuSample&&cpu&&Number.isFinite(cpu.user)&&Number.isFinite(cpu.system))percent=Math.max(0,(cpu.user-h.cpuSample.user+cpu.system-h.cpuSample.system)/((now-h.lastMetrics)*1000)*100);h.metrics={rss:Math.max(0,message.rss),ffmpeg:!!message.ffmpeg,cpuPercent:Math.round(percent*10)/10};h.lastMetrics=now;h.cpuSample=cpu;if(message.rss>this.store.setting('limits',{maxWorkerRSSMB:1024}).maxWorkerRSSMB*1048576){this.state(id,'failed','Worker memory cap exceeded');void this.stop(id,true);}}this.emit('change');}
      else if(message.event==='done'&&message.entryId===h.current?.id){const failed=!!message.error;
        if(failed&&!h.skipping&&(h.current.attempts||0)<config.mediaRetries){h.current.attempts=(h.current.attempts||0)+1;this.store.run('UPDATE queue_items SET attempts=? WHERE id=? AND instance_id=?',h.current.attempts,h.current.id,id);this.state(id,'ready','Source failed; bounded retry in progress');h.retryTimer=setTimeout(()=>{h.retryTimer=undefined;if(this.handles.get(id)!==h||h.stopping)return;this.send(h,'play',{providers:this.providers.snapshot(h.current.source.reference?[h.current.source.reference.providerId]:[]),source:{...h.current.source,...(h.current.source.inputSecretId?{input:this.vault.read(h.current.source.inputSecretId)}:{})},entryId:h.current.id});},1000*2**h.current.attempts);return;}
        this.playlists.finish(id,h.current,!!h.skipping||failed);h.current=undefined;h.skipping=false;this.updateRequests(id);h.failureCount=failed?h.failureCount+1:0;
        this.state(id,'ready',failed?'Playback failed; check source access, file, codec and transport':undefined);
        if(h.failureCount>=5){this.state(id,'failed','Five consecutive media failures; fix the source and restart this instance');void this.stop(id,true);return;}
        const timer=setTimeout(()=>{this.timers.delete(timer);void this.pump(id);},failed?Math.min(30000,1000*2**h.failureCount):100);this.timers.add(timer);
      }else if(message.event==='error'){const safe=typeof message.message==='string'&&message.message.length<=300?message.message:'Worker operation failed';this.state(id,'failed',safe);h.reject?.(new AppError('WORKER_FAILED',safe));h.connectReject?.(new AppError('VOICE_FAILED',safe));if(['AUTH_INVALID','UNSUPPORTED_TRANSPORT','OFFICIAL_VIDEO_UNSUPPORTED'].includes(message.code))h.stopping=true;}
      else if(message.event==='connected'){this.state(id,'ready');h.connectResolve?.();}
    });
    proc.on('exit',()=>{try{process.kill(-proc.pid!,'SIGKILL');}catch{}clearTimeout(h.timer);h.reject?.(new AppError('WORKER_EXIT','Worker exited before ready',503));if(this.handles.get(id)!==h)return;this.handles.delete(id);
      if(h.stopping||this.closing)return;this.state(id,'failed','Worker exited unexpectedly; pending playback checkpoint retained');
      const retries=(this.store.get('SELECT retries FROM instance_runtime WHERE instance_id=?',id)?.retries||0)+1;this.store.run('UPDATE instance_runtime SET retries=? WHERE instance_id=?',retries,id);
      if(retries<=config.maxRetries){this.state(id,'reconnecting');const timer=setTimeout(()=>{this.timers.delete(timer);if(!this.closing&&this.get(id).state==='reconnecting')void this.start(id).catch(()=>this.state(id,'failed','Worker restart failed; retry manually'));},Math.min(60000,1000*2**retries)+Math.floor(Math.random()*500));this.timers.add(timer);}
    });
    proc.on('error',()=>{h.reject?.(new AppError('SPAWN_FAILED','Worker could not start',503));this.state(id,'failed','Worker could not start');});await ready;
  }
  private send(h:Handle,command:string,data:object={}){if(h.proc.connected)h.proc.send({nonce:h.nonce,command,...data});}
  async pump(id:string){const h=this.handles.get(id);if(!h||h.stopping||h.current||h.state!=='ready')return;
    const limits=this.store.setting('limits',{maxWorkers:8,maxFfmpeg:8});if([...this.handles.values()].filter(v=>v.current).length>=limits.maxFfmpeg){const timer=setTimeout(()=>{this.timers.delete(timer);void this.pump(id);},1000);this.timers.add(timer);return;}
    const config=this.config(id);const item=this.playlists.next(id,config.mode==='live');if(!item)return;if(item.source.reference&&config.providerIds.length&&!config.providerIds.includes(item.source.reference.providerId)){this.state(id,'failed','Queued provider is no longer enabled for this room');await this.stop(id,true);return;}h.current=item;this.playlists.begin(id,item);this.updateRequests(id);
    const source={...item.source,...(item.source.inputSecretId?{input:this.vault.read(item.source.inputSecretId)}:{})};this.send(h,'play',{source,providers:this.providers.snapshot(source.reference?[source.reference.providerId]:[]),entryId:item.id});this.emit('change');}
  async skip(id:string){const h=this.handles.get(id);if(h?.retryTimer){clearTimeout(h.retryTimer);h.retryTimer=undefined;this.playlists.finish(id,h.current,true);h.current=undefined;await this.pump(id);return;}if(!h?.current)throw new AppError('NOT_PLAYING','No current item',409);h.skipping=true;this.send(h,'skip');}
  async stop(id:string,failed=false){const h=this.handles.get(id);if(!h){this.state(id,failed?'failed':'stopped');return;}if(h.stopping)return;h.stopping=true;this.state(id,'stopping');clearTimeout(h.timer);clearTimeout(h.retryTimer);h.connectReject?.(new AppError('STOPPED','Instance stopped'));this.send(h,'stop');
    await new Promise<void>(resolve=>{if(h.proc.exitCode!==null){resolve();return;}const timer=setTimeout(()=>{try{process.kill(-h.proc.pid!,'SIGKILL');}catch{}resolve();},10000);h.proc.once('exit',()=>{clearTimeout(timer);resolve();});});
    this.handles.delete(id);this.state(id,failed?'failed':'stopped',failed?'Repeated playback failure; inspect source and retry':undefined);
  }
  async restart(id:string){await this.stop(id);this.store.run('UPDATE instance_runtime SET retries=0 WHERE instance_id=?',id);await this.start(id);}
  async connect(id:string){const h=this.handles.get(id);if(!h||h.state!=='ready')throw new AppError('INSTANCE_NOT_READY','Start the instance and stop playback before joining/moving',409);const c=this.config(id);this.state(id,'connecting');await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{h.connectResolve=undefined;h.connectReject=undefined;this.state(id,'failed','Voice connection timed out');reject(new AppError('VOICE_TIMEOUT','Voice connection timed out',504));},15000);h.connectResolve=()=>{clearTimeout(timer);resolve();};h.connectReject=(error)=>{clearTimeout(timer);reject(error);};this.send(h,'connect',{guildId:c.guildId,channelId:c.voiceChannelId});});}
  async remove(id:string,confirm:boolean){if(!confirm)throw new AppError('CONFIRM_REQUIRED','Confirm deletion of this instance, its queues and playlists');await this.stop(id);this.store.run('DELETE FROM instances WHERE id=?',id);this.emit('change');}
  updateRequests(id:string){for(const row of this.store.all("SELECT id,source FROM requests WHERE instance_id=? AND state IN ('queued','playing')",id)){const data=JSON.parse(row.source);const queued=(data.queueIds||[]).map((key:string)=>this.store.get('SELECT status FROM queue_items WHERE id=? AND instance_id=?',key,id)).filter(Boolean);const state=!queued.length?'completed':queued.some((q:any)=>q.status==='playing')?'playing':'queued';this.store.run('UPDATE requests SET state=? WHERE id=?',state,row.id);}}
  async drainProvider(providerId:string){await Promise.all([...this.handles.entries()].filter(([,h])=>h.current?.source.reference?.providerId===providerId).map(([id])=>this.stop(id)));}
  refreshProviders(){for(const h of this.handles.values())this.send(h,'providers',{providers:[]});}
  async recover(){for(const instance of this.list()){if(instance.enabled&&instance.autostart&&!this.closing){await this.start(instance.id).catch(()=>{});await new Promise(r=>setTimeout(r,500));}}}
  async shutdown(){this.closing=true;clearInterval(this.watchdog);for(const timer of this.timers)clearTimeout(timer);this.timers.clear();await Promise.all([...this.handles.keys()].map(id=>this.stop(id)));}
}
