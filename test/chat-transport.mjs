#!/usr/bin/env node
/**
 * 薄 Chat Completions transport 的本地捕获测试（真实 fetch → 本机 http 服务）。
 *
 *   node test/chat-transport.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildChatBody, postChatCompletion, messageEvidence } from '../lib/chat-transport.js';
import { GuideStore } from '../lib/store.js';
import { WorkStore } from '../lib/work.js';
import { normalizePreset } from '../lib/preset.js';
import { generateForWork } from '../lib/writer.js';

const KEY = 'sk-test-DO-NOT-LEAK';
const captured = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    captured.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw || '{}') });
    const mode = req.headers['x-test-mode'];
    if (mode === 'error') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `bad key ${KEY}` }));
      return;
    }
    const finish = mode === 'length' ? 'length' : 'stop';
    const content = mode === 'length' ? 'partial' : 'MAIN WORLD D0 PHI OK';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: finish }], usage: { total_tokens: 12 } }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${server.address().port}/v1`;

const messages = [
  { role: 'system', content: '[MAIN]' },
  { role: 'system', content: '[WORLD]' },
  { role: 'user', content: 'U1' },
  { role: 'assistant', content: 'A1' },
  { role: 'user', content: 'NOW' },
  { role: 'system', content: '[D0]' },
  { role: 'system', content: '[PHI]' },
];

// 1) 最终 body：角色顺序与标记（D0/PHI 保持 system）
const body = buildChatBody({ model: 'vtx-gemini-4-argon', messages, maxTokens: 128, temperature: 0.9 });
assert.deepEqual(body.messages.map((m) => m.role), ['system', 'system', 'user', 'assistant', 'user', 'system', 'system']);
assert.equal(body.max_tokens, 128);
assert.equal(body.temperature, 0.9);
assert.equal(body.stream, false);
const evidence = messageEvidence(body.messages);
assert.deepEqual(evidence.map((item) => item.markers.join('')), ['[MAIN]', '[WORLD]', '', '', '', '[D0]', '[PHI]']);

// 2) 真实 fetch：server 收到的就是这份 body
{
  const result = await postChatCompletion({ baseURL, apiKey: KEY, body });
  assert.equal(result.ok, true);
  assert.equal(result.finish, 'stop');
  const seen = captured.at(-1);
  assert.equal(seen.url, '/v1/chat/completions', '发到配置端点的 /chat/completions');
  assert.deepEqual(seen.body.messages.map((m) => m.role), ['system', 'system', 'user', 'assistant', 'user', 'system', 'system'], '发送顺序与角色');
  assert.deepEqual(seen.body.messages.map((m) => String(m.content).match(/\[[A-Z0-9_]+\]/)?.[0] ?? ''),
    ['[MAIN]', '[WORLD]', '', '', '', '[D0]', '[PHI]']);
  assert.equal(seen.body.max_tokens, 128, '输出上限随请求发送');
  assert.equal(result.evidence.length, 7);
}

// 3) 非 stop → ok:false（不产出正文）
{
  const result = await postChatCompletion({
    baseURL, apiKey: KEY, body, signal: undefined,
  }).catch(() => null);
  assert.equal(result.ok, true, '默认模式仍是 stop');
  const lengthBody = { ...body };
  const proxy = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }));
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyURL = `http://127.0.0.1:${proxy.address().port}/v1`;
  const partial = await postChatCompletion({ baseURL: proxyURL, apiKey: KEY, body: lengthBody });
  assert.equal(partial.ok, false, 'finish_reason=length 不算成功');
  proxy.close();
}

// 4) 已取消 → 根本不发请求
{
  const before = captured.length;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => postChatCompletion({ baseURL, apiKey: KEY, body, signal: controller.signal }),
    (error) => error?.code === 'aborted',
  );
  assert.equal(captured.length, before, '取消后没有发出请求');
}

// 5) 失败信息不含 key（替换为 [redacted]）
{
  const badServer = http.createServer((req, res) => {
    req.resume();
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `bad key ${KEY}` }));
  });
  await new Promise((resolve) => badServer.listen(0, '127.0.0.1', resolve));
  const badURL = `http://127.0.0.1:${badServer.address().port}/v1`;
  await assert.rejects(
    () => postChatCompletion({ baseURL: badURL, apiKey: KEY, body }),
    (error) => {
      assert.equal(String(error.message).includes(KEY), false, '错误信息不含 key');
      assert.ok(String(error.message).includes('[redacted]'), '错误信息含 [redacted]');
      return true;
    },
  );
  badServer.close();
}

// 6) writer：非 stop / 取消都不保存正文（chat 分支）
{
  const root = await mkdtemp(path.join(os.tmpdir(), 'wg-chat-'));
  const store = new GuideStore(root);
  const workStore = new WorkStore(root);
  await store.ensure();
  await store.savePreset(normalizePreset({
    id: 'p', name: 'P',
    prompts: [{ identifier: 'main', content: '[MAIN]', role: 'system' }, { identifier: 'chatHistory', marker: true }],
    prompt_order: [{ order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }],
  }));
  await store.saveSettings({ enabled: true, targets: ['writer'], includeWorlds: false, includePreset: true, scanDepth: 2, vars: {}, maxChars: 6000, worldIds: [], contextWindow: 0, maxTokens: 64, worldBudgetPercent: 0, worldBudgetTokens: 0, maxRecursionSteps: 0 });
  const work = await workStore.save({
    id: 'w', title: 'w', presetId: 'p', worldIds: [],
    route: { provider: 'catiecli', model: 'm', transport: 'chat' },
  });

  // 假 cancel 通道：返回 ok:false
  const fakeFail = async () => ({ ok: false, finish: 'length', evidence: [] });
  const bad = await generateForWork({
    store, workStore, workId: work.id, message: 'hi', llm: {}, model: { provider: 'catiecli', model: 'm' },
    chatTransport: fakeFail, save: true,
  });
  assert.equal(bad.ok, false);
  assert.equal((await workStore.chat(work.id)).length, 0, '非 stop 不写历史');

  // 上游 ok 但已被取消：不保存
  const controller = new AbortController();
  const fakeOk = async () => ({ ok: true, content: '正文', finish: 'stop', evidence: [], usage: null, status: 200 });
  const pending = generateForWork({
    store, workStore, workId: work.id, message: 'hi', llm: {}, model: { provider: 'catiecli', model: 'm' },
    chatTransport: async (args) => { const r = await fakeOk(); controller.abort(); return r; },
    signal: controller.signal, save: true,
  });
  const cancelled = await pending;
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.code, 'aborted');
  assert.equal((await workStore.chat(work.id)).length, 0, '取消后不写历史');
  await rm(root, { recursive: true, force: true });
}

server.close();
console.log('chat-transport: 全部通过');
