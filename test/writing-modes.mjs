import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {Readable} from 'node:stream';
import {apply} from '../index.js';import {GuideStore,normalizeSettings} from '../lib/store.js';import {ExtensionStore} from '../lib/extension-store.js';import {ExtensionScopes} from '../lib/extension-scopes.js';import {isWritingMode,normalizeWritingModes} from '../lib/writing-modes.js';

assert.deepEqual(normalizeSettings({targets:['standard']}).writingModes,['writer'],'legacy targets never silently become full takeover');
assert.deepEqual(normalizeWritingModes(['writer',' standard ','standard','*',null]),['writer','standard']);
assert.deepEqual(normalizeSettings({writingModes:[]}).writingModes,[]);
assert.equal(isWritingMode({writingModes:[]},'writer'),false);
assert.equal(isWritingMode({writingModes:['standard']},''),false);

const root=await fs.mkdtemp(path.join(os.tmpdir(),'wg-modes-')),store=new GuideStore(root),ext=new ExtensionStore(root),scopes=new ExtensionScopes({store,extensionStore:ext});
const events=new Map(),sections=[],cleanups=[],requests=[];let handler,origin;
const modes=new Map([['s','standard'],['w','writer'],['other','custom']]);
const user={id:'u',role:'user',source:{kind:'user'},content:[{type:'text',text:'SYNTHETIC_INPUT'}]};
const reply={id:'a',role:'assistant',content:[{type:'text',text:'RAW_REPLY'}]};
const provider=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'RAW_REPLY'},finish_reason:'stop'}]}));});
try{
 await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+provider.address().port;
 await store.ensure();await store.saveSettings({targets:['writer','standard'],includeWorlds:true,maxTokens:256});
 await store.savePreset({id:'p',name:'Synthetic preset',prompts:[{identifier:'main',content:'TEMPLATE_<%= 1+1 %>'},{identifier:'charDescription',marker:true},{identifier:'worldInfoBefore',marker:true},{identifier:'chatHistory',marker:true}],prompt_order:[{order:['main','charDescription','worldInfoBefore','chatHistory'].map(identifier=>({identifier,enabled:true}))}],extensions:{regex_scripts:[
  {id:'send',scriptName:'send',findRegex:'SYNTHETIC_INPUT',replaceString:'SEND_INPUT',placement:[1],promptOnly:true,disabled:false},
  {id:'display',scriptName:'display',findRegex:'RAW_REPLY',replaceString:'DISPLAY_REPLY',placement:[2],markdownOnly:true,disabled:false},
 ],tavern_helper:{scripts:[{id:'helper',type:'script',name:'Synthetic helper',enabled:true,content:'return "HELPER_OK";'}]}}});
 await store.saveWorld({id:'world',name:'Synthetic world',entries:[{uid:1,constant:true,content:'WORLD_MARKER',position:0}]});
 await store.saveCard({id:'card',name:'Synthetic card',description:'CARD_MARKER',linkedWorldId:'world'});
 await store.saveBindings({enabled:true,defaultBinding:{presetId:'p',cardId:'card',worldSelection:'none',provider:'fixture',model:'model'},bindings:{}});
 await ext.save({});await ext.updateSection('template',{enabled:true,allowedPresetIds:['p']});
 await scopes.setAllowed({type:'preset',id:'p',kind:'regex',enabled:true});await scopes.setAllowed({type:'preset',id:'p',kind:'helper',enabled:true});
 const services={
  settings:{describe:()=>[{ns:'dsh-llm-pi-ai',value:{providers:{fixture:{api:'openai-completions',baseURL:origin+'/v1',apiKeyEnv:'SYNTHETIC_KEY',models:[{id:'model'}]}}}}]},
  credentials:{resolve:async()=>({value:'SYNTHETIC_ONLY'})},
  connection:{requestRejection:()=>null,createPeer:()=>({dispose(){}})},
  sessions:{get:id=>modes.has(id)?{id}:null},agentPresets:{presetForSession:s=>modes.get(s.id),list:()=>['writer','standard','custom'].map(id=>({id,name:id}))},
  typertGateway:{invoke:async({method,args})=>method==='list'?{items:[...modes].map(([sessionId,agentPreset])=>({sessionId,projections:{values:{agentPreset}}}))}:{records:[user,reply].map((m,seq)=>({event:{seq,type:m.role==='user'?'user/message':'assistant/message',data:m.role==='user'?m:{message:m}}})),hasMore:false}},
 };
 apply({get:name=>services[name],effect:fn=>{const clean=fn();if(typeof clean==='function')cleanups.push(clean);},on:(name,fn)=>{events.set(name,fn);return()=>events.delete(name);},systemPrompt:{section:spec=>{sections.push(spec);return()=>{};}},webServer:{getOrigin:()=>origin,register:spec=>{handler=spec.handler;return()=>{};}}},{dataDir:root,seedSamples:false,enableTool:false});
 const call=async(url,body)=>{const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);req.method=body===undefined?'GET':'POST';req.url='/api/writing-guide'+url;req.headers={};let value;const res={setHeader(){},end(text){value=JSON.parse(text);}};await handler(req,res);return {status:res.statusCode,...value};};
 await call('/state');
 const run=async(sessionId,extra={})=>{const result=events.get('llm/stream')({sessionId,provider:'host',model:'host-model',messages:[user],...extra},()=> 'HOST');if(result==='HOST')return result;const chunks=[];for await(const chunk of result)chunks.push(chunk);return chunks;};
 assert.equal(await run('s'),'HOST');assert.equal((await call('/session-panel?sessionId=s')).writer,false);
 assert.equal((await call('/reading?sessionId=s')).writer,false);
 assert.equal((await call('/extensions/scopes?sessionId=s')).status,400);
 const beforeBindings=await fs.readFile(path.join(root,'bindings.json'),'utf8');
 assert.equal((await call('/settings',{patch:{writingModes:['standard']}})).status,200);
 assert.equal(await fs.readFile(path.join(root,'bindings.json'),'utf8'),beforeBindings);
 assert.equal((await call('/state')).settings.writingModes[0],'standard');
 assert.equal((await call('/sessions')).sessions.find(s=>s.id==='s').writer,true);
 assert.equal((await call('/sessions')).sessions.find(s=>s.id==='w').writer,false);
 assert.equal((await call('/session-panel?sessionId=s')).writer,true);
 assert.equal((await call('/session-panel?sessionId=w')).writer,false);
 assert.equal((await call('/extensions/scopes?sessionId=s')).sources.find(s=>s.type==='preset').id,'p');
 const chunks=await run('s');assert.equal(chunks.at(-1).reason.kind,'stop');
 assert.equal(requests.length,1);assert.equal(requests[0].model,'model');
 const sent=JSON.stringify(requests[0].messages);for(const mark of ['TEMPLATE_2','WORLD_MARKER','CARD_MARKER','SEND_INPUT'])assert.ok(sent.includes(mark),mark);
 assert.ok(!sent.includes('<%'));assert.equal(user.content[0].text,'SYNTHETIC_INPUT','send regex preserves host history');
 assert.equal((await call('/diagnostics?sessionId=s')).last.phase,'completed');
 const reading=await call('/reading?sessionId=s');assert.equal(reading.writer,true);assert.ok(reading.messages.some(m=>m.html?.includes('DISPLAY_REPLY')));
 const listing=await call('/extensions/scopes?sessionId=s'),preset=listing.sources.find(s=>s.type==='preset');
 const helper=await call('/extensions/scope/run',{sessionId:'s',scope:preset,scriptId:'helper',revision:preset.helperRevision});assert.equal(helper.status,200);assert.equal(helper.result,'HELPER_OK');
 assert.equal(await run('w'),'HOST');assert.equal(await run('other'),'HOST');assert.equal(await run('s',{purpose:'session-title'}),'HOST');
 assert.equal((await call('/settings',{patch:{writingModes:['*']}})).status,400);
 assert.equal((await call('/settings',{patch:{writingModes:['missing']}})).status,400);
 assert.deepEqual((await store.loadSettings()).writingModes,['standard']);
 await call('/bindings',{enabled:false});assert.equal(await run('s'),'HOST');assert.equal((await call('/session-panel?sessionId=s')).writingEnabled,false);
 await call('/bindings',{enabled:true});await call('/bindings',{sessionId:'s',binding:{...(await store.loadBindings()).defaultBinding,enabled:false}});assert.equal(await run('s'),'HOST');
 await call('/bindings',{sessionId:'s',remove:true});modes.set('s','custom');assert.equal(await run('s'),'HOST');assert.equal((await call('/session-panel?sessionId=s')).writer,false);modes.set('s','standard');
 const result=await run('s',{messages:[{role:'assistant',content:[{type:'tool-call',id:'tool',name:'synthetic',input:{}}]},user]});assert.equal(result.at(-1).reason.kind,'error');assert.equal(requests.length,1,'tool history never reaches model');
 // The same selected standard mode also uses the real resident browser and buttons.
 await scopes.replace({type:'preset',id:'p',kind:'helper',items:[{id:'resident',type:'script',name:'Synthetic resident',enabled:true,button:{enabled:true,buttons:[{name:'Advance',visible:true}]},content:'eventOn("message_received",()=>insertOrAssignVariables({received:true})); eventOn(getButtonEvent("Advance"),()=>insertOrAssignVariables({clicked:true}));'}]});
 await ext.updateSection('resident',{defaultEnabled:true});
 const residentRun=await run('s');assert.equal(residentRun.at(-1).reason.kind,'stop');assert.equal(requests.length,2);assert.ok(JSON.stringify(requests[1].messages).includes('TEMPLATE_2'));
 assert.equal((await ext.sessionVars('s')).vars.received,true);
 const panel=await call('/session-panel?sessionId=s');assert.equal(panel.active,true);assert.equal(panel.residentEnabled,true);
 const button=panel.buttons.find(b=>b.name==='Advance');assert.ok(button);
 assert.equal((await call('/session-panel/action',{sessionId:'s',action:'button',scriptId:button.scriptId,name:button.name})).status,200);
 assert.equal((await ext.sessionVars('s')).vars.clicked,true);
 await call('/settings',{patch:{writingModes:[]}});assert.equal(await run('s'),'HOST');assert.equal(await run('w'),'HOST');
 assert.equal((await call('/reading?sessionId=s')).writer,false);assert.equal((await call('/extensions/scope/run',{sessionId:'s',scope:preset,scriptId:'helper',revision:preset.helperRevision})).status,400);
 assert.equal((await call('/session-panel/action',{sessionId:'s',action:'activate'})).status,400,'removed mode cannot start a resident runtime');
 assert.deepEqual((await new GuideStore(root).loadSettings()).writingModes,[],'empty selection survives reopening storage');
 console.log('writing-modes: real apply, HTTP transport, materials/template/send+display regex/helper, exclusions and live settings passed');
}finally{for(const clean of cleanups.reverse())await clean();await new Promise(resolve=>provider.close(resolve));await fs.rm(root,{recursive:true,force:true});}
