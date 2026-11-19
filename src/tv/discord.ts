import { Client, GatewayIntentBits, SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, MessageFlags } from 'discord.js';
import { randomUUID } from 'node:crypto';
import { AppStore } from './store.js'; import { Vault } from './vault.js'; import { InstanceManager } from './instances.js';
import { Permissions, Actor } from './permissions.js'; import { Catalog } from './catalog.js'; import { Requests } from './requests.js'; import { Concierge } from './ai.js';
import { AppError, fields, snowflake, text, publicError } from './errors.js';
interface Selection {actor:string;guild:string;room:string;expires:number;choices:any[]}
export class DiscordApplications {
  private clients=new Map<string,Client>();private selections=new Map<string,Selection>();private errors=new Map<string,string>();
  constructor(readonly store:AppStore,readonly vault:Vault,readonly policy:Permissions,readonly instances:InstanceManager,readonly catalog:Catalog,readonly requests:Requests,readonly ai:Concierge){}
  list(){return this.store.all('SELECT * FROM discord_applications').map(row=>({...JSON.parse(row.config),id:row.id,connected:this.clients.get(row.id)?.isReady()||false,error:this.errors.get(row.id),secret:this.vault.metadata(row.secret_id)}));}
  save(input:any,id?:string){fields(input,['name','applicationId','guildIds','credential']);const old=id&&this.store.get('SELECT * FROM discord_applications WHERE id=?',id);if(id&&!old)throw new AppError('NOT_FOUND','Application not found',404);
    if(id&&this.clients.has(id))throw new AppError('APP_RUNNING','Stop this command connection before editing',409);
    const previous=old?JSON.parse(old.config):{};const config={name:text(input.name||previous.name,'name',80),applicationId:snowflake(input.applicationId||previous.applicationId),guildIds:input.guildIds||previous.guildIds||[]};if(!Array.isArray(config.guildIds)||!config.guildIds.length||config.guildIds.length>100)throw new AppError('GUILDS_REQUIRED','Choose 1–100 authorized guild IDs');config.guildIds=config.guildIds.map(snowflake);
    id ||= randomUUID();const secret=input.credential?this.vault.put('discord-application',id,text(input.credential,'bot token',16384),old?.secret_id||undefined):old?.secret_id;if(!secret)throw new AppError('TOKEN_REQUIRED','Configure a Discord application bot token');
    this.store.run('INSERT INTO discord_applications VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,secret_id=excluded.secret_id',id,JSON.stringify(config),secret);return this.list().find(v=>v.id===id);
  }
  async start(id:string){if(this.clients.has(id))return;const row=this.store.get('SELECT * FROM discord_applications WHERE id=?',id);if(!row)throw new AppError('NOT_FOUND','Application not found',404);const config=JSON.parse(row.config);
    const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildVoiceStates],allowedMentions:{parse:[]}});this.clients.set(id,client);
    client.on('interactionCreate',i=>void this.interaction(client,config,i));client.on('error',()=>this.errors.set(id,'Discord connection error; check token and network'));
    try{await client.login(this.vault.read(row.secret_id));if(client.application?.id!==config.applicationId)throw new AppError('APP_ID_MISMATCH','Token belongs to a different application');
      for(const guildId of config.guildIds){const guild=await client.guilds.fetch(guildId).catch(()=>null);if(!guild)throw new AppError('GUILD_ACCESS','Command bot must already be installed in each configured guild');
        for(const command of this.commands())await client.application!.commands.create(command,guildId);}
      this.errors.delete(id);this.store.set('discord-autostart',[...new Set([...this.store.setting<string[]>('discord-autostart',[]),id])]);
    }catch{await this.stop(id);this.errors.set(id,'Command login/registration failed; verify application ID, token, installed guild and application-command scope');throw new AppError('DISCORD_SETUP','Command login/registration failed; verify token, application ID and installation permissions',502);}
  }
  async destinations(id:string){const client=this.clients.get(id);if(!client?.isReady())throw new AppError('APP_STOPPED','Start this command connection to discover its installed guilds');const row=this.store.get('SELECT config FROM discord_applications WHERE id=?',id);const allowed=JSON.parse(row.config).guildIds;const results:any[]=[];for(const guildId of allowed){const guild=await client.guilds.fetch(guildId);const channels=await guild.channels.fetch();results.push({id:guild.id,name:guild.name,channels:[...channels.values()].filter(c=>c?.type===2).map(c=>({id:c!.id,name:c!.name}))});}return results;}
  async stop(id:string,persist=true){if(persist)this.store.set('discord-autostart',this.store.setting<string[]>('discord-autostart',[]).filter(value=>value!==id));this.clients.get(id)?.destroy();this.clients.delete(id);}
  async remove(id:string){await this.stop(id);this.store.run('DELETE FROM discord_applications WHERE id=?',id);}
  async actor(client:Client,guildId:string,userId:string):Promise<Actor>{const guild=await client.guilds.fetch(guildId).catch(()=>null);const member=guild&&await guild.members.fetch({user:userId,force:true}).catch(()=>null);if(!member)throw new AppError('MEMBERSHIP_UNVERIFIED','Cannot verify current Discord membership/roles',403);return {id:userId,guildId,roleIds:[...member.roles.cache.keys()],verified:true,source:'discord'};}
  private commands(){
    const room=(b:any)=>b.addStringOption((v:any)=>v.setName('room').setDescription('Choose an authorized playback room').setRequired(true).setAutocomplete(true));
    const watch=room(new SlashCommandBuilder().setName('watch').setDescription('Find a movie, show, season or episode in your libraries')).addStringOption((v:any)=>v.setName('query').setDescription('Title to search').setRequired(true).setMaxLength(200));
    const recommend=room(new SlashCommandBuilder().setName('recommend').setDescription('Suggestions from your authorized catalog; confirmation required')).addStringOption((v:any)=>v.setName('description').setDescription('What would you like to watch?').setRequired(true).setMaxLength(1000));
    const commands=[watch,recommend,...['queue','nowplaying','skip','room'].map(name=>room(new SlashCommandBuilder().setName(name).setDescription(`Playback room ${name}`))),new SlashCommandBuilder().setName('request-cancel').setDescription('Cancel your own pending media request').addStringOption(v=>v.setName('id').setDescription('Request ID').setRequired(true))];return commands.map(c=>c.toJSON());
  }
  private async select(interaction:any,actor:Actor,room:string,choices:any[],heading:string){
    for(const[key,value]of this.selections)if(value.expires<Date.now())this.selections.delete(key);if(this.selections.size>2000)throw new AppError('SELECTION_LIMIT','Too many pending selections; retry shortly',429);
    const id=randomUUID();const items=choices.slice(0,25);this.selections.set(id,{actor:actor.id,guild:actor.guildId!,room,expires:Date.now()+300000,choices:items});
    if(!items.length){await interaction.editReply({content:'No accessible results. Try another title or room.',components:[]});return;}
    const menu=new StringSelectMenuBuilder().setCustomId(`sbtv:${id}`).setPlaceholder('Choose a real library match').addOptions(items.map((item,index)=>({label:String(item.title||item.name).slice(0,100),description:String(item.label||item.kind||'Select').slice(0,100),value:String(index)})));
    await interaction.editReply({content:heading,components:[new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)]});
  }
  private async interaction(client:Client,config:any,i:any){
    if(!i.guildId||!config.guildIds.includes(i.guildId))return;
    try{
      if(i.isAutocomplete()){const actor=await this.actor(client,i.guildId,i.user.id);const focused=i.options.getFocused().toLowerCase();await i.respond(this.instances.list().filter(room=>room.mode==='on-demand'&&room.guildId===i.guildId&&this.policy.allowed(actor,'instance.view',room.id)&&room.name.toLowerCase().includes(focused)).slice(0,25).map(room=>({name:room.name,value:room.id})));return;}
      if(!i.isChatInputCommand()&&!i.isStringSelectMenu())return;
      await i.deferReply({flags:MessageFlags.Ephemeral});
      const actor=await this.actor(client,i.guildId,i.user.id);
      if(i.isStringSelectMenu()){
        const key=i.customId.startsWith('sbtv:')?i.customId.slice(5):'';const state=this.selections.get(key);if(!state||state.actor!==actor.id||state.guild!==actor.guildId||state.expires<Date.now())throw new AppError('SELECTION_EXPIRED','Selection expired or belongs to another user; search again',403);
        const choice=state.choices[Number(i.values[0])];if(!choice)throw new AppError('INVALID_SELECTION','Invalid selection');this.selections.delete(key);this.policy.require(actor,'media.search',state.room);
        if(choice.action==='request'){const member=await client.guilds.cache.get(i.guildId)?.members.fetch({user:i.user.id,force:true});const request=await this.requests.submit(actor,state.room,choice.input,true,member?.voice.channelId||undefined);await i.editReply({content:`Request ${request.id}: ${request.state} (${request.count} item(s)).`,components:[]});return;}
        const provider=this.catalog.provider(actor,choice.providerId,state.room),item=await provider.getItem(choice.id);
        if(item.kind==='series'){const seasons=await provider.getSeasons(item.id);await this.select(i,actor,state.room,seasons.map(season=>({...season,label:`Season · ${provider.config.name}`})),`Choose a season of ${item.title}`);}
        else if(item.kind==='season'){const episodes=await provider.getEpisodes(item.seriesId!,item.id);await this.select(i,actor,state.room,[{title:`Request entire ${item.title}`,action:'request',input:{providerId:choice.providerId,itemId:item.id}},...episodes.map(e=>({...e,label:`Episode ${e.episodeNumber||''} · ${provider.config.name}`}))],`Choose an episode or request the season`);}
        else await this.select(i,actor,state.room,[{title:`Confirm ${item.title}`,action:'request',input:{providerId:choice.providerId,itemId:item.id}}],`${item.title}${item.year?` (${item.year})`:''} · ${provider.config.name}. Confirm to request in ${this.instances.get(state.room).name}.`);
        return;
      }
      const name=i.commandName,room=i.options.getString('room');
      if(name==='request-cancel'){const result=this.requests.decide(actor,i.options.getString('id',true),'cancel');await i.editReply({content:`Request ${result.state}`});return;}
      this.policy.require(actor,'instance.view',room);
      if(name==='watch'){this.policy.require(actor,'media.search',room);const groups=await this.catalog.search(actor,i.options.getString('query',true),room,{limit:10});const items=groups.flatMap(g=>g.items.map(item=>({...item,label:`${item.year||''} ${item.kind} · ${this.catalog.providers.registry.get(item.providerId).config.name}`})));await this.select(i,actor,room,items,'Choose a library match. No playback until confirmation.');}
      else if(name==='recommend'){const results=await this.ai.recommend(actor,i.options.getString('description',true),room);await this.select(i,actor,room,results.items.map(item=>({...item,label:`Suggestion · ${item.kind}`})),results.message);}
      else if(name==='skip'){this.policy.require(actor,'queue.skip',room);await this.instances.skip(room);this.store.audit(actor.id,'queue.skip',room);await i.editReply({content:'Skip requested; cleanup completes before the next item.'});}
      else if(name==='queue'){this.policy.require(actor,'queue.view',room);const queue=this.requests.playlists.queue(room);await i.editReply({content:queue.map((q,index)=>`${index+1}. ${q.source.title}`).join('\n').slice(0,1800)||'Queue is empty.'});}
      else {const status=this.instances.get(room);await i.editReply({content:`${status.name}: ${status.state}${status.current?` · ${status.current.title}`:''}`});}
    }catch(error){const message=publicError(error).body.message;try{if(i.deferred||i.replied)await i.editReply({content:message,components:[]});else if(i.isAutocomplete())await i.respond([]);else await i.reply({content:message,flags:MessageFlags.Ephemeral});}catch{/* expired interaction; no token/body logging */}}
  }
  async shutdown(){await Promise.all([...this.clients.keys()].map(id=>this.stop(id,false)));this.selections.clear();}
}
