/** Browser-only host adapter. Never closes over Node objects or credentials. */
export function createTavernHost(initial,events) {
  const copy=x=>JSON.parse(JSON.stringify(x));
  const state=copy(initial);
  state.variables??={};state.variables.global??={};state.variables.chat??={};state.variables.messages??={};state.variables.scripts??={};
  state.chat??=[];state.worlds??=[];state.settings??={};
  function hydrateChat(){state.chat.forEach((row,i)=>{Object.defineProperty(row,'variables',{configurable:true,enumerable:true,get:()=>[state.variables.messages[i]??{}],set:value=>{state.variables.messages[i]=value?.[row.swipe_id??0]??{};}});});}
  hydrateChat();
  const original=copy(state);
  const metrics={events:0,variableWrites:0,worldWrites:0,errors:0,logs:0,blocked:0};
  const scripts=new Map((initial.scripts??[]).map(s=>[s.id,s]));
  const handlers={};
  const index=id=>{const n=id==null||id==='latest'?-1:Number(id);const i=n<0?state.chat.length+n:n;if(!Number.isInteger(i)||i<0||i>=state.chat.length)throw Error('MESSAGE_RANGE');return i;};
  const currentBook=()=>state.worlds.find(w=>w.id===state.card?.linkedWorldId||w.name===state.card?.extensions?.world);
  const eventApi={...events};
  const emit=async(name,...args)=>{metrics.events++;return events.eventEmit(name,...args);};
  eventApi.eventEmit=emit;
  const publicEvents={APP_READY:'app_ready',CHAT_CHANGED:'chat_id_changed',MESSAGE_SENT:'message_sent',MESSAGE_RECEIVED:'message_received',MESSAGE_UPDATED:'message_updated',MESSAGE_EDITED:'message_edited',MESSAGE_SWIPED:'message_swiped',MESSAGE_DELETED:'message_deleted',GENERATION_STARTED:'generation_started',GENERATION_AFTER_COMMANDS:'GENERATION_AFTER_COMMANDS',GENERATION_ENDED:'generation_ended',GENERATION_STOPPED:'generation_stopped',CHARACTER_MESSAGE_RENDERED:'character_message_rendered',USER_MESSAGE_RENDERED:'user_message_rendered',WORLDINFO_UPDATED:'worldinfo_updated',WORLDINFO_ENTRIES_LOADED:'worldinfo_entries_loaded',CHAT_COMPLETION_SETTINGS_READY:'chat_completion_settings_ready'};
  function apiFor(scriptId) {
    const owned=new Map();
    const wrapped=(name,fn,once=false)=>{
      let map=owned.get(name);if(!map){map=new Map();owned.set(name,map);}
      if(!map.has(fn))map.set(fn,(...args)=>{
        if(!map.has(fn))return;
        if(once)api.eventRemoveListener(name,fn);
        if(['message_sent','message_received','message_updated','message_edited','message_swiped','character_message_rendered','user_message_rendered'].includes(name)){args[0]=parseInt(args[0]);if(Number.isNaN(args[0]))return;}
        return fn(...args);
      });return map.get(fn);
    };
    function table(option={type:'chat'}) {
      const type=option.type??'chat';
      if(type==='global'||type==='chat')return [state.variables,type];
      if(type==='message'){const id=index(option.message_id);state.variables.messages[id]??={};return [state.variables.messages,id];}
      if(type==='script'){const id=option.script_id??scriptId;state.variables.scripts[id]??=copy(scripts.get(id)?.data??{});return [state.variables.scripts,id];}
      if(type==='character'||type==='preset'){state.variables[type]??={};return [state.variables,type];}
      throw Error('VARIABLE_SCOPE_UNSUPPORTED');
    }
    const api={...eventApi,tavern_events:publicEvents,iframe_events:{GENERATION_ENDED:'js_generation_ended'},
      eventOn(name,fn){events.eventOn(name,wrapped(name,fn));return {stop:()=>api.eventRemoveListener(name,fn)};},
      eventOnce(name,fn){events.eventOnce(name,wrapped(name,fn,true));return {stop:()=>api.eventRemoveListener(name,fn)};},
      eventMakeFirst(name,fn){events.eventMakeFirst(name,wrapped(name,fn));return {stop:()=>api.eventRemoveListener(name,fn)};},
      eventMakeLast(name,fn){events.eventMakeLast(name,wrapped(name,fn));return {stop:()=>api.eventRemoveListener(name,fn)};},
      eventRemoveListener(name,fn){const map=owned.get(name),w=map?.get(fn);if(w)events.eventRemoveListener(name,w);map?.delete(fn);},
      eventClearEvent(name){for(const fn of [...(owned.get(name)?.keys()??[])])api.eventRemoveListener(name,fn);},
      eventClearListener(fn){for(const name of owned.keys())api.eventRemoveListener(name,fn);},
      eventClearAll(){for(const name of owned.keys())api.eventClearEvent(name);},
      getVariables(option){const [base,key]=table(option);return copy(base[key]);},
      replaceVariables(value,option){if(!value||typeof value!=='object')throw Error('VARIABLE_SHAPE');const [base,key]=table(option);base[key]=copy(value);metrics.variableWrites++;},
      async updateVariablesWith(fn,option){const value=await fn(api.getVariables(option));api.replaceVariables(value,option);return copy(value);},
      insertOrAssignVariables(value,option){const next=_.merge(api.getVariables(option),copy(value));api.replaceVariables(next,option);return next;},
      insertVariables(value,option){const next=_.defaultsDeep(api.getVariables(option),copy(value));api.replaceVariables(next,option);return next;},
      deleteVariable(key,option){const next=api.getVariables(option);const had=_.has(next,key);_.unset(next,key);api.replaceVariables(next,option);return had;},
      getAllVariables(){return _.merge({},state.variables.global,state.variables.character,state.variables.preset,state.variables.chat,state.variables.messages[state.chat.length-1]??{});},
      getScriptId:()=>scriptId,getCurrentMessageId:()=>state.chat.length-1,getLastMessageId:()=>state.chat.length-1,
      getTavernHelperVersion:async()=> '4.12.1',getTavernVersion:()=> '1.15.0',
      getScriptTrees:()=>copy(initial.scripts??[]),getScriptTree:()=>copy(scripts.get(scriptId)??{}),
      getScriptButtons:()=>copy(scripts.get(scriptId)?.button?.buttons??[]),
      getButtonEvent:name=>'writing_button:'+scriptId+':'+name,
      replaceScriptButtons(buttons){const s=scripts.get(scriptId);if(s)s.button={...s.button,buttons:copy(buttons)};},
      appendInexistentScriptButtons(buttons){const current=api.getScriptButtons();api.replaceScriptButtons([...current,...buttons.filter(b=>!current.some(x=>x.name===b.name))]);},
      getChatMessages(range,options={}) {
        const m=/^(-?\d+)(?:-(-?\d+))?$/.exec(String(range).replace('{{lastMessageId}}',String(state.chat.length-1)));if(!m)throw Error('MESSAGE_RANGE');
        const start=Number(m[1])<0?state.chat.length+Number(m[1]):Number(m[1]),end=Number(m[2]??m[1])<0?state.chat.length+Number(m[2]??m[1]):Number(m[2]??m[1]);
        return state.chat.flatMap((row,i)=>i>=start&&i<=end&&(!options.role||options.role==='all'||options.role===(row.is_user?'user':'assistant'))?[{message_id:i,name:row.name,role:row.is_system?'system':row.is_user?'user':'assistant',is_hidden:!!row.is_system,message:row.mes,data:copy(state.variables.messages[i]??{}),extra:copy(row.extra??{}),...(options.include_swipes?{swipe_id:0,swipes:[row.mes],swipes_data:[copy(state.variables.messages[i]??{})],swipes_info:[]}: {})}]:[]);
      },
      async setChatMessages(rows){for(const row of rows){const i=index(row.message_id);if(row.message!==undefined)state.chat[i].mes=row.message;if(row.data)state.variables.messages[i]=copy(row.data);if(row.swipes_data)state.variables.messages[i]=copy(row.swipes_data[0]??{});}},
      getWorldbookNames:()=>state.worlds.map(w=>w.name),getGlobalWorldbookNames:()=>state.globalWorlds??[],
      getCharWorldbookNames:()=>({primary:currentBook()?.name??null,additional:[]}),getCharLorebooks:()=>({primary:currentBook()?.name??null,additional:[]}),getChatWorldbookName:()=>null,
      getLorebookSettings:()=>({selected_global_lorebooks:state.globalWorlds??[],scan_depth:2,context_percentage:25,...state.loreSettings}),
      setLorebookSettings:value=>{state.loreSettings={...state.loreSettings,...copy(value)};},
      getLorebookEntries:async name=>copy((state.worlds.find(w=>w.name===name)?.entries??[]).map(e=>({...e,enabled:!e.disable}))),
      getWorldbook:async name=>copy((state.worlds.find(w=>w.name===name)?.entries??[]).map(e=>({uid:e.uid,name:e.comment,enabled:!e.disable,content:e.content,strategy:{type:e.constant?'constant':e.vectorized?'vectorized':'selective',keys:e.key??[],keys_secondary:{logic:e.selectiveLogic??0,keys:e.keysecondary??[]},scan_depth:e.scanDepth},position:{type:['before_character_definition','after_character_definition','before_author_note','after_author_note','at_depth'][e.position]??'after_character_definition',role:['system','user','assistant'][e.role??0],depth:e.depth,order:e.order},probability:e.probability,recursion:{prevent_incoming:e.excludeRecursion,prevent_outgoing:e.preventRecursion,delay_until:e.delayUntilRecursion},effect:{sticky:e.sticky,cooldown:e.cooldown,delay:e.delay}}))),
      async replaceWorldbook(name,entries){const w=state.worlds.find(w=>w.name===name);if(!w)throw Error('WORLD_NOT_FOUND');w.entries=entries.map(e=>({...(w.entries.find(old=>old.uid===e.uid)??{}),uid:e.uid,comment:e.name??e.comment,content:e.content,disable:!e.enabled,constant:e.strategy?.type==='constant',key:e.strategy?.keys??[],keysecondary:e.strategy?.keys_secondary?.keys??[],order:e.position?.order??100}));metrics.worldWrites++;},
      async updateWorldbookWith(name,fn){const rows=await fn(await api.getWorldbook(name));await api.replaceWorldbook(name,rows);return rows;},
      getCharData:()=>copy(state.card),getCharacter:()=>copy(state.card),
      getPreset:()=>copy(state.preset),getPresetNames:()=>[state.preset?.name??''],getCurrentPresetName:()=>state.preset?.name??'',
      substituteParams:text=>String(text).replace(/{{char}}/gi,state.card?.name??'').replace(/{{user}}/gi,state.user??'User'),
      substitudeMacros:text=>api.substituteParams(text),
      waitGlobalInitialized:name=>new Promise((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{if(window[name]!==undefined){clearInterval(timer);resolve();}else if(Date.now()-started>10000){clearInterval(timer);reject(Error('GLOBAL_INIT_TIMEOUT'));}},20);}),
      registerVariableSchema(schema,option={type:'chat'}){handlers[option.type]=schema;},
      getEnabledTavernRegexes:()=>copy((state.regex??[]).filter(s=>!s.disabled)),getTavernRegexes:()=>copy(state.regex??[]),
      injectPrompts(){throw Error('PROMPT_INJECTION_UNSUPPORTED');},
    };
    api.getWorldbookEntries=api.getWorldbook;
    api.insertOrAssign=api.insertOrAssignVariables;
    return api;
  }
  const api=apiFor('host');
  const eventSource={on:api.eventOn,once:api.eventOnce,makeFirst:api.eventMakeFirst,makeLast:api.eventMakeLast,removeListener:api.eventRemoveListener,emit:api.eventEmit,emitAndWait:api.eventEmitAndWait};
  const silly={chat:state.chat,chatMetadata:state.variables.chat,extensionSettings:state.settings,characters:[{name:state.card?.name,data:state.card}],characterId:0,this_chid:0,eventSource,event_types:publicEvents,
    getCurrentChatId:()=>state.sessionId,saveSettingsDebounced(){},saveChatConditional:async()=>{},saveMetadataDebounced(){},saveChat:async()=>{},getContext(){return silly;},getRequestHeaders:()=>({'Content-Type':'application/json'}),
  };
  silly.name1=state.user??'User';silly.name2=state.card?.name??'';
  Object.defineProperty(silly,'chatMetadata',{get:()=>({variables:state.variables.chat})});
  Object.defineProperty(silly,'extensionSettings',{get:()=>state.settings});
  return {state,metrics,apiFor,silly,events:api,original,hydrateChat,
    snapshot:()=>copy({variables:state.variables,worlds:state.worlds,chat:state.chat,settings:state.settings,metrics}),
    restore(value){state.variables=copy(value.variables);state.worlds=copy(value.worlds);state.chat.splice(0,state.chat.length,...copy(value.chat));state.settings=copy(value.settings);hydrateChat();},
  };
}
