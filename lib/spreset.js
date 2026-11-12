import {runExtensionJob} from './extension-runtime.js';
import {applyScriptsSafe} from './regex-engine.js';
import {replaceNameMacros} from './name-macros.js';
const record=value=>value&&typeof value==='object'&&!Array.isArray(value);
export function spresetSettings(preset){
  if(record(preset?.extensions?.SPreset))return preset.extensions.SPreset;
  const source=preset?.prompts?.find(prompt=>prompt.identifier==='SPresetSettings')?.content;
  if(!source)return {};
  try{const value=JSON.parse(source);return record(value)?value:{};}catch{throw Error('SPRESET_SETTINGS_INVALID');}
}
/** Upstream prefers its bound rules, appending native rules whose ids are not already bound. */
export function presetRegexes(preset){
  const bound=spresetSettings(preset).RegexBinding?.regexes;
  const native=preset?.extensions?.regex_scripts??[];
  if(!Array.isArray(bound)||!bound.length)return native;
  const ids=new Set(bound.map(rule=>rule.id).filter(Boolean));
  return [...bound,...native.filter(rule=>!rule.id||!ids.has(rule.id))];
}
const validateMessages=value=>{
  if(!Array.isArray(value)||value.length>1000)throw Error('SPRESET_MESSAGES_INVALID');
  for(const row of value)if(!record(row)||!['system','user','assistant','tool'].includes(row.role)||typeof row.content!=='string')throw Error('SPRESET_MESSAGE_INVALID');
  if(JSON.stringify(value).length>2_000_000)throw Error('SPRESET_OUTPUT_LIMIT');
  return value;
};
async function pureScript(source,input,signal){
  if(typeof source!=='string'||source.length>300000)throw Error('SPRESET_SCRIPT_INVALID');
  try{return (await runExtensionJob({kind:'spreset',code:source,input},{signal,timeoutMs:3000})).result;}
  catch(error){throw Object.assign(Error(error.code==='aborted'?'SPRESET_ABORTED':'SPRESET_SCRIPT_FAILED'),{code:error.code==='aborted'?'aborted':'SPRESET_SCRIPT_FAILED'});}
}
function injectedMessage(message,config){
  if(!config?.enabled)return [message];
  const calls=(config.toolCalls??[]).map(call=>({id:String(call.id??''),type:'function',function:{name:String(call.name??call.function?.name??''),arguments:typeof(call.arguments??call.function?.arguments)==='string'?(call.arguments??call.function.arguments):JSON.stringify(call.arguments??call.function?.arguments??{})}}));
  if(calls.some(call=>!call.id||!call.function.name))throw Error('SPRESET_TOOL_HISTORY_INVALID');
  const base={...message,...(calls.length?{role:'assistant',tool_calls:calls}:{})};
  const results=(config.toolResults??[]).map(result=>({role:'tool',tool_call_id:String(result.toolCallId??result.tool_call_id??''),content:typeof result.content==='string'?result.content:JSON.stringify(result.content??'')}));
  if(results.some(result=>!result.tool_call_id))throw Error('SPRESET_TOOL_HISTORY_INVALID');
  // Generic OpenAI-compatible text transport does not invent provider-specific signatures.
  return [base,...results];
}
export async function applySPresetRequest(plan,preset,{char='',user='用户',signal}={}){
  const config=spresetSettings(preset),notes=[];
  if((preset?.prompts??[]).some(prompt=>prompt.spreset_condition_enabled))throw Error('SPRESET_ENTRY_CONDITIONS_UNSUPPORTED');
  if(config.OutputPreprocessing?.enabled&&(config.OutputPreprocessing.consumeToolCalls||config.OutputPreprocessing.toolCallFormatter?.enabled))throw Error('SPRESET_OUTPUT_TOOL_FORMAT_UNSUPPORTED');
  if(config.MacroNest)notes.push('MacroNest: bounded recursive data macros');
  let messages=plan.messages.flatMap(row=>injectedMessage(row,config.MessageInjections?.[row.promptId]).map(value=>{
    if(row.promptId!==undefined)Object.defineProperty(value,'promptId',{value:row.promptId});return value;
  }));
  const squash=config.ChatSquash??{};
  if(squash.enabled){
    const tag=String(squash.conditional_tag??'');
    const enabled=!squash.conditional_enabled||(tag&&messages.some(m=>m.content.includes(tag)));
    if(enabled){
      if(squash.conditional_enabled)messages.forEach(message=>message.content=message.content.split(tag).join(''));
      const affix=text=>replaceNameMacros(text,{char,user});
      const prefix={user:affix(squash.user_prefix??'\n\nUser:'),assistant:affix(squash.char_prefix??'\n\nAssistant:'),system:affix(squash.prefix_system)};
      const suffix={user:affix(squash.user_suffix),assistant:affix(squash.char_suffix),system:affix(squash.suffix_system)};
      const merged=[];let buffer='',lastRole='',outputRole=squash.role==='follow'?(messages[0]?.role??'user'):squash.role??'assistant',lastHistory;
      const flush=async()=>{
        if(!buffer)return;let text=buffer+(suffix[lastRole]??'');
        if(squash.parse_clewd!==false&&/<regex(?:\s|>)/i.test(text))throw Error('SPRESET_INLINE_REGEX_UNSUPPORTED');
        if(squash.parse_clewd!==false)text=text.replace(/\s*<\|curtail\|>\s*/g,'\n').replace(/\s*<\|join\|>\s*/g,'').replace(/\s*<\|space\|>\s*/g,' ');
        if(squash.squashed_post_script_enable)text=await pureScript(squash.squashed_post_script,text,signal);
        if(typeof text!=='string')throw Error('SPRESET_SQUASH_RESULT');
        if(squash.re_split)merged.push(...splitSquashed(text,prefix,suffix));else merged.push({role:outputRole,content:text});
        buffer='';lastRole='';
      };
      for(let index=0;index<messages.length;index++){
        const original=messages[index],history=original.promptId===undefined;
        const row={...original,role:squash.user_role_system&&original.role==='system'?'user':original.role};let separate=!!row.tool_calls||row.role==='tool';
        if(squash.separate_chat_history&&!history){await flush();merged.push(row);lastHistory=history;continue;}
        if(squash.separate_chat_history&&lastHistory!==undefined&&history!==lastHistory)await flush();lastHistory=history;
        if(squash.parse_clewd!==false&&row.content.includes('<|no-trans|>')){row.content=row.content.replace('<|no-trans|>','');separate=true;}
        if(squash.enable_squashed_separator&&squash.squashed_separator_string){
          const result=await applyScriptsSafe([{findRegex:squash.squashed_separator_regex?squash.squashed_separator_string:escapePattern(squash.squashed_separator_string),replaceString:'',placement:[2]}],row.content,{placement:2});
          if(!result.ok)throw Error('SPRESET_SEPARATOR_FAILED');if(result.output!==row.content){separate=true;row.content=result.output;}
        }
        if(separate){await flush();merged.push(row);if(squash.role==='follow')outputRole=row.role;continue;}
        if(row.role!==lastRole){if(lastRole)buffer+=suffix[lastRole]??'';buffer+=prefix[row.role]??'';}buffer+=row.content;lastRole=row.role;
      }
      await flush();messages=merged;notes.push('ChatSquash');
    }
  }else if(squash.squashed_post_script_enable){messages=validateMessages(await pureScript(squash.squashed_post_script,messages,signal));notes.push('ChatSquash-script');}
  const forced=config.ForcedPostProcessing;
  if(forced?.enabled){
    const mode=forced.mode==='claude'?'merge':forced.mode;
    if(!['','merge','merge_tools','semi','semi_tools','strict','strict_tools','single'].includes(mode))throw Error('SPRESET_POSTPROCESS_MODE_UNSUPPORTED');
    if(mode)messages=postProcessMessages(messages,mode,{char,user});
    notes.push('ForcedPostProcessing');
  }
  const active=new Set(preset?.prompt_order?.[0]?.order?.filter(row=>row.enabled!==false).map(row=>row.identifier));
  const tools=[],toolCode={};
  for(const [id,binding]of Object.entries(config.ToolBindings??{}))if(binding.enabled&&binding.valid&&active.has(id)){
    const definition=await pureScript(`()=>{const tool=(()=>{${String(binding.code??'')}})();if(typeof tool.action!=='function')throw Error('TOOL_ACTION_REQUIRED');return {name:tool.name,description:tool.description,parameters:tool.parameters};}`,null,signal);
    if(!definition||!/^[\w-]{1,64}$/.test(definition.name??'')||definition.parameters?.type!=='object')throw Error('SPRESET_TOOL_DEFINITION');
    if(Object.hasOwn(toolCode,definition.name))throw Error('SPRESET_TOOL_DUPLICATE');
    tools.push({type:'function',function:definition});Object.defineProperty(toolCode,definition.name,{value:binding.code,enumerable:true});
  }
  validateMessages(messages);
  plan.messages=messages;
  Object.defineProperty(plan,'spreset',{value:{config,tools,toolCode,stop:squash.enable_stop_string?parseStops(squash.stop_string):undefined},configurable:true});
  const providerMetadataSkipped=Object.values(config.MessageInjections??{}).some(item=>item?.enabled&&(item.reasoning||item.signature));
  plan.meta.spreset={features:notes,toolCount:tools.length,providerMetadataSkipped};
  return plan;
}
export async function spresetTool(code,args,{signal}={}){
  return pureScript(`async input=>{const tool=(()=>{${code}})();return await tool.action(input);}`,args,signal);
}
const escapePattern=text=>String(text).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function parseStops(text){try{const parsed=JSON.parse(text);if(Array.isArray(parsed))return parsed.map(String);}catch{}return text?[String(text)]:undefined;}
export function postProcessMessages(source,mode,{char='',user='用户'}={}){
  const preserveTools=mode.endsWith('_tools'),single=mode==='single',strict=single||mode.startsWith('semi')||mode.startsWith('strict');
  let messages=source.map(value=>{
    const row={...value};
    if(!preserveTools){delete row.tool_calls;delete row.tool_call_id;if(row.role==='tool')row.role='user';}
    if(single){const name=row.role==='assistant'?char:row.role==='user'?user:'';if(name&&!row.content.startsWith(name+': '))row.content=name+': '+row.content;row.role='user';}
    return row;
  });
  const merge=list=>{const out=[];for(const row of list){const prev=out.at(-1);if(prev&&prev.role===row.role&&row.content&&row.role!=='tool'&&!prev.tool_calls&&!row.tool_calls)prev.content+='\n\n'+row.content;else out.push({...row});}return out;};
  messages=merge(messages);if(!messages.length)messages=[{role:'user',content:"Let's get started."}];
  if(strict){messages=messages.map((row,index)=>index>0&&row.role==='system'?{...row,role:'user'}:row);
    if(mode.startsWith('strict')){const index=messages[0].role==='system'?1:0;if(messages[index]?.role!=='user')messages.splice(index,0,{role:'user',content:"Let's get started."});}
    messages=merge(messages);
  }return messages;
}
function splitSquashed(text,prefix,suffix){
  const rows=[];let remaining=text;const roles=['user','assistant','system'];
  for(let guard=0;remaining.length&&guard<1000;guard++){
    const role=roles.find(role=>prefix[role]&&remaining.startsWith(prefix[role]));
    if(!role)throw Error('SPRESET_RESPLIT_PREFIX');
    remaining=remaining.slice(prefix[role].length);let end=remaining.length;
    for(const key of roles)if(prefix[key]){const index=remaining.indexOf(prefix[key]);if(index>=0&&index<end)end=index;}
    let content=remaining.slice(0,end);if(suffix[role]&&content.endsWith(suffix[role]))content=content.slice(0,-suffix[role].length);
    if(content.trim())rows.push({role,content:content.trim()});remaining=remaining.slice(end);
  }
  if(remaining)throw Error('SPRESET_RESPLIT_LIMIT');return rows;
}
export async function spresetOutput(config,text,{signal}={}){
  const processor=config?.OutputPreprocessing;if(!processor?.enabled)return text;
  const result=await pureScript(processor.script,{buffer:text,chunk:text,raw:text,hold:'',output:'',state:{},final:true,stream:false,channel:'main'},signal);
  if(typeof result==='string')return result;
  if(!record(result)||!['output','emit','text','content'].some(key=>Object.hasOwn(result,key)))throw Error('SPRESET_OUTPUT_INVALID');
  return String(result.output??result.emit??result.text??result.content??'')+String(result.hold??'');
}
export async function spresetFinalRequest(config,body,{signal,provider=''}={}){
  if(!config?.FinalRequestProcessing?.enabled)return body;
  const code=`async input=>{const processRequest=(${config.FinalRequestProcessing.script.trim().replace(/;\s*$/,'')});const result=await processRequest(input);return result===undefined?input.request:result;}`;
  const result=await pureScript(code,{request:body,provider:{adapter:'openai',source:provider,model:body.model},model:body.model,source:provider,stream:false,preview:false},signal);
  if(!record(result)||!Array.isArray(result.messages))throw Error('SPRESET_FINAL_REQUEST_INVALID');
  validateMessages(result.messages);
  return {...result,model:body.model,stream:false,max_tokens:body.max_tokens,...(body.tools?{tools:body.tools}:{})};
}
