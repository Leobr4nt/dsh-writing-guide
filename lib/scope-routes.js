import { helperSettings } from './extension-scopes.js';
import { createHash } from 'node:crypto';
import { applyScriptsSafe } from './regex-engine.js';
import { safeRuntimeIssue } from './tavern-browser.js';
import { isResidentEnabled } from './extension-store.js';
import { buildReading } from './reading.js';
import { ReadingAssets } from './reading-assets.js';

const fault = (message, status = 400) => Object.assign(new Error(message), { status });
const scopeKey = scope => `${scope.type}:${scope.id}`;
const revision = items => createHash('sha256').update(JSON.stringify(items)).digest('hex');

/** One authoritative view of the selected conversation's extension owners. */
export function registerScopeRoutes(on, { readBody, store, scopes, extensionStore, listSessions, getSessionInfo, readSessionMessages, runtime, residentManager,readingRuntime }) {
  let readingAssets;const readingCache=new Map();
  const context = async selection => {
    const sessionId = String(selection?.sessionId ?? '');
    if (sessionId) {
      let info;
      if(typeof getSessionInfo==='function')info=await getSessionInfo(sessionId);
      else {const result=await listSessions();const sessions=Array.isArray(result)?result:result?.rows??[];info=sessions.find(s=>s.id===sessionId);}
      if(!info||(info.writer!==true&&info.preset!=='writer'))throw Object.assign(fault('请选择真实的写作模式会话'),{code:'NOT_WRITER'});
    }
    const bindings = await store.loadBindings();
    const binding = (sessionId && bindings.bindings?.[sessionId]) || bindings.defaultBinding || {};
    const inspect = selection?.inspect === true || selection?.inspect === 'true';
    return {
      sessionId, inspect,
      presetId: inspect ? String(selection.presetId ?? '') : String(binding.presetId ?? ''),
      cardId: inspect ? String(selection.cardId ?? '') : String(binding.cardId ?? ''),
      provider: binding.provider ?? '', model: binding.model ?? '',
      writingEnabled: bindings.enabled !== false && binding.enabled !== false,
    };
  };
  const owner = async request => {
    const target = request.scope;
    if (!target || !['global', 'preset', 'character'].includes(target.type)) throw fault('缺少有效扩展来源');
    const listed = await scopes.list({ presetId:target.type === 'preset' ? target.id : '', cardId:target.type === 'character' ? target.id : '' });
    const found = listed.find(s => s.type === target.type && s.id === target.id);
    if (!found) throw fault('扩展所属素材已不存在',404);
    return found;
  };
  const itemsOf = (scope, kind) => kind === 'regex' ? scope.regex : scope.scripts;
  const verify = (scope, body) => {
    if (!['regex','helper'].includes(body.kind)) throw fault('扩展类型无效');
    if (typeof body.revision !== 'string' || revision(itemsOf(scope,body.kind)) !== body.revision) throw fault('来源内容已更新，请重新载入后编辑',409);
  };
  // Serialize route read/modify/write, including optimistic revision checks.
  let writes = Promise.resolve();
  const mutate = fn => { const pending = writes.then(fn,fn); writes = pending.catch(()=>{}); return pending; };

  on('GET','/extensions/scopes',async(_req,_res,url)=>{
    const selected = await context(Object.fromEntries(url.searchParams));
    const sources = await scopes.list(selected);
    const [presets,cards,settings] = await Promise.all([store.listPresets(),store.listCards(),extensionStore.load()]);
    const missing=[];if(selected.presetId&&!sources.some(s=>s.type==='preset'))missing.push('预设 '+selected.presetId+' 已不存在');if(selected.cardId&&!sources.some(s=>s.type==='character'))missing.push('角色卡 '+selected.cardId+' 已不存在');
    return {ok:true,context:selected,missing,sources:sources.map(s=>({...s,key:scopeKey(s),regexRevision:revision(s.regex),helperRevision:revision(s.scripts)})),
      presets:presets.map(p=>({id:p.id,name:p.name})),cards:cards.map(c=>({id:c.id,name:c.name})),template:settings.template,resident:settings.resident??{enabled:false,sessionIds:[]}};
  });
  on('POST','/extensions/resident',async req=>{
    const body=await readBody(req),selected=await context(body);
    if(!selected.sessionId||selected.inspect)throw fault('请先选择写作会话');
    await extensionStore.update(state=>{const ids=new Set(state.resident?.sessionIds??[]),disabled=new Set(state.resident?.disabledSessionIds??[]);if(body.enabled){ids.add(selected.sessionId);disabled.delete(selected.sessionId);}else{ids.delete(selected.sessionId);disabled.add(selected.sessionId);}return {...state,resident:{...state.resident,enabled:ids.size>0,sessionIds:[...ids],disabledSessionIds:[...disabled]}};});
    if(!body.enabled)await residentManager?.close(selected.sessionId);
    return {ok:true};
  });
  on('POST','/extensions/resident/default',async req=>{
    const body=await readBody(req);
    if(typeof body.enabled!=='boolean')throw fault('需要明确的默认开关值');
    await extensionStore.updateSection('resident',{defaultEnabled:body.enabled});
    if(!body.enabled)await residentManager?.dispose();
    return {ok:true};
  });
  on('GET','/session-panel',async(_req,_res,url)=>{
    const sessionId=url.searchParams.get('sessionId');
    let selected;
    try{selected=await context({sessionId});}catch(error){if(error.code==='NOT_WRITER')return {ok:true,writer:false};throw fault('写作配置暂时无法读取，请重试',502);}
    if(!sessionId)return {ok:true,writer:false};
    const settings=await extensionStore.load();
    const enabled=selected.writingEnabled&&isResidentEnabled(settings,sessionId);
    const runtime=enabled&&residentManager?await residentManager.inspect(sessionId):{active:false,busy:false,buttons:[]};
    return {ok:true,writer:true,writingEnabled:selected.writingEnabled,provider:selected.provider,model:selected.model,residentEnabled:!!enabled,...runtime};
  });
  on('GET','/reading',async(_req,_res,url)=>{
    const selected=await context({sessionId:url.searchParams.get('sessionId')});
    if(!selected.sessionId)throw fault('请选择写作会话');
    const session=await readSessionMessages?.(selected.sessionId);
    if(!session?.writer||session.error)throw fault('暂时无法读取写作会话',502);
    const {regex}=await scopes.resolve(selected);
    const card=selected.cardId?await store.getCard(selected.cardId):null;
    try{
      const key=revision([selected,session.messages,regex,card?.name]);
      const cached=readingCache.get(selected.sessionId);
      if(cached?.key===key&&cached.expires>Date.now())return cached.value;
      readingAssets??=new ReadingAssets(store.root);
      const value={ok:true,...await buildReading({messages:session.messages,scripts:regex,char:card?.name??'',assets:readingAssets}),model:selected.model};
      if(readingCache.size>=8)readingCache.delete(readingCache.keys().next().value);
      readingCache.set(selected.sessionId,{key,value,expires:Date.now()+60000});return value;
    }
    catch{throw fault('显示处理未完成，请切回原始对话或检查正则',422);}
  });
  on('GET','/runtime-surface',async(_req,_res,url)=>{
    const selected=await context({sessionId:url.searchParams.get('sessionId')});
    if(!selected.sessionId||!residentManager)throw fault('请选择写作会话');
    const settings=await extensionStore.load();if(!isResidentEnabled(settings,selected.sessionId))throw fault('常驻运行尚未启用');
    try{return {ok:true,...await residentManager.surface(selected.sessionId)};}catch{throw fault('请先启动扩展，并等待当前操作结束',409);}
  });
  on('POST','/reading/document',async req=>{
    const body=await readBody(req),selected=await context(body);if(!selected.sessionId||!readingRuntime)throw fault('请选择写作会话');
    const entry=readingCache.get(selected.sessionId),row=entry?.value?.messages.flatMap(message=>message.parts??[message]).find(row=>row.id===body.messageId);
    if(!row?.interactive)throw fault('请刷新阅读内容后重试',409);
    try{return {ok:true,...await readingRuntime.render(selected.sessionId,row,body.width)};}catch{throw fault('完整美化暂时无法加载，请刷新或切回原文',422);}
  });
  on('POST','/reading/document/action',async req=>{
    const body=await readBody(req),selected=await context(body);if(!selected.sessionId||!readingRuntime)throw fault('请选择写作会话');
    try{return {ok:true,...await readingRuntime.act(selected.sessionId,String(body.messageId),String(body.token),body.input)};}catch{throw fault('美化页面已过期或操作未完成，请重新加载',409);}
  });
  on('POST','/session-panel/action',async req=>{
    const body=await readBody(req),selected=await context(body);
    if(!selected.sessionId||!residentManager||!['activate','button','surface'].includes(body.action))throw fault('操作无效');
    if(!selected.writingEnabled)throw fault('写作接管已停用，请先在写作配置中启用');
    const session=await readSessionMessages?.(selected.sessionId);
    if(!session?.writer||session.error)throw fault('无法读取写作会话',502);
    const saved=await store.loadBindings();
    const binding=saved.bindings?.[selected.sessionId]??saved.defaultBinding??{};
    const card=binding.cardId?await store.getCard(binding.cardId):null;
    let transaction;
    try{
      transaction=await residentManager.prepare({sessionId:selected.sessionId,binding,card,conversation:session.messages,interaction:true});
      if(!transaction)throw fault('请先在扩展页开启本会话常驻运行');
      if(body.action==='activate')return await transaction.activate();
      if(body.action==='surface')return await transaction.interact(body.input??{});
      if(typeof body.scriptId!=='string'||typeof body.name!=='string')throw fault('按钮无效');
      return await transaction.clickButton(body.scriptId,body.name);
    }catch(error){
      if(error.status)throw error;
      const issue=safeRuntimeIssue(error);
      throw fault(`脚本操作未完成：${issue.category}${issue.api?' / '+issue.api:''}`,409);
    }finally{await transaction?.finish();}
  });
  on('POST','/extensions/scope/allowed',async req=>{
    const body=await readBody(req);
    return mutate(async()=>{const source=await owner(body);await scopes.setAllowed({...source,kind:body.kind,enabled:body.enabled===true});return {ok:true};});
  });
  on('POST','/extensions/scope/save',async req=>{
    const body=await readBody(req);
    return mutate(async()=>{const source=await owner(body);verify(source,body);await scopes.replace({...source,kind:body.kind,items:body.items});return {ok:true};});
  });
  on('POST','/extensions/scope/import',async req=>{
    const body=await readBody(req);
    return mutate(async()=>{
      const source=await owner(body);verify(source,body);
      let value=body.data;
      // Raw role-card JSON uses data.extensions; normal preset JSON uses extensions.
      const ext=value?.data?.extensions??value?.extensions;
      if(body.kind==='regex')value=ext?.regex_scripts??value?.regex_scripts??value;
      else if(ext)value=helperSettings(ext).scripts;
      else if(value?.tavern_helper||value?.TavernHelper_scripts)value=helperSettings(value).scripts;
      else if(!Array.isArray(value)&&value?.type!=='folder')value=value?.scripts??value;
      const items=Array.isArray(value)?value:[value];
      await scopes.importItems({...source,kind:body.kind,items});
      return {ok:true,imported:items.length};
    });
  });
  on('POST','/extensions/scope/preview',async req=>{
    const body=await readBody(req);const selected=await context(body);
    const resolved=await scopes.resolve(selected);
    const text=String(body.text??'');if(text.length>200000)throw fault('预览文本超过 200000 字符');
    const card=selected.cardId?await store.getCard(selected.cardId):null;
    const scene={placement:Number(body.placement??2),depth:Number(body.depth??0),char:card?.name??'',user:'用户'};
    const raw=await applyScriptsSafe(resolved.regex,text,scene);
    const result=raw.ok?await applyScriptsSafe(resolved.regex,raw.output,{...scene,...(body.mode==='display'?{isMarkdown:true}:{isPrompt:true})}):raw;
    return {ok:true,result,context:selected};
  });
  on('POST','/extensions/scope/run',async req=>{
    const body=await readBody(req);const selected=await context(body);
    if(!selected.sessionId||selected.inspect)throw fault('运行脚本需选择实际写作会话，素材浏览不可执行');
    const source=await owner(body);verify(source,{...body,kind:'helper'});
    if(source.type==='preset'&&source.id!==selected.presetId || source.type==='character'&&source.id!==selected.cardId)throw fault('该脚本不属于此会话当前的素材');
    const resolved=await scopes.resolve(selected);
    const script=resolved.scripts.find(s=>s.scopeType===source.type&&s.scopeId===source.id&&s.id===body.scriptId);
    if(!script)throw fault('来源、文件夹或脚本未启用，或脚本已移除');
    const session=await readSessionMessages(selected.sessionId);
    if(session?.error||!session?.writer)throw fault(session?.error??'无法读取写作会话',502);
    const snapshot=await extensionStore.sessionVars(selected.sessionId);
    const key=JSON.stringify([source.type,source.id,script.id]);
    const result=await runtime.runHelperScript({script,variables:snapshot.vars,scriptVariables:snapshot.scriptVars?.[key]??script.data??{},chatMessages:session.messages,context:{model:selected.model,user:'用户'}});
    // Do not commit a result computed against material that changed during execution.
    const after=await owner(body);verify(after,{...body,kind:'helper'});
    const current=await context(body);
    if(current.presetId!==selected.presetId||current.cardId!==selected.cardId)throw fault('会话绑定已变化，本次变量未保存',409);
    const stillEnabled=(await scopes.resolve(current)).scripts.some(s=>s.scopeType===source.type&&s.scopeId===source.id&&s.id===script.id);
    if(!stillEnabled)throw fault('脚本或来源已停用，本次变量未保存',409);
    await extensionStore.saveSessionVars(selected.sessionId,{vars:result.variables,messageVars:snapshot.messageVars,scriptVars:{...snapshot.scriptVars,[key]:result.scriptVariables},expectedVersion:snapshot.version});
    return {ok:true,result:result.result,logs:result.logs,source:scopeKey(source)};
  });
}
