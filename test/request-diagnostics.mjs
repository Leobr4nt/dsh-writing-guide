import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {apply} from '../index.js';
import {GuideStore} from '../lib/store.js';
import {postChatCompletion} from '../lib/chat-transport.js';
import {writingDiagnostic,writingBindingSummary} from '../lib/diagnostics.js';

// These sentinels are synthetic; neither serializer may return private payload fields.
const privateText='SYNTHETIC_PRIVATE_PAYLOAD';
const record={
  at:'2026-01-01T00:00:00.000Z',phase:'failed',requestSent:true,writingRoute:'fixture/model',
  messages:5,roles:['system','user','assistant','tool','unknown'],effectiveWorldIds:['w1','w2'],outputCap:128,
  error:{code:'SYNTHETIC_PRIVATE_CODE',message:privateText},card:privateText,
  variables:{secret:privateText},providerBody:privateText,entries:[privateText],spreset:{script:privateText},
};
const recordBefore=structuredClone(record);
assert.deepEqual(writingDiagnostic(record),{
  at:record.at,phase:'failed',requestSent:true,writingRoute:'fixture/model',messages:5,
  roles:{system:1,user:1,assistant:1},worlds:2,outputCap:128,errorCode:'WRITING_GUIDE_FAILED',
});
assert.equal(writingDiagnostic({...record,error:{code:'ABORTED',message:privateText}}).errorCode,'ABORTED');
assert.equal(writingDiagnostic({...record,error:null}).errorCode,null);
assert.equal(writingDiagnostic({...record,requestSent:'true'}).requestSent,false);
assert.equal(writingDiagnostic(null),null);
assert.deepEqual(record,recordBefore);

const binding={
  presetId:'fixture-preset',cardId:'',worldIds:[],provider:'fixture',model:'model',maxTokens:128,
  contextWindow:0,worldSelection:'none',useCardBook:false,enabled:true,authorNote:privateText,
  variables:{secret:privateText},apiKey:privateText,prompt:privateText,
};
const bindingBefore=structuredClone(binding);
assert.deepEqual(writingBindingSummary(binding),{
  presetId:'fixture-preset',cardId:'',worldIds:[],provider:'fixture',model:'model',maxTokens:128,
  contextWindow:0,worldSelection:'none',useCardBook:false,enabled:true,hasAuthorNote:true,
});
assert.equal(writingBindingSummary({...binding,authorNote:''}).hasAuthorNote,false);
assert.equal(writingBindingSummary(null),null);
assert.deepEqual(binding,bindingBefore);
assert.doesNotMatch(JSON.stringify([writingDiagnostic(record),writingBindingSummary(binding)]),/SYNTHETIC_PRIVATE_/);

const root=await fs.mkdtemp(path.join(os.tmpdir(),'wg-request-diagnostics-'));
const cleanup=[],captured=[],beforeSend=[],tools=new Map(),events=new Map();
let handler,diagnostic,providerAvailable=false,responseStatus=200,serverError;
const server=http.createServer(async(req,res)=>{
  try{
    let raw='';for await(const chunk of req)raw+=chunk;
    captured.push({url:req.url,body:JSON.parse(raw),during:await diagnostic()});
    res.writeHead(responseStatus,{'content-type':'application/json'});
    res.end(JSON.stringify(responseStatus===200
      ?{choices:[{message:{role:'assistant',content:'SYNTHETIC_REPLY'},finish_reason:'stop'}]}
      :{error:'SYNTHETIC_PRIVATE_PROVIDER_BODY'}));
  }catch(error){serverError=error;res.writeHead(500);res.end('{}');}
});
try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const store=new GuideStore(root);await store.ensure();
  await store.saveSettings({includeWorlds:false,maxTokens:128});
  const preset={
    id:'fixture-preset',name:'Synthetic preset',
    prompts:[{identifier:'main',role:'system',content:'SYNTHETIC_MAIN'},{identifier:'chatHistory',marker:true}],
    prompt_order:[{order:[{identifier:'main',enabled:true},{identifier:'chatHistory',enabled:true}]}],
    extensions:{SPreset:{FinalRequestProcessing:{enabled:true,
      script:'({request})=>({...request,messages:[...request.messages,{role:"assistant",content:"SYNTHETIC_FINAL_ASSISTANT"},{role:"system",content:"SYNTHETIC_FINAL_SYSTEM"}]})',
    }}},
  };
  await store.savePreset(preset);
  await store.saveBindings({enabled:true,defaultBinding:binding,bindings:{'fixture-session':binding}});
  const services={
    settings:{describe:()=>providerAvailable?[{ns:'dsh-llm-pi-ai',value:{providers:{fixture:{
      api:'openai-completions',baseURL:origin+'/v1',apiKeyEnv:'SYNTHETIC_KEY_REF',models:[{id:'model'}],
    }}}}]:[]},
    credentials:{resolve:async ref=>{
      assert.equal(ref,'SYNTHETIC_KEY_REF');beforeSend.push(await diagnostic());
      return {value:'SYNTHETIC_TEST_KEY'};
    }},
    connection:{requestRejection:()=>null},
    sessions:{get:id=>({id,header:{agentPreset:'writer'}})},
    agentPresets:{presetForSession:()=> 'writer'},
    tools:{register:tool=>{tools.set(tool.name,tool);return ()=>tools.delete(tool.name);}},
  };
  const ctx={
    get:name=>services[name],
    effect:fn=>{const dispose=fn();if(typeof dispose==='function')cleanup.push(dispose);},
    on:(name,fn)=>{events.set(name,fn);return ()=>events.delete(name);},
    systemPrompt:{section:()=>()=>{}},
    webServer:{getOrigin:()=>origin,register:spec=>{handler=spec.handler;return ()=>{};}},
  };
  apply(ctx,{dataDir:root,seedSamples:false,enableTool:true});
  const request=async url=>{
    const req=Readable.from([]);req.method='GET';req.url=url;req.headers={};
    let body;
    const res={setHeader(){},end(text){body=JSON.parse(text);}};
    await handler(req,res);assert.equal(res.statusCode,200);return body;
  };
  diagnostic=async()=> (await request('/api/writing-guide/diagnostics?sessionId=fixture-session')).last;
  assert.equal(await diagnostic(),null,'await plugin boot without inventing a request record');
  const readTool=async()=>{
    const result=await tools.get('writing_guide').execute({action:'session_list'});
    assert.equal(result.ok,true);assert.doesNotMatch(result.detail,/SYNTHETIC_PRIVATE_/);
    return JSON.parse(result.detail);
  };
  const summaries=await readTool();
  assert.deepEqual(summaries.defaults,writingBindingSummary(binding));
  assert.deepEqual(summaries.bindings['fixture-session'],writingBindingSummary(binding));

  const options={sessionId:'fixture-session',provider:'host',model:'host-model',messages:[
    {role:'user',source:{kind:'user'},content:[{type:'text',text:'SYNTHETIC_INPUT'}]},
  ]};
  const original=structuredClone(options);
  const run=async()=>{
    const chunks=[];
    for await(const chunk of events.get('llm/stream')(options,()=>{throw Error('unexpected host fallback');}))chunks.push(chunk);
    assert.deepEqual(options,original,'generation must preserve the host input');
    return chunks;
  };

  // Real provider validation fails before credentials, onRequest or fetch can run.
  let chunks=await run(),last=await diagnostic();
  assert.equal(chunks.at(-1).reason.kind,'error');
  assert.equal(last.phase,'failed');assert.equal(last.requestSent,false);
  assert.equal(captured.length,0);assert.equal(beforeSend.length,0);
  assert.deepEqual((await readTool()).diagnostics['fixture-session'],last);

  providerAvailable=true;
  chunks=await run();last=await diagnostic();
  assert.equal(serverError,undefined);assert.equal(captured.length,1);
  assert.equal(chunks.at(-1).reason.kind,'stop');assert.equal(last.phase,'completed');
  assert.equal(beforeSend[0].requestSent,false);assert.equal(beforeSend[0].phase,'preparing');
  const sent=captured[0],roles={system:0,user:0,assistant:0};
  for(const message of sent.body.messages)roles[message.role]++;
  assert.equal(sent.url,'/v1/chat/completions');
  assert.deepEqual(sent.body.messages.slice(-2).map(row=>row.role),['assistant','system']);
  assert.equal(roles.assistant,beforeSend[0].roles.assistant+1,'final processor changes the original plan roles');
  assert.equal(roles.system,beforeSend[0].roles.system+1);
  assert.equal(sent.during.phase,'requesting','onRequest runs before the local server receives the request');
  for(const snapshot of [sent.during,last]){
    assert.equal(snapshot.requestSent,true);assert.deepEqual(snapshot.roles,roles);
    assert.equal(snapshot.messages,sent.body.messages.length);
  }
  assert.deepEqual((await readTool()).diagnostics['fixture-session'],last,'tool and HTTP use the same safe diagnostic');

  // Failure after sending must stay sent, while the response body stays private.
  responseStatus=500;chunks=await run();last=await diagnostic();
  assert.equal(serverError,undefined);assert.equal(captured.length,2);
  assert.equal(chunks.at(-1).reason.kind,'error');
  assert.equal(last.phase,'failed');assert.equal(last.requestSent,true);
  assert.equal(last.errorCode,'WRITING_GUIDE_FAILED');
  assert.doesNotMatch(JSON.stringify(last),/SYNTHETIC_PRIVATE_/);
  assert.deepEqual((await readTool()).diagnostics['fixture-session'],last);

  // The real transport also suppresses the callback for an already cancelled request.
  let callbacks=0;
  await assert.rejects(postChatCompletion({baseURL:origin+'/v1',apiKey:'SYNTHETIC_TEST_KEY',
    body:{model:'model',messages:[{role:'user',content:'SYNTHETIC_CANCELLED'}]},
    signal:AbortSignal.abort(),onRequest:()=>callbacks++,
  }),error=>error.code==='aborted');
  assert.equal(callbacks,0);assert.equal(captured.length,2);
  for(const [baseURL,error] of [['not-an-absolute-url',{code:'ERR_INVALID_URL'}],['ftp://127.0.0.1/v1',/HTTP 或 HTTPS/]]){
    await assert.rejects(postChatCompletion({baseURL,apiKey:'SYNTHETIC_TEST_KEY',
      body:{model:'model',messages:[{role:'user',content:'SYNTHETIC_INVALID_ENDPOINT'}]},
      onRequest:()=>callbacks++,
    }),error);
    assert.equal(callbacks,0,'invalid endpoints must not trigger onRequest');
    assert.equal(captured.length,2,'invalid endpoints must not reach the HTTP server');
  }
  console.log('request-diagnostics: safe serializers, actual plugin transport, preflight/abort/URL isolation, local HTTP final roles and tool/API privacy passed');
}finally{
  for(const dispose of cleanup.reverse())await dispose();
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await fs.rm(root,{recursive:true,force:true});
}
