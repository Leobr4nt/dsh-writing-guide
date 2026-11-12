import assert from 'node:assert/strict';
import {registerScopeRoutes} from '../lib/scope-routes.js';
import {buildReading} from '../lib/reading.js';

const messages=Object.freeze([
  {id:'synthetic-user',role:'user',content:'SEED'},
  {id:'synthetic-old',role:'assistant',content:'SEED'},
  {id:'synthetic-latest',role:'assistant',content:'SEED'},
].map(Object.freeze));
const original=structuredClone(messages);
// Display rules precede the common rule to catch a single-pass or reversed-phase preview.
const regex=[
  {id:'assistant-display',findRegex:'/SEED_RAW/g',replaceString:'ASSISTANT_DISPLAY',placement:[2],markdownOnly:true,maxDepth:0},
  {id:'user-display',findRegex:'/SEED_RAW/g',replaceString:'USER_DISPLAY',placement:[1],markdownOnly:true},
  {id:'common',findRegex:'/SEED/g',replaceString:'SEED_RAW',placement:[1,2]},
  {id:'prompt-only',findRegex:'/SEED|DISPLAY/g',replaceString:'SEND_ONLY',placement:[1,2],promptOnly:true},
  {id:'disabled',findRegex:'/SEED|DISPLAY/g',replaceString:'DISABLED',placement:[1,2],markdownOnly:true,disabled:true},
];
const originalRules=structuredClone(regex),routes=new Map();
registerScopeRoutes((method,path,handler)=>routes.set(method+' '+path,handler),{
  readBody:async request=>request,
  store:{loadBindings:async()=>({defaultBinding:{presetId:'synthetic-preset'},bindings:{}})},
  getSessionInfo:async id=>({id,preset:'writer',writer:true}),
  scopes:{resolve:async selected=>{
    assert.equal(selected.sessionId,'synthetic-session');assert.equal(selected.presetId,'synthetic-preset');
    return {regex,scripts:[]};
  }},
});
const preview=routes.get('POST /extensions/scope/preview');
const reading=await buildReading({messages,scripts:regex});
const expected=['USER_DISPLAY','SEED_RAW','ASSISTANT_DISPLAY'];
assert.deepEqual(reading.messages.map(row=>row.text),expected,'common rules precede display rules and honor role/depth');
assert.deepEqual(messages,original,'reading must not change source history');
for(let index=0;index<messages.length;index++){
  const row=messages[index];
  const request=Object.freeze({sessionId:'synthetic-session',text:row.content,mode:'display',placement:row.role==='user'?1:2,depth:messages.length-1-index});
  // Repeat against the same source to detect accumulated replacements.
  for(let repeat=0;repeat<2;repeat++){
    const result=await preview(request);
    assert.equal(result.ok,true);assert.equal(result.result.ok,true);
    assert.equal(result.result.output,expected[index],row.id+' preview must apply each phase exactly once');
    assert.equal(result.result.output,reading.messages[index].text,row.id+' preview must match actual reading');
  }
  assert.equal(reading.messages[index].original,original[index].content);
  assert.equal(request.text,original[index].content);
  assert.deepEqual(messages,original,'preview must not change source history');
}
assert.deepEqual(regex,originalRules,'preview and reading must not mutate shared rules');
console.log('regex-preview-parity: common/display order, prompt-only exclusion, role/depth, repeatability and original history preservation passed');
