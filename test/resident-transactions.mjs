import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GuideStore } from '../lib/store.js';
import { ExtensionStore } from '../lib/extension-store.js';
import { ResidentRuntime } from '../lib/resident-runtime.js';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'wg-resident-tx-'));const store=new GuideStore(root),extensionStore=new ExtensionStore(root);await store.ensure();
let starts=0,closes=0;
class Browser {
  async start(input){starts++;this.state={variables:structuredClone(input.variables),worlds:input.worlds,chat:input.chat,settings:input.settings};}
  async loadScripts(){}async settle(){}async emit(){}async setChat(rows){this.state.chat=rows;}
  async snapshot(){return structuredClone(this.state);}async restore(value){this.state=structuredClone(value);}
  async render(texts){this.state.variables.chat.renders=(this.state.variables.chat.renders??0)+1;return texts;}
  async processReply(content){this.state.chat.push({mes:content});this.state.variables.messages[this.state.chat.length-1]={updated:true};return this.snapshot();}
  async status(){return {scripts:[],mvu:true};}async close(){closes++;}
  async buttons(){return [{scriptId:'a',name:'Advance'}];}
  async clickButton(id,name){if(id!=='a'||name!=='Advance')throw Error('BUTTON_NOT_AVAILABLE');this.state.variables.chat.clicked=true;return this.snapshot();}
}
const manager=new ResidentRuntime({store,extensionStore,scopes:{resolve:async()=>({scripts:[],regex:[]})},factory:()=>new Browser()});
const args={sessionId:'s',binding:{worldIds:[],worldSelection:'none'},card:null,conversation:[]};
try {
  assert.equal(await manager.prepare(args),null);
  await extensionStore.updateSection('resident',{enabled:true,sessionIds:['s']});
  let tx=await manager.prepare(args);await tx.render(['a'],{});await tx.render(['a'],{});await tx.complete('ok');await tx.finish();
  assert.equal((await extensionStore.sessionVars('s')).vars.renders,1,'budget rebuild must not repeat writes');
  tx=await manager.prepare(args);assert.equal(starts,1,'same binding reuses resident runtime');await tx.render(['x'],{});await tx.finish();assert.equal(closes,1,'failed generation drops runtime');assert.equal((await extensionStore.sessionVars('s')).vars.renders,1);
  tx=await manager.prepare(args);await extensionStore.saveSessionVars('s',{vars:{newer:true},expectedVersion:1});await assert.rejects(tx.complete('ok'),/CONFLICT/);await tx.finish();assert.deepEqual((await extensionStore.sessionVars('s')).vars,{newer:true});
  tx=await manager.prepare(args);await tx.render(['x'],{});await tx.complete('ok');await tx.finish();
  await extensionStore.saveSessionVars('s',{vars:{edited:true},messageVars:{editedMessage:true},expectedVersion:3});
  const beforeRestart=starts;
  tx=await manager.prepare(args);assert.equal(starts,beforeRestart+1,'external variable edits invalidate a cached browser');
  await tx.complete('ok');await tx.finish();
  assert.deepEqual((await extensionStore.sessionVars('s')).vars,{edited:true},'a resident browser cannot overwrite a newer external variable snapshot');
  await manager.close('s');
  tx=await manager.prepare(args);await tx.complete('ok');await tx.finish();
  assert.deepEqual((await extensionStore.sessionVars('s')).vars,{edited:true},'committed state survives browser recreation');
  await store.savePreset({id:'p',name:'original',prompts:[]});
  const withPreset={...args,binding:{...args.binding,presetId:'p'}};
  tx=await manager.prepare(withPreset);await tx.complete('ok');await tx.finish();
  const beforeEdit=starts;
  await store.savePreset({id:'p',name:'edited',prompts:[]});
  tx=await manager.prepare(withPreset);assert.equal(starts,beforeEdit+1,'editing a preset refreshes the runtime context');await tx.finish();
  const beforeButtons=await extensionStore.sessionVars('s');
  tx=await manager.prepare({...args,interaction:true});await tx.clickButton('a','Advance');await tx.finish();
  const afterButtons=await extensionStore.sessionVars('s');
  assert.equal(afterButtons.vars.clicked,true);
  assert.equal(afterButtons.version,beforeButtons.version+1);
  assert.equal((await manager.inspect('s')).buttons[0].name,'Advance');
  tx=await manager.prepare({...args,interaction:true});
  await assert.rejects(tx.clickButton('foreign','Advance'),/BUTTON_NOT_AVAILABLE/);await tx.finish();
  assert.equal((await extensionStore.sessionVars('s')).version,afterButtons.version,'failed button action leaves persisted variables untouched');
  console.log('resident-transactions: opt-in, resident reuse, budget rollback and concurrent state protection passed');
}finally{await manager.dispose();await fs.rm(root,{recursive:true,force:true});}
