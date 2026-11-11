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
  async start(input){starts++;this.state={variables:{chat:{},messages:{},scripts:{},global:{}},worlds:input.worlds,chat:input.chat,settings:{}};}
  async loadScripts(){}async settle(){}async emit(){}async setChat(rows){this.state.chat=rows;}
  async snapshot(){return structuredClone(this.state);}async restore(value){this.state=structuredClone(value);}
  async render(texts){this.state.variables.chat.renders=(this.state.variables.chat.renders??0)+1;return texts;}
  async processReply(content){this.state.chat.push({mes:content});this.state.variables.messages[this.state.chat.length-1]={updated:true};return this.snapshot();}
  async status(){return {scripts:[],mvu:true};}async close(){closes++;}
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
  console.log('resident-transactions: opt-in, resident reuse, budget rollback and concurrent state protection passed');
}finally{await manager.dispose();await fs.rm(root,{recursive:true,force:true});}
