import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium} from 'playwright-core';
import {ReadingRuntime} from '../lib/reading-runtime.js';
import {interactiveReadingHtml} from '../lib/reading.js';
import {readingDomDocument} from '../lib/reading-dom.js';

const root=await mkdtemp(path.join(os.tmpdir(),'wg-reading-dom-'));
const runtime=new ReadingRuntime(root);let browser;
try{
  const fixture='<html><head><style>body{color:#ddd;background:#181818}#panel{display:none}#tail{margin-top:16000px}</style></head><body><p id="story">可选择复制的合成正文。</p><button id="toggle">展开</button><div id="panel"><input id="edit" value="初始"><input id="check" type="checkbox"><select id="choice"><option value="a">A</option><option value="b">B</option></select><span id="echo"></span></div><details><summary>摘要</summary>折叠内容</details><p id="tail">长文末尾</p><script>document.querySelector("#toggle").onclick=()=>document.querySelector("#panel").style.display="block";document.querySelector("#edit").oninput=e=>{document.querySelector("#echo").textContent=e.target.value;localStorage.setItem("reading",e.target.value)};</script></body></html>';
  const row={id:'synthetic',...await interactiveReadingHtml(fixture)};
  let surface=await runtime.render('s',row,800);assert.equal(surface.format,'html');assert.equal(surface.image,undefined);assert.match(surface.document,/长文末尾/);assert.equal(surface.truncated,undefined);
  const entry=[...runtime.entries.values()][0];
  const id=selector=>entry.page.locator(selector).getAttribute('data-reading-node');
  surface=await runtime.act('s',row.id,surface.token,{type:'node-click',nodeId:await id('#toggle')});
  assert.ok(await entry.page.locator('#panel').isVisible());
  surface=await runtime.act('s',row.id,surface.token,{type:'node-change',nodeId:await id('#edit'),value:'直接输入'});
  assert.match(surface.document,/直接输入/);assert.equal(await entry.page.locator('#echo').textContent(),'直接输入');
  surface=await runtime.act('s',row.id,surface.token,{type:'node-change',nodeId:await id('#choice'),values:['b']});
  assert.equal(await entry.page.locator('#choice').inputValue(),'b');
  surface=await runtime.act('s',row.id,surface.token,{type:'node-change',nodeId:await id('#check'),checked:true});assert.ok(await entry.page.locator('#check').isChecked());
  await assert.rejects(runtime.act('s',row.id,surface.token,{type:'node-click',nodeId:'1"] script'}),/READING_NODE/);
  await assert.rejects(runtime.act('s',row.id,'wrong',{type:'node-change',nodeId:'1',value:'x'}),/READING_EXPIRED/);
  assert.ok(!/<script\b|onclick=|oninput=/.test(surface.document),'only inert DOM reaches DSH');

  browser=await chromium.launch({executablePath:process.env.DSH_WRITING_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage();let requests=0;await page.route('https://blocked.invalid/**',route=>{requests++;return route.abort();});
  await page.setContent('<iframe title="reader" sandbox="allow-same-origin" style="width:800px;height:600px"></iframe>');
  await page.locator('iframe').evaluate((node,html)=>node.srcdoc=html,surface.document);
  let frame=page.frames()[1];await frame.locator('#story').waitFor();
  const selected=await frame.locator('#story').evaluate(node=>{const range=document.createRange();range.selectNodeContents(node);getSelection().removeAllRanges();getSelection().addRange(range);return getSelection().toString();});
  assert.equal(selected,'可选择复制的合成正文。');
  assert.equal(await frame.locator('#tail').textContent(),'长文末尾');
  assert.equal(await frame.locator('script').count(),0);assert.equal(await frame.locator('#choice').inputValue(),'b');assert.ok(await frame.locator('#check').isChecked());
  const hostile=readingDomDocument({html:'<meta http-equiv="refresh" content="0;url=https://blocked.invalid/nav"><base href="https://blocked.invalid/"><script>parent.evil=1</script><img src="https://blocked.invalid/i" onerror="parent.evil=2"><iframe src="https://blocked.invalid/frame"></iframe><form action="https://blocked.invalid/submit"><input name="p"></form><p id="safe">safe</p>',head:'<style>@import "https://blocked.invalid/s";body{background:url(https://blocked.invalid/b)}</style><script>parent.evil=3</script>'});
  await page.locator('iframe').evaluate((node,html)=>node.srcdoc=html,hostile);frame=page.frames()[1];await frame.locator('#safe').waitFor();await page.waitForTimeout(80);assert.equal(requests,0);assert.equal(await page.evaluate(()=>window.evil),undefined);assert.equal(await frame.locator('iframe,script,base').count(),0);
  console.log('reading-dom: selectable text, full long documents, live control state, persistence boundary and inert DOM isolation passed');
}finally{await browser?.close();await runtime.dispose();await rm(root,{recursive:true,force:true});}
