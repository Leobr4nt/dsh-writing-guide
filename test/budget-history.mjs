#!/usr/bin/env node
/**
 * 预算来源正确性反例（假 llm）：
 *   - 只裁作品历史，不裁预设/@D/post-history 指导/本次输入
 *   - 预算不足 → 拒绝，不删预设凑数
 *   - contextWindow <= maxTokens → 零调用
 *   - contextWindow=0 → 未设限，不裁
 *
 *   node test/budget-history.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GuideStore } from '../lib/store.js';
import { WorkStore } from '../lib/work.js';
import { normalizePreset } from '../lib/preset.js';
import { normalizeWorld } from '../lib/worldinfo.js';
import { generateForWork } from '../lib/writer.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'wg-bh-'));
const store = new GuideStore(root);
const workStore = new WorkStore(root);
await store.ensure();

const fakeLlm = ({ contextWindow = 4096, systemPromptUpdate } = {}) => {
  const calls = [];
  return {
    calls,
    async resolveModelInfo() {
      return { context: { contextWindow }, ...(systemPromptUpdate ? { systemPromptUpdate } : {}) };
    },
    stream(request) {
      calls.push(request);
      return (async function* run() {
        yield { type: 'text-delta', index: 0, text: 'ok' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
};

const preset = (mainContent) => normalizePreset({
  id: 'p', name: 'P',
  prompts: [
    { identifier: 'main', content: mainContent },
    { identifier: 'worldInfoBefore', marker: true },
    { identifier: 'chatHistory', marker: true },
    { identifier: 'guide', content: '[GUIDE_USER]', role: 'user', system_prompt: false, marker: false },
    { identifier: 'depth0', content: '[D0_USER]', role: 'user', marker: false, injection_position: 1, injection_depth: 0, injection_order: 100 },
  ],
  prompt_order: [{ order: [
    { identifier: 'main', enabled: true },
    { identifier: 'worldInfoBefore', enabled: true },
    { identifier: 'chatHistory', enabled: true },
    { identifier: 'guide', enabled: true },
    { identifier: 'depth0', enabled: true },
  ] }],
});
await store.savePreset(preset('[MAIN]'));
await store.saveWorld(normalizeWorld({ id: 'w', name: 'W', entries: [{ uid: 1, key: [], constant: true, content: '[WI]' }] }));
const base = {
  enabled: true, targets: ['writer'], includeWorlds: true, includePreset: true,
  scanDepth: 2, vars: {}, maxChars: 6000, worldIds: [], contextWindow: 0, maxTokens: 0,
  worldBudgetPercent: 25, worldBudgetTokens: 0, maxRecursionSteps: 0, degradeOrder: true,
};
await store.saveSettings(base);

const seedHistory = async (id, pairs) => {
  const work = await workStore.save({ id, title: id, presetId: 'p', worldIds: ['w'] });
  const rows = [];
  for (let i = 0; i < pairs; i += 1) {
    rows.push({ role: 'user', content: `HIST_U${i}-` + '历史'.repeat(12) });
    rows.push({ role: 'assistant', content: `HIST_A${i}-` + '历史'.repeat(12) });
  }
  await workStore.append(id, rows);
  return work;
};
const textOf = (call) => call.messages.map((m) => m.content.map((b) => b.text ?? '').join('')).join('\n');

// 1) 只裁历史：GUIDE_USER / D0_USER / 本次输入必须保留
{
  await store.saveSettings({ ...base, contextWindow: 260, maxTokens: 60 });
  const work = await seedHistory('h1', 4);
  const llm = fakeLlm({ contextWindow: 260 });
  const result = await generateForWork({ store, workStore, workId: work.id, message: '本次输入', llm, model: { provider: 'f', model: 'm' }, save: false });
  assert.equal(result.ok, true, result.detail);
  assert.ok(result.meta.budget.droppedPairs >= 1, '确实裁了历史');
  const text = textOf(llm.calls[0]);
  assert.match(text, /\[GUIDE_USER\]/, 'post-history user 指导不能被裁');
  assert.match(text, /\[D0_USER\]/, '@D(user) 不能被裁');
  assert.match(text, /本次输入/, '本次输入不能被裁');
  assert.match(text, /\[MAIN\]/, '预设 main 不能被裁');
  assert.doesNotMatch(text, /HIST_U0/, '最旧的历史对被裁掉');
}

// 2) 预算不足（预设本身太大）→ 拒绝，不删预设凑数
{
  await store.savePreset(preset('[MAIN]' + '大'.repeat(400)));
  await store.saveSettings({ ...base, contextWindow: 200, maxTokens: 40 });
  const work = await seedHistory('h2', 2);
  const llm = fakeLlm({ contextWindow: 200 });
  const result = await generateForWork({ store, workStore, workId: work.id, message: '本次输入', llm, model: { provider: 'f', model: 'm' }, save: false });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'budget/over-context');
  assert.equal(llm.calls.length, 0, '超预算不得发请求');
  assert.match(result.detail, /预设\/世界书\/本次输入本身超出预算/);
  await store.savePreset(preset('[MAIN]'));
}

// 3) contextWindow <= maxTokens → 立即拒绝，零调用
{
  await store.saveSettings({ ...base, contextWindow: 32, maxTokens: 32 });
  const work = await seedHistory('h3', 1);
  const llm = fakeLlm({ contextWindow: 32 });
  const result = await generateForWork({ store, workStore, workId: work.id, message: 'x', llm, model: { provider: 'f', model: 'm' } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'budget/context-exhausted');
  assert.equal(llm.calls.length, 0);
}

// 4) contextWindow=0 → 未设限，不裁历史
{
  await store.saveSettings({ ...base, contextWindow: 0, maxTokens: 0 });
  const work = await seedHistory('h4', 4);
  const llm = fakeLlm({ contextWindow: 0 });
  const result = await generateForWork({ store, workStore, workId: work.id, message: '本次输入', llm, model: { provider: 'f', model: 'm' }, save: false });
  assert.equal(result.ok, true, result.detail);
  const text = textOf(llm.calls[0]);
  assert.match(text, /HIST_U0/, '未设限时不裁历史');
  assert.equal(result.meta.budget ?? null, null, '未设限时没有 budget 记录');
}

await rm(root, { recursive: true, force: true });
console.log('budget-history: 全部通过');
