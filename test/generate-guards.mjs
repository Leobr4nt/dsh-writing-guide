#!/usr/bin/env node
/**
 * 生成入口守门测试（用真实 store/workStore + 假 llm，不发网络请求）。
 *
 *   node test/generate-guards.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GuideStore } from '../lib/store.js';
import { WorkStore } from '../lib/work.js';
import { normalizePreset } from '../lib/preset.js';
import { normalizeWorld } from '../lib/worldinfo.js';
import { generateForWork, buildScanText } from '../lib/writer.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'wg-gen-'));
const store = new GuideStore(root);
const workStore = new WorkStore(root);
await store.ensure();

const fakeLlm = (options = {}) => {
  const calls = [];
  return {
    calls,
    stream(request) {
      calls.push(request);
      const { finish = { kind: 'stop' }, text = 'OK', delay = 0 } = options;
      return (async function* run() {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        if (text) yield { type: 'text-delta', index: 0, text };
        yield { type: 'finish', reason: finish };
      })();
    },
  };
};
const model = { provider: 'fake', model: 'fake-1' };

// 世界书：首轮输入里才出现的词
await store.saveWorld(normalizeWorld({
  id: 'rain-city',
  name: '雨城',
  entries: [
    { uid: 1, key: ['雨城'], content: '【雨城设定】常年下雨' },
    { uid: 2, key: ['雪'], content: '【雪设定】不该出现' },
    { uid: 3, key: [], constant: true, content: '【常驻】海边小城' },
  ],
}));
await store.savePreset(normalizePreset({
  id: 'p1',
  name: '预设1',
  prompts: [
    { identifier: 'main', content: '【预设主提示】' },
    { identifier: 'worldInfoBefore', marker: true },
    { identifier: 'chatHistory', marker: true },
  ],
  prompt_order: [{ order: [
    { identifier: 'main', enabled: true },
    { identifier: 'worldInfoBefore', enabled: true },
    { identifier: 'chatHistory', enabled: true },
  ] }],
}));
await store.saveSettings({
  enabled: true, targets: ['writer'], includeWorlds: true, includePreset: true,
  scanDepth: 2, vars: {}, maxChars: 6000, worldIds: [],
});
const work = await workStore.save({ id: 'w1', title: 'W1', presetId: 'p1', worldIds: ['rain-city'], authorNote: '' });

const joinMessages = (call) => call.messages.map((m) => String(m.content?.[0]?.text ?? '')).join('\n');

// 1) 空输入 → 不发起请求
{
  const llm = fakeLlm();
  const result = await generateForWork({ store, workStore, workId: work.id, message: '   ', llm, model });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'work/empty-message');
  assert.equal(llm.calls.length, 0, '空输入不应调用模型');
}

// 2) 首轮输入里的关键词能激活世界书（scanText 含本次输入）
{
  const llm = fakeLlm();
  const result = await generateForWork({ store, workStore, workId: work.id, message: '雨城', llm, model, save: false });
  assert.equal(result.ok, true);
  assert.equal(llm.calls.length, 1);
  const text = joinMessages(llm.calls[0]);
  assert.match(text, /【雨城设定】/, '首轮输入激活了雨城条目');
  assert.match(text, /【常驻】/, '常驻条目');
  assert.doesNotMatch(text, /【雪设定】/, '未命中的条目不出现');
  assert.match(text, /【预设主提示】/, '预设 main 生效');
}

// 3) includeWorlds=false → 世界书不注入
{
  await store.saveSettings({ includeWorlds: false });
  const llm = fakeLlm();
  await generateForWork({ store, workStore, workId: work.id, message: '雨城', llm, model, save: false });
  const text = joinMessages(llm.calls[0]);
  assert.doesNotMatch(text, /【雨城设定】/, '关闭世界书后不注入');
  assert.match(text, /【预设主提示】/, '预设仍在');
  await store.saveSettings({ includeWorlds: true });
}

// 4) includePreset=false → 预设不执行
{
  await store.saveSettings({ includePreset: false });
  const llm = fakeLlm();
  await generateForWork({ store, workStore, workId: work.id, message: '雨城', llm, model, save: false });
  const text = joinMessages(llm.calls[0]);
  assert.doesNotMatch(text, /【预设主提示】/, '关闭预设后不执行');
  assert.match(text, /【雨城设定】/, '世界书仍在');
  await store.saveSettings({ includePreset: true });
}

// 5) 总开关关闭 → 不注入
{
  await store.saveSettings({ enabled: false });
  const llm = fakeLlm();
  const result = await generateForWork({ store, workStore, workId: work.id, message: '雨城', llm, model, save: false });
  const text = joinMessages(llm.calls[0]);
  assert.doesNotMatch(text, /【雨城设定】/);
  assert.doesNotMatch(text, /【预设主提示】/);
  assert.ok(result.meta.notes.some((note) => note.includes('总开关')), '要说明总开关关闭');
  await store.saveSettings({ enabled: true });
}

// 6) 重复点击：第二次直接 busy，模型只被调用一次
{
  const llm = fakeLlm({ delay: 60 });
  const first = generateForWork({ store, workStore, workId: work.id, message: '雨城', llm, model, save: false });
  const second = await generateForWork({ store, workStore, workId: work.id, message: '雨城', llm, model, save: false });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'work/busy');
  assert.equal((await first).ok, true);
  assert.equal(llm.calls.length, 1, '并发只发一次请求');
}

// 7) 删除后不再生成（不复活）
{
  await workStore.remove(work.id);
  const llm = fakeLlm();
  const result = await generateForWork({ store, workStore, workId: work.id, message: '雨城', llm, model, save: false });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'work/not-found');
  assert.equal(llm.calls.length, 0);
}

// 8) 中止 / 非 stop finish → 不写正文
{
  const fresh = await workStore.save({ id: 'w2', title: 'W2', presetId: 'p1', worldIds: ['rain-city'] });
  const aborted = new AbortController();
  aborted.abort();
  const llm1 = fakeLlm();
  const r1 = await generateForWork({ store, workStore, workId: fresh.id, message: '雨城', llm: llm1, model, signal: aborted.signal });
  assert.equal(r1.ok, false);
  assert.equal(llm1.calls.length, 0, '已中止的请求不发出');

  const llm2 = fakeLlm({ finish: { kind: 'max-tokens' } });
  const r2 = await generateForWork({ store, workStore, workId: fresh.id, message: '雨城', llm: llm2, model });
  assert.equal(r2.ok, false, '非 stop 不算成功');
  assert.equal((await workStore.chat(fresh.id)).length, 0, '失败不写历史');

  const okLlm = fakeLlm({ text: '正文' });
  const r3 = await generateForWork({ store, workStore, workId: fresh.id, message: '雨城', llm: okLlm, model });
  assert.equal(r3.ok, true);
  const chat = await workStore.chat(fresh.id);
  assert.equal(chat.length, 2, '成功写一对 user/assistant');
  assert.equal(chat[0].role, 'user');
  assert.equal(chat[1].content, '正文');
}

// 9) 扫描窗口包含本次输入
assert.match(buildScanText([{ role: 'user', content: '旧' }], '雨城', 2), /旧\n雨城/);
assert.match(buildScanText([], '雨城', 2), /雨城/);

await rm(root, { recursive: true, force: true });
console.log('generate-guards: 全部通过');
