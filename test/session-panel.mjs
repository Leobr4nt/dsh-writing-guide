import assert from 'node:assert/strict';
import {registerScopeRoutes} from '../lib/scope-routes.js';
const routes=new Map();let preset='writer',listCalls=0,inspectCalls=0;
const binding={provider:'fixture',model:'synthetic-model'};
let bindings={defaultBinding:binding,bindings:{}},bindingsError=null,sessionError=null;
registerScopeRoutes((method,path,handler)=>routes.set(method+' '+path,handler),{
  store:{loadSettings:async()=>({writingModes:['writer']}),loadBindings:async()=>{if(bindingsError)throw bindingsError;return bindings;}},
  extensionStore:{load:async()=>({resident:{defaultEnabled:true}})},
  listSessions:async()=>{listCalls++;return [{id:'blank',preset:'standard'}];},
  getSessionInfo:async id=>{if(sessionError)throw sessionError;return id==='blank'?{id,preset,writer:preset==='writer'}:null;},
  residentManager:{inspect:async id=>{inspectCalls++;assert.equal(id,'blank');return {active:true,busy:false,buttons:[{name:'synthetic-button'}]};}},
});
const read=routes.get('GET /session-panel');
const url=new URL('http://local/session-panel?sessionId=blank');
let result=await read(null,null,url);
assert.equal(result.writer,true,'a live blank-session preset overrides stale list metadata');
assert.equal(result.model,'synthetic-model');assert.equal(result.residentEnabled,true);
assert.equal(result.writingEnabled,true);assert.equal(result.active,true);assert.equal(inspectCalls,1);
assert.equal(listCalls,0,'panel reads do not scan all user sessions');
for(const [label,state] of [
  ['global disabled',{enabled:false,defaultBinding:binding,bindings:{}}],
  ['global disabled with enabled session',{enabled:false,defaultBinding:binding,bindings:{blank:{...binding,enabled:true}}}],
  ['session disabled',{enabled:true,defaultBinding:binding,bindings:{blank:{...binding,enabled:false}}}],
  ['default binding disabled',{enabled:true,defaultBinding:{...binding,enabled:false},bindings:{}}],
]){
  bindings=state;
  const before=inspectCalls;
  result=await read(null,null,url);
  assert.deepEqual(result,{ok:true,writer:true,writingEnabled:false,provider:'fixture',model:'synthetic-model',residentEnabled:false,active:false,busy:false,buttons:[]},label);
  assert.equal(inspectCalls,before,label+' must not inspect the runtime');
}
bindings={enabled:true,defaultBinding:{...binding,enabled:false},bindings:{blank:{...binding,enabled:true}}};
result=await read(null,null,url);
assert.equal(result.writingEnabled,true,'an enabled session overrides a disabled default binding');
assert.equal(result.residentEnabled,true);assert.equal(result.active,true);assert.equal(inspectCalls,2);

bindings={defaultBinding:binding,bindings:{}};
for(const source of ['session','bindings']){
  const raw=new Error('SYNTHETIC_RAW_'+source+'_DETAIL');
  if(source==='session')sessionError=raw;else bindingsError=raw;
  const before=inspectCalls;
  await assert.rejects(read(null,null,url),error=>{
    assert.equal(error.status,502,source+' read failure must not become writer:false');
    assert.equal(error.message,'写作配置暂时无法读取，请重试');
    assert.doesNotMatch(String(error.stack)+JSON.stringify(error),/SYNTHETIC_RAW_/,'raw failure details must not escape');
    return true;
  });
  assert.equal(inspectCalls,before,'failed context must not inspect the runtime');
  sessionError=null;bindingsError=null;
}
preset='standard';result=await read(null,null,url);assert.deepEqual(result,{ok:true,writer:false});
result=await read(null,null,new URL('http://local/session-panel?sessionId=missing'));assert.deepEqual(result,{ok:true,writer:false});
assert.equal(inspectCalls,2);assert.equal(listCalls,0);
console.log('session-panel: live preset, disabled bindings, runtime isolation and safe context failures passed');
