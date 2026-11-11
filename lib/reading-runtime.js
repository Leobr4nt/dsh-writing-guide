import {chromium} from 'playwright-core';
import {existsSync} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {safeRuntimeIssue} from './tavern-browser.js';
import {ensureReadingCanvas} from './surface-theme.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const browserPath=()=>[process.env.DSH_WRITING_BROWSER,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium','/usr/bin/google-chrome'].find(value=>value&&existsSync(value));
const escaped=value=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');

/** Interactive reading documents live outside the DSH renderer. Every network route is denied. */
export class ReadingRuntime{
  constructor(root){this.root=path.join(root,'reading-settings');this.entries=new Map();this.queue=Promise.resolve();this.browser=null;}
  serial(fn){const task=this.queue.then(fn,fn);this.queue=task.catch(()=>{});return task;}
  async bounded(task,entry){let timer;try{return await Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>{this.entries.delete(entry.id);void entry.context.close();reject(Error('READING_TIMEOUT'));},12000);})]);}finally{clearTimeout(timer);}}
  async dispose(){await this.serial(async()=>{for(const entry of this.entries.values())clearTimeout(entry.idle);this.entries.clear();await this.browser?.close();this.browser=null;});}
  async render(sessionId,row,width=920){return this.serial(async()=>{
    const id=hash(sessionId+'|'+row.id),revision=hash(JSON.stringify([row.head,row.html,row.bodyAttributes]));
    let entry=this.entries.get(id);width=Math.max(320,Math.min(1400,Math.round(Number(width)||920)));
    if(entry&&entry.revision!==revision){await entry.context.close();clearTimeout(entry.idle);this.entries.delete(id);entry=null;}
    if(!entry){
      if(this.entries.size>=4){const [oldId,old]=this.entries.entries().next().value;clearTimeout(old.idle);await old.context.close();this.entries.delete(oldId);}
      this.browser??=await chromium.launch({executablePath:browserPath(),headless:true,chromiumSandbox:true,args:['--disable-background-networking','--disable-component-update','--disable-sync']});
      const context=await this.browser.newContext({viewport:{width,height:900},serviceWorkers:'block',acceptDownloads:false,colorScheme:'dark'});
      let settings={};try{settings=JSON.parse(await fs.readFile(path.join(this.root,id+'.json'),'utf8'));}catch{}
      const attrs=Object.entries(row.bodyAttributes??{}).filter(([key])=>['class','id','style','data-theme'].includes(key)).map(([key,value])=>`${key}="${escaped(value)}"`).join(' ');
      const html='<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{color-scheme:light dark}body{margin:0;overflow-wrap:anywhere;font:15px/1.75 system-ui}img{max-width:100%}html{min-height:0!important}input,button,select,textarea{font:inherit}</style>'+(row.head??'')+'</head><body '+attrs+'>'+row.html+'</body></html>';
      const address='https://reading.invalid/'+id;
      let admitted=false;
      await context.route('**/*',route=>{
        if(!admitted&&route.request().url()===address&&route.request().isNavigationRequest()){admitted=true;return route.fulfill({contentType:'text/html',body:html});}
        const image=row.imageSources?.[route.request().url()];
        if(route.request().resourceType()==='image'&&image){const match=/^data:(image\/[\w+-]+);base64,(.+)$/.exec(image);if(match)return route.fulfill({contentType:match[1],body:Buffer.from(match[2],'base64')});}
        return route.abort();
      });
      await context.routeWebSocket(/.*/,socket=>socket.close());
      await context.addInitScript(values=>{if(location.origin==='https://reading.invalid')for(const [key,value]of Object.entries(values))localStorage.setItem(key,String(value));},settings);
      const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push({...safeRuntimeIssue(error),duplicateDeclaration:/already been declared/.test(error.message),syntax:error.name==='SyntaxError',security:error.name==='SecurityError'}));page.on('popup',popup=>void popup.close());
      try{await page.goto(address,{waitUntil:'load',timeout:12000});await page.waitForTimeout(250);}catch{await context.close();throw Error('READING_DOCUMENT_FAILED');}
      entry={context,page,revision,width,address,errors:()=>errors.length,diagnostics:()=>errors.slice(0,12),id,token:randomUUID()};this.entries.set(id,entry);
    }
    if(entry.width!==width){entry.width=width;await entry.page.setViewportSize({width,height:900});}
    this.retain(entry);return this.capture(entry);
  });}
  retain(entry){clearTimeout(entry.idle);entry.idle=setTimeout(()=>{void this.serial(async()=>{if(this.entries.get(entry.id)===entry){this.entries.delete(entry.id);await entry.context.close();}});},300000);entry.idle.unref?.();}
  async capture(entry){
    await this.bounded(entry.page.evaluate(ensureReadingCanvas),entry);
    const height=await this.bounded(entry.page.evaluate(()=>Math.ceil(Math.max(document.documentElement.scrollHeight,document.body.scrollHeight,innerHeight))),entry);
    const clipped=Math.min(10000,height);const png=await entry.page.screenshot({type:'png',clip:{x:0,y:0,width:entry.width,height:clipped},captureBeyondViewport:true,timeout:10000});
    return {image:'data:image/png;base64,'+png.toString('base64'),width:entry.width,height:clipped,truncated:height>clipped,token:entry.token,issues:entry.errors()};
  }
  async act(sessionId,messageId,token,input){return this.serial(async()=>{
    const entry=this.entries.get(hash(sessionId+'|'+messageId));if(!entry||entry.token!==token)throw Error('READING_EXPIRED');
    return this.bounded(this.perform(entry,input),entry);
  });}
  async perform(entry,input){
    const action=input??{};
    if(action.type==='click'){
      if(!Number.isFinite(action.x)||!Number.isFinite(action.y)||action.x<0||action.x>entry.width||action.y<0||action.y>10000)throw Error('READING_POINT');
      await entry.page.evaluate(y=>scrollTo(0,Math.max(0,y-450)),action.y);const scroll=await entry.page.evaluate(()=>scrollY);await entry.page.mouse.click(action.x,action.y-scroll);
    }else if(action.type==='text'){
      if(typeof action.text!=='string'||action.text.length>4000)throw Error('READING_TEXT');await entry.page.keyboard.insertText(action.text);
    }else if(action.type==='key'){
      if(!['Enter','Tab','Escape','Backspace','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(action.key))throw Error('READING_KEY');await entry.page.keyboard.press(action.key);
    }else if(action.type!=='refresh')throw Error('READING_ACTION');
    await entry.page.waitForTimeout(100);
    if(entry.page.url()!==entry.address){this.entries.delete(entry.id);await entry.context.close();throw Error('READING_NAVIGATION_BLOCKED');}
    const settings=await entry.page.evaluate(()=>Object.fromEntries(Object.keys(localStorage).map(key=>[key,localStorage.getItem(key)])));
    const json=JSON.stringify(settings);if(json.length<=200000){await fs.mkdir(this.root,{recursive:true});await fs.writeFile(path.join(this.root,entry.id+'.json'),json);}
    this.retain(entry);return this.capture(entry);
  }
}
