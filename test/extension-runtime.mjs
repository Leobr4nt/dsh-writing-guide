import assert from 'node:assert/strict';
import { runTemplateBatch, runHelperScript } from '../lib/extension-runtime.js';
import { buildPlan } from '../lib/plan.js';
import { normalizePreset } from '../lib/preset.js';

const template = (texts, extra = {}) => runTemplateBatch({ texts, ...extra });
const helper = (content, extra = {}) => runHelperScript({ script: { id:'synthetic', content }, ...extra });
const output = await template([
  '<% if(getvar("mood",{defaults:0}) > 1) { %><%= char %><% } else { %>none<% } %>',
  '<% for(const x of [1,2,3]) { %><%- x %><% } %>',
  '<% setvar("chapter", 2, {scope:"local"}); %><%- getvar("chapter") %>',
  '<% setvar("scene", "rain"); %><%- getvar("scene") %>',
], { variables:{mood:3}, context:{char:'A<B'} });
assert.deepEqual(output.texts, ['A&lt;B','123','2','rain']);
assert.equal(output.variables.chapter,2);
assert.equal(output.messageVariables.scene,'rain');
assert.deepEqual((await template(['<%- getvar("missing",{defaults:"ok"}) %>'])).texts,['ok']);
assert.deepEqual((await template(['<%- typeof process %>|<%- typeof require %>|<%- typeof fetch %>|<%- typeof window %>'])).texts,['undefined|undefined|undefined|undefined']);
await assert.rejects(template(['<%- include("C:/private.txt") %>']), /include/);
await assert.rejects(template(['<% setvar("x",1,{scope:"global"}) %>']), /作用域/);
await assert.rejects(template(['<% while(true) {} %>']), /interrupted|超时/);
await assert.rejects(template(['<%- getvar("constructor.prototype") %>']), /路径/);
assert.equal((await template(['<%- Math.random() %>'],{seed:'r'})).texts[0], (await template(['<%- Math.random() %>'],{seed:'r'})).texts[0]);
const vars = {count:1};
const result = await helper('await updateVariablesWith(v => ({...v,count:v.count+1})); replaceVariables({once:true},{type:"script"}); return getChatMessages(-1);', {variables:vars,chatMessages:[{role:'user',content:'hello'}]});
assert.equal(result.variables.count,2);
assert.deepEqual(vars,{count:1});
assert.deepEqual(result.scriptVariables,{once:true});
assert.equal(result.result[0].message,'hello');
assert.deepEqual((await helper('return getVariables()')).result,{});
assert.equal((await helper('return ({}).constructor.constructor("return typeof process")()')).result,'undefined');
await assert.rejects(helper('await fetch("https://example.org")'),/fetch/);
await assert.rejects(helper('while(true) {}'), /interrupted|超时/);
await assert.rejects(helper('replaceVariables(JSON.parse(\'{"__proto__":{"x":1}}\'))'), /路径|属性/);
await assert.rejects(helper('return getVariables({type:"global"})'),/作用域/);
const abort = new AbortController(); abort.abort();
await assert.rejects(template(['X'],{signal:abort.signal}), /取消/);

// Mark configured prompts even when their roles are user/assistant. Never evaluate history.
const preset = normalizePreset({prompts:[
  {identifier:'main',content:'<%- char %>',role:'user'},
  {identifier:'chatHistory',marker:true},
  {identifier:'depth',content:'<%- user %>',injection_position:1,injection_depth:0},
],prompt_order:[{order:['main','chatHistory','depth'].map(identifier=>({identifier,enabled:true}))}]});
const plan = buildPlan({preset,conversation:[{role:'user',content:'<% throw Error("user code") %>'},{role:'assistant',content:'<% throw Error("model code") %>'}]});
assert.deepEqual(plan.meta.templateIndexes.map(i=>plan.messages[i].content),['<%- char %>','<%- user %>']);
console.log('extension-runtime: EJS, helper API, provenance, isolation and limits passed');
