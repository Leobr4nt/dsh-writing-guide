import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {chromium} from 'playwright-core';
import {build} from 'esbuild';

// Real production components; only synthetic text and metadata, no user files.
const source=fs.readFileSync(process.env.WG_TEST_CLIENT??new URL('../client.js',import.meta.url),'utf8');
const start=source.indexOf('    function ReadingFrame('),end=source.indexOf('    function RuntimeSurface(',start);
assert.ok(start>=0&&end>start);
const harness=`import React,{useState,useRef,useEffect,useCallback}from'react';import{createRoot}from'react-dom/client';
const h=React.createElement,RuntimeSurface=()=>null;window.pending=0;
const api=async(...args)=>{window.pending++;try{return await window.syntheticApi(...args);}finally{window.pending--;}};
const intervals=new Map();let next=0;const setInterval=fn=>{intervals.set(++next,fn);return next;};const clearInterval=id=>intervals.delete(id);
window.pollReading=()=>{for(const fn of intervals.values())void fn();};
${source.slice(start,end)}
let root=createRoot(document.querySelector('#app'));
window.openReading=(sessionId='a',running=false)=>root.render(h(WritingReadingView,{sessionId,useProjection:()=> 'writer',useSession:fn=>fn({running})}));
window.closeReading=()=>{root.unmount();root=createRoot(document.querySelector('#app'));};`;
const bundle=await build({stdin:{contents:harness,resolveDir:fileURLToPath(new URL('../',import.meta.url))},bundle:true,write:false,format:'iife',logLevel:'silent'});
const browser=await chromium.launch({executablePath:process.env.DSH_WRITING_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const storageKey=id=>'dsh-writing-guide:reading-position:'+id;
const row=(id,height,interactive=false)=>({id,role:'assistant',interactive,html:`<div data-fixture="${id}" style="height:${height}px">SYNTHETIC</div>`,original:'SYNTHETIC'});
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}
async function settle(page){await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(done)))));}
async function position(page){return page.evaluate(()=>{const s=document.querySelector('[data-conversation-scroll]')??document.scrollingElement;return {top:s.scrollTop,max:s.scrollHeight-s.clientHeight};});}
async function go(page,top){
  // Real browser input distinguishes a reader gesture from focus/layout scrolls.
  await page.mouse.move(300,250);await page.mouse.wheel(0,-1);await settle(page);
  await page.evaluate(top=>{const s=document.querySelector('[data-conversation-scroll]')??document.scrollingElement;s.scrollTo({top,behavior:'instant'});},top);await settle(page);
}
async function loaded(page,count){
  await page.waitForFunction(count=>window.pending===0&&document.querySelectorAll('iframe').length===count&&[...document.querySelectorAll('iframe')].every(f=>f.contentDocument?.querySelector('[data-fixture]')&&f.clientHeight>1000),count);
  await settle(page);
}
async function bottom(page){
  // Focus with scroll-behavior:smooth may start moving only on the next frame.
  // Require a stable landing, not a one-frame visit to the bottom.
  await page.evaluate(()=>new Promise((resolve,reject)=>{
    let stable=0,previousMax=-1;const start=performance.now();
    const sample=()=>{const s=document.querySelector('[data-conversation-scroll]')??document.scrollingElement,max=s.scrollHeight-s.clientHeight,gap=max-s.scrollTop;
      stable=Math.abs(gap)<3&&max===previousMax?stable+1:0;previousMax=max;
      if(stable>=6)return resolve();if(performance.now()-start>6000)return reject(Error('Bottom did not settle: '+JSON.stringify({top:s.scrollTop,max,gap})));
      requestAnimationFrame(sample);
    };requestAnimationFrame(sample);
  }));
}
async function fixture(t,{mode='nested',rows=[row('one',3500),row('two',6500,true)],saved,hold,fail=false,storageBlocked=false}={}){
  const context=await browser.newContext({viewport:{width:1100,height:800}}),page=await context.newPage(),errors=[];
  page.setDefaultTimeout(6000);page.on('pageerror',e=>errors.push(e.message));
  const sessions=new Map([['a',rows],['b',[row('other',12000)]]]),gate=deferred(),entered=deferred();let held=false;
  t.after(async()=>{gate.resolve();await context.close();assert.deepEqual(errors,[],'no page errors');});
  await page.exposeFunction('syntheticApi',async(method,url,body)=>{
    const session=method==='GET'?new URL(url,'https://fixture.invalid').searchParams.get('sessionId'):body.sessionId;
    if(hold&&!held&&(hold==='get'?method==='GET':body?.messageId===hold)){held=true;entered.resolve();await gate.promise;}
    if(method==='GET')return {messages:structuredClone(sessions.get(session)??[])};
    if(fail)throw Error('Synthetic render failed');
    const current=(sessions.get(session)??[]).flatMap(r=>r.parts??[r]).find(r=>r.id===body.messageId);
    return {token:'synthetic',document:'<!doctype html><style>body{margin:0}</style>'+current.html};
  });
  // Host layout follows ConversationContent/DefaultConversationViews and the
  // renderer's display:contents slot anchors, not just a plain scrolling div.
  const host=mode==='host',nested=mode!=='document';
  await page.route('https://fixture.invalid/**',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><style>html,body{margin:0;scroll-behavior:smooth}#scroller{height:650px;overflow:auto;scroll-behavior:smooth}#composer{height:100px;position:sticky;bottom:0;background:white}${host?'#host{display:flex;flex-direction:column;height:700px}#scroller{display:flex;flex-direction:column;flex:1;min-height:0;scrollbar-gutter:stable}[data-slot],#app{display:contents}#view{display:flex;flex-direction:column;flex:1 0 auto;min-height:auto}#composer{flex:none;margin-top:auto;overflow-anchor:none}':''}</style>${host?'<div id="host" data-conversation-content><header style="height:50px;flex:none">SYNTHETIC HEADER</header>':''}${nested?'<div id="scroller" data-conversation-scroll>':''}${host?'<div data-slot="conversation.session"><div id="view">':''}<div id="app" data-slot="conversation.view"></div>${host?'</div></div>':''}<div id="composer" data-composer-seat><input aria-label="Composer"></div>${nested?'</div>':''}${host?'</div>':''}`}));
  await page.goto('https://fixture.invalid/');
  if(saved!==undefined)await page.evaluate(({key,saved})=>localStorage.setItem(key,typeof saved==='string'?saved:JSON.stringify(saved)),{key:storageKey('a'),saved});
  if(storageBlocked)await page.evaluate(()=>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Synthetic blocked storage','SecurityError');}}));
  const boot=async()=>{await page.addScriptTag({content:bundle.outputFiles[0].text});await page.evaluate(()=>window.openReading());};
  await boot();return {page,sessions,gate,entered,boot};
}

try{
  for(const mode of ['nested','document','host'])await test(`opens ${mode} at bottom on every reentry, ignoring saved coordinates`,async t=>{
    const {page}=await fixture(t,{mode,saved:{top:0,left:0}});await loaded(page,2);await bottom(page);
    await go(page,1800);await page.evaluate(()=>window.closeReading());await page.evaluate(()=>window.openReading());await loaded(page,2);
    await bottom(page);
    await go(page,0);await page.evaluate(()=>window.closeReading());await page.evaluate(()=>window.openReading());await loaded(page,2);
    await bottom(page);
    const saved=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),storageKey('a'));
    assert.deepEqual(saved,{top:0,left:0},'old coordinates are no longer read or written');
  });
  await test('A/B/A session switching always opens latest content without remounting the view',async t=>{
    const {page}=await fixture(t);await loaded(page,2);await go(page,2100);
    await page.evaluate(()=>window.openReading('b'));await loaded(page,1);await bottom(page);
    await go(page,4200);await page.evaluate(()=>window.openReading('a'));await loaded(page,2);await bottom(page);
    await page.evaluate(()=>window.openReading('b'));await loaded(page,1);await bottom(page);
  });
  await test('page reload opens latest content without restoring old coordinates',async t=>{
    const {page,boot}=await fixture(t);await loaded(page,2);await go(page,2700);
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await page.reload();await boot();await loaded(page,2);await bottom(page);
  });
  await test('opening follows delayed multi-part interactive frame geometry',async t=>{
    const rows=[row('one',3000),{id:'parts',role:'assistant',parts:[row('part-a',2000),row('part-b',7000,true)]}];
    const {page,entered,gate}=await fixture(t,{rows,saved:{top:9000,left:0},hold:'part-b'});
    await entered.promise;await settle(page);assert.ok((await position(page)).max<9000);
    gate.resolve();await loaded(page,3);await bottom(page);assert.ok((await position(page)).top>10000);
  });
  await test('manual scrolling inside a frame cancels following until next entry',async t=>{
    const {page,entered,gate}=await fixture(t,{rows:[row('one',7000),row('two',6000,true)],saved:{top:10000,left:0},hold:'two'});
    await entered.promise;await page.waitForFunction(()=>document.querySelector('iframe')?.clientHeight>6000);await settle(page);
    assert.equal(await page.evaluate(()=>document.elementFromPoint(300,250)?.tagName),'IFRAME','gesture starts inside the loaded frame');
    await go(page,1200);gate.resolve();await loaded(page,2);assert.equal((await position(page)).top,1200,'late response respects manual reading');
    await page.evaluate(()=>window.closeReading());await page.evaluate(()=>window.openReading());await loaded(page,2);await bottom(page);
  });
  await test('polling, new responses and running transitions preserve current reading',async t=>{
    const {page,sessions}=await fixture(t);await loaded(page,2);await go(page,1500);
    await page.evaluate(()=>window.pollReading());await loaded(page,2);assert.equal((await position(page)).top,1500);
    await page.evaluate(()=>window.openReading('a',true));await loaded(page,2);assert.equal((await position(page)).top,1500);
    sessions.get('a').push(row('third',3000));await page.evaluate(()=>window.openReading('a',false));await loaded(page,3);assert.equal((await position(page)).top,1500);
  });
  await test('failed frame and shortened history finish at the available boundary',async t=>{
    const {page}=await fixture(t,{saved:{top:20000,left:0},fail:true});
    await page.getByRole('alert').waitFor();await settle(page);const p=await position(page);assert.ok(Math.abs(p.top-p.max)<3);
    await go(page,800);await page.evaluate(()=>window.pollReading());await settle(page);assert.equal((await position(page)).top,800);
  });
  await test('invalid persisted state falls back to latest content',async t=>{
    const {page}=await fixture(t,{saved:'invalid json'});await loaded(page,2);const p=await position(page);assert.ok(Math.abs(p.top-p.max)<3);
  });
  await test('leaving before history arrives does not affect the next opening',async t=>{
    const {page,entered,gate}=await fixture(t,{saved:{top:3400,left:0},hold:'get'});
    await entered.promise;await page.evaluate(()=>window.closeReading());
    assert.equal(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).top,storageKey('a')),3400);
    gate.resolve();await page.evaluate(()=>window.openReading());await loaded(page,2);await bottom(page);
  });
  await test('unavailable browser storage does not break reading or manual scrolling',async t=>{
    const {page}=await fixture(t,{storageBlocked:true});await loaded(page,2);const p=await position(page);assert.ok(Math.abs(p.top-p.max)<3);
    await go(page,600);await page.evaluate(()=>window.pollReading());await loaded(page,2);assert.equal((await position(page)).top,600);
    await page.evaluate(()=>window.closeReading());
  });
  for(const mode of ['nested','document'])await test(`late layout ${mode}: follow repeated growth, shrink and delayed composer sizing`,async t=>{
    const {page}=await fixture(t,{mode});await loaded(page,2);await bottom(page);
    // These changes happen after every iframe reported its first complete layout.
    // The previous all-frames-ready cutoff left the viewport above the real end.
    for(const height of [8500,10000,4500,11500]){
      await page.frameLocator('iframe').nth(1).locator('[data-fixture]').evaluate((el,height)=>el.style.height=height+'px',height);
      await page.waitForFunction(height=>document.querySelectorAll('iframe')[1].clientHeight===height+2,height);
      await bottom(page);
    }
    await page.locator('#composer').evaluate(el=>el.style.height='260px');await bottom(page);
    await page.setViewportSize({width:900,height:600});await bottom(page);
    // A manual scroll ends following even if there are later image/layout changes.
    await go(page,1800);await page.frameLocator('iframe').nth(1).locator('[data-fixture]').evaluate(el=>el.style.height='13000px');
    await page.waitForFunction(()=>document.querySelectorAll('iframe')[1].clientHeight===13002);await settle(page);
    assert.equal((await position(page)).top,1800,'late layout must not override a reader who has scrolled away');
  });
  await test('height clamping while another frame loads does not count as user scrolling',async t=>{
    const {page,entered,gate}=await fixture(t,{rows:[row('one',7000),row('two',6000,true)],hold:'two'});
    await entered.promise;await page.waitForFunction(()=>document.querySelector('iframe')?.clientHeight>6000);await bottom(page);
    await page.frameLocator('iframe').locator('[data-fixture]').evaluate(el=>el.style.height='1200px');
    await page.waitForFunction(()=>document.querySelector('iframe').clientHeight<2000);await bottom(page);
    gate.resolve();await loaded(page,2);await bottom(page);
  });
  await test('automatic host scrolling cannot cancel following during loading',async t=>{
    const {page,entered,gate}=await fixture(t,{rows:[row('one',7000),row('two',6000,true)],hold:'two'});
    await entered.promise;await page.waitForFunction(()=>document.querySelector('iframe')?.clientHeight>6000);await bottom(page);
    // A browser/host scroll is not evidence of a reader gesture. Keep the scroll
    // range unchanged so coordinate heuristics cannot explain away this case.
    for(let i=0;i<4;i++){
      await settle(page);await page.evaluate(()=>document.querySelector('[data-conversation-scroll]').scrollTop=0);await settle(page);await bottom(page);
    }
    gate.resolve();await loaded(page,2);await bottom(page);
  });
  for(const mode of ['nested','document','host'])await test(`automatic focus scrolling ${mode} after loading cannot cancel following`,async t=>{
    const {page}=await fixture(t,{mode});await loaded(page,2);await bottom(page);
    await page.evaluate(()=>document.querySelector('[data-writing-reading] button').focus());
    await bottom(page);
    await page.frameLocator('iframe').nth(1).locator('[data-fixture]').evaluate(el=>el.style.height='11000px');
    await page.waitForFunction(()=>document.querySelectorAll('iframe')[1].clientHeight===11002);await bottom(page);
  });
  await test('synthetic input events cannot impersonate a reader gesture',async t=>{
    const {page}=await fixture(t);await loaded(page,2);await bottom(page);
    await page.evaluate(()=>{const s=document.querySelector('[data-conversation-scroll]');s.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true}));s.scrollTop=0;});
    await bottom(page);
    await page.frameLocator('iframe').nth(1).locator('body').evaluate(el=>el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})));
    await page.evaluate(()=>document.querySelector('[data-conversation-scroll]').scrollTop=0);await bottom(page);
  });
  await test('a real keyboard gesture hands control to the reader',async t=>{
    const {page}=await fixture(t);await loaded(page,2);await bottom(page);
    await page.locator('[data-conversation-scroll]').evaluate(el=>{el.tabIndex=0;el.focus({preventScroll:true});});
    await page.keyboard.press('Home');await page.waitForFunction(()=>document.querySelector('[data-conversation-scroll]').scrollTop===0);
    await page.frameLocator('iframe').nth(1).locator('[data-fixture]').evaluate(el=>el.style.height='11000px');
    await page.waitForFunction(()=>document.querySelectorAll('iframe')[1].clientHeight===11002);await settle(page);assert.equal((await position(page)).top,0);
  });
  await test('a real click inside the iframe hands control to the reader',async t=>{
    const {page}=await fixture(t);await loaded(page,2);await bottom(page);
    assert.equal(await page.evaluate(()=>document.elementFromPoint(300,250)?.tagName),'IFRAME');
    await page.mouse.click(300,250);
    await page.evaluate(()=>document.querySelector('[data-conversation-scroll]').scrollTo({top:1700,behavior:'instant'}));await settle(page);
    assert.equal((await position(page)).top,1700,'trusted iframe input must stop following before later layout');
    await page.frameLocator('iframe').nth(1).locator('[data-fixture]').evaluate(el=>el.style.height='11000px');
    await page.waitForFunction(()=>document.querySelectorAll('iframe')[1].clientHeight===11002);await settle(page);assert.equal((await position(page)).top,1700);
  });
}finally{await browser.close();}
