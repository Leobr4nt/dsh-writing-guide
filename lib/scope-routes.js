import { helperSettings } from './extension-scopes.js';
import { createHash } from 'node:crypto';
import { applyScriptsSafe } from './regex-engine.js';

const fault = (message, status = 400) => Object.assign(new Error(message), { status });
const scopeKey = scope => `${scope.type}:${scope.id}`;
const revision = items => createHash('sha256').update(JSON.stringify(items)).digest('hex');

/** One authoritative view of the selected conversation's extension owners. */
export function registerScopeRoutes(on, { readBody, store, scopes, extensionStore, listSessions, readSessionMessages, runtime }) {
  const context = async selection => {
    const sessionId = String(selection?.sessionId ?? '');
    if (sessionId) {
      const result = await listSessions();
      const sessions = Array.isArray(result) ? result : result?.rows ?? [];
      if (!sessions.some(s => s.id === sessionId && (s.writer || s.preset === 'writer'))) throw fault('请选择真实的写作模式会话');
    }
    const bindings = await store.loadBindings();
    const binding = (sessionId && bindings.bindings?.[sessionId]) || bindings.defaultBinding || {};
    const inspect = selection?.inspect === true || selection?.inspect === 'true';
    return {
      sessionId, inspect,
      presetId: inspect ? String(selection.presetId ?? '') : String(binding.presetId ?? ''),
      cardId: inspect ? String(selection.cardId ?? '') : String(binding.cardId ?? ''),
      provider: binding.provider ?? '', model: binding.model ?? '',
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
      presets:presets.map(p=>({id:p.id,name:p.name})),cards:cards.map(c=>({id:c.id,name:c.name})),template:settings.template};
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
    let result;
    if(body.mode==='display')result=await applyScriptsSafe(resolved.regex,text,{...scene,isMarkdown:true});
    else {const raw=await applyScriptsSafe(resolved.regex,text,scene);result=raw.ok?await applyScriptsSafe(resolved.regex,raw.output,{...scene,isPrompt:true}):raw;}
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
