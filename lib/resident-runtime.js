import path from 'node:path';
import { createHash } from 'node:crypto';
import { TavernBrowser, safeRuntimeIssue } from './tavern-browser.js';
import { selectWritingWorlds } from './card-lore.js';
import { pickGreeting } from './cards.js';
import { isResidentEnabled } from './extension-store.js';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');

/** Per-writer resident runtime. Failed requests discard the browser transaction. */
export class ResidentRuntime {
  constructor({store,extensionStore,scopes,factory=options=>new TavernBrowser(options)}){Object.assign(this,{store,extensionStore,scopes,factory});this.sessions=new Map();this.busy=new Set();}
  async close(sessionId){const item=this.sessions.get(sessionId);this.sessions.delete(sessionId);clearTimeout(item?.idle);await item?.runtime.close();}
  async dispose(){await Promise.allSettled([...this.sessions.keys()].map(id=>this.close(id)));}
  async inspect(sessionId){
    const entry=this.sessions.get(sessionId);
    if(!entry||this.busy.has(sessionId))return {active:!!entry,busy:this.busy.has(sessionId),buttons:[]};
    try{return {active:true,busy:false,buttons:await entry.runtime.buttons(),status:await entry.runtime.status()};}
    catch{return {active:false,busy:false,buttons:[],error:'RUNTIME_UNAVAILABLE'};}
  }
  async prepare({sessionId,binding,card,conversation,signal,interaction=false}) {
    const settings=await this.extensionStore.load();
    if(!isResidentEnabled(settings,sessionId))return null;
    if(this.busy.has(sessionId))throw Error('RESIDENT_SESSION_BUSY');
    this.busy.add(sessionId);
    try {
      const resolved=await this.scopes.resolve(binding);
      const scripts=resolved.scripts.map(s=>({...s,id:JSON.stringify([s.scopeType,s.scopeId,s.id])}));
      const allWorlds=await this.store.listWorlds();
      const worlds=selectWritingWorlds({allWorlds,binding,card}).books;
      const worldBasis=digest(worlds.map(w=>[w.id,w.entries]));
      const preset=binding.presetId?await this.store.getPreset(binding.presetId):null;
      const snapshot=await this.extensionStore.sessionVars(sessionId);
      const key=digest({binding,scripts,card,preset,worlds,regex:resolved.regex,template:settings.template});
      let entry=this.sessions.get(sessionId);
      if(entry&&(entry.key!==key||entry.version!==Number(snapshot.version??0))){await this.close(sessionId);entry=null;}
      const rows=[...(card&&pickGreeting(card)?[{role:'assistant',content:pickGreeting(card)}]:[]),...conversation];
      if(!entry){
        if(this.sessions.size>=4){const idle=[...this.sessions.keys()].find(id=>!this.busy.has(id));if(!idle)throw Error('RESIDENT_CAPACITY');await this.close(idle);}
        const runtime=this.factory({cacheDir:path.join(this.store.root,'runtime-modules')});
        entry={runtime,key,version:Number(snapshot.version??0)};this.sessions.set(sessionId,entry);
        const initial=snapshot.residentState;
        await runtime.start({sessionId,card,preset,worlds:initial?.worldBasis===worldBasis?initial.worlds:worlds,globalWorlds:worlds.filter(w=>binding.worldIds?.includes(w.id)).map(w=>w.name),scripts,
          chat:rows.map(r=>({name:r.role==='user'?'用户':card?.name??'',is_user:r.role==='user',is_system:false,mes:r.content,swipe_id:0,extra:{}})),
          variables:{...(initial?.variables??{global:{},messages:{},scripts:{}}),chat:snapshot.vars??initial?.variables?.chat??{}},settings:initial?.settings??{},regex:resolved.regex});
        await runtime.loadScripts(scripts);await runtime.settle(1200);
        const status=await runtime.status();if(status.scripts.some(s=>!s.moduleLoaded))throw Error('RESIDENT_MODULE_START_FAILED');
      }else {clearTimeout(entry.idle);await entry.runtime.setChat(rows);}
      if(signal?.aborted)throw Error('RESIDENT_ABORTED');
      if(!interaction){await entry.runtime.emit('generation_started','normal',{});await entry.runtime.emit('GENERATION_AFTER_COMMANDS','normal',{});}
      const base=await entry.runtime.snapshot();
      const owner=this;let committed=false;
      const commit=async updated=>{
        if(signal?.aborted)throw Error('RESIDENT_ABORTED');
        await owner.extensionStore.update(current=>{
          if(!isResidentEnabled(current,sessionId))throw Error('RESIDENT_DISABLED');
          const saved=current.sessions?.[sessionId]??{};
          if(Number(saved.version??0)!==Number(snapshot.version??0))throw Error('RESIDENT_VARIABLE_CONFLICT');
          const next={...saved,vars:updated.variables.chat??{},scriptVars:updated.variables.scripts??{},messageVars:updated.variables.messages[updated.chat.length-1]??{},residentState:{variables:updated.variables,worlds:updated.worlds,worldBasis,settings:updated.settings,lastMessageId:updated.chat.length-1},version:Number(saved.version??0)+1};
          return {...current,sessions:{...current.sessions,[sessionId]:next}};
        },{signal});
        entry.version=Number(snapshot.version??0)+1;committed=true;
      };
      const stageVariables=async variables=>{
        const staged=structuredClone(base);staged.variables.chat=structuredClone(variables);
        await entry.runtime.restore(staged);
      };
      return {
        worlds:base.worlds,
        chatVariables:structuredClone(base.variables.chat??{}),
        stageVariables,
        async render(texts,context,variables=base.variables.chat??{}){try{await stageVariables(variables);return await entry.runtime.render(texts,context);}catch(error){const safe=safeRuntimeIssue(error);throw new Error('模板运行失败：'+safe.category+(safe.api?' / '+safe.api:''));}},
        async complete(content){
          if(signal?.aborted)throw Error('RESIDENT_ABORTED');
          const updated=await entry.runtime.processReply(content);
          if(signal?.aborted)throw Error('RESIDENT_ABORTED');
          const status=await entry.runtime.status();
          await commit(updated);return {status,content:updated.chat.at(-1)?.mes??content};
        },
        async clickButton(scriptId,name){
          if(!interaction)throw Error('INTERACTION_REQUIRED');
          const updated=await entry.runtime.clickButton(scriptId,name);
          const messages=rows=>rows.map(({variables,...message})=>message);
          if(digest(messages(updated.chat))!==digest(messages(base.chat)))throw Error('CHAT_WRITE_UNSUPPORTED');
          await commit(updated);return {ok:true};
        },
        async activate(){if(!interaction)throw Error('INTERACTION_REQUIRED');await commit(await entry.runtime.snapshot());return {ok:true};},
        async finish(){owner.busy.delete(sessionId);if(!committed)await owner.close(sessionId);else{entry.idle=setTimeout(()=>{if(!owner.busy.has(sessionId))void owner.close(sessionId);},300000);entry.idle.unref?.();}},
      };
    }catch(error){this.busy.delete(sessionId);await this.close(sessionId);const safe=safeRuntimeIssue(error);throw Object.assign(new Error('常驻扩展运行失败：'+safe.category+(safe.api?' / '+safe.api:'')),{code:'RESIDENT_FAILED'});}
  }
}
