import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {getGlobalDispatcher,setGlobalDispatcher} from 'undici';
import {apply} from '../index.js';
import {GuideStore} from '../lib/store.js';
import {ExtensionStore} from '../lib/extension-store.js';
import {normalizeBinding,BindingCache} from '../lib/session-bindings.js';
import {DEFAULT_REQUEST_TIMEOUT_SECONDS,normalizeRequestTimeoutSeconds} from '../lib/request-timeout.js';
import {postChatCompletion} from '../lib/chat-transport.js';
import {writingDiagnostic,writingBindingSummary} from '../lib/diagnostics.js';

// All files, sessions, credentials and provider responses below are synthetic.
const nativeSetTimeout=globalThis.setTimeout;
const binding={presetId:'fixture-timeout',provider:'fixture',model:'model',worldIds:[],worldSelection:'none',maxTokens:128};
const reply=JSON.stringify({choices:[{message:{role:'assistant',content:'SYNTHETIC_REPLY'},finish_reason:'stop'}]});

async function bounded(work){
  const controller=new AbortController();let watchdog;
  try{
    return await Promise.race([work(controller),new Promise((_,reject)=>{
      watchdog=nativeSetTimeout(()=>{controller.abort();reject(Error('Synthetic HTTP operation exceeded the 3s test deadline'));},3000);
    })]);
  }finally{clearTimeout(watchdog);controller.abort();}
}

async function requestTimers(timeoutMs,work,{accelerate=false}={}){
  const original=globalThis.setTimeout,calls=[];
  globalThis.setTimeout=function(callback,ms,...args){
    if(ms!==timeoutMs)return original(callback,ms,...args);
    const call={ms,fired:false};calls.push(call);
    call.handle=original(()=>{call.fired=true;callback(...args);},accelerate?100:ms);
    return call.handle;
  };
  try{return await work(calls);}
  finally{
    globalThis.setTimeout=original;
    for(const call of calls)clearTimeout(call.handle);
  }
}

test('request timeout normalization and safe summaries',()=>{
  assert.equal(DEFAULT_REQUEST_TIMEOUT_SECONDS,600);
  assert.equal(normalizeRequestTimeoutSeconds(),600);
  assert.equal(normalizeBinding().requestTimeoutSeconds,600);
  for(const value of [undefined,null,'','  ','synthetic-invalid',NaN,Infinity,-Infinity,0,-1,-0.2,{},true,false,[120],[]]){
    assert.equal(normalizeRequestTimeoutSeconds(value),600,`fallback for ${String(value)}`);
    assert.equal(normalizeBinding({requestTimeoutSeconds:value}).requestTimeoutSeconds,600);
  }
  for(const [value,expected] of [[0.01,1],[1,1],[1.99,1],[137.9,137],['239.9',239],[600,600],[3599.9,3599],[3600,3600],[3601,3600],[1e9,3600]]){
    assert.equal(normalizeRequestTimeoutSeconds(value),expected);
    assert.equal(normalizeBinding({requestTimeoutSeconds:value}).requestTimeoutSeconds,expected);
  }
  const source={...binding,requestTimeoutSeconds:137.9,authorNote:'SYNTHETIC_PRIVATE_NOTE',variables:{secret:'SYNTHETIC_PRIVATE_VAR'}};
  const record={requestTimeoutSeconds:137.9,phase:'failed',requestSent:true,error:{code:'timeout',message:'SYNTHETIC_PRIVATE_ERROR'}};
  const before=structuredClone({source,record});
  assert.equal(writingBindingSummary(source).requestTimeoutSeconds,137);
  assert.equal(writingBindingSummary(binding).requestTimeoutSeconds,600);
  assert.equal(writingDiagnostic(record).requestTimeoutSeconds,137);
  assert.equal(writingDiagnostic(record).errorCode,'timeout');
  assert.equal(writingDiagnostic({}).requestTimeoutSeconds,600);
  assert.doesNotMatch(JSON.stringify([writingBindingSummary(source),writingDiagnostic(record)]),/SYNTHETIC_PRIVATE_/);
  assert.deepEqual({source,record},before);
});

// Subtests run sequentially: the timer and dispatcher overrides are process globals.
test('request timeout through real apply, routes, hook and local HTTP',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wg-request-timeout-'));
  const store=new GuideStore(root),extensions=new ExtensionStore(root);
  const captured=[],serverErrors=[];
  let plugin,respond;
  const delayedReply=async res=>{
    await delay(15);
    res.writeHead(200,{'content-type':'application/json'});
    res.write(reply.slice(0,30));
    await delay(25);
    res.end(reply.slice(30));
  };
  respond=delayedReply;
  const server=http.createServer(async(req,res)=>{
    try{
      let raw='';for await(const chunk of req)raw+=chunk;
      const entry={url:req.url,body:JSON.parse(raw),closed:false};captured.push(entry);
      res.once('close',()=>{entry.closed=true;});
      await respond(res,entry);
    }catch(error){serverErrors.push(error);res.destroy();}
  });
  try{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const origin=`http://127.0.0.1:${server.address().port}`;
    await store.ensure();
    await store.saveSettings({includeWorlds:false,maxTokens:128});
    await store.savePreset({
      id:binding.presetId,name:'Synthetic timeout preset',
      prompts:[{identifier:'main',role:'system',content:'SYNTHETIC_MAIN TURN={{incvar::turn}}'},{identifier:'chatHistory',marker:true}],
      prompt_order:[{order:[{identifier:'main',enabled:true},{identifier:'chatHistory',enabled:true}]}],
    });
    await store.saveBindings({enabled:true,defaultBinding:binding,bindings:{'fixture-legacy':binding}});

    const boot=async()=>{
      const cleanup=[],events=new Map(),registeredTools=new Map();let handler;
      const services={
        settings:{describe:()=>[{ns:'dsh-llm-pi-ai',value:{providers:{fixture:{
          api:'openai-completions',baseURL:origin+'/v1',apiKeyEnv:'SYNTHETIC_KEY_REF',models:[{id:'model'}],
        }}}}]},
        credentials:{resolve:async ref=>{assert.equal(ref,'SYNTHETIC_KEY_REF');return {value:'SYNTHETIC_TEST_KEY'};}},
        connection:{requestRejection:()=>null},
        sessions:{get:id=>({id,header:{agentPreset:'writer'}})},
        agentPresets:{presetForSession:()=> 'writer'},
        tools:{register:tool=>{registeredTools.set(tool.name,tool);return ()=>registeredTools.delete(tool.name);}},
      };
      apply({
        get:name=>services[name],
        effect:fn=>{const dispose=fn();if(typeof dispose==='function')cleanup.push(dispose);},
        on:(name,fn)=>{events.set(name,fn);return ()=>events.delete(name);},
        systemPrompt:{section:()=>()=>{}},
        webServer:{getOrigin:()=>origin,register:spec=>{handler=spec.handler;return ()=>{};}},
      },{dataDir:root,seedSamples:false,enableTool:true});
      const api=async(url,body)=>{
        const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
        req.method=body===undefined?'GET':'POST';req.url='/api/writing-guide'+url;req.headers={};
        let result;const res={setHeader(){},end(text){result=JSON.parse(text);}};
        await handler(req,res);assert.equal(res.statusCode,200);assert.equal(result.ok,true);return result;
      };
      const result={
        api,
        diagnostic:async id=>(await api('/diagnostics?sessionId='+encodeURIComponent(id))).last,
        summaries:async()=>{
          const result=await registeredTools.get('writing_guide').execute({action:'session_list'});
          assert.equal(result.ok,true);return JSON.parse(result.detail);
        },
        run:async(id,signal)=>{
          const options={sessionId:id,provider:'host',model:'host-model',messages:[
            {id:'fixture-user',role:'user',source:{kind:'user'},content:[{type:'text',text:'SYNTHETIC_INPUT'}]},
          ]};
          const before=structuredClone(options),chunks=[];
          for await(const chunk of events.get('llm/stream')({...options,signal},()=>{throw Error('unexpected host fallback');}))chunks.push(chunk);
          assert.deepEqual(options,before);return chunks;
        },
        close:async()=>{for(const dispose of cleanup.splice(0).reverse())await dispose();},
      };
      plugin=result;
      await api('/bindings'); // The registered route awaits the real plugin boot.
      return result;
    };
    await boot();

    await t.test('bindings persist, reload, default and isolate sessions',async()=>{
      let state=await plugin.api('/bindings');
      assert.equal(state.defaults.requestTimeoutSeconds,600);
      assert.equal(state.bindings['fixture-legacy'].requestTimeoutSeconds,600);
      await plugin.api('/bindings',{defaults:{requestTimeoutSeconds:311.9}});
      await plugin.api('/bindings',{sessionId:'fixture-a',binding:{...binding,requestTimeoutSeconds:'137.9'}});
      await plugin.api('/bindings',{sessionId:'fixture-b',binding:{...binding,requestTimeoutSeconds:9000}});
      state=await plugin.api('/bindings',{defaults:{requestTimeoutSeconds:239}});
      assert.equal(state.defaults.requestTimeoutSeconds,239);
      assert.equal(state.bindings['fixture-a'].requestTimeoutSeconds,137);
      assert.equal(state.bindings['fixture-b'].requestTimeoutSeconds,3600);
      assert.equal(state.bindings['fixture-legacy'].requestTimeoutSeconds,600);
      const reloaded=new BindingCache(await new GuideStore(root).loadBindings());
      assert.equal(reloaded.defaults().requestTimeoutSeconds,239);
      assert.equal(reloaded.get('fixture-a').requestTimeoutSeconds,137);
      assert.equal(reloaded.get('fixture-b').requestTimeoutSeconds,3600);
      await plugin.close();await boot();
      assert.deepEqual(await plugin.api('/bindings'),state,'apply reloads the saved bindings');
      const summaries=await plugin.summaries();
      assert.equal(summaries.defaults.requestTimeoutSeconds,239);
      assert.equal(summaries.bindings['fixture-a'].requestTimeoutSeconds,137);
      assert.equal(summaries.bindings['fixture-b'].requestTimeoutSeconds,3600);
      state=await plugin.api('/bindings',{defaults:{requestTimeoutSeconds:0}});
      assert.equal(state.defaults.requestTimeoutSeconds,600);
      state=await plugin.api('/bindings',{sessionId:'fixture-a',binding:{...binding,requestTimeoutSeconds:'synthetic-invalid'}});
      assert.equal(state.bindings['fixture-a'].requestTimeoutSeconds,600);
      assert.equal(state.bindings['fixture-b'].requestTimeoutSeconds,3600);
      await plugin.close();await boot();
      state=await plugin.api('/bindings');
      assert.equal(state.defaults.requestTimeoutSeconds,600);
      assert.equal(state.bindings['fixture-a'].requestTimeoutSeconds,600);
      await plugin.api('/bindings',{sessionId:'fixture-a',binding:{...binding,requestTimeoutSeconds:137}});
      await plugin.api('/bindings',{sessionId:'fixture-b',binding:{...binding,requestTimeoutSeconds:239}});
    });

    const post=options=>postChatCompletion({baseURL:origin+'/v1',apiKey:'SYNTHETIC_TEST_KEY',
      body:{model:'model',messages:[{role:'user',content:'SYNTHETIC_DIRECT_INPUT'}]},...options});

    await t.test('post defaults to 600000ms and delegates with hidden HTTP deadlines disabled',async()=>{
      const original=getGlobalDispatcher(),dispatches=[],before=captured.length;
      const recording={dispatch(options,handler){
        dispatches.push({headersTimeout:options.headersTimeout,bodyTimeout:options.bodyTimeout});
        return original.dispatch(options,handler);
      }};
      try{
        setGlobalDispatcher(recording);
        await requestTimers(600000,async calls=>{
          const result=await bounded(controller=>post({signal:controller.signal}));
          assert.equal(result.ok,true);assert.equal(result.content,'SYNTHETIC_REPLY');
          assert.deepEqual(calls.map(row=>row.ms),[600000]);
          assert.equal(calls[0].fired,false);
        });
        assert.deepEqual(dispatches,[{headersTimeout:0,bodyTimeout:0}]);
        assert.equal(getGlobalDispatcher(),recording,'transport preserves the installed dispatcher');
        assert.equal(captured.length,before+1);
      }finally{setGlobalDispatcher(original);}
    });

    await t.test('apply forwards each session deadline through the hook to real HTTP',async()=>{
      for(const [id,seconds] of [['fixture-new',600],['fixture-a',137],['fixture-b',239],['fixture-a',137]]){
        const before=captured.length,snapshot=await extensions.sessionVars(id);
        await requestTimers(seconds*1000,async calls=>{
          const chunks=await bounded(controller=>plugin.run(id,controller.signal));
          assert.equal(chunks.at(-1).reason.kind,'stop');
          assert.equal(chunks.find(row=>row.type==='text-delta').text,'SYNTHETIC_REPLY');
          assert.deepEqual(calls.map(row=>row.ms),[seconds*1000]);
          assert.equal(calls[0].fired,false);
        });
        assert.equal(captured.length,before+1);
        assert.equal(captured.at(-1).url,'/v1/chat/completions');
        const saved=await extensions.sessionVars(id);
        assert.equal(saved.vars.turn,Number(snapshot.vars.turn??0)+1,'successful responses commit the staged macro');
        assert.equal(saved.version,snapshot.version+1);
        const last=await plugin.diagnostic(id);
        assert.equal(last.phase,'completed');assert.equal(last.requestSent,true);
        assert.equal(last.requestTimeoutSeconds,seconds);
        assert.deepEqual((await plugin.summaries()).diagnostics[id],last);
      }
      assert.equal((await plugin.diagnostic('fixture-b')).requestTimeoutSeconds,239);
    });

    for(const stage of ['headers','body'])await t.test(`timeout while awaiting ${stage} does not retry or commit variables`,async()=>{
      const before=captured.length,snapshot=await extensions.sessionVars('fixture-a');
      const other=await extensions.sessionVars('fixture-b');
      let during;
      respond=async res=>{
        during=await plugin.diagnostic('fixture-a');
        if(stage==='body'){
          res.writeHead(200,{'content-type':'application/json'});
          res.write(reply.slice(0,30)); // Headers and body bytes arrive, but response.text() cannot finish.
        }
      };
      try{
        await requestTimers(137000,async calls=>{
          const chunks=await bounded(controller=>plugin.run('fixture-a',controller.signal));
          assert.equal(chunks.at(-1).reason.kind,'error');
          assert.equal(chunks.at(-1).reason.failure.code,'timeout');
          assert.match(chunks.at(-1).reason.failure.message,/137.*完整响应/);
          assert.equal(chunks.some(row=>row.type==='text-delta'||row.type==='block-end'),false);
          assert.deepEqual(calls.map(row=>row.ms),[137000]);assert.equal(calls[0].fired,true);
        },{accelerate:true});
        await delay(120);
        assert.equal(captured.length,before+1,'failed HTTP requests are never automatically retried');
        assert.equal(captured.at(-1).closed,true,'deadline aborts the underlying HTTP response');
        assert.equal(during.phase,'requesting');assert.equal(during.requestSent,true);
        assert.equal(during.requestTimeoutSeconds,137);
        const last=await plugin.diagnostic('fixture-a');
        assert.equal(last.phase,'failed');assert.equal(last.errorCode,'timeout');
        assert.equal(last.requestSent,true);assert.equal(last.requestTimeoutSeconds,137);
        assert.deepEqual((await plugin.summaries()).diagnostics['fixture-a'],last);
        assert.deepEqual(await new ExtensionStore(root).sessionVars('fixture-a'),snapshot);
        assert.deepEqual(await extensions.sessionVars('fixture-b'),other);
      }finally{respond=delayedReply;}
    });

    for(const stage of ['headers','body'])await t.test(`cancellation while awaiting ${stage} is promptly aborted, not timed out`,async()=>{
      const before=captured.length,snapshot=await extensions.sessionVars('fixture-a');
      const received=Promise.withResolvers();
      respond=async res=>{
        if(stage==='body'){res.writeHead(200,{'content-type':'application/json'});res.write(reply.slice(0,30));}
        received.resolve();
      };
      try{
        await requestTimers(137000,async calls=>{
          const chunks=await bounded(async controller=>{
            const pending=plugin.run('fixture-a',controller.signal);
            await received.promise;
            await delay(30); // Allow fetch to enter response.text() in the body case.
            controller.abort();return pending;
          });
          assert.equal(chunks.at(-1).reason.kind,'aborted');
          assert.equal(chunks.at(-1).reason.failure.code.toLowerCase(),'aborted');
          assert.equal(chunks.some(row=>row.type==='text-delta'),false);
          assert.deepEqual(calls.map(row=>row.ms),[137000]);assert.equal(calls[0].fired,false);
        });
        await delay(30);
        assert.equal(captured.length,before+1);assert.equal(captured.at(-1).closed,true);
        const last=await plugin.diagnostic('fixture-a');
        assert.equal(last.phase,'aborted');assert.equal(last.errorCode,'aborted');assert.equal(last.requestTimeoutSeconds,137);
        assert.deepEqual(await new ExtensionStore(root).sessionVars('fixture-a'),snapshot);
      }finally{respond=delayedReply;}
    });

    await t.test('already aborted requests never start HTTP or a request timer',async()=>{
      const before=captured.length;let callbacks=0;
      await requestTimers(600000,async calls=>{
        await assert.rejects(post({signal:AbortSignal.abort(),onRequest:()=>callbacks++}),{code:'aborted'});
        const chunks=await plugin.run('fixture-new',AbortSignal.abort());
        assert.equal(chunks.at(-1).reason.kind,'aborted');
        assert.equal(calls.length,0);
      });
      assert.equal(callbacks,0);assert.equal(captured.length,before);
      const last=await plugin.diagnostic('fixture-new');
      assert.equal(last.requestSent,false);assert.equal(last.requestTimeoutSeconds,600);
    });
    assert.deepEqual(serverErrors,[]);
  }finally{
    try{await plugin?.close();}
    finally{
      server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
      await fs.rm(root,{recursive:true,force:true});
    }
  }
});
