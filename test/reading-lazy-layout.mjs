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

// Generated fixtures only: no application server, browser profile, or user files.
const source=fs.readFileSync(process.env.WG_TEST_CLIENT??new URL('../client.js',import.meta.url),'utf8');
const start=source.indexOf('    function ReadingFrame('),end=source.indexOf('    function WritingReadingView(',start);
assert.ok(start>=0&&end>start,'extract actual ReadingFrame and ReadingContent');
const bundle=await build({stdin:{contents:`
import React,{useState,useRef,useEffect,useCallback}from'react';
import{createRoot}from'react-dom/client';const h=React.createElement;
window.apiPending=0;const api=async(...args)=>{window.apiPending++;try{return await window.syntheticApi(...args);}finally{window.apiPending--;}};
${source.slice(start,end)}
const root=createRoot(document.querySelector('#app'));
window.renderRow=row=>root.render(h(ReadingContent,{row,sessionId:'lazy-layout-synthetic'}));
`,resolveDir:fileURLToPath(new URL('../',import.meta.url))},bundle:true,write:false,format:'iife',logLevel:'silent'});
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'wg-lazy-layout-'));
const browser=await chromium.launch({executablePath:process.env.DSH_WRITING_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
console.log('reading-lazy-layout client SHA-256: '+createHash('sha256').update(source).digest('hex'));

function fixture(id,{heavy=false,repeatedIds=false,roots=false,interactive=true}={}){
  const buttons=Array.from({length:3},(_,index)=>`<section data-synthetic-item="${index}"><span class="synthetic-button" ${repeatedIds?'id="synthetic-repeated-button"':''} data-synthetic-button="${index}" tabindex="0">心声</span><div data-synthetic-content="${index}" style="height:300px;display:none">SYNTHETIC FOLD</div></section><div style="height:${index===2?3000:2300}px"></div>`).join('');
  // Body styles survive snapshot sanitization; source scripts do not. Many small
  // blocks interleaved with inert nodes make srcdoc parsing span animation frames.
  const padding=heavy?Array.from({length:48},(_,block)=>'<style>'+Array.from({length:700},(_,n)=>`.synthetic-unused-${block}-${n}{color:rgb(30,40,50);--padding:${n}}`).join('')+'</style>'+Array.from({length:180},()=>'<i class="synthetic-padding" hidden></i>').join('')+'<script>/*'+('synthetic-only;'.repeat(500))+'*/</script>').join(''):'';
  return {id,interactive,role:'assistant',
    head:'<style>body{margin:0;background:#181818;color:#eee}.synthetic-lazy{content-visibility:auto!important;contain-intrinsic-size:1100px}.synthetic-button{display:block;height:32px;line-height:32px;cursor:pointer}.synthetic-hidden{content-visibility:hidden;contain-intrinsic-size:0px}.synthetic-visible{content-visibility:visible}</style>',
    rootAttributes:roots?{style:'content-visibility:auto;contain-intrinsic-size:1100px'}:{},
    bodyAttributes:roots?{style:'content-visibility:auto;contain-intrinsic-size:1100px'}:{},
    html:'<div style="height:150px"></div>'+padding+'<div class="synthetic-lazy"><div style="height:1200px"></div>'+buttons+'</div><div class="synthetic-hidden">SYNTHETIC HIDDEN</div><div class="synthetic-visible"></div><div data-synthetic-end></div>'+(interactive?`<script>
      window.syntheticClicked=[];
      document.addEventListener('click',event=>{const button=event.target.closest('[data-synthetic-button]');if(!button)return;const index=Number(button.dataset.syntheticButton);window.syntheticClicked.push(index);const content=button.parentElement.querySelector('[data-synthetic-content]');content.style.display=content.style.display==='none'?'block':'none';});
    </script>`:'')};
}
async function settle(page){await page.waitForFunction(()=>window.apiPending===0);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))));}

async function createFixture(t,options={}){
  const runtime=new ReadingRuntime(path.join(temporary,createHash('sha256').update(t.name).digest('hex')));
  const context=await browser.newContext({viewport:{width:1100,height:900},serviceWorkers:'block'});
  const page=await context.newPage();page.setDefaultTimeout(15000);
  const rows=Array.from({length:options.frames??1},(_,index)=>fixture('synthetic-'+index,options));
  const errors=[],requests=[];let gate=null;
  page.on('pageerror',error=>errors.push(error.name));
  t.after(async()=>{gate?.release();await context.close();await runtime.dispose();assert.deepEqual(errors,[],'browser page errors');});
  await context.route('**/*',route=>route.abort());await context.routeWebSocket(/.*/,socket=>socket.close());
  await page.exposeFunction('syntheticApi',async(method,url,body)=>{
    if(url.endsWith('/action')){
      requests.push({messageId:body.messageId,nodeId:body.input.nodeId});
      const result=await runtime.act(body.sessionId,body.messageId,body.token,body.input);
      if(gate){gate.enter();await gate.wait;gate=null;}return result;
    }
    return runtime.render(body.sessionId,rows.find(row=>row.id===body.messageId),body.width);
  });
  await page.setContent('<!doctype html><style>body{margin:0}#host{width:950px;height:700px;overflow:auto}#app{width:920px}</style><div id="host"><div style="height:1000px"></div><div id="app"></div><div style="height:2000px"></div></div>');
  if(options.documentScroll)await page.evaluate(()=>{const host=document.querySelector('#host');host.style.height='auto';host.style.overflow='visible';});
  // Observe the real component without editing its code. takeRecords catches the
  // 1px measurement inside each synchronous RAF callback. No layout reads occur
  // while parsing: inspecting body.scrollHeight here could mask the lazy-layout bug.
  await page.evaluate(()=>{
    window.lazyTrace=[];window.partialParse=[];window.traceEnabled=false;
    const nativeRAF=window.requestAnimationFrame.bind(window);
    const observer=new MutationObserver(()=>{});observer.observe(document.querySelector('#app'),{subtree:true,attributes:true,attributeFilter:['style'],attributeOldValue:true});
    const state=frame=>{const doc=frame.contentDocument;return {document:doc,ready:doc?.readyState,children:doc?.body?.childElementCount??0,height:frame.style.height};};
    window.requestAnimationFrame=callback=>nativeRAF(time=>{
      const frames=[...document.querySelectorAll('iframe')],before=frames.map(state);
      callback(time);
      const measured=new Set(observer.takeRecords().filter(record=>record.target.tagName==='IFRAME'&&/(?:^|;)\s*height:\s*1px(?:;|$)/.test(record.oldValue??'')).map(record=>record.target));
      if(window.traceEnabled)for(const frame of measured){const prior=before[frames.indexOf(frame)],after=state(frame);window.lazyTrace.push({frame:frames.indexOf(frame),ready:prior?.ready,afterReady:after.ready,sameDocument:prior?.document===after.document,children:prior?.children,beforeHeight:prior?.height,afterHeight:after.height});}
    });
    const sample=()=>{if(window.traceEnabled)for(const [index,frame]of [...document.querySelectorAll('iframe')].entries()){const s=state(frame);if(s.ready==='loading')window.partialParse.push({frame:index,children:s.children,height:s.height});}nativeRAF(sample);};nativeRAF(sample);
  });
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  await page.evaluate(rows=>window.renderRow(rows.length===1?rows[0]:{id:'synthetic-parts',parts:rows}),rows);
  await page.waitForFunction(count=>document.querySelectorAll('iframe').length===count&&[...document.querySelectorAll('iframe')].every(frame=>frame.contentDocument?.querySelector('[data-synthetic-end]')&&frame.clientHeight>8000)&&window.apiPending===0,rows.length);
  await settle(page);
  if(options.heavy){const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});}
  return {page,rows,requests,runtime,
    sourcePage(index=rows.length-1){return runtime.entries.get(createHash('sha256').update('lazy-layout-synthetic|'+rows[index].id).digest('hex')).page;},
    hold(){let release,enter;const wait=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{enter=resolve;});gate={wait,release,enter};return {release,entered};},
  };
}
async function position(page,frameIndex,buttonIndex){
  await page.evaluate(({frameIndex,buttonIndex})=>{
    const frame=document.querySelectorAll('iframe')[frameIndex],target=frame.contentDocument.querySelectorAll('.synthetic-button')[buttonIndex],host=document.querySelector('#host');
    const delta=frame.getBoundingClientRect().top+target.getBoundingClientRect().top-342;
    if(host.style.overflow==='visible')window.scrollTo(0,window.scrollY+delta);else host.scrollTop+=delta;
  },{frameIndex,buttonIndex});await settle(page);
}
async function read(page,frameIndex,buttonIndex){return page.evaluate(({frameIndex,buttonIndex})=>{
  const frame=document.querySelectorAll('iframe')[frameIndex],doc=frame.contentDocument,target=doc.querySelectorAll('.synthetic-button')[buttonIndex];
  return {outer:window.scrollY,host:document.querySelector('#host').scrollTop,inner:doc.scrollingElement.scrollTop,height:frame.clientHeight,bodyHeight:doc.body.scrollHeight,targetY:frame.getBoundingClientRect().top+target.getBoundingClientRect().top,nodeId:target.dataset.readingNode,open:[...doc.querySelectorAll('[data-synthetic-content]')].map(node=>getComputedStyle(node).display!=='none'),visibility:getComputedStyle(doc.querySelector('.synthetic-lazy')).contentVisibility};
},{frameIndex,buttonIndex});}
async function sourceState(f,frameIndex){return f.sourcePage(frameIndex).evaluate(()=>({auto:getComputedStyle(document.querySelector('.synthetic-lazy')).contentVisibility,inline:document.querySelector('.synthetic-lazy').style.getPropertyValue('content-visibility'),root:getComputedStyle(document.documentElement).contentVisibility,body:getComputedStyle(document.body).contentVisibility,clicked:window.syntheticClicked,open:[...document.querySelectorAll('[data-synthetic-content]')].map(node=>getComputedStyle(node).display!=='none')}));}
async function exercise(f,{sequence=[0,1,2,2,1,0,2],delay=false}={}){
  const {page,rows}=f,frameIndex=rows.length-1,expected=[false,false,false],measurements=[];
  const unchanged=rows.length>1?await read(page,0,0):null;
  const sourceStyles=await f.sourcePage().evaluate(()=>[...document.querySelectorAll('style')].map(n=>n.textContent));
  for(const buttonIndex of sequence){
    await position(page,frameIndex,buttonIndex);let before=await read(page,frameIndex,buttonIndex);
    await page.evaluate(()=>{window.traceEnabled=true;});
    const gate=delay?f.hold():null;
    const requestIndex=f.requests.length;
    await page.frameLocator('iframe').nth(frameIndex).locator('.synthetic-button').nth(buttonIndex).click();
    if(gate){await gate.entered;await page.evaluate(()=>{document.querySelector('#host').scrollTop+=180;});before=await read(page,frameIndex,buttonIndex);gate.release();}
    expected[buttonIndex]=!expected[buttonIndex];
    await settle(page);
    await page.waitForFunction(({frameIndex,expected})=>{const doc=document.querySelectorAll('iframe')[frameIndex]?.contentDocument;return window.apiPending===0&&doc?.readyState==='complete'&&[...doc.querySelectorAll('[data-synthetic-content]')].map(n=>getComputedStyle(n).display!=='none').join()===expected.join();},{frameIndex,expected});
    await settle(page);const after=await read(page,frameIndex,buttonIndex),actualSource=await sourceState(f,frameIndex);
    assert.equal(f.requests.length,requestIndex+1,'exactly one bridged action');assert.equal(f.requests[requestIndex].nodeId,before.nodeId,'clicked the selected same-name node');assert.equal(f.requests[requestIndex].messageId,rows[frameIndex].id,'clicked the selected frame');
    assert.equal(actualSource.clicked.at(-1),buttonIndex);assert.deepEqual(actualSource.open,expected);assert.deepEqual(after.open,expected);
    assert.equal(actualSource.auto,'auto','source lazy-layout declaration is unchanged');assert.equal(actualSource.inline,'','projection override never leaks into source');
    assert.equal(after.visibility,'visible');assert.equal(after.inner,0);assert.ok(after.height>=after.bodyHeight,'full document fits iframe');
    const scrollDelta=Math.max(Math.abs(after.outer-before.outer),Math.abs(after.host-before.host)),screenDelta=Math.abs(after.targetY-before.targetY);
    measurements.push({buttonIndex,open:expected[buttonIndex],scrollDelta,screenDelta,beforeHeight:before.height,afterHeight:after.height,nodeId:after.nodeId});
    assert.ok(scrollDelta<5&&screenDelta<5,JSON.stringify(measurements.at(-1)));
  }
  assert.deepEqual(await f.sourcePage().evaluate(()=>[...document.querySelectorAll('style')].map(n=>n.textContent)),sourceStyles,'source stylesheets stay byte-for-byte unchanged');
  if(unchanged){const after=await read(page,0,0);assert.deepEqual(after.open,unchanged.open);assert.equal(after.height,unchanged.height);assert.deepEqual((await sourceState(f,0)).clicked,[]);}
  const traces=await page.evaluate(()=>({measure:window.lazyTrace,partial:window.partialParse}));
  assert.ok(traces.measure.length>0,'observed actual 1px measurements');
  assert.deepEqual(traces.measure.filter(item=>item.ready!=='complete'||item.afterReady!=='complete'||!item.sameDocument),[],'no old callback measures a partially parsed or replaced document');
  console.log(JSON.stringify({checks:measurements,measurements:traces.measure.length,partialParseSamples:traces.partial.length,partialParse:traces.partial.slice(0,8),sizeTrace:traces.measure.slice(-8)}));
  return traces;
}

try{
  await test('lazy long text: three same-name span buttons open forward, close backward, reopen last',async t=>{const f=await createFixture(t);await exercise(f);});
  await test('document scroll and auto on root/body preserve the clicked anchor',async t=>{
    const f=await createFixture(t,{roots:true,documentScroll:true});await exercise(f);
    const src=await sourceState(f,0);assert.equal(src.root,'auto');assert.equal(src.body,'auto');
    assert.deepEqual(await f.page.frameLocator('iframe').locator('body').evaluate(body=>[getComputedStyle(body.ownerDocument.documentElement).contentVisibility,getComputedStyle(body).contentVisibility,getComputedStyle(body.querySelector('.synthetic-hidden')).contentVisibility,getComputedStyle(body.querySelector('.synthetic-visible')).contentVisibility]),['visible','visible','hidden','visible']);
  });
  await test('two iframes and repeated button HTML ids still select only the intended node',async t=>{const f=await createFixture(t,{frames:2,repeatedIds:true});await exercise(f);});
  await test('large body styles/scripts expose partial parsing without measuring the partial document',async t=>{
    const f=await createFixture(t,{heavy:true});const trace=await exercise(f,{sequence:[1,1]});assert.ok(trace.partial.length>0,'fixture must actually expose loading-state srcdoc');
  });
  await test('waiting for the source response does not lock subsequent user scrolling',async t=>{const f=await createFixture(t);await exercise(f,{sequence:[1],delay:true});});
}finally{
  await browser.close();fs.rmSync(temporary,{recursive:true,force:true});
}
