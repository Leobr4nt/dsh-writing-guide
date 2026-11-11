import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {GuideStore} from '../lib/store.js';import {ExtensionStore} from '../lib/extension-store.js';
import {ResidentRuntime} from '../lib/resident-runtime.js';import {createSessionHook} from '../lib/session-hook.js';import {runTemplateBatch} from '../lib/extension-runtime.js';
const root=await mkdtemp(path.join(os.tmpdir(),'wg-macro-resident-')),store=new GuideStore(root),ext=new ExtensionStore(root);await store.ensure();
const scopes={resolve:async()=>({regex:[],scripts:[{scopeType:'global',scopeId:'global',id:'s',enabled:true,content:'eventOn("message_received",()=>updateVariablesWith(v=>({...v,coins:Number(v.coins)+1})));'}]})};
let manager=new ResidentRuntime({store,extensionStore:ext,scopes}),captured;
const setPreset=async text=>store.savePreset({id:'p',name:'Fixture',prompts:[{identifier:'main',content:text},{identifier:'chatHistory',marker:true}],prompt_order:[{order:[{identifier:'main',enabled:true},{identifier:'chatHistory',enabled:true}]}]});
const run=async(ok=true)=>{
  const hook=createSessionHook({store,extensionStore:ext,scopes,residentManager:manager,runTemplateBatch,diagnostics:new Map(),transport:async({plan})=>{captured=plan.messages.map(m=>m.content).join('\n');return {ok,content:'ACK',finish:ok?'stop':'length'};}});
  const chunks=[];for await(const c of hook({messages:[{id:'u',role:'user',source:{kind:'user'},content:'synthetic'}]},'s',{presetId:'p',worldSelection:'none',provider:'test',model:'m'}))chunks.push(c);return chunks;
};
try{
  await store.saveSettings({contextWindow:0,maxTokens:128});await ext.updateSection('resident',{enabled:true,sessionIds:['s']});await ext.updateSection('template',{enabled:true,allowedPresetIds:['p']});
  await setPreset('{{setvar::coins::80}}MACRO={{getvar::coins}};<% setLocalVar("coins",Number(getLocalVar("coins"))+2); %>EJS=<%- getLocalVar("coins") %>');
  assert.equal((await run()).at(-1).reason.kind,'stop');assert.match(captured,/MACRO=80;EJS=82/);assert.equal((await ext.sessionVars('s')).vars.coins,83);
  await manager.dispose();manager=new ResidentRuntime({store,extensionStore:new ExtensionStore(root),scopes});
  await setPreset('RESTORED={{getvar::coins}}');await run();assert.match(captured,/RESTORED=83/);let state=await ext.sessionVars('s');assert.equal(state.vars.coins,84);assert.equal(state.version,2);
  await ext.updateSection('template',{enabled:false});await setPreset('{{addvar::coins::5}}COINS={{getvar::coins}}');await run();assert.match(captured,/COINS=89/);state=await ext.sessionVars('s');assert.equal(state.vars.coins,90,'macros commit even when EJS is disabled');
  await run(false);assert.deepEqual(await ext.sessionVars('s'),state,'failed resident generation rolls back both macro and script variables');assert.equal(manager.sessions.has('s'),false);
  console.log('macro-resident: shared macro/EJS/script variables, restart and failed-generation rollback passed');
}finally{await manager.dispose();await rm(root,{recursive:true,force:true});}
