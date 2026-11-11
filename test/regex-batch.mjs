import assert from 'node:assert/strict';import {runScriptSync,runBatchSafe} from '../lib/regex-engine.js';
const base={findRegex:'/a/g',replaceString:'b',placement:[1],promptOnly:true,disabled:false};
const batch=await runBatchSafe({scripts:[base],inputs:[{index:0,text:'a',scene:{placement:1,isPrompt:true}},{index:1,text:'a',scene:{placement:2,isPrompt:true}}]});assert.deepEqual(batch.results.map(r=>r.output),['b','a']);
assert.equal(runScriptSync({...base,findRegex:'/(aabb)/g',replaceString:'$1',trimStrings:['ab']},'aabb').output,'ab');
assert.equal(runScriptSync({...base,findRegex:'/a/g '},'aa').output,'bb');
assert.equal(runScriptSync({...base,findRegex:'/(?:)/gu',replaceString:'X'},'😀').output,'X😀X');
assert.equal(runScriptSync({...base,findRegex:'/(?:)/g',replaceString:'X'},'😀').output.length,5);
const aborted=new AbortController();aborted.abort();assert.equal((await runBatchSafe({scripts:[base],inputs:[],signal:aborted.signal})).code,'aborted');
console.log('regex-batch: mixed scenes, trim once, trailing flags, Unicode and cancellation passed');
