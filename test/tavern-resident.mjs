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
  const scripts=[{id:'a',name:'Fixture script',enabled:true,button:{enabled:true,buttons:[{name:'Advance',visible:true},{name:'Hidden',visible:false}]},content:'let ticks=0; eventOn("tick",async()=>{await Promise.resolve();insertOrAssignVariables({ticks:++ticks});}); eventOn(getButtonEvent("Advance"),()=>{insertOrAssignVariables({buttonClicked:true});replaceScriptButtons([{name:"Next",visible:true}]);});',data:{}},
    {id:'b',content:'eventOn("tick",()=>insertOrAssignVariables({other:true})); eventClearAll();',data:{}}];
  await runtime.start({sessionId:'test',card:{name:'Fixture'},preset:{name:'Fixture'},worlds:[{id:'book',name:'Fixture world',originalData:{version:1},entries:[{uid:7,content:'synthetic lore',key:['fixture'],disable:false}]}],chat:[{name:'Fixture',is_user:false,mes:'fixture'}],scripts});
  const loadedBook=await runtime.page.evaluate(async()=>{
    const book=await SillyTavern.getContext().loadWorldInfo('Fixture world');
    book.entries[7].content='changed copy';
    return {entry:(await SillyTavern.loadWorldInfo('Fixture world')).entries[7],missing:await SillyTavern.loadWorldInfo('missing'),version:book.version,uuid:SillyTavern.uuidv4()};
  });
  assert.equal(loadedBook.entry.content,'synthetic lore','context reads cannot mutate stored entries');
  assert.equal(loadedBook.missing,null);
  assert.equal(loadedBook.version,1);
  assert.match(loadedBook.uuid,/^[a-f0-9-]{36}$/);
  await runtime.loadScripts(scripts);await runtime.emit('tick');await runtime.emit('tick');
  const state=await runtime.snapshot();assert.equal(state.variables.chat.ticks,2);assert.equal(state.variables.chat.other,undefined,'clearAll applies only to the calling script');
  const output=await runtime.render(['<%- await Promise.resolve(getLocalVar("ticks")) %>']);assert.deepEqual(output,['2']);
  assert.deepEqual((await runtime.buttons()).map(button=>button.name),['Advance']);
  assert.equal((await runtime.clickButton('a','Advance')).variables.chat.buttonClicked,true);
  assert.deepEqual((await runtime.buttons()).map(button=>button.name),['Next']);
  await assert.rejects(runtime.clickButton('a','Hidden'),/BUTTON_NOT_AVAILABLE/);
  await assert.rejects(runtime.clickButton('other','Next'),/BUTTON_NOT_AVAILABLE/);
  assert.equal(await runtime.page.evaluate(()=>typeof $.fn.draggable),'function');
  await runtime.page.evaluate(()=>{
    const button=document.createElement('button');button.textContent='Surface fixture';button.id='surface-fixture';button.onclick=()=>insertOrAssignVariables({surfaceClicked:true});document.body.prepend(button);
  });
  const box=await runtime.page.locator('#surface-fixture').boundingBox();
  assert.equal((await runtime.interact({type:'click',x:box.x+box.width/2,y:box.y+box.height/2})).variables.chat.surfaceClicked,true);
  const surface=await runtime.surface();assert.ok(surface.image.startsWith('data:image/png;base64,'));assert.ok(surface.width>0);
  await assert.rejects(runtime.interact({type:'key',key:'Control+R'}),/SURFACE_KEY/);
  await runtime.page.evaluate(async()=>{try{await fetch('https://example.invalid/private-fixture');}catch{}});
  assert.ok((await runtime.status()).blockedRequests>0);
  await runtime.loadScripts([{id:'protected',content:'throw Error("PRIVATE_SENTINEL");'}]);await runtime.settle(100);
  assert.ok(!JSON.stringify(await runtime.status()).includes('PRIVATE_SENTINEL'));
  assert.equal(await runtime.page.evaluate(()=>typeof process),'undefined');
  console.log('tavern-resident: resident closures, isolated listeners, async templates, blocked network and error privacy passed');
} finally {await runtime.close();await fs.rm(dir,{recursive:true,force:true});}
