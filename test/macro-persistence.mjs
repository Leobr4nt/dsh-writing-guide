import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {GuideStore} from '../lib/store.js';
import {ExtensionStore} from '../lib/extension-store.js';
import {createSessionHook} from '../lib/session-hook.js';
import {runTemplateBatch,runHelperScript} from '../lib/extension-runtime.js';
import {createMacroScope,macroVariables} from '../lib/macros.js';
import {buildPlan} from '../lib/plan.js';
const root=await mkdtemp(path.join(os.tmpdir(),'wg-macro-persist-'));
const store=new GuideStore(root);let ext=new ExtensionStore(root);
await store.ensure();await store.saveSettings({includeWorlds:true,maxTokens:128,contextWindow:0,maxChars:0});
const binding={presetId:'p',worldIds:[],worldSelection:'none',provider:'fixture',model:'synthetic'};
const request=(id='u',prior=[])=>({messages:[...prior,{id,role:'user',source:{kind:'user'},content:[{type:'text',text:'synthetic'}]}]});
const preset=async content=>store.savePreset({id:'p',name:'Fixture',prompts:[{identifier:'main',content},{identifier:'worldInfoBefore',marker:true},{identifier:'chatHistory',marker:true}],prompt_order:[{order:[{identifier:'main',enabled:true},{identifier:'worldInfoBefore',enabled:true},{identifier:'chatHistory',enabled:true}]}]});
let capture,diagnostics;const run=async({session='s',options=request(),route=binding,transport,templates=false}={})=>{
  diagnostics=new Map();const hook=createSessionHook({store,extensionStore:ext,diagnostics,runTemplateBatch:templates?runTemplateBatch:null,transport:async args=>{
    capture=args;return transport?transport(args):{ok:true,content:'ACK',finish:'stop'};
  }});const chunks=[];for await(const c of hook(options,session,route))chunks.push(c);return chunks;
};
const sent=()=>capture.plan.messages.map(row=>row.content).join('\n');
try{
  await preset('{{setvar::coins::80}}{{incvar::turn}} COINS={{getvar::coins}}');
  await run();let state=await ext.sessionVars('s');assert.equal(state.vars.coins,'80');assert.equal(state.vars.turn,1);assert.equal(state.version,1);
  ext=new ExtensionStore(root);await preset('COINS={{getvar::coins}} TURN={{incvar::turn}}');
  await run();assert.match(sent(),/COINS=80 TURN=2/);assert.equal((await ext.sessionVars('s')).version,2,'restart loads prior values and makes one commit');
  await run({session:'other'});assert.match(sent(),/COINS= TURN=1/);assert.equal((await ext.sessionVars('s')).vars.turn,2);
  for(const transport of [async()=>({ok:false,finish:'length'}),async()=>{throw Error('synthetic network');}]){
    const before=await ext.sessionVars('s');await run({transport});assert.deepEqual(await ext.sessionVars('s'),before,'failed output leaves variables intact');
  }
  const abort=new AbortController(),beforeAbort=await ext.sessionVars('s');
  await run({options:{...request(),signal:abort.signal},transport:async()=>{abort.abort();return {ok:true,finish:'stop',content:'ACK'};}});
  assert.deepEqual(await ext.sessionVars('s'),beforeAbort);
  await store.saveSettings({contextWindow:1200});
  const history=[{role:'user',source:{kind:'user'},content:'x'.repeat(6000)},{role:'assistant',content:'y'.repeat(6000)}];
  await run({options:request('budget',history)});assert.equal((await ext.sessionVars('s')).vars.turn,3,'budget rebuild commits one increment');assert.equal(diagnostics.get('s').droppedPairs,1);
  await store.saveSettings({contextWindow:0});
  let conflict=await run({transport:async()=>{
    const saved=await ext.sessionVars('s');await ext.saveSessionVars('s',{vars:{external:9},expectedVersion:saved.version});
    return {ok:true,finish:'stop',content:'ACK'};
  }});
  assert.equal(conflict.at(-1).reason.kind,'error');assert.equal(conflict.some(c=>c.type==='text-delta'),false);assert.deepEqual((await ext.sessionVars('s')).vars,{external:9});
  await preset('{{setvar::coins::5}} MACRO={{getvar::coins}} <% setvar("coins",Number(getvar("coins",{scope:"local"}))+2,{scope:"local"}); %> EJS=<%- getvar("coins",{scope:"local"}) %>');
  await ext.updateSection('template',{enabled:true,allowedPresetIds:['p']});
  const beforeTemplate=(await ext.sessionVars('s')).version;await run({templates:true});assert.match(sent(),/MACRO=5\s+EJS=7/);state=await ext.sessionVars('s');assert.equal(state.vars.coins,7);assert.equal(state.version,beforeTemplate+1);
  await preset('{{setvar::coins::999}}<% throw Error("synthetic"); %>');await run({templates:true});assert.deepEqual(await ext.sessionVars('s'),state,'template errors cannot commit earlier macro writes');
  const result=await runHelperScript({script:{id:'synthetic',content:'insertOrAssignVariables({coins:11});'},variables:state.vars,context:{},scriptVariables:{}});
  await ext.saveSessionVars('s',{vars:result.variables,expectedVersion:state.version});
  await preset('SCRIPT={{getvar::coins}}{{deletevar::external}}');await run();assert.match(sent(),/SCRIPT=11/);assert.equal((await ext.sessionVars('s')).vars.external,undefined);
  await store.saveWorld({id:'w',name:'Synthetic world',entries:[{uid:1,constant:true,content:'{{setvar::worldValue::saved}}WORLD={{getvar::coins}}'}]});
  await preset('PRESET');await run({route:{...binding,worldIds:['w'],worldSelection:'selected'}});assert.match(sent(),/WORLD=11/);assert.equal((await ext.sessionVars('s')).vars.worldValue,'saved');
  const diskBefore=await readFile(ext.file,'utf8');const previewScope=createMacroScope({variables:(await ext.sessionVars('s')).vars});
  buildPlan({preset:{prompts:[{identifier:'main',content:'{{setvar::preview::not-saved}}'}],prompt_order:[{order:[{identifier:'main',enabled:true}]}]},macroScope:previewScope});
  assert.equal(macroVariables(previewScope).preview,'not-saved');assert.equal(await readFile(ext.file,'utf8'),diskBefore,'preview never persists');
  assert.equal(JSON.stringify(capture.plan.meta).includes('worldValue'),false,'pending variables never enter public plan metadata');
  let release;const gate=new Promise(resolve=>release=resolve);let queued;
  const entered=new Promise(resolve=>{queued=resolve;});
  const blocker=ext.update(async()=>{queued();await gate;});await entered;
  const cancel=new AbortController();let sentResolve;const gotResult=new Promise(resolve=>sentResolve=resolve);
  await preset('{{incvar::turn}}');const savedBeforeQueue=await ext.sessionVars('s');
  const pending=run({options:{...request('queued'),signal:cancel.signal},transport:async()=>{sentResolve();return {ok:true,finish:'stop',content:'ACK'};}});
  await gotResult;cancel.abort();release();await blocker;await pending;
  assert.deepEqual(await ext.sessionVars('s'),savedBeforeQueue,'cancellation while waiting for the write queue leaves no commit');
  console.log('macro-persistence: cross-turn/restart, session isolation, budget rebuild, rollback, conflicts, shared variables and preview isolation passed');
}finally{await rm(root,{recursive:true,force:true});}
