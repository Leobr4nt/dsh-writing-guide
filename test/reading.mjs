import assert from 'node:assert/strict';
import {buildReading,readingHtml} from '../lib/reading.js';
const rows=[{id:'u',role:'user',content:'QUESTION'},{id:'a',role:'assistant',content:'<secret>PRIVATE</secret>Visible'}];
const original=structuredClone(rows);
const rules=[{id:'hide',disabled:false,findRegex:'/<secret>[\\s\\S]*?<\/secret>/g',replaceString:'',placement:[2],markdownOnly:true},
  {id:'format',findRegex:'/Visible/',replaceString:'<details open><summary>Status</summary><b>Visible</b></details>',placement:[2],markdownOnly:true}];
let result=await buildReading({messages:rows,scripts:rules});assert.equal(result.messages[0].text,'QUESTION');assert.ok(!result.messages[1].text.includes('PRIVATE'));assert.match(result.messages[1].html,/<details open>/);assert.deepEqual(rows,original);
result=await buildReading({messages:rows,scripts:[{...rules[0],findRegex:'/[\\s\\S]+/g'}]});assert.equal(result.messages[1].hidden,true);assert.equal(result.messages[1].original,original[1].content);
result=await buildReading({messages:rows,scripts:[{...rules[0],minDepth:1}]});assert.equal(result.messages[1].changed,false);
const html=readingHtml('<script>alert(1)</script><img src="https://remote.invalid/a" onerror="bad()"><iframe src="x"></iframe><a href="javascript:bad()">link</a><b>OK</b>');
assert.ok(!html.includes('<script')&&!html.includes('onerror')&&!html.includes('<iframe')&&!html.includes('https://remote'));assert.match(html,/<b>OK<\/b>/);
console.log('reading: display-only regex, hidden content, depth, HTML isolation and original history preservation passed');
