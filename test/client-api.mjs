#!/usr/bin/env node
/**
 * 前端请求 payload 实测：从 client.js 抽出 `api(method, path, body)`，
 * 注入 fake fetch，断言真正发出去的 method / headers / body 形状。
 *
 *   node test/client-api.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

const start = source.indexOf('async function api(method, path, body) {');
const end = source.indexOf('\n    }\n', start);
assert.ok(start > 0 && end > start, '找不到 api() 定义');
const body = source.slice(start, end + 6);

const captured = [];
const fakeFetch = async (url, init) => {
  captured.push({ url, method: init.method, headers: init.headers, body: init.body });
  return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
};

// eslint-disable-next-line no-new-func
const factory = new Function('fetch', 'API', `${body}\nreturn api;`);
const api = factory(fakeFetch, 'http://host/api/writing-guide');

// 1) 默认配置保存：单层 JSON，POST
await api('POST', '/bindings', { defaults: { presetId: 'writing-sample', cardId: 'shen-yan' } });
let last = captured.at(-1);
assert.equal(last.method, 'POST');
assert.equal(last.headers['content-type'], 'application/json');
assert.deepEqual(JSON.parse(last.body), { defaults: { presetId: 'writing-sample', cardId: 'shen-yan' } });
assert.equal(JSON.stringify(JSON.parse(last.body)).includes('"method"'), false, 'body 里不应出现 method 字段');

// 2) 启停
await api('POST', '/bindings', { enabled: false });
last = captured.at(-1);
assert.equal(last.method, 'POST');
assert.deepEqual(JSON.parse(last.body), { enabled: false });

// 3) 会话绑定 / 恢复默认
await api('POST', '/bindings', { sessionId: 'sess-1', binding: { presetId: 'p' } });
assert.deepEqual(JSON.parse(captured.at(-1).body), { sessionId: 'sess-1', binding: { presetId: 'p' } });
await api('POST', '/bindings', { sessionId: 'sess-1', remove: true });
assert.deepEqual(JSON.parse(captured.at(-1).body), { sessionId: 'sess-1', remove: true });

// 4) 角色卡保存 / 导入
await api('POST', '/cards', { card: { id: 'c1', name: '沈砚' } });
assert.equal(captured.at(-1).method, 'POST');
assert.deepEqual(JSON.parse(captured.at(-1).body), { card: { id: 'c1', name: '沈砚' } });
await api('POST', '/cards/import', { pngBase64: 'AAA' });
assert.deepEqual(JSON.parse(captured.at(-1).body), { pngBase64: 'AAA' });

// 5) 删除必须是 DELETE，且不带 body
await api('DELETE', '/cards/c1');
last = captured.at(-1);
assert.equal(last.method, 'DELETE');
assert.equal(last.body, undefined);

// 6) 源码里不应再有嵌套 payload 写法
assert.equal(/body:\s*JSON\.stringify\([^)]*JSON\.stringify/.test(source), false);
assert.equal(source.includes("method: 'DELETE'"), false, 'DELETE 不再通过 call 表达');

console.log('client-api: 全部通过');
