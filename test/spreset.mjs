import assert from 'node:assert/strict';import {spresetSettings,presetRegexes,applySPresetRequest,spresetOutput,spresetFinalRequest,spresetTool,postProcessMessages} from '../lib/spreset.js';
import {createSessionHook} from '../lib/session-hook.js';
const rule=id=>({id,findRegex:'/x/',replaceString:'y',placement:[2]});
const preset={extensions:{regex_scripts:[rule('same'),rule('native')],SPreset:{RegexBinding:{regexes:[{...rule('same'),replaceString:'bound'},rule('bound')]}}}};
assert.deepEqual(presetRegexes(preset).map(r=>r.id),['same','bound','native']);assert.equal(presetRegexes(preset)[0].replaceString,'bound');
assert.equal(spresetSettings({prompts:[{identifier:'SPresetSettings',content:'{"MacroNest":true}'}]}).MacroNest,true);
const run=async(config,messages)=>{const plan={messages,meta:{}};await applySPresetRequest(plan,{extensions:{SPreset:config},prompt_order:[{order:[{identifier:'tool',enabled:true}]}]});return plan;};
let plan=await run({ChatSquash:{enabled:true,role:'assistant',user_prefix:'U:',char_prefix:'A:',user_suffix:';',char_suffix:'!'}},[{role:'user',content:'hi'},{role:'user',content:'again'},{role:'assistant',content:'ok'}]);
assert.deepEqual(plan.messages,[{role:'assistant',content:'U:hiagain;A:ok!'}]);
plan=await run({ChatSquash:{enabled:true,re_split:true,role:'assistant',user_prefix:'U:',char_prefix:'A:',user_suffix:';',char_suffix:'!'}},[{role:'user',content:'hi'},{role:'assistant',content:'ok'}]);
assert.deepEqual(plan.messages,[{role:'user',content:'hi'},{role:'assistant',content:'ok'}]);
plan=await run({ChatSquash:{enabled:true,conditional_enabled:true,conditional_tag:'[JOIN]',role:'user',user_prefix:'',user_suffix:''}},[{role:'user',content:'[JOIN]a'},{role:'user',content:'b'}]);assert.equal(plan.messages[0].content,'ab');
plan=await run({ChatSquash:{enabled:false,squashed_post_script_enable:true,squashed_post_script:'messages=>messages.map(m=>({...m,content:m.content.toUpperCase()}))'}},[{role:'user',content:'hi'}]);assert.equal(plan.messages[0].content,'HI');
const row={role:'system',content:'example'};Object.defineProperty(row,'promptId',{value:'structured'});
plan=await run({MessageInjections:{structured:{enabled:true,toolCalls:[{id:'c',name:'lookup',arguments:{x:1}}],toolResults:[{toolCallId:'c',content:'ok'}]}}},[row]);assert.equal(plan.messages[0].role,'assistant');assert.equal(plan.messages[1].role,'tool');assert.equal(plan.messages[1].tool_call_id,'c');
assert.equal(await spresetOutput({OutputPreprocessing:{enabled:true,script:'({buffer})=>({output:buffer.toUpperCase(),hold:"!"})'}},'hi'),'HI!');
await assert.rejects(spresetOutput({OutputPreprocessing:{enabled:true,script:'()=>process.env'}},'hi'),/SPRESET_SCRIPT_FAILED/);
const code='return {name:"double",description:"test",parameters:{type:"object",properties:{x:{type:"number"}}},action:({x})=>x*2};';
plan=await run({ToolBindings:{tool:{valid:true,enabled:true,code}}},[{role:'user',content:'test'}]);assert.equal(plan.spreset.tools[0].function.name,'double');assert.equal(await spresetTool(code,{x:4}),8);assert.ok(!JSON.stringify(plan).includes('action'));
const body={model:'safe',max_tokens:128,messages:[{role:'user',content:'x'}],stream:false};const final=await spresetFinalRequest({FinalRequestProcessing:{enabled:true,script:'({request})=>({...request,model:"other",temperature:0.3})'}},body);assert.equal(final.model,'safe');assert.equal(final.temperature,0.3);
assert.equal((await spresetFinalRequest({FinalRequestProcessing:{enabled:true,script:'({request})=>{request.temperature=0.8;}' }},body)).temperature,0.8);
assert.deepEqual(postProcessMessages([{role:'assistant',content:'a'},{role:'system',content:'b'}],'strict').map(m=>m.role),['user','assistant','user']);
assert.equal(postProcessMessages([{role:'assistant',content:'a'}],'single',{char:'Fixture'})[0].content,'Fixture: a');
plan=await run({ForcedPostProcessing:{enabled:true,mode:'merge'}},[{role:'system',content:'a'},{role:'system',content:'b'}]);assert.equal(plan.messages[0].content,'a\n\nb');
console.log('spreset: regex precedence, squash, structured history, isolated processors, tools and request controls passed');
{
  const preset={id:'p',prompts:[{identifier:'main',content:'<%= "EXAMPLE" %>'}],prompt_order:[{order:[{identifier:'main',enabled:true}]}],extensions:{SPreset:{MessageInjections:{main:{enabled:true,toolCalls:[{id:'x',name:'fixture',arguments:{}}],toolResults:[{toolCallId:'x',content:'result'}]}}}}};
  let captured;
  const hook=createSessionHook({store:{getPreset:async()=>preset,listWorlds:async()=>[],loadSettings:async()=>({maxTokens:128})},extensionStore:{load:async()=>({template:{enabled:true,allowedPresetIds:['p']}}),sessionVars:async()=>({vars:{},version:0})},scopes:{resolve:async()=>({regex:[],scripts:[]})},runTemplateBatch:async()=>({texts:['EXAMPLE'],variables:{},messageVariables:{}}),diagnostics:new Map(),transport:async({plan})=>{captured=plan.messages;return {ok:true,finish:'stop',content:'ACK'};}});
  for await(const _ of hook({messages:[{role:'user',source:{kind:'user'},content:'test'}]},'s',{presetId:'p',provider:'fixture',model:'m',worldSelection:'none'})){}
  assert.equal(captured[0].tool_calls[0].function.name,'fixture');assert.equal(captured[1].role,'tool');
}
