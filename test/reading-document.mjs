import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {interactiveReadingHtml,readingHtml,unwrapReading} from '../lib/reading.js';
import {ReadingAssets,publicImageUrl} from '../lib/reading-assets.js';
const root=await mkdtemp(path.join(os.tmpdir(),'reading-assets-'));
try{
  for(const url of ['http://example.com/a.png','https://127.0.0.1/a','https://[::1]/a','https://[::ffff:127.0.0.1]/a','https://169.254.169.254/a','https://10.0.0.1/a','https://192.168.1.1/a','https://localhost/a','https://test.internal/a','https://example.com:8080/a','https://user:pass@example.com/a'])assert.equal(publicImageUrl(url),null);
  assert.ok(publicImageUrl('https://example.com/a.png'));
  let downloads=0;const assets=new ReadingAssets(root,{download:async()=>{downloads++;return {bytes:Buffer.from([137,80,78,71,13,10,26,10,0]),mime:'image/png'};}});
  const values=await Promise.all([assets.image('https://example.com/a.png'),assets.image('https://example.com/a.png')]);assert.equal(downloads,1);assert.equal(values[0],values[1]);await assets.image('https://example.com/a.png');assert.equal(downloads,1);
  const source='```html\n<html><head><style>#settings{display:none}</style></head><body data-theme="dark"><div id="settings"><input type="number" value="18"><button onclick="this.dataset.clicked=1">Change</button></div><img src="https://example.com/a.png"><script>window.fixture=1;</script><iframe src="https://example.com"></iframe></body></html>\n```';
  assert.equal(unwrapReading(source).document,true);
  const row=await interactiveReadingHtml(source,assets);assert.equal(row.interactive,true);assert.equal(row.imagesLoaded,1);assert.match(row.html,/id="settings"/);assert.match(row.html,/<input/);assert.match(row.html,/<script>/);assert.match(row.head,/#settings/);assert.ok(!row.html.includes('<iframe'));assert.equal(row.bodyAttributes['data-theme'],'dark');assert.ok(!row.html.includes('https://example.com'));assert.ok(!row.html.includes('<pre>'));
  assert.match(readingHtml('<style>#a{color:red}</style><div id="a">x</div>'),/id="a"/);
  const mixed='Before\n\n<style>#one{color:red}</style><div id="one">A</div>\n<script>\n  const a=`line\n    value`;\n  window.fixture=a;\n</script>\n\n```html\n<html><head><style>#two{color:blue}</style></head><body><div id="two">B</div><script>window.other=2;</script></body></html>\n```';
  const combined=await interactiveReadingHtml(mixed,assets);
  assert.equal(combined.parts.length,2,'frontend document owns an independent iframe');
  assert.match(combined.parts[0].html,/id="one"/);assert.match(combined.parts[1].html,/id="two"/);assert.match(combined.parts[0].html,/const a=`line\n    value`/);assert.match(combined.parts[1].html,/window.other=2/);
  console.log('reading-document: full HTML preservation, controls/styles, bounded image cache and private address rejection passed');
}finally{await rm(root,{recursive:true,force:true});}
