import assert from 'node:assert/strict';
import {registerScopeRoutes} from '../lib/scope-routes.js';
const routes=new Map();let preset='writer',listCalls=0;
registerScopeRoutes((method,path,handler)=>routes.set(method+' '+path,handler),{
  store:{loadBindings:async()=>({defaultBinding:{provider:'fixture',model:'synthetic-model'},bindings:{}})},
  extensionStore:{load:async()=>({resident:{defaultEnabled:true}})},
  listSessions:async()=>{listCalls++;return [{id:'blank',preset:'standard'}];},
  getSessionInfo:async id=>id==='blank'?{id,preset,writer:preset==='writer'}:null,
  residentManager:{inspect:async()=>({active:false,busy:false,buttons:[]})},
});
const read=routes.get('GET /session-panel');
const url=new URL('http://local/session-panel?sessionId=blank');
let result=await read(null,null,url);
assert.equal(result.writer,true,'a live blank-session preset overrides stale list metadata');
assert.equal(result.model,'synthetic-model');assert.equal(result.residentEnabled,true);
assert.equal(listCalls,0,'panel reads do not scan all user sessions');
preset='standard';result=await read(null,null,url);assert.equal(result.writer,false);
result=await read(null,null,new URL('http://local/session-panel?sessionId=missing'));assert.equal(result.writer,false);
console.log('session-panel: live preset switch, stale-list isolation and unknown-session rejection passed');
