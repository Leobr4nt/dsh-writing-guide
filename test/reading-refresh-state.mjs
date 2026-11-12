import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {chromium} from 'playwright-core';
import {build} from 'esbuild';
import {ReadingRuntime} from '../lib/reading-runtime.js';

// Only generated fixtures are admitted. No application server or user data is used.
const source=fs.readFileSync(new URL('../client.js',import.meta.url),'utf8');
const start=source.indexOf('    function ReadingFrame('),end=source.indexOf('    function RuntimeSurface(',start);
assert.ok(start>=0&&end>start,'locate real reading components');
const harness=`import React,{useState,useRef,useEffect,useCallback}from'react';
import{createRoot}from'react-dom/client';const h=React.createElement;
window.apiPending=0;
const api=async(...args)=>{window.apiPending++;try{return await window.syntheticApi(...args);}finally{window.apiPending--;}};
// Invoke the production poll callback explicitly; real 4-second ticks cannot race gates.
const intervals=new Map();let nextInterval=1;
const setInterval=(fn,delay)=>{const id=nextInterval++;intervals.set(id,fn);return id;};
const clearInterval=id=>intervals.delete(id);
window.pollReading=()=>{for(const fn of intervals.values())void fn();};
const RuntimeSurface=()=>null;
${source.slice(start,end)}
const root=createRoot(document.querySelector('#app'));
window.renderReading=({sessionId='session-a',running=false}={})=>root.render(h(WritingReadingView,{
  sessionId,useProjection:()=> 'writer',useSession:selector=>selector({running})
}));
// No React key here: exercise ReadingFrame's own row/session identity cleanup too.
window.renderFrame=({row,sessionId='session-a'})=>root.render(h(ReadingFrame,{row,sessionId}));`;
const bundle=await build({stdin:{contents:harness,resolveDir:fileURLToPath(new URL('../',import.meta.url))},bundle:true,write:false,format:'iife',logLevel:'silent'});
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'wg-refresh-state-'));
const browser=await chromium.launch({executablePath:process.env.DSH_WRITING_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
console.log('reading-refresh-state client SHA-256: '+createHash('sha256').update(source).digest('hex'));

function fixtureRow({id='message-a',label='initial',headVersion=1}={}){
  return {id,role:'assistant',interactive:true,original:'SYNTHETIC ONLY',
    head:`<style>:root{--audit-head-version:${headVersion}}body{margin:0}#lead{height:1000px}.audit-scroll{height:180px;width:420px;overflow:auto;scroll-behavior:smooth}.audit-scroll>div{height:3000px;width:2200px}#tail{height:7000px}</style>`,
    html:`<div id="lead"></div><p id="marker">${label}</p><input id="edit" value="baseline"><select id="choose"><option value="a">A</option><option value="b">B</option></select><button id="update">Update</button><span id="result">initial</span>
      <div id="panel" class="audit-scroll"><div>synthetic identified scroll area</div></div>
      <div data-audit-scroll="anonymous" class="audit-scroll"><div>synthetic node-identified scroll area</div></div>
      <details data-writing-fold="draft"><summary>Protected synthetic fold</summary><div style="height:300px">synthetic folded content</div></details>
      <details id="ordinary"><summary>Ordinary synthetic fold</summary><div style="height:200px">synthetic source fold</div></details><div id="tail"></div>
      <script>document.querySelector('#edit').oninput=e=>document.querySelector('#result').textContent='input:'+e.target.value;
      document.querySelector('#choose').onchange=e=>document.querySelector('#result').textContent='select:'+e.target.value;
      document.querySelector('#update').onclick=()=>document.querySelector('#result').textContent='clicked';</script>`};
}

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
async function entered(gate){
  let timer;try{await Promise.race([gate.entered.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('No '+gate.kind+' request reached the response gate')),8000);})]);}finally{clearTimeout(timer);}
}
async function settle(page){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))));}
async function idle(page){await page.waitForFunction(()=>window.apiPending===0);await settle(page);}

async function createFixture(t,{view=false,running=false,row=fixtureRow()}={}){
  const context=await browser.newContext({viewport:{width:1200,height:900}});
  const page=await context.newPage();page.setDefaultTimeout(8000);
  const runtime=new ReadingRuntime(path.join(temporary,createHash('sha256').update(t.name).digest('hex')));
  const sessions=new Map([['session-a',[row]]]),gates=[],errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  t.after(async()=>{for(const gate of gates)gate.release.resolve();await context.close();await runtime.dispose();assert.deepEqual(errors,[],'browser page errors');});
  // Hold responses after the real runtime has produced them, without blocking its queue.
  await page.exposeFunction('syntheticApi',async(method,url,body)=>{
    const kind=method==='GET'?'get':url.endsWith('/action')?'action':'document';
    const gate=gates.find(item=>item.kind===kind&&!item.used);if(gate)gate.used=true;
    let result;
    if(kind==='get'){
      const sessionId=new URL(url,'https://synthetic.invalid').searchParams.get('sessionId');
      result={messages:structuredClone(sessions.get(sessionId)??[])};
    }else if(kind==='action')result=await runtime.act(body.sessionId,body.messageId,body.token,body.input);
    else{
      const current=sessions.get(body.sessionId)?.find(item=>item.id===body.messageId);
      assert.ok(current,'synthetic document row exists');result=await runtime.render(body.sessionId,current,body.width);
    }
    if(gate){gate.entered.resolve();await gate.release.promise;}return result;
  });
  await page.route('**/*',route=>route.abort());
  await page.setContent('<!doctype html><style>body{margin:0}#scroller{height:600px;width:950px;overflow:auto;scroll-behavior:smooth}</style><div id="scroller"><div id="app"></div></div><input id="outside" aria-label="Outside reading"><div style="height:1000px"></div>');
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  await page.evaluate(({view,running,row})=>view?window.renderReading({running}):window.renderFrame({row}),{view,running,row});
  await page.waitForFunction(()=>document.querySelector('iframe')?.contentDocument?.querySelector('#panel'));
  await idle(page);
  return {page,sessions,runtime,row,
    hold(kind){const gate={kind,entered:deferred(),release:deferred(),used:false};gates.push(gate);return gate;},
    sourcePage(sessionId='session-a',id=row.id){return runtime.entries.get(createHash('sha256').update(sessionId+'|'+id).digest('hex')).page;},
  };
}

async function position(page,{outer=5000,top=1200,left=230,anonymousTop=900,anonymousLeft=180}={}){
  await page.evaluate(values=>{
    const documentInside=document.querySelector('iframe').contentDocument;
    document.querySelector('#scroller').scrollTo({top:values.outer,behavior:'instant'});
    documentInside.querySelector('#panel').scrollTo({top:values.top,left:values.left,behavior:'instant'});
    documentInside.querySelector('[data-audit-scroll]').scrollTo({top:values.anonymousTop,left:values.anonymousLeft,behavior:'instant'});
  },{outer,top,left,anonymousTop,anonymousLeft});
  await settle(page);return readPosition(page);
}
async function readPosition(page){return page.evaluate(()=>{
  const doc=document.querySelector('iframe')?.contentDocument,panel=doc?.querySelector('#panel'),anonymous=doc?.querySelector('[data-audit-scroll]');
  return {outer:document.querySelector('#scroller').scrollTop,top:panel?.scrollTop,left:panel?.scrollLeft,anonymousTop:anonymous?.scrollTop,anonymousLeft:anonymous?.scrollLeft};
});}
async function rememberFrame(page){await page.evaluate(()=>{
  window.savedFrame=document.querySelector('iframe');window.savedDocument=window.savedFrame.contentDocument;window.removedSavedFrame=false;
  window.removalObserver?.disconnect();window.removalObserver=new MutationObserver(records=>{
    for(const record of records)for(const removed of record.removedNodes)if(removed===window.savedFrame||removed.contains?.(window.savedFrame))window.removedSavedFrame=true;
  });window.removalObserver.observe(document.querySelector('#app'),{subtree:true,childList:true});
});}
async function retainedFrame(page,phase){
  await settle(page);
  const state=await page.evaluate(()=>({sameFrame:document.querySelector('iframe')===window.savedFrame,sameDocument:document.querySelector('iframe')?.contentDocument===window.savedDocument,connected:window.savedFrame.isConnected,removed:window.removedSavedFrame}));
  assert.deepEqual(state,{sameFrame:true,sameDocument:true,connected:true,removed:false},phase+' must retain the mounted iframe and document');
}
async function changedDocument(page){await page.waitForFunction(()=>document.querySelector('iframe')?.contentDocument?.querySelector('#panel')&&document.querySelector('iframe').contentDocument!==window.savedDocument);await idle(page);}
async function triggerInput(page){await page.evaluate(()=>{
  const input=document.querySelector('iframe').contentDocument.querySelector('#edit');
  input.focus({preventScroll:true});input.value='changed';input.dispatchEvent(new Event('input',{bubbles:true}));
});}

try{
  for(const running of [false,true])await test(`running ${running} -> ${!running}: keep iframe while GET waits`,async t=>{
    const f=await createFixture(t,{view:true,running}),{page}=f;
    await page.evaluate(()=>{document.querySelector('iframe').contentDocument.querySelector('[data-reading-local-fold]').open=true;});
    const before=await position(page);await rememberFrame(page);
    const gate=f.hold('get');await page.evaluate(value=>window.renderReading({running:value}),!running);await entered(gate);
    await retainedFrame(page,'running request pending');assert.deepEqual(await readPosition(page),before,'pending running refresh scroll');
    const latest=await position(page,{outer:5300,top:1400});gate.release.resolve();await idle(page);
    await retainedFrame(page,'running response complete');assert.deepEqual(await readPosition(page),latest,'running response retains subsequent user scroll');
    assert.equal(await page.evaluate(()=>document.querySelector('iframe').contentDocument.querySelector('[data-reading-local-fold]').open),true,'running preserves local fold');
  });

  for(const field of ['html','head'])await test(`same row new ${field}: retain old document until replacement`,async t=>{
    const f=await createFixture(t,{view:true}),{page}=f;
    const before=await position(page);await rememberFrame(page);
    const replacement=field==='html'?fixtureRow({label:'replacement'}):fixtureRow({headVersion:2});
    f.sessions.set('session-a',[replacement]);const gate=f.hold('document');
    await page.evaluate(()=>window.pollReading());await entered(gate);
    await retainedFrame(page,'same-row '+field+' load pending');assert.deepEqual(await readPosition(page),before,'old surface keeps its scroll');
    const latest=await position(page,{outer:5400,top:1600,left:310,anonymousTop:1100,anonymousLeft:260});
    gate.release.resolve();await changedDocument(page);
    assert.deepEqual(await readPosition(page),latest,'replacement captures positions at response time');
    const version=await page.evaluate(field=>{const doc=document.querySelector('iframe').contentDocument;return field==='html'?doc.querySelector('#marker').textContent:doc.defaultView.getComputedStyle(doc.documentElement).getPropertyValue('--audit-head-version').trim();},field);
    assert.equal(version,field==='html'?'replacement':'2','new source is actually displayed');
  });

  for(const action of ['input','select','click','fold','refresh','width'])await test(`inner scroll survives ${action} with real runtime`,async t=>{
    const f=await createFixture(t),{page}=f;await position(page);await rememberFrame(page);
    const gate=f.hold(['refresh','width'].includes(action)?'document':'action');
    if(['refresh','width'].includes(action))await f.sourcePage().evaluate(()=>{document.querySelector('#result').textContent='source changed';});
    if(action==='input')await triggerInput(page);
    else await page.evaluate(action=>{
      const doc=document.querySelector('iframe').contentDocument;
      if(action==='select'){const select=doc.querySelector('#choose');select.value='b';select.dispatchEvent(new Event('change',{bubbles:true}));}
      if(action==='click')doc.querySelector('#update').click();
      if(action==='fold')doc.querySelector('#ordinary summary').click();
      if(action==='refresh')document.querySelector('[data-reading-document] button').click();
      if(action==='width')document.querySelector('#scroller').style.width='850px';
    },action);
    await entered(gate);await retainedFrame(page,action+' response pending');
    const latest=await position(page,{outer:5100,top:1500,left:330,anonymousTop:1000,anonymousLeft:280});
    gate.release.resolve();await changedDocument(page);
    assert.deepEqual(await readPosition(page),latest,action+' retains latest scroll in both axes, by id and source node id');
    if(action==='input')assert.equal(await page.evaluate(()=>document.querySelector('iframe').contentDocument.querySelector('#edit').value),'changed');
    if(action==='select')assert.equal(await page.evaluate(()=>document.querySelector('iframe').contentDocument.querySelector('#choose').value),'b');
    if(action==='fold')assert.equal(await page.evaluate(()=>document.querySelector('iframe').contentDocument.querySelector('#ordinary').open),true);
    if(action==='click')assert.equal(await page.evaluate(()=>document.querySelector('iframe').contentDocument.querySelector('#result').textContent),'clicked');
  });

  await test('delayed input response respects external focus and later scroll',async t=>{
    const f=await createFixture(t),{page}=f;await position(page);await rememberFrame(page);
    const gate=f.hold('action');await triggerInput(page);await entered(gate);
    await page.evaluate(()=>document.querySelector('#outside').focus({preventScroll:true}));
    const latest=await position(page,{outer:4300,top:1700,anonymousTop:1200});
    assert.equal(await page.evaluate(()=>document.activeElement.id),'outside','user moved focus before response');
    gate.release.resolve();await changedDocument(page);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'outside','response must not refocus the old input');
    assert.deepEqual(await readPosition(page),latest,'response keeps user scroll after request');
  });

  for(const kind of ['row','session'])await test(`${kind} switch clears old scroll/fold/focus and rejects delayed response`,async t=>{
    const f=await createFixture(t),{page}=f;
    await page.evaluate(()=>{document.querySelector('iframe').contentDocument.querySelector('[data-reading-local-fold]').open=true;});
    await position(page);const gate=f.hold('action');await triggerInput(page);await entered(gate);
    const sessionId=kind==='session'?'session-b':'session-a';
    const row=fixtureRow({id:kind==='row'?'message-b':'message-a',label:'new identity'});f.sessions.set(sessionId,[row]);
    await page.evaluate(({row,sessionId})=>{document.querySelector('#outside').focus({preventScroll:true});window.renderFrame({row,sessionId});},{row,sessionId});
    await page.waitForFunction(()=>document.querySelector('iframe')?.contentDocument?.querySelector('#marker')?.textContent==='new identity');await settle(page);
    const state=()=>page.evaluate(()=>{const doc=document.querySelector('iframe').contentDocument;return {label:doc.querySelector('#marker').textContent,value:doc.querySelector('#edit').value,top:doc.querySelector('#panel').scrollTop,left:doc.querySelector('#panel').scrollLeft,anonymousTop:doc.querySelector('[data-audit-scroll]').scrollTop,anonymousLeft:doc.querySelector('[data-audit-scroll]').scrollLeft,open:doc.querySelector('[data-reading-local-fold]').open,focus:document.activeElement.id};});
    const expected={label:'new identity',value:'baseline',top:0,left:0,anonymousTop:0,anonymousLeft:0,open:false,focus:'outside'};
    assert.deepEqual(await state(),expected,kind+' identity must not inherit old view state');
    gate.release.resolve();await idle(page);assert.deepEqual(await state(),expected,'late old response must not change the new identity');
  });
}finally{
  await browser.close();
  // This directory was created above solely for synthetic runtime localStorage.
  fs.rmSync(temporary,{recursive:true,force:true});
}
