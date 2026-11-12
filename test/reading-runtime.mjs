import assert from 'node:assert/strict';import {mkdtemp,rm,readFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {interactiveReadingHtml} from '../lib/reading.js';import {ReadingRuntime} from '../lib/reading-runtime.js';
const root=await mkdtemp(path.join(os.tmpdir(),'wg-reading-runtime-'));let runtime=new ReadingRuntime(root);
const document='<html><head><style>#settings{display:none}#toggle{position:absolute;left:10px;top:10px;width:90px;height:30px}#settings{position:absolute;top:60px}body{height:200px}</style></head><body><button id="toggle">Settings</button><div id="settings"><input id="font" value="16"></div><div id="text">FIXTURE</div><script>$(function(){const stored=localStorage.getItem("font");if(stored)$("#font").val(stored);$("#toggle").on("click",()=>$("#settings").toggle());$("#font").on("input",function(){localStorage.setItem("font",this.value);$("#text").css("font-size",this.value+"px")});fetch("https://example.invalid/private").catch(()=>{});new Image().src="https://example.invalid/image";});</script></body></html>';
try{
  const row={id:'m',...await interactiveReadingHtml(document)};
  let surface=await runtime.render('s',row,800),entry=[...runtime.entries.values()][0];
  assert.equal(surface.format,'html');assert.match(surface.document,/FIXTURE/);assert.equal(surface.image,undefined);assert.equal(await entry.page.locator('#settings').isVisible(),false);
  await runtime.act('s','m',surface.token,{type:'click',x:40,y:25});assert.equal(await entry.page.locator('#settings').isVisible(),true);
  await runtime.act('s','m',surface.token,{type:'click',x:25,y:72});await runtime.act('s','m',surface.token,{type:'key',key:'Backspace'});await runtime.act('s','m',surface.token,{type:'text',text:'22'});
  const saved=await entry.page.locator('#font').inputValue();await runtime.dispose();runtime=new ReadingRuntime(root);surface=await runtime.render('s',row,800);entry=[...runtime.entries.values()][0];assert.equal(await entry.page.locator('#font').inputValue(),saved);
  assert.equal(await entry.page.evaluate(()=>typeof process),'undefined');assert.equal(entry.page.url().startsWith('https://reading.invalid/'),true);
  await assert.rejects(runtime.act('other','m',surface.token,{type:'refresh'}),/EXPIRED/);
  await assert.rejects(runtime.act('s','m','wrong',{type:'refresh'}),/EXPIRED/);
  const before=await entry.page.locator('script').count();assert.ok(before>=2);
  console.log('reading-runtime: full document controls, persisted settings, scoped actions, selectable DOM presentation and isolated browser passed');
}finally{await runtime.dispose();await rm(root,{recursive:true,force:true});}
