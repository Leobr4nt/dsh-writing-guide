/** Metadata-only acceptance for a local validation-suite.json; never print source/error text. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ejs from 'ejs';
import { GuideStore } from '../lib/store.js';
import { ExtensionStore } from '../lib/extension-store.js';
import { ExtensionScopes, flattenEnabled } from '../lib/extension-scopes.js';
import { createSessionHook } from '../lib/session-hook.js';
import { runTemplateBatch, runHelperScript } from '../lib/extension-runtime.js';

const [manifestPath, reportPath] = process.argv.slice(2);
const knownApis = ['getvar','setvar','getVariables','replaceVariables','updateVariablesWith','insertOrAssignVariables',
  'getChatMessages','getLastMessageId','getScriptId','getAllVariables','getwi','getchar','getWorldbook',
  'getWorldbookEntries','replaceWorldbook','updateWorldbookWith','eventOn','eventOnce','eventEmit',
  'waitGlobalInitialized','registerVariableSchema','Mvu','SillyTavern','TavernHelper','document','window','fetch','jQuery','_','z','$'];
const hash = data => createHash('sha256').update(data).digest('hex');
const changedKeys = (before, after) => new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]
  .filter(k => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]))).size;
const moduleSyntax = source => /\bimport\s*(?:\(|["'{*]|[A-Za-z_$][\w$]*\s+from)/.test(source);
const compile = (source, asyncMode) => {
  try { ejs.compile(source,{client:true,compileDebug:false,async:asyncMode}); return true; } catch { return false; }
};
function failure(error, { source = '', kind = '' } = {}) {
  // Inspect in memory, emit only fixed technical identifiers; never persist error.message.
  const text = String(error?.message ?? '');
  if (kind === 'helper' && source.length > 300_000) return { category:'SCRIPT_SIZE_LIMIT' };
  if (kind === 'template' && !compile(source,false)) return { category:compile(source,true)?'ASYNC_TEMPLATE_UNSUPPORTED':'TEMPLATE_COMPILE_FAILURE' };
  if (kind === 'helper' && moduleSyntax(source) && /SyntaxError|expect|import|parse/i.test(text)) return {category:'MODULE_IMPORT_UNSUPPORTED'};
  if (/超时|interrupted|out of memory/i.test(text)) return {category:'EXECUTION_LIMIT'};
  if (/超过|上限/.test(text)) return {category:'INPUT_OR_OUTPUT_LIMIT'};
  if (/未完成异步/.test(text)) return {category:'ASYNC_LIFECYCLE_UNSUPPORTED'};
  if (/cannot read propert|undefined is not an object|cannot convert undefined or null|cannot read.*undefined/i.test(text)) return {category:'UNINITIALIZED_CONTEXT'};
  if (/模板选项|变量 flags|变量 results/.test(text)) return {category:'UNSUPPORTED_TEMPLATE_OPTION'};
  if (/变量作用域/.test(text)) return {category:'UNSUPPORTED_VARIABLE_SCOPE'};
  for (const api of knownApis) {
    if (text.includes(api) && /not defined|not a function|undefined|尚未支持|is not initialized/i.test(text)) return {category:'UNAVAILABLE_API',api};
  }
  if (/not defined|could not find|not initialized|undefined variable|not a function/i.test(text)) return {category:'MISSING_RUNTIME_BINDING'};
  return {category:'RUNTIME_FAILURE'};
}
const frequencies = items => Object.fromEntries([...new Set(items)].map(key => [key, items.filter(x => x === key).length]));

let stage = 'manifest';
try {
  if (!manifestPath || !reportPath) throw new Error('ARGUMENTS');
  const manifest = JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  const root = path.dirname(path.resolve(manifestPath));
  const store = new GuideStore(root), extensionStore = new ExtensionStore(root);
  const scopes = new ExtensionScopes({store,extensionStore});
  const watched = [...Object.values(manifest.inputs ?? {}).map(x => x.path),
    ...['settings.json','bindings.json','extensions.json'].map(x => path.join(root,x)),
    ...['presets','cards','worlds'].flatMap(d => fs.readdirSync(path.join(root,d)).filter(f=>f.endsWith('.json')).map(f=>path.join(root,d,f)))];
  const before = new Map(watched.map(file => [file,hash(fs.readFileSync(file))]));
  const bindings = await store.loadBindings(), binding = bindings.bindings?.[manifest.sessionId];
  if (!binding) throw new Error('BINDING_MISSING');
  const card = await store.getCard(binding.cardId), preset = await store.getPreset(binding.presetId);
  const sources = await scopes.list(binding), extensionState = await extensionStore.load();
  const snapshot = await extensionStore.sessionVars(manifest.sessionId);
  const result = {version:1, materialTextExposed:false, rawErrorsStored:false, networkModelRequests:0, externalModulesFetched:0,
    persistentWrites:0, scopeGates:sources.filter(s=>s.type!=='global').map(s=>({type:s.type,regexAllowed:s.regexAllowed,helperAllowed:s.helperAllowed})),
    templateGate:{enabled:extensionState.template?.enabled===true,selected:(extensionState.template?.allowedPresetIds??[]).includes(binding.presetId)},
  };
  stage='assemble';
  const request={messages:[{id:'metadata-acceptance',role:'user',source:{kind:'user'},content:[{type:'text',text:'兼容性状态验收'}]}]};
  let actualPlan;
  const previewVariables={load:()=>extensionStore.load(),sessionVars:id=>extensionStore.sessionVars(id)};
  const baselineHook=createSessionHook({store,extensionStore:previewVariables,scopes,diagnostics:new Map(),transport:async({plan})=>{actualPlan=plan;return {ok:true,content:'ACK',finish:'stop'};}});
  for await (const _ of baselineHook(request,manifest.sessionId,binding)) {}
  if (!actualPlan) throw new Error('ASSEMBLY_FAILED');
  const texts=actualPlan.meta.templateIndexes.map(i=>actualPlan.messages[i].content);
  result.assembly={worlds:actualPlan.meta.worldBookIds?.length??0,messages:actualPlan.messages.length,templateMessages:texts.filter(t=>t.includes('<%')).length};
  stage='template-inventory';
  const templateInventory=[];
  for(const book of await store.listWorlds()) {
    if (![manifest.styleWorldId,manifest.linkedWorldId].includes(book.id))continue;
    for(const entry of book.entries)if(entry.content?.includes('<%'))templateInventory.push({text:entry.content,enabled:!entry.disable});
  }
  for(const prompt of preset.prompts??[])if(prompt.content?.includes('<%'))templateInventory.push({text:prompt.content,enabled:true});
  result.templateSyntax={fragments:templateInventory.length,enabledFragments:templateInventory.filter(x=>x.enabled).length,
    currentCompilerPass:templateInventory.filter(x=>compile(x.text,false)).length,
    asyncCompilerPass:templateInventory.filter(x=>compile(x.text,true)).length};
  stage='template-execution';
  const context={char:card?.name??'',user:'用户',model:binding.model,chatMessages:[]};
  try {
    const rendered=await runTemplateBatch({texts,variables:snapshot.vars,messageVariables:snapshot.messageVars,context,seed:'suite-acceptance'});
    result.templateBatch={ok:true,outputs:rendered.texts.length,remainingTemplateMarkers:rendered.texts.filter(x=>x.includes('<%')).length,changedVariableKeys:changedKeys(snapshot.vars,rendered.variables)};
  } catch(error) { result.templateBatch={ok:false,...failure(error,{source:texts.join('\n'),kind:'template'})}; }
  const fragments=[];
  for(let i=0;i<texts.length;i++) {
    if(!texts[i].includes('<%'))continue;
    try {const rendered=await runTemplateBatch({texts:[texts[i]],variables:snapshot.vars,messageVariables:snapshot.messageVars,context,seed:'suite-acceptance'});fragments.push({index:i,ok:true,outputChars:rendered.texts[0].length});}
    catch(error){fragments.push({index:i,ok:false,...failure(error,{source:texts[i],kind:'template'})});}
  }
  result.activeTemplateFragments={tested:fragments.length,passed:fragments.filter(x=>x.ok).length,failures:fragments.filter(x=>!x.ok)};
  stage='template-library-probes';
  const library=[];
  for(let index=0;index<templateInventory.length;index++) {
    const fragment=templateInventory[index];
    try {
      await runTemplateBatch({texts:[fragment.text],variables:structuredClone(snapshot.vars??{}),messageVariables:structuredClone(snapshot.messageVars??{}),context,seed:'suite-acceptance'});
      library.push({index,enabled:fragment.enabled,executionReturned:true});
    } catch(error) {library.push({index,enabled:fragment.enabled,executionReturned:false,...failure(error,{source:fragment.text,kind:'template'})});}
  }
  result.libraryTemplateProbes={tested:library.length,executionReturned:library.filter(x=>x.executionReturned).length,
    failureCategories:frequencies(library.filter(x=>!x.executionReturned).map(x=>x.category)),
    note:'Independent probes with the current variable snapshot, not a simulation of ST activation order or successful MVU initialization.'};
  stage='generation-gate';
  let calls=0,commits=0,finish;
  const inMemory={load:async()=>({...extensionState,template:{enabled:true,allowedPresetIds:[binding.presetId]}}),sessionVars:async()=>structuredClone(snapshot),saveSessionVars:async()=>{commits++;}};
  const gated=createSessionHook({store,extensionStore:inMemory,scopes,runTemplateBatch,diagnostics:new Map(),transport:async()=>{calls++;return {ok:true,content:'ACK',finish:'stop'};}});
  for await(const chunk of gated(request,manifest.sessionId,binding))if(chunk.type==='finish')finish=chunk.reason.kind;
  result.enabledTemplatePath={finish,modelTransportCalls:calls,variableCommits:commits,changesPersisted:false};
  stage='helper-execution';
  const capabilityProbe=await runHelperScript({script:{id:'capability-probe',content:'return {mvu:typeof Mvu,eventOn:typeof eventOn,document:typeof document,window:typeof window,moduleState:typeof __mvuState};'}});
  result.runtimeCapabilities=capabilityProbe.result;
  const helperResults=[];
  for(const source of sources.filter(s=>s.type!=='global')) {
    const scripts=flattenEnabled(source.scripts,{requireEnabled:false});
    for(let index=0;index<scripts.length;index++) {
      const script=scripts[index].item, code=script.content;
      const dependencies=knownApis.filter(api=>{
        const escaped=api.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
        return new RegExp('(?:^|[^\\w$])'+escaped+'(?:[^\\w$]|$)').test(code);
      });
      const row={source:source.type,index,enabled:script.enabled===true,chars:code.length,moduleSyntax:moduleSyntax(code),technicalApiMarkers:dependencies};
      try {
        const run=await runHelperScript({script,variables:structuredClone(snapshot.vars??{}),scriptVariables:structuredClone(script.data??{}),chatMessages:[],context});
        Object.assign(row,{executionReturned:true,changedChatKeys:changedKeys(snapshot.vars,run.variables),changedScriptKeys:changedKeys(script.data,run.scriptVariables),logCount:run.logs?.length??0});
      }catch(error){Object.assign(row,{executionReturned:false,...failure(error,{source:code,kind:'helper'})});}
      helperResults.push(row);
    }
  }
  result.helpers={tested:helperResults.length,executionReturned:helperResults.filter(r=>r.executionReturned).length,
    failureCategories:frequencies(helperResults.filter(r=>!r.executionReturned).map(r=>r.category)),results:helperResults};
  result.mvu={moduleLoaderAvailable:false,persistentSharedScriptRuntimeAvailable:false,hostEventLifecycleAvailable:false,
    modelOutputVariableUpdateStageAvailable:false,initialized:false,updateVerified:false,
    evidence:'Capability probe plus installed extension-worker and session-hook code: isolated jobs, no module loader/event bus/output update stage.',
    reason:'Required MVU module and host lifecycle are not implemented by the installed runner; state initialization/update cannot pass.'};
  result.inputsAndStateUnchanged=watched.every(file=>hash(fs.readFileSync(file))===before.get(file));
  result.accepted=result.templateBatch.ok&&helperResults.every(r=>r.executionReturned)&&result.mvu.updateVerified;
  fs.writeFileSync(reportPath,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
  process.exitCode=result.accepted?0:2;
} catch {
  // Never print the caught error, which may include a protected material excerpt.
  console.log(JSON.stringify({accepted:false,infrastructureFailure:true,stage,materialTextExposed:false}));
  process.exitCode=1;
}
