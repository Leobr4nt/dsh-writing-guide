import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ReadingRuntime} from '../lib/reading-runtime.js';
import {TavernBrowser,safeRuntimeIssue} from '../lib/tavern-browser.js';
import {createIssueBuffer,mergeIssueSnapshots} from '../lib/runtime-issues.js';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'wg-surface-'));
const reading=new ReadingRuntime(root),runtime=new TavernBrowser({cacheDir:root});
try{
  const cases=[
    {id:'transparent-dark',css:':root{color-scheme:light}body{color:#f1f5f9}',root:'rgb(21, 23, 28)',scheme:'dark'},
    {id:'transparent-light',css:'body{color:#111}',root:'rgb(255, 255, 255)',scheme:'light'},
    {id:'explicit-root',css:':root{background:#ffeedd;color-scheme:light}',root:'rgb(255, 238, 221)',scheme:'light',text:'rgb(0, 0, 0)'},
    {id:'color4',css:'body{color:color(srgb 0.95 0.95 0.95)}',root:'rgb(21, 23, 28)',scheme:'dark'},
    {id:'explicit-body',css:'body{background:#123456;color:#fff}',body:'rgb(18, 52, 86)'},
  ];
  for(const fixture of cases){
    await reading.render('theme',{id:fixture.id,html:'<p>Readable synthetic text</p>',head:`<style>${fixture.css}</style>`},800);
    const entry=[...reading.entries.values()].at(-1);
    const styles=await entry.page.evaluate(()=>({root:getComputedStyle(document.documentElement).backgroundColor,body:getComputedStyle(document.body).backgroundColor,scheme:getComputedStyle(document.documentElement).colorScheme,text:getComputedStyle(document.body).color}));
    for(const key of ['root','body','scheme','text'])if(fixture[key])assert.equal(styles[key],fixture[key]);
    if(fixture.id==='transparent-dark'){
      await entry.page.evaluate(()=>document.body.style.color='#111');await reading.capture(entry);
      assert.equal(await entry.page.evaluate(()=>getComputedStyle(document.documentElement).backgroundColor),'rgb(255, 255, 255)','theme changes must refresh fallback');
    }
  }
  const scripts=[
    {id:'background',content:'let ticks=0;eventOn("tick",()=>insertOrAssignVariables({ticks:++ticks}));',data:{}},
    {id:'visible',content:'document.body.insertAdjacentHTML("beforeend",`<button id="inside">Frame control</button><div style="display:none"><button>Hidden</button></div>`);document.getElementById("inside").onclick=()=>insertOrAssignVariables({clicked:true});',data:{}},
    {id:'fail',content:'eventOn(getButtonEvent("Fail"),()=>{throw Error("PRIVATE_FIXTURE missing is not defined");});',button:{enabled:true,buttons:[{name:'Fail',visible:true}]},data:{}},
  ];
  await runtime.start({sessionId:'surface-fixture',scripts});await runtime.loadScripts(scripts);await runtime.settle(100);
  assert.equal(await runtime.page.locator('iframe').count(),3);
  assert.equal(await runtime.page.locator('iframe:visible').count(),1,'background scripts leave no empty rectangles');
  await runtime.emit('tick');assert.equal((await runtime.snapshot()).variables.chat.ticks,1);
  const frame=runtime.page.frames().find(f=>f.name()==='TH-script-visible');
  await frame.locator('#inside').click();assert.equal((await runtime.snapshot()).variables.chat.clicked,true);
  await frame.locator('#inside').evaluate(n=>n.remove());await runtime.settle(100);
  assert.equal(await runtime.page.locator('iframe:visible').count(),0,'hidden nested UI must not keep a frame visible');
  const background=runtime.page.frames().find(f=>f.name()==='TH-script-background');
  await background.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<input aria-label="Later UI">'));await runtime.settle(100);
  assert.equal(await runtime.page.locator('iframe:visible').count(),1,'late UI must become visible');
  await runtime.page.evaluate(()=>document.querySelector('#extensions_settings').innerHTML='<div class="inline-drawer"><div class="inline-drawer-header">Synthetic settings</div><div class="inline-drawer-content"><label>Enable<input type="checkbox"></label></div></div>');
  assert.equal(await runtime.page.locator('.inline-drawer-content').isVisible(),false);
  await runtime.page.locator('.inline-drawer-header').click();assert.equal(await runtime.page.locator('.inline-drawer-content').isVisible(),true);
  const colors=await runtime.page.evaluate(()=>({background:getComputedStyle(document.body).backgroundColor,text:getComputedStyle(document.body).color}));
  assert.deepEqual(colors,{background:'rgb(21, 23, 28)',text:'rgb(230, 233, 240)'});
  for(let i=0;i<2;i++)await assert.rejects(runtime.clickButton('fail','Fail'),/BUTTON_HANDLER_FAILED/);
  await runtime.page.evaluate(()=>{for(let i=0;i<199;i++)window.__runtimeIssues.record('PRIVATE_FIXTURE missing is not defined');});
  const status=await runtime.status();assert.equal(status.errors.length,1);assert.equal(status.errorCount,201);assert.equal(status.errors[0].count,201);
  assert.ok(!JSON.stringify(status).includes('PRIVATE_FIXTURE'));
  await runtime.page.evaluate(()=>{const b=document.createElement('button');b.id='failure';b.textContent='Failure';b.onclick=()=>{throw Error('PRIVATE_FIXTURE missing is not defined');};document.body.prepend(b);});
  for(let i=0;i<2;i++){const b=await runtime.page.locator('#failure').boundingBox();await assert.rejects(runtime.interact({type:'click',x:b.x+5,y:b.y+5}),/SURFACE_HANDLER_FAILED/);}
  const buffer=createIssueBuffer(safeRuntimeIssue,2);
  buffer.record('getVariables is not defined');buffer.record('getWorldbook is not defined');buffer.record('getChatMessages is not defined');buffer.record('getChatMessages is not defined');
  assert.equal(buffer.total,4);assert.equal(buffer.snapshot().errors.length,2);assert.equal(buffer.snapshot().omittedErrorCount,1);
  const merged=mergeIssueSnapshots(buffer.snapshot(),buffer.snapshot());assert.equal(merged.errorCount,8);assert.equal(merged.omittedErrorCount,2);
  console.log('surface-theme: transparent canvas contrast, authored themes, live/empty frames, drawers, bounded private diagnostics and repeat-failure rejection passed');
}finally{await reading.dispose();await runtime.close();await fs.rm(root,{recursive:true,force:true});}
