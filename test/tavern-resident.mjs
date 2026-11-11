import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTavernEvents } from '../lib/tavern-events.js';
import { TavernBrowser } from '../lib/tavern-browser.js';

const trace=[],errors=[];const events=createTavernEvents(e=>errors.push(e));
events.eventOn('e',async()=>{await Promise.resolve();trace.push(1);});events.eventOn('e',()=>trace.push(2));
await events.eventEmit('e');assert.deepEqual(trace,[1,2]);
let once=0;events.eventOnce('once',()=>{once++;events.eventEmitAndWait('once');});await events.eventEmit('once');assert.equal(once,1);
const stop=events.eventOn('stop',()=>{throw Error('should not run');});stop.stop();await events.eventEmit('stop');assert.equal(errors.length,0);
events.eventOn('error',()=>{throw Error('test');});events.eventOn('error',()=>trace.push(3));await events.eventEmit('error');assert.equal(errors.length,1);assert.equal(trace.at(-1),3);
const ordering=[];const fn=()=>ordering.push('a');events.eventOn('order',fn);events.eventOn('order',()=>ordering.push('b'));events.eventMakeLast('order',fn);await events.eventEmit('order');assert.deepEqual(ordering,['b','a']);

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wg-browser-test-'));const runtime=new TavernBrowser({cacheDir:dir});
try {
  const scripts=[{id:'a',content:'let ticks=0; eventOn("tick",async()=>{await Promise.resolve();insertOrAssignVariables({ticks:++ticks});});',data:{}},
    {id:'b',content:'eventOn("tick",()=>insertOrAssignVariables({other:true})); eventClearAll();',data:{}}];
  await runtime.start({sessionId:'test',card:{name:'Fixture'},preset:{name:'Fixture'},worlds:[],chat:[{name:'Fixture',is_user:false,mes:'fixture'}],scripts});
  await runtime.loadScripts(scripts);await runtime.emit('tick');await runtime.emit('tick');
  const state=await runtime.snapshot();assert.equal(state.variables.chat.ticks,2);assert.equal(state.variables.chat.other,undefined,'clearAll applies only to the calling script');
  const output=await runtime.render(['<%- await Promise.resolve(getLocalVar("ticks")) %>']);assert.deepEqual(output,['2']);
  await runtime.page.evaluate(async()=>{try{await fetch('https://example.invalid/private-fixture');}catch{}});
  assert.ok((await runtime.status()).blockedRequests>0);
  await runtime.loadScripts([{id:'protected',content:'throw Error("PRIVATE_SENTINEL");'}]);await runtime.settle(100);
  assert.ok(!JSON.stringify(await runtime.status()).includes('PRIVATE_SENTINEL'));
  assert.equal(await runtime.page.evaluate(()=>typeof process),'undefined');
  console.log('tavern-resident: resident closures, isolated listeners, async templates, blocked network and error privacy passed');
} finally {await runtime.close();await fs.rm(dir,{recursive:true,force:true});}
