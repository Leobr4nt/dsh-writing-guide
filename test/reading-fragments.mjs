import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium} from 'playwright-core';
import {ReadingAssets} from '../lib/reading-assets.js';
import {ReadingRuntime} from '../lib/reading-runtime.js';
import {buildReading,splitReadingDocuments} from '../lib/reading.js';

const root=await mkdtemp(path.join(os.tmpdir(),'wg-reading-fragments-'));const runtime=new ReadingRuntime(root);let browser;
try{
  let downloads=0;
  const assets=new ReadingAssets(root,{downloadStyle:async()=>{downloads++;return {mime:'text/css',bytes:Buffer.from('@import "https://blocked.invalid/font.css";:root[data-theme=night] body{background:#112233;color:#eeeeee}#settings{display:none}button{border-radius:13px;background:#123456;color:#fff}')};}});
  const document='<html data-theme="night"><head><link rel="preconnect" href="https://blocked.invalid"><link rel="stylesheet" href="https://example.com/theme.css"></head><body><button id="toggle">Settings</button><div id="settings"><input id="input" value="18"></div><p id="text">Synthetic text</p><style id="dynamic"></style><script>document.querySelector("#dynamic").sheet.insertRule("#text{font-size:21px}");document.querySelector("#toggle").onclick=()=>document.querySelector("#settings").style.display="block";const template=`raw\n    backticks`;</script></body></html>';
  const input='Plain **before**\n\n```html\n'+document+'\n```\n\nAfter.';
  const parts=splitReadingDocuments(input);assert.equal(parts.length,3);assert.equal(parts[1].source,document);assert.ok(!parts[0].source.includes('```')&&!parts[2].source.includes('```'));
  const reading=await buildReading({messages:[{id:'m',role:'assistant',content:input}],scripts:[],assets});
  const row=reading.messages[0];assert.equal(row.parts.length,3);assert.equal(row.parts[1].stylesLoaded,1);assert.equal(row.parts[1].stylesFailed,0);assert.equal(row.parts[1].rootAttributes['data-theme'],'night');
  assert.match(row.parts[0].html,/<strong>before<\/strong>/);assert.ok(!row.parts[0].html.includes('<html'));assert.match(row.parts[2].html,/After/);
  let surface=await runtime.render('s',row.parts[1],800);const entry=[...runtime.entries.values()][0];
  assert.equal(await entry.page.locator('#settings').isVisible(),false);assert.equal(await entry.page.locator('body').evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(17, 34, 51)');
  assert.match(surface.document,/#text\s*\{\s*font-size:\s*21px/,'CSSOM-inserted rules survive DOM projection');
  browser=await chromium.launch({executablePath:process.env.DSH_WRITING_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});const page=await browser.newPage();await page.setContent('<iframe sandbox="allow-same-origin" style="width:800px;height:600px"></iframe>');await page.locator('iframe').evaluate((n,html)=>n.srcdoc=html,surface.document);const frame=page.frameLocator('iframe');await frame.locator('#text').waitFor();
  assert.equal(await frame.locator('#settings').isVisible(),false);assert.equal(await frame.locator('#text').evaluate(n=>getComputedStyle(n).fontSize),'21px');
  assert.equal(await frame.locator('#toggle').evaluate(n=>getComputedStyle(n).borderRadius),'13px');assert.equal(await frame.locator('body').evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(17, 34, 51)');
  assert.ok(!(await frame.locator('body').innerText()).includes('```'));assert.ok(!(await frame.locator('body').innerText()).includes('<link'));
  const id=await entry.page.locator('#toggle').getAttribute('data-reading-node');surface=await runtime.act('s',row.parts[1].id,surface.token,{type:'node-click',nodeId:id});assert.ok(await entry.page.locator('#settings').isVisible());
  await assets.stylesheet('https://example.com/theme.css');assert.equal(downloads,1);assert.equal(await assets.stylesheet('https://127.0.0.1/private.css'),null);
  const bad=new ReadingAssets(root,{downloadStyle:async()=>({bytes:Buffer.from('<html>bad</html>'),mime:'text/html'})});assert.equal(await bad.stylesheet('https://example.com/not-css'),null);
  const two=splitReadingDocuments('```html\n'+document+'\n```\n\n```html\n'+document+'\n```');assert.equal(two.length,2);
  console.log('reading-fragments: frontend boundaries, external layout CSS cache, collapsed controls, CSSOM rules and text presentation passed');
}finally{await browser?.close();await runtime.dispose();await rm(root,{recursive:true,force:true});}
