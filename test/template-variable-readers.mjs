import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runTemplateBatch} from '../lib/extension-runtime.js';
import {TavernBrowser} from '../lib/tavern-browser.js';
import {GuideStore} from '../lib/store.js';
import {ExtensionStore} from '../lib/extension-store.js';
import {createSessionHook} from '../lib/session-hook.js';

// Expected behavior follows ST-Prompt-Template variables.ts: message without
// withMsg reads cache; cache precedence is shallow global -> local -> message.
const globals={globalOnly:4,scope:'global',nested:{globalOnly:true}},local={localOnly:7,scope:'local',nested:{localOnly:true},encoded:'["first","second"]'},message={stat_data:{score:9},scope:'message',nested:{messageOnly:true},'dotted.key':'literal'};
const templates=[
  '<%- getMessageVar("stat_data.score") %>|<%- getLocalVar("localOnly") %>|<%- getGlobalVar("globalOnly") %>',
  '<%- getMessageVar("localOnly") %>|<%- getMessageVar("globalOnly") %>|<%- getvar("scope") %>',
  '<%- _.get(getMessageVar(null),"stat_data.score") %>|<%- getMessageVar("missing",{defaults:0}) %>',
  '<%- getMessageVar("nested.globalOnly",{defaults:"absent"}) %>|<%- getvar("nested.localOnly",{defaults:"absent"}) %>',
  '<%- getLocalVar("encoded",{index:1}) %>|<%- getvar("encoded",{scope:"local",index:8,defaults:"absent"}) %>',
  '<%- getMessageVar("dotted.key") %>|<%- getvar("stat_data[\'score\']") %>',
  '<% const value=getMessageVar("stat_data",{clone:true});value.score=99; %><%- getMessageVar("stat_data.score") %>',
  '<% getMessageVar("stat_data").score=15; %><%- getMessageVar("stat_data.score") %>',
  '<%- getMessageVar("stat_data.score",{noCache:true}) %>',
  '<% setLocalVar("newLocal",12);setMessageVar("newMessage",13); %><%- getLocalVar("newLocal",{noCache:true}) %>|<%- getMessageVar("newMessage") %>',
  '<%- typeof process %>|<%- typeof require %>|<%- typeof _.get %>',
];
const expected=['9|7|4','7|4|message','9|0','absent|absent','second|absent','literal|9','9','15','9','12|13','undefined|undefined|function'];
const originals=JSON.stringify({globals,local,message});
const root=await fs.mkdtemp(path.join(os.tmpdir(),'wg-template-getters-'));
let browser;
try{
  const quick=await runTemplateBatch({texts:templates,variables:local,messageVariables:message,globalVariables:globals});
  assert.deepEqual(quick.texts,expected);assert.equal(quick.variables.newLocal,12);assert.equal(quick.messageVariables.newMessage,13);
  assert.equal(JSON.stringify({globals,local,message}),originals,'source snapshots must remain unchanged');
  assert.equal(quick.messageVariables.stat_data.score,9,'editing the merged cache cannot mutate persistent message variables');
  const helperWrites=await runTemplateBatch({globalVariables:globals,texts:['<% replaceVariables({});insertOrAssignVariables({x:1});insertVariables({y:2}); %><%- getMessageVar("globalOnly") %>']});assert.deepEqual(helperWrites.texts,['4'],'helper writes retain global fallback in the merged cache');
  const random=()=>runTemplateBatch({texts:['<%- _.random(0,1000000) %>|<%- _.sample([1,2,3,4,5]) %>'],seed:'same-request'});
  assert.deepEqual((await random()).texts,(await random()).texts,'lodash random follows the request seed on rebuilds');
  assert.deepEqual((await runTemplateBatch({texts:['<%- getMessageVar("missing",{defaults:"new-chat"}) %>|<%- getGlobalVar("missing",{defaults:false}) %>']})).texts,['new-chat|false']);
  for(const text of ['<%- getMessageVar("__proto__.x") %>','<%- getLocalVar("constructor.prototype") %>'])await assert.rejects(runTemplateBatch({texts:[text]}),/变量路径/);
  await assert.rejects(runTemplateBatch({texts:['<%- getMessageVar("x",{withMsg:{id:0}}) %>']}),/withMsg/,'unsupported history selection must not silently return the latest value');
  await assert.rejects(runTemplateBatch({texts:['<%- getvar("x",{scope:"initial"}) %>']}),/作用域/);
  browser=new TavernBrowser({cacheDir:path.join(root,'modules')});
  await browser.start({sessionId:'synthetic',chat:[{is_user:false,mes:'synthetic'}],variables:{global:globals,chat:local,messages:{0:message}},scripts:[]});
  assert.deepEqual(await browser.render(templates),expected,'resident and QuickJS templates expose the same getters');
  await assert.rejects(browser.render(['<%- getMessageVar("x",{withMsg:{id:0}}) %>']),/withMsg/);
  const browserBefore=await browser.snapshot();
  await browser.setChat([{role:'assistant',content:'synthetic prior'},{role:'user',content:'synthetic current'}]);
  assert.deepEqual(await browser.render(['<%- getMessageVar("stat_data.score") %>']),['9'],'current message inherits the previous variable table');
  let inherited=await browser.snapshot();assert.equal(inherited.variables.messages[1].stat_data.score,9);
  delete inherited.variables.messages[1].stat_data;
  await browser.restore(inherited);
  assert.deepEqual(await browser.render(['<%- getMessageVar("stat_data.score",{defaults:"deleted",noCache:true}) %>']),['deleted'],'noCache must not re-inherit a deliberately deleted value');
  await browser.restore(browserBefore);
  const emptyTable=await browser.snapshot();emptyTable.chat.push({is_user:false,mes:'synthetic empty'}, {is_user:true,mes:'synthetic current'});emptyTable.variables.messages[1]={};await browser.restore(emptyTable);
  assert.deepEqual(await browser.render(['<%- getMessageVar("stat_data.score",{defaults:"empty"}) %>']),['empty'],'an empty preceding table stops backward search');

  // Exercise the normal writer hook, saved state and transaction boundary.
  const store=new GuideStore(root),ext=new ExtensionStore(root);await store.ensure();
  await store.saveSettings({includeWorlds:false,maxTokens:128});
  const content='<% setLocalVar("attempt",Number(getLocalVar("attempt",{defaults:0}))+1);setMessageVar("round",Number(getMessageVar("round",{defaults:0}))+1); %><%- getMessageVar("stat_data.score") %>|<%- getGlobalVar("globalOnly") %>|<%- _.get(getMessageVar(null),"round") %>';
  await store.savePreset({id:'p',prompts:[{identifier:'main',content},{identifier:'chatHistory',marker:true}],prompt_order:[{order:[{identifier:'main',enabled:true},{identifier:'chatHistory',enabled:true}]}]});
  await ext.updateSection('template',{enabled:true,allowedPresetIds:['p']});
  await ext.update(state=>({...state,sessions:{s:{vars:{},messageVars:message,scriptVars:{},version:0,residentState:{variables:{global:globals,chat:{},messages:{0:message},scripts:{}},lastMessageId:0}}}}));
  const binding={presetId:'p',provider:'test',model:'synthetic',worldSelection:'none'},diagnostics=new Map();let fail=true,sent,cancel;
  const hook=createSessionHook({store,extensionStore:ext,runTemplateBatch,diagnostics,transport:async args=>{sent=args.plan.messages;cancel?.abort();return {ok:!fail,finish:fail?'length':'stop',content:'ACK'};}});
  const run=async()=>{const out=[];for await(const c of hook({signal:cancel?.signal,messages:[{role:'user',source:{kind:'user'},content:'synthetic request'}]},'s',binding))out.push(c);return out;};
  const before=await fs.readFile(ext.file,'utf8');
  await run();assert.ok(sent.some(row=>row.content==='9|4|1'));assert.equal(await fs.readFile(ext.file,'utf8'),before,'failed output cannot commit template writes');
  fail=false;cancel=new AbortController();await run();assert.equal(await fs.readFile(ext.file,'utf8'),before,'cancelled output cannot commit template writes');cancel=null;
  const result=await run();assert.equal(result.at(-1).reason.kind,'stop');let saved=await new ExtensionStore(root).sessionVars('s');assert.equal(saved.vars.attempt,1);assert.equal(saved.messageVars.round,1);assert.equal(saved.messageVars.stat_data.score,9);assert.equal(saved.residentState.variables.messages[0].round,1);
  await run();saved=await new ExtensionStore(root).sessionVars('s');assert.equal(saved.vars.attempt,2);assert.equal(saved.messageVars.round,2);
  assert.deepEqual(saved.residentState.variables.global,globals,'global reads do not change stored global variables');
  console.log('template-variable-readers: upstream getter semantics, QuickJS/browser parity, lodash isolation, fresh/saved state and writer rollback passed');
}finally{await browser?.close();await fs.rm(root,{recursive:true,force:true});}
