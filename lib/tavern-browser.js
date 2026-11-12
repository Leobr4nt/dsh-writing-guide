import { PUBLIC_HELPER_APIS, PUBLIC_TEMPLATE_APIS, PUBLIC_SILLYTAVERN_APIS } from './tavern-api-names.js';
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { RuntimeModules } from './runtime-modules.js';
import { createTavernEvents } from './tavern-events.js';
import { createTavernHost } from './tavern-host.js';
import { createTemplateReaders } from './template-readers.js';
import { createIssueBuffer, mergeIssueSnapshots } from './runtime-issues.js';
import { tavernSurfaceCss, watchScriptFrame, installTavernDrawers } from './surface-theme.js';

const require=createRequire(import.meta.url);
const API_NAMES=['Vue','Mvu','SillyTavern','TavernHelper','getVariables','replaceVariables','getChatMessages','getWorldbook','getLorebookEntries','getLorebookSettings','getCharLorebooks','getCharWorldbookNames','getScriptId','getTavernHelperVersion','getScriptName','getScriptInfo','getScriptTrees','getTavernRegexes','registerVariableSchema','insertOrAssignVariables','eventOn','eventEmit','eventOnce','waitGlobalInitialized','substitudeMacros','getAllVariables','replaceScriptButtons','appendInexistentScriptButtons','getButtonEvent','getWorldbookSettings','getCurrentCharacterName','replaceTavernRegexes','updateTavernRegexesWith','getPreset','getPresetNames','getCurrentPresetName','getChatLorebook','getCharData','generate','getCurrentMessageId','setChatMessages','getGlobalWorldbookNames','formatAsTavernRegexedString','triggerSlash','uuidv4','YAML','_','z','$','document','window','localStorage','getwi','getvar','variables','define'];
const SAFE_API_NAMES=[...new Set([...API_NAMES,...PUBLIC_HELPER_APIS,...PUBLIC_TEMPLATE_APIS,...PUBLIC_SILLYTAVERN_APIS])]
  .filter(n=>n.length>2&&!['async','name','type','data','value','content','options'].includes(n));
export function safeRuntimeIssue(error){return classifyRuntimeIssue(error,SAFE_API_NAMES);}
function classifyRuntimeIssue(error,names) {
  const text=String(error?.message??error??'').split('\n')[0];
  const matches=names.filter(name=>new RegExp('(?:^|[^\\w$])'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?:[^\\w$]|$)').test(text));
  const api=matches.find(name=>!['SillyTavern','TavernHelper','window','document'].includes(name))??matches[0];
  const category=/not defined|is not a function|undefined/.test(text)?'MISSING_API':/timeout|TIMEOUT/i.test(text)?'TIMEOUT':/MODULE_/.test(text)?'MODULE_FAILURE':/Failed to fetch|ERR_FAILED|ERR_BLOCKED_BY_CLIENT/i.test(text)?'NETWORK_BLOCKED':'RUNTIME_ERROR';
  return {category,...(api?{api}:{})};
}
function browserPath() {
  const candidates=[process.env.DSH_WRITING_BROWSER,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium','/usr/bin/google-chrome','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  const found=candidates.find(existsSync);if(!found)throw Error('BROWSER_NOT_INSTALLED');return found;
}
let vendorPromise;
async function vendors() {
  vendorPromise??=(async()=>{
    const built=await build({stdin:{contents:"import * as z from 'zod'; import * as YAML from 'yaml'; import * as Vue from 'vue'; globalThis.z=z; globalThis.YAML=YAML; globalThis.Vue=Vue;",resolveDir:fileURLToPath(new URL('../',import.meta.url))},bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',logLevel:'silent'});
    return [await fs.readFile(require.resolve('jquery/dist/jquery.js'),'utf8'),await fs.readFile(require.resolve('jquery-ui/dist/jquery-ui.js'),'utf8'),await fs.readFile(require.resolve('lodash/lodash.js'),'utf8'),built.outputFiles[0].text];
  })();return vendorPromise;
}

export class TavernBrowser {
  constructor({cacheDir}){this.modules=new RuntimeModules(cacheDir);this.assets=new Map();this.issues=createIssueBuffer(safeRuntimeIssue);this.scriptResults=[];this.blockedRequests=0;}
  async bounded(work,timeoutMs=10000){let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>{void this.close();reject(Error('RUNTIME_TIMEOUT'));},timeoutMs);})]);}finally{clearTimeout(timer);}}
  async start(initial) {
    await this.modules.load();
    this.browser=await chromium.launch({executablePath:browserPath(),headless:true,chromiumSandbox:true,args:['--disable-background-networking','--disable-component-update','--disable-sync']});
    this.context=await this.browser.newContext({serviceWorkers:'block',acceptDownloads:false,colorScheme:'dark'});
    await this.context.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin==='https://writing.invalid'&&url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!DOCTYPE html><html><head></head><body><div id="extensions_settings2"></div><div id="extensions_settings"></div><div id="extensionsMenu"></div><div id="tavern_helper"></div><div id="chat"></div><textarea id="send_textarea"></textarea></body></html>'});
      if(url.origin==='https://writing.invalid'&&url.pathname==='/version')return route.fulfill({contentType:'application/json',body:JSON.stringify({pkgVersion:'1.15.0',adapter:'dsh-writing'})});
      const asset=this.assets.get(url.href);if(asset)return route.fulfill({contentType:'application/javascript',body:asset});
      this.blockedRequests++;await route.abort();
    });
    await this.context.routeWebSocket(/.*/,socket=>socket.close());
    this.page=await this.context.newPage();
    this.page.on('pageerror',error=>this.issues.record(error));
    this.page.on('console',msg=>{if(msg.type()==='error')this.issues.record(msg.text());});
    await this.page.goto('https://writing.invalid/');
    await this.page.addStyleTag({content:tavernSurfaceCss});
    await this.page.evaluate(installTavernDrawers);
    for(const content of await vendors())await this.page.addScriptTag({content});
    await this.page.evaluate(({initial,host,events,buffer,classify,names,watchFrame,css})=>{
      const classifyIssue=(0,eval)('('+classify+')');
      const failures=(0,eval)('('+buffer+')')(error=>classifyIssue(error,names));window.__runtimeIssues=failures;
      window.__tavern=(0,eval)('('+host+')')(initial,(0,eval)('('+events+')')(error=>failures.record(error)));
      window.SillyTavern=window.__tavern.silly;
      Object.assign(window,window.__tavern.apiFor('host'));
      window.toastr=Object.fromEntries(['info','warning','success','error','clear','remove'].map(k=>[k,()=>{window.__tavern.metrics.logs++;}]));
      window.TavernHelper={...window.__tavern.apiFor('host')};
      window.getContext=()=>window.SillyTavern;
      window.__loadScript=async({id,url})=>{
        const box=document.createElement('div');box.dataset.scriptId=id;document.querySelector('#tavern_helper').append(box);
        const frame=document.createElement('iframe');frame.name='TH-script-'+id;frame.dataset.dshScriptFrame='';box.append(frame);
        (0,eval)('('+watchFrame+')')(frame,css);
        const w=frame.contentWindow;
        const api=window.__tavern.apiFor(id);Object.assign(w,api,{SillyTavern:window.SillyTavern,TavernHelper:window.TavernHelper,toastr:window.toastr,_:window._,z:window.z,YAML:window.YAML,Vue:window.Vue,$:window.$,jQuery:window.jQuery});
        Object.defineProperty(w,'Mvu',{configurable:true,get:()=>window.Mvu});
        w.console={log(){},info(){},warn(){},debug(){},error(...args){failures.record(args.map(a=>typeof a==='string'?a:a?.message??'').join(' '));}};
        w.addEventListener('error',event=>{failures.record(event.error??event.message);event.preventDefault();});
        w.addEventListener('unhandledrejection',event=>{failures.record(event.reason);event.preventDefault();});
        await new Promise((resolve,reject)=>{const s=w.document.createElement('script');s.type='module';s.src=url;s.onload=resolve;s.onerror=()=>reject(Error('MODULE_EXECUTION'));w.document.body.append(s);});
      };
    },{initial,host:createTavernHost.toString(),events:createTavernEvents.toString(),buffer:createIssueBuffer.toString(),classify:classifyRuntimeIssue.toString(),names:SAFE_API_NAMES,watchFrame:watchScriptFrame.toString(),css:tavernSurfaceCss});
    return this;
  }
  async loadScripts(scripts) {
    for(let index=0;index<scripts.length;index++) {
      const script=scripts[index];
      try {
        const content=await this.modules.bundle(script.content);const url='https://writing.invalid/script/'+index+'.js';this.assets.set(url,content);
        await this.bounded(this.page.evaluate(args=>window.__loadScript(args),{id:script.id,url}),15000);
        this.scriptResults.push({index,moduleLoaded:true});
        // Ready callbacks and async startup continue in their resident frames.
        await this.page.waitForTimeout(150);
      }catch(error){this.scriptResults.push({index,moduleLoaded:false,...safeRuntimeIssue(error)});}
    }
  }
  async settle(ms=1200){await this.bounded(this.page.waitForTimeout(ms),ms+3000);}
  async emit(name,...args){return this.bounded(this.page.evaluate(async({name,args})=>{await window.__tavern.events.eventEmit(name,...args);},{name,args}));}
  async snapshot(){return this.bounded(this.page.evaluate(()=>window.__tavern.snapshot()));}
  async restore(value){return this.bounded(this.page.evaluate(v=>window.__tavern.restore(v),value));}
  async setChat(rows) {
    await this.bounded(this.page.evaluate(rows=>{const host=window.__tavern;host.state.chat.splice(0,host.state.chat.length,...rows.map(r=>({name:r.role==='user'?host.silly.name1:host.silly.name2,is_user:r.role==='user',is_system:r.role==='system',mes:r.content,swipe_id:0,extra:{}})));host.hydrateChat();},rows));
  }
  async processReply(content) {
    const index=await this.bounded(this.page.evaluate(content=>{const host=window.__tavern;host.state.chat.push({name:host.silly.name2,is_user:false,is_system:false,mes:content,swipe_id:0,extra:{}});host.hydrateChat();return host.state.chat.length-1;},content));
    await this.emit('message_received',index);
    await this.emit('character_message_rendered',index,'normal');
    await this.emit('generation_ended',index);
    return this.snapshot();
  }
  async buttons() {
    return this.bounded(this.page.evaluate(()=>window.__tavern.buttons()));
  }
  async surface(){
    const image=await this.bounded(this.page.screenshot({type:'png'}));
    const viewport=this.page.viewportSize();return {image:'data:image/png;base64,'+image.toString('base64'),width:viewport.width,height:viewport.height};
  }
  async interact(action){
    const viewport=this.page.viewportSize();
    const priorErrors=this.issues.total+await this.bounded(this.page.evaluate(()=>window.__runtimeIssues.total));
    if(action.type==='click'){
      if(!Number.isFinite(action.x)||!Number.isFinite(action.y)||action.x<0||action.y<0||action.x>viewport.width||action.y>viewport.height)throw Error('SURFACE_COORDINATE');
      await this.bounded(this.page.mouse.click(action.x,action.y));
    }else if(action.type==='text'){
      if(typeof action.text!=='string'||action.text.length>4000)throw Error('SURFACE_TEXT');await this.bounded(this.page.keyboard.insertText(action.text));
    }else if(action.type==='key'){
      if(!['Enter','Escape','Tab','Backspace','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(action.key))throw Error('SURFACE_KEY');await this.bounded(this.page.keyboard.press(action.key));
    }else if(action.type==='scroll'){
      if(!Number.isFinite(action.dy)||Math.abs(action.dy)>1000)throw Error('SURFACE_SCROLL');await this.bounded(this.page.mouse.wheel(0,action.dy));
    }else throw Error('SURFACE_ACTION');
    await this.settle(100);
    if(this.issues.total+await this.bounded(this.page.evaluate(()=>window.__runtimeIssues.total))!==priorErrors)throw Error('SURFACE_HANDLER_FAILED');
    return this.snapshot();
  }
  async clickButton(scriptId,name) {
    return this.bounded(this.page.evaluate(async({scriptId,name})=>{
      const host=window.__tavern;
      if(!host.buttons().some(button=>button.scriptId===scriptId&&button.name===name))throw Error('BUTTON_NOT_AVAILABLE');
      const errors=window.__runtimeIssues.total;
      await host.events.eventEmit(host.apiFor(scriptId).getButtonEvent(name));
      if(window.__runtimeIssues.total!==errors)throw Error('BUTTON_HANDLER_FAILED');
      return host.snapshot();
    },{scriptId,name}));
  }
  async verifyMvuUpdate() {
    return this.bounded(this.page.evaluate(async()=>{
      if(!window.Mvu)return {initialized:false,updated:false};
      const before=window.__tavern.snapshot();
      const data=window.Mvu.getMvuData({type:'message',message_id:0});
      const candidates=[];
      function collect(value,keys=[]){if(candidates.length>=24)return;if(typeof value==='number'&&Number.isFinite(value))candidates.push({keys,value});else if(value&&typeof value==='object')for(const [key,child]of Object.entries(value)){if(!key.startsWith('$'))collect(child,[...keys,key]);}}
      collect(data?.stat_data??{});
      let result={initialized:!!data?.stat_data,updated:false,candidates:candidates.length};
      for(let i=0;i<candidates.length;i++){
        const c=candidates[i],pointer='/'+c.keys.map(k=>k.replace(/~/g,'~0').replace(/\//g,'~1')).join('/');
        const content='<UpdateVariable><JSONPatch>'+JSON.stringify([{op:'replace',path:pointer,value:c.value+1}])+'</JSONPatch></UpdateVariable>';
        try {
          const parsed=await window.Mvu.parseMessage(content,data);
          if(_.get(parsed?.stat_data,c.keys)===c.value+1){
            await window.Mvu.replaceMvuData(parsed,{type:'message',message_id:0});
            result={...result,updated:_.get(window.Mvu.getMvuData({type:'message',message_id:0})?.stat_data,c.keys)===c.value+1,candidateIndex:i};
            window.__tavern.restore(before);
            const host=window.__tavern;host.state.chat.push({name:host.silly.name2,is_user:false,is_system:false,mes:content,swipe_id:0,extra:{}});
            host.hydrateChat();
            const messageId=host.state.chat.length-1;
            await host.events.eventEmit('message_received',messageId);
            await host.events.eventEmit('character_message_rendered',messageId,'normal');
            result.eventUpdateVerified=_.get(window.Mvu.getMvuData({type:'message',message_id:messageId})?.stat_data,c.keys)===c.value+1;
            break;
          }
        }catch{}
      }
      window.__tavern.restore(before);
      return {...result,restored:true};
    }),15000);
  }
  async status() {
    const raw=await this.bounded(this.page.evaluate(()=>({...window.__runtimeIssues.snapshot(),metrics:window.__tavern.metrics,listeners:window.__tavern.events.listenerCount(),mvu:typeof window.Mvu==='object',mvuMethods:typeof window.Mvu==='object'?['getMvuData','parseMessage','replaceMvuData'].filter(k=>typeof window.Mvu[k]==='function'):[],chatStateKeys:Object.keys(window.__tavern.state.variables.chat??{}).length,messageStateCount:Object.keys(window.__tavern.state.variables.messages??{}).length,initializedBooks:Object.keys(window.__tavern.state.variables.messages[window.__tavern.state.chat.length-1]?.initialized_lorebooks??{}).length,statKeys:Object.keys(window.__tavern.state.variables.messages[window.__tavern.state.chat.length-1]?.stat_data??{}).length})));
    return {...raw,...mergeIssueSnapshots(this.issues.snapshot(),raw),scripts:this.scriptResults,blockedRequests:this.blockedRequests,downloadedModules:this.modules.downloads};
  }
  async render(texts,context={}) {
    const programs=texts.map(text=>ejs.compile(text,{client:true,compileDebug:false,async:true,outputFunctionName:'print'}).toString());
    return this.bounded(this.page.evaluate(async({programs,context,readers})=>{
      const host=window.__tavern,api=host.apiFor('template');
      // ST prepares the current message from the nearest previous variable table.
      // Read raw tables: helper getVariables() creates missing tables as a side effect.
      const current=host.state.chat.length-1,messages=host.state.variables.messages;
      const initialized=host.state.variables.templateInitialized??={};
      if(current>0&&!initialized[current]){
        let previous={};
        for(let id=current-1;id>=0;id--)if(messages[id]!=null){previous=messages[id];break;}
        messages[current]=_.cloneDeep(Object.assign({},previous,messages[current]));
        initialized[current]=true;
      }
      let cache;
      const refresh=()=>{cache=_.cloneDeep(Object.assign({},host.state.variables.global,host.state.variables.chat,host.state.variables.messages[host.state.chat.length-1]??{}));};
      refresh();
      const vars=()=>cache;
      const env={...api,...context,_:window._,YAML:window.YAML,z:window.z,Mvu:window.Mvu,
        setvar:(key,value,options={})=>{const type=options.scope==='global'?'global':options.scope==='local'?'chat':'message';const values=api.getVariables({type});_.set(values,key,value);api.replaceVariables(values,{type});_.set(cache,key,value);return value;},
        getwi:async(name)=>api.getLorebookEntries(name),getchar:()=>host.state.card,
      };
      for(const [suffix,type]of [['Local','chat'],['Global','global'],['Message','message']]){
        env['set'+suffix+'Var']=(key,value,options={})=>env.setvar(key,value,{...options,scope:type==='chat'?'local':type});
      }
      Object.assign(env,(0,eval)('('+readers+')')({lodash:window._,cache:vars,local:()=>host.state.variables.chat,global:()=>host.state.variables.global,refresh}));
      Object.defineProperty(env,'variables',{get:vars});
      env.SillyTavern=window.SillyTavern;
      env.userName=context.user??'用户';env.charName=context.char??host.state.card?.name??'';env.assistantName=env.charName;
      env.lastMessageId=host.state.chat.length-1;env.chatId=host.state.sessionId;
      await host.events.eventEmit('prompt_template_prepare',env);
      const out=[];for(const program of programs)out.push(await (0,eval)('('+program+')').call(env,env,undefined,()=>{throw Error('INCLUDE_UNSUPPORTED');}));
      return out;
    },{programs,context,readers:createTemplateReaders.toString()}));
  }
  async close(){const browser=this.browser;this.browser=null;if(browser)await browser.close().catch(()=>{});}
}
