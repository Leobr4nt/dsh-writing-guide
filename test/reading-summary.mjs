import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {buildReading,splitReadingDocuments,unwrapReading} from '../lib/reading.js';
import {parseDocument,DomUtils} from 'htmlparser2';

const summary='<details><summary>摘要</summary>\n<p id="summary-body">合成摘要内容</p>\n</details>';
const document='<!doctype html>\n<html><head><style>body{color:#eee;background:#15171c}</style></head><body><p>合成正文</p></body></html>';
let browser;
try{
  browser=await chromium.launch({executablePath:process.env.DSH_WRITING_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage();
  for(const fence of ['```','~~~~'])for(const newline of ['\n','\r\n']){
    const input=('前段\n\n'+fence+'html\n<!-- retained annotation\nsecond line -->\n\n'+document+'\n\n'+fence+'\n\n'+summary).replace(/\n/g,newline);
    const original=structuredClone([{id:'m',role:'assistant',content:input}]);
    const split=splitReadingDocuments(input);assert.equal(split.length,3);
    assert.ok(split[1].source.includes('retained annotation'),'frontend comments are preserved');
    assert.equal(unwrapReading(split[1].source).document,true);
    assert.ok(!split[0].source.includes(fence)&&!split[2].source.includes(fence),'paired fences belong to frontend, not adjacent prose');
    const reading=await buildReading({messages:original,scripts:[]});assert.equal(original[0].content,input,'history must remain unchanged');
    const tail=reading.messages[0].parts.at(-1);const parsed=parseDocument(tail.html);
    assert.equal(DomUtils.findAll(n=>n.name==='details',parsed.children).length,1);
    assert.equal(DomUtils.findAll(n=>n.name==='summary',parsed.children).length,1);
    assert.ok(!tail.html.includes('&lt;details')&&!tail.html.includes('<pre>'));
    await page.setContent('<iframe sandbox="allow-same-origin" title="summary"></iframe>');
    await page.locator('iframe').evaluate((node,html)=>node.srcdoc=html,tail.html);
    const frame=page.frameLocator('iframe');await frame.locator('summary').waitFor();
    assert.equal(await frame.locator('#summary-body').isVisible(),false);
    await frame.locator('summary').click();assert.equal(await frame.locator('#summary-body').isVisible(),true);
    assert.equal(await frame.locator('#summary-body').textContent(),'合成摘要内容');
    await frame.locator('summary').click();assert.equal(await frame.locator('#summary-body').isVisible(),false);
  }
  // Do not reinterpret an intentional code sample or consume unrelated prose.
  const code=await buildReading({messages:[{id:'code',role:'assistant',content:'```text\n'+summary+'\n```'}],scripts:[]});
  assert.equal(DomUtils.findAll(n=>n.name==='details',parseDocument(code.messages[0].html).children).length,0);
  const unrelated=splitReadingDocuments('```html\nnot an HTML preamble\n'+document+'\n```\n'+summary);
  assert.ok(unrelated[0].source.includes('not an HTML preamble'));
  console.log('reading-summary: comment-prefixed frontend fences, native expand/collapse, CRLF and literal code preservation passed');
}finally{await browser?.close();}
