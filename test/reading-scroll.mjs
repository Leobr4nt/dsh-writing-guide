import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';import {build} from 'esbuild';import {ReadingRuntime} from '../lib/reading-runtime.js';import {buildReading} from '../lib/reading.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'wg-reading-scroll-')),runtime=new ReadingRuntime(root);let browser;
const source=fs.readFileSync(process.env.WG_TEST_CLIENT??new URL('../client.js',import.meta.url),'utf8'),a=source.indexOf('    function ReadingFrame('),b=source.indexOf('    function WritingReadingView(',a);
const js=`import React,{useState,useRef,useEffect,useCallback}from'react';import{createRoot}from'react-dom/client';const h=React.createElement;const api=async(method,url,body)=>{const r=await fetch(url,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});const value=await r.json();if(!r.ok)throw Error(value.error||'fixture');return value;};${source.slice(a,b)}const root=createRoot(document.querySelector('#app'));window.renderRow=row=>root.render(h(ReadingContent,{row,sessionId:'s'}));`;
const bundle=await build({stdin:{contents:js,resolveDir:fileURLToPath(new URL('../',import.meta.url))},bundle:true,write:false,format:'iife',logLevel:'silent'});
const details='<details id="plain"><summary>Character thoughts</summary><div style="height:600px">THOUGHTS</div></details><details id="fold" data-writing-fold="draft"><summary>Draft</summary><div style="height:700px">DRAFT</div></details>';
const controls='<button id="settings">Settings</button><div id="panel" style="display:none;height:300px"><input id="edit" value="initial"><select id="select"><option value="a">A</option><option value="b">B</option></select><span id="echo"></span></div>';
const fixture='<html><body style="margin:0"><div style="height:5000px">START</div>'+details+controls+'<div style="height:7000px">END</div><script>document.querySelector("#settings").onclick=()=>{const panel=document.querySelector("#panel");panel.style.display=panel.style.display==="none"?"block":"none";};document.querySelector("#edit").oninput=e=>document.querySelector("#echo").textContent=e.target.value;</script></body></html>';
const interactive=(await buildReading({messages:[{id:'interactive',role:'assistant',content:fixture}],scripts:[]})).messages[0];
const staticRow=(await buildReading({messages:[{id:'static',role:'assistant',content:'<div style="height:5000px">START</div>'+details+'<div style="height:7000px">END</div>'}],scripts:[]})).messages[0];
let active=interactive,delayAction=0;
try{
 browser=await chromium.launch({executablePath:process.env.DSH_WRITING_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[],measurements=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://fixture.invalid/**',async route=>{const url=new URL(route.request().url());if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<style>html,body{margin:0}#scroll{height:700px;overflow:auto}#app{max-width:900px;margin:auto}</style><div id="scroll"><div style="height:1000px">PREVIOUS</div><div id="app"></div><div style="height:1500px">AFTER</div></div>'});try{const body=route.request().postDataJSON();if(url.pathname.endsWith('/action')&&delayAction)await new Promise(resolve=>setTimeout(resolve,delayAction));const value=url.pathname.endsWith('/action')?await runtime.act(body.sessionId,body.messageId,body.token,body.input):await runtime.render(body.sessionId,(active.parts??[active]).find(p=>p.id===body.messageId),body.width);await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});}catch{await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'美化页面已过期或操作未完成，请重新加载'})});}});
 await page.goto('https://fixture.invalid/');await page.addScriptTag({content:bundle.outputFiles[0].text});
 const frame=()=>page.frameLocator('iframe').first();
 const position=async selector=>{
  await page.evaluate(selector=>{const node=document.querySelector('iframe'),target=node.contentDocument.querySelector(selector),scroll=document.querySelector('#scroll'),y=scroll.style.overflow==='visible'?window.scrollY:scroll.scrollTop,delta=node.getBoundingClientRect().top+target.getBoundingClientRect().top-(scroll.style.overflow==='visible'?0:scroll.getBoundingClientRect().top)-180;if(scroll.style.overflow==='visible')window.scrollTo(0,y+delta);else scroll.scrollTop=y+delta;},selector);
  await page.waitForTimeout(100);
 };
 const scroll=()=>page.evaluate(()=>({outer:window.scrollY,inner:document.querySelector('#scroll').scrollTop}));
 const stable=async(label,action,selector='#plain summary')=>{await position(selector);const before=await scroll();await action();await page.waitForTimeout(500);const after=await scroll();const delta=Math.max(Math.abs(after.outer-before.outer),Math.abs(after.inner-before.inner));measurements.push({label,delta});assert.ok(delta<5,`${label} scroll jumped: ${JSON.stringify({before,after})}`);};
 for(const mode of ['nested','document']){
  await page.evaluate(mode=>{const scroll=document.querySelector('#scroll');scroll.style.height=mode==='document'?'auto':'700px';scroll.style.overflow=mode==='document'?'visible':'auto';scroll.scrollTop=0;window.scrollTo(0,0);},mode);
  for(const row of [staticRow,interactive]){
   active=row;await page.evaluate(row=>window.renderRow(row),row);await frame().locator('#plain summary').waitFor();await page.waitForFunction(()=>document.querySelector('iframe').clientHeight>11000);
   for(const selector of ['#plain summary','#fold summary']){
    await stable(mode+' '+row.id+' expand '+selector,()=>frame().locator(selector).click(),selector);
    await stable(mode+' '+row.id+' collapse '+selector,()=>frame().locator(selector).click(),selector);
   }
   if(row.interactive){
    await stable(mode+' settings open',()=>frame().locator('#settings').click(),'#settings');await frame().locator('#edit').waitFor({state:'visible'});
    await stable(mode+' input',()=>frame().locator('#edit').fill('updated'),'#edit');assert.equal(await frame().locator('#edit').inputValue(),'updated');
    await stable(mode+' select',()=>frame().locator('#select').selectOption('b'),'#select');
    await stable(mode+' settings close',()=>frame().locator('#settings').click(),'#settings');
    // Click refresh via the DOM without scrolling to the toolbar at the frame top.
    await stable(mode+' refresh',()=>page.getByRole('button',{name:'刷新',exact:true}).evaluate(n=>n.click()));
    await stable(mode+' delayed image/layout',()=>frame().locator('body').evaluate(body=>{const block=document.createElement('div');block.style.height='200px';block.textContent='LATE_CONTENT';body.append(block);}));
    // The user may keep scrolling while the source browser handles a click.
    delayAction=450;await position('#plain summary');await frame().locator('#plain summary').click();
    await page.evaluate(()=>{const scroller=document.querySelector('#scroll');if(scroller.style.overflow==='visible')window.scrollBy(0,650);else scroller.scrollTop+=650;});
    const moved=await scroll();await page.waitForTimeout(1000);assert.deepEqual(await scroll(),moved,mode+' cannot restore stale pre-request scroll');delayAction=0;
    await stable(mode+' narrow viewport',()=>page.setViewportSize({width:480,height:800}));await page.setViewportSize({width:1100,height:800});await page.waitForTimeout(500);
    const unchanged=await scroll();await page.evaluate(row=>window.renderRow(structuredClone(row)),row);await page.waitForTimeout(200);assert.deepEqual(await scroll(),unchanged,mode+' equal polling data cannot move the viewport');
    await stable(mode+' smooth-scroll ancestor',async()=>{await page.evaluate(()=>{document.documentElement.style.scrollBehavior='smooth';document.querySelector('#scroll').style.scrollBehavior='smooth';});await frame().locator('#plain summary').click();});
    await page.evaluate(()=>{document.documentElement.style.scrollBehavior='';document.querySelector('#scroll').style.scrollBehavior='';});
   }
  }
 }
 // Multi-part document: a refresh in one frame must not reset the containing scroller.
 active={id:'parts',parts:[{...staticRow,id:'first'},{...interactive,id:'second'}]};await page.evaluate(row=>window.renderRow(row),active);await page.frameLocator('iframe').nth(1).locator('#plain summary').waitFor();await page.waitForTimeout(500);
 await page.frameLocator('iframe').nth(1).locator('#plain summary').scrollIntoViewIfNeeded();const before=await scroll();await page.frameLocator('iframe').nth(1).locator('#plain summary').click();await page.waitForTimeout(500);const after=await scroll();assert.ok(Math.abs(after.outer-before.outer)<5,'later frame bridge toggle must preserve document scroll');
 active=interactive;await page.evaluate(row=>window.renderRow(row),active);await frame().locator('#plain summary').waitFor();await page.waitForTimeout(250);await position('#plain summary');
 // Five other source documents evict the visible frame from the four-entry runtime.
 for(let i=0;i<5;i++)await runtime.render('evict',{...interactive,id:'evict-'+i},900);
 const expiredScroll=await scroll(),expiredAnchor=await frame().locator('#plain summary').boundingBox();await frame().locator('#plain summary').click();await page.getByRole('alert').getByText('阅读页已重新加载，请再次操作。',{exact:true}).waitFor();await page.waitForTimeout(250);
 const recoveredAnchor=await frame().locator('#plain summary').boundingBox();assert.ok(Math.abs(recoveredAnchor.y-expiredAnchor.y)<5,'expired recovery keeps the visible paragraph anchored even when its notice adds height');assert.ok((await scroll()).outer>expiredScroll.outer-50,'expired-document recovery must not jump to the top');assert.equal(await frame().locator('#plain').evaluate(n=>n.open),false,'recovery does not replay a possibly effectful action');
 await frame().locator('#plain summary').click();await page.waitForFunction(()=>document.querySelector('iframe')?.contentDocument?.querySelector('#plain')?.open);
 assert.equal(errors.length,0,JSON.stringify(errors));console.log(JSON.stringify({realComponent:true,checks:measurements,multiFrame:true,expiredRecovery:true,errors:0}));
}finally{await browser?.close();await runtime.dispose();fs.rmSync(root,{recursive:true,force:true});}
