import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';import {build} from 'esbuild';
import {buildReading} from '../lib/reading.js';import {ReadingRuntime} from '../lib/reading-runtime.js';import {protectReadingFolds} from '../lib/reading-folds.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'wg-fold-client-')),runtime=new ReadingRuntime(root);let browser;
const source=fs.readFileSync(new URL('../client.js',import.meta.url),'utf8'),a=source.indexOf('    function ReadingFrame('),b=source.indexOf('    function WritingReadingView(',a);
const component=`import React,{useState,useRef,useEffect,useCallback} from'react';import{createRoot}from'react-dom/client';const h=React.createElement;const api=async(method,url,body)=>{const r=await fetch(url,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error('fixture');return r.json();};${source.slice(a,b)}const root=createRoot(document.querySelector('#app'));window.renderRow=row=>root.render(h(ReadingContent,{row,sessionId:'fixture'}));`;
const bundle=await build({stdin:{contents:component,resolveDir:fileURLToPath(new URL('../',import.meta.url))},bundle:true,write:false,format:'iife',logLevel:'silent'});
const rules=[
 {id:'covenant',findRegex:'/<writing_covenant>([\\s\\S]*?)<\\/writing_covenant>/gi',replaceString:'\n<details data-writing-fold="writing_covenant"><summary>Covenant</summary><div>\n\n$1\n\n</div></details>\n',placement:[2],markdownOnly:true},
 {id:'draft',findRegex:'/<draft>([\\s\\S]*?)<\\/draft>/gi',replaceString:'\n<details data-writing-fold="draft"><summary>Draft</summary><div>\n\n$1\n\n</div></details>\n',placement:[2],markdownOnly:true},
];
// A frontend like the reported one flattens source DOM before rebuilding styled paragraphs.
const fixture='<html><head><style>body{margin:0}#source{display:none}</style></head><body><div id="source">OUTSIDE_BEFORE\n<draft>DRAFT_BODY\n<writing_covenant>COVENANT_BODY</writing_covenant>\nDRAFT_END</draft>\nOUTSIDE_AFTER</div><button id="render-again">Reformat</button><div id="output"></div><details id="authored"><summary>Authored</summary>AUTHORED_BODY</details><script>const source=document.querySelector("#source").textContent;document.querySelector("#source").remove();function render(){const output=document.querySelector("#output");output.replaceChildren();for(const line of source.split(/\\n+/)){const p=document.createElement("p");p.textContent=line;output.append(p);}}render();document.querySelector("#render-again").onclick=render;</script></body></html>';
const original=[{id:'m',role:'assistant',content:fixture}],row=(await buildReading({messages:original,scripts:rules})).messages[0];let active=row;
try{
  assert.equal(original[0].content,fixture);
  const protectedHtml=protectReadingFolds('<details><summary>ordinary</summary>keep</details><pre><details data-writing-fold="draft">CODE_SAMPLE</details></pre><details data-writing-fold="draft"><summary>Draft</summary><script>window.bad=1</script><div onclick="bad()">SAFE</div></details>');
  assert.equal(protectedHtml.folds.length,1);assert.match(protectedHtml.html,/CODE_SAMPLE/);assert.match(protectedHtml.html,/ordinary/);assert.doesNotMatch(protectedHtml.folds[0].html,/<script|onclick=/);
  const malformed='<details data-writing-fold="draft"><summary>Outer</summary><details><summary>Inner</summary>INNER</details>AFTER';
  assert.equal(protectReadingFolds(malformed).html,malformed);assert.equal(protectReadingFolds(malformed).folds.length,0,'an inner close cannot prove that the outer fold is closed');
  browser=await chromium.launch({executablePath:process.env.DSH_WRITING_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});const page=await browser.newPage({viewport:{width:1000,height:900}}),calls=[],errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://fixture.invalid/**',async route=>{
    const url=new URL(route.request().url());if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<style>#app{max-width:900px}</style><div id="app"></div>'});
    try{const body=route.request().postDataJSON();calls.push({path:url.pathname,input:body.input});const result=url.pathname.endsWith('/action')?await runtime.act(body.sessionId,body.messageId,body.token,body.input):await runtime.render(body.sessionId,active,body.width);await route.fulfill({contentType:'application/json',body:JSON.stringify(result)});}catch{await route.fulfill({status:500,contentType:'application/json',body:'{}'});}
  });
  await page.goto('https://fixture.invalid/');await page.addScriptTag({content:bundle.outputFiles[0].text});await page.evaluate(row=>window.renderRow(row),row);
  const frame=page.frameLocator('iframe'),draft=frame.locator('#output details[data-writing-fold="draft"]'),covenant=draft.locator('details[data-writing-fold="writing_covenant"]');
  await draft.locator(':scope > summary').waitFor();assert.equal(await draft.evaluate(n=>n.open),false);assert.equal(await covenant.evaluate(n=>n.open),false);
  assert.equal(await frame.getByText('DRAFT_BODY',{exact:false}).isVisible(),false);assert.equal(await frame.getByText('COVENANT_BODY',{exact:true}).isVisible(),false);
  const beforeActions=calls.filter(c=>c.path.endsWith('/action')).length;
  await draft.locator(':scope > summary').click();await page.waitForFunction(()=>document.querySelector('iframe')?.contentDocument?.querySelector('#output details')?.open);
  assert.equal(await frame.getByText('DRAFT_BODY',{exact:false}).isVisible(),true);assert.equal(await frame.getByText('COVENANT_BODY',{exact:true}).isVisible(),false);
  await covenant.locator(':scope > summary').click();assert.equal(await frame.getByText('COVENANT_BODY',{exact:true}).isVisible(),true);
  assert.equal(calls.filter(c=>c.path.endsWith('/action')).length,beforeActions,'local folds must not dispatch clicks to a source paragraph');
  await page.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForTimeout(300);
  assert.equal(await draft.evaluate(n=>n.open),true);assert.equal(await covenant.evaluate(n=>n.open),true,'open state survives a projected refresh');
  await frame.locator('#render-again').click();await page.waitForTimeout(300);assert.equal(await draft.evaluate(n=>n.open),true);assert.equal(await covenant.evaluate(n=>n.open),true);
  assert.equal(await frame.getByText('OUTSIDE_BEFORE',{exact:true}).isVisible(),true);assert.equal(await frame.getByText('OUTSIDE_AFTER',{exact:true}).isVisible(),true);
  assert.ok(!(await frame.locator('body').innerText()).includes('DSHWRITINGFOLD'));
  await frame.locator('#authored summary').click();await page.waitForFunction(()=>document.querySelector('iframe')?.contentDocument?.querySelector('#authored')?.open);assert.equal(await [...runtime.entries.values()][0].page.locator('#authored').evaluate(n=>n.open),true,'ordinary details retain source interaction');
  await draft.locator(':scope > summary').focus();await draft.locator(':scope > summary').press('Enter');assert.equal(await draft.evaluate(n=>n.open),false);assert.equal(await frame.getByText('DRAFT_BODY',{exact:false}).isVisible(),false);
  await page.setViewportSize({width:480,height:900});await page.waitForTimeout(500);assert.equal(await draft.evaluate(n=>n.open),false);assert.equal(await frame.locator('script').count(),0);assert.equal(await frame.locator('[data-reading-local-fold][data-reading-node]').count(),0);
  active={...row,id:'other'};await page.evaluate(row=>window.renderRow(row),active);await page.waitForTimeout(350);assert.equal(await covenant.evaluate(n=>n.open),false,'another message cannot inherit local open state');
  // Source formatters may split/duplicate/remove a token or leave it hidden.
  for(const [mode,render]of Object.entries({
    split:'for(const c of token){const span=document.createElement("span");span.textContent=c;output.append(span);}',
    duplicate:'output.textContent=token+" "+token;',
    interrupted:'const a=document.createTextNode(token.slice(0,10)),b=document.createTextNode(token.slice(10)),pre=document.createElement("pre");pre.textContent="SKIPPED_HISTORY";output.append(a,pre,b);',
    removed:'output.textContent="VISIBLE_AFTER";',
    hidden:'output.textContent=token;output.style.display="none";',
    styled:'output.textContent="VISIBLE_AFTER";const style=document.createElement("style");style.textContent="section{display:none!important}summary{display:none!important}";document.head.append(style);',
  })){
    const input='<html><body><div id="source" hidden><details data-writing-fold="draft"><summary>Protected</summary><div>RECOVERED_BODY</div><script>window.foldExecuted=true;</script></details></div><div id="output"></div><p>VISIBLE_OUTSIDE</p><script>const token=document.querySelector("#source").textContent;document.querySelector("#source").remove();const output=document.querySelector("#output");'+render+'</script></body></html>';
    active=(await buildReading({messages:[{id:'case-'+mode,role:'assistant',content:input}],scripts:[]})).messages[0];await page.evaluate(row=>window.renderRow(row),active);
    const protectedFold=frame.locator('details[data-reading-local-fold]');await protectedFold.locator(':scope > summary').waitFor();
    assert.equal(await protectedFold.count(),1,mode+' retains content exactly once');assert.equal(await frame.getByText('RECOVERED_BODY',{exact:true}).isVisible(),false);
    await protectedFold.locator(':scope > summary').click();assert.equal(await frame.getByText('RECOVERED_BODY',{exact:true}).isVisible(),true);assert.equal(await frame.getByText('VISIBLE_OUTSIDE',{exact:true}).isVisible(),true);
    if(mode==='interrupted')assert.equal(await frame.locator('pre').textContent(),'SKIPPED_HISTORY','excluded nodes between token pieces are never deleted');
    const sourceEntry=[...runtime.entries.values()].at(-1);assert.equal(await sourceEntry.page.evaluate(()=>window.foldExecuted),undefined,'fold script never executes');
    assert.ok(!(await frame.locator('body').innerText()).includes('DSHWRITINGFOLD'));
  }
  assert.equal(errors.length,0,JSON.stringify(errors));
  console.log('reading-folds-client: text-reparsing frontend, final iframe native folds, click/keyboard, refresh/reformat/resize, state isolation and inert projection passed');
}finally{await browser?.close();await runtime.dispose();fs.rmSync(root,{recursive:true,force:true});}
