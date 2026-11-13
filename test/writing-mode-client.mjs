import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {fileURLToPath} from 'node:url';import {build} from 'esbuild';import {chromium} from 'playwright-core';
const source=await fs.readFile(new URL('../client.js',import.meta.url),'utf8');
const start=source.indexOf('    function WritingSessionPanel('),end=source.indexOf('    function RuntimeSurface(',start);assert.ok(start>=0&&end>start);
const harness=`import React,{useState,useRef,useEffect,useCallback}from'react';import{createRoot}from'react-dom/client';const h=React.createElement,RuntimeSurface=()=>null;
const callbacks=new Map();let serial=0;const setInterval=fn=>{callbacks.set(++serial,fn);return serial;},clearInterval=id=>callbacks.delete(id);
const api=(...args)=>window.fixtureApi(...args);window.poll=()=>{for(const fn of callbacks.values())void fn();};
${source.slice(start,end)}
const root=createRoot(document.querySelector('#app'));window.renderMode=(preset='standard',sessionId='s')=>root.render(h(React.Fragment,{},h(WritingSessionPanel,{sessionId,useProjection:()=>preset}),h(WritingReadingView,{sessionId,useProjection:()=>preset,useSession:fn=>fn({running:false})})));`;
const bundle=await build({stdin:{contents:harness,resolveDir:fileURLToPath(new URL('../',import.meta.url))},bundle:true,write:false,format:'iife',logLevel:'silent'});
const browser=await chromium.launch({executablePath:process.env.DSH_WRITING_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 let eligible=false,pending=0,gate=null;const waiting=[];
 await page.exposeFunction('fixtureApi',async(method,url)=>{
  pending++;const snapshot=eligible;try{
   if(gate){const block=gate;waiting.push(url);await block;}
   if(url.startsWith('/session-panel'))return {writer:snapshot,writingEnabled:true,model:'SYNTHETIC_MODEL',provider:'fixture',residentEnabled:true,active:true,buttons:[{scriptId:'script',name:'SYNTHETIC_BUTTON'}]};
   assert.ok(url.startsWith('/reading?'));
   return {writer:snapshot,messages:snapshot?[{id:'m',role:'assistant',original:'SYNTHETIC',html:'<div style="height:6000px">SYNTHETIC</div>'}]:[]};
  }finally{pending--;}
 });
 await page.route('**/*',route=>route.abort());await page.setContent('<div data-conversation-scroll style="height:650px;overflow:auto"><div id="app"></div></div>');
 await page.addScriptTag({content:bundle.outputFiles[0].text});await page.evaluate(()=>window.renderMode());
 await page.getByText(/当前模式未启用完整写作流程/).waitFor();assert.equal(await page.locator('[data-writing-panel]').count(),0);
 eligible=true;await page.evaluate(()=>window.dispatchEvent(new Event('writing-guide-modes-changed')));
 await page.getByText('写作模型：SYNTHETIC_MODEL',{exact:true}).waitFor();await page.getByRole('button',{name:'SYNTHETIC_BUTTON',exact:true}).waitFor();
 await page.waitForFunction(()=>document.querySelector('iframe')?.clientHeight>6000);
 await page.waitForFunction(()=>{const s=document.querySelector('[data-conversation-scroll]');return Math.abs(s.scrollHeight-s.clientHeight-s.scrollTop)<3;});
 eligible=false;await page.evaluate(()=>window.dispatchEvent(new Event('writing-guide-modes-changed')));
 await page.getByText(/当前模式未启用完整写作流程/).waitFor();assert.equal(await page.locator('[data-writing-panel]').count(),0);assert.equal(await page.locator('iframe').count(),0);
 // Old responses must not resurrect UI after a settings save or a mode switch.
 for(const change of ['settings','mode']){
  eligible=true;await page.evaluate(()=>window.dispatchEvent(new Event('writing-guide-modes-changed')));await page.getByText('写作模型：SYNTHETIC_MODEL',{exact:true}).waitFor();
  let release;waiting.length=0;gate=new Promise(done=>release=done);await page.evaluate(()=>window.poll());
  for(let i=0;i<100&&waiting.length<2;i++)await new Promise(done=>setTimeout(done,10));assert.ok(waiting.length>=2);
  gate=null;eligible=false;await page.evaluate(change=>change==='settings'?window.dispatchEvent(new Event('writing-guide-modes-changed')):window.renderMode('custom'),change);
  await page.getByText(/当前模式未启用完整写作流程/).waitFor();release();
  for(let i=0;i<100&&pending;i++)await new Promise(done=>setTimeout(done,10));
  await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  assert.equal(await page.locator('iframe').count(),0);assert.equal(await page.locator('[data-writing-panel]').count(),0);
 }
 assert.deepEqual(errors,[]);console.log('writing-mode-client: selected custom mode panel/reading, immediate toggle, bottom landing and stale-response isolation passed');
}finally{await browser.close();}
