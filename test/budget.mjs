#!/usr/bin/env node
/**
 * 请求预算准入测试（假 llm，不发网络请求）。
 *
 *   node test/budget.mjs
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
import { estimateTokens, resolveBudget, fitMessages } from '../lib/budget.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'wg-budget-'));
const store = new GuideStore(root);
const workStore = new WorkStore(root);
await store.ensure();

const fakeLlm = ({ contextWindow = 4096, finish = { kind: 'stop' }, text = 'ok' } = {}) => {
  const calls = [];
  return {
    calls,
    async resolveModelInfo() { return { context: { contextWindow } }; },
    stream(request) {
      calls.push(request);
      return (async function* run() {
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'finish', reason: finish };
      })();
    },
  };
};

await store.saveWorld(normalizeWorld({
  id: 'w', name: 'W',
  entries: [{ uid: 1, key: ['雨'], constant: true, content: '【世界书】' }],
}));
await store.savePreset(normalizePreset({
  id: 'p', name: 'P',
  prompts: [{ identifier: 'main', content: '【预设】' }, { identifier: 'chatHistory', marker: true }],
  prompt_order: [{ order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }],
}));
const baseSettings = {
  enabled: true, targets: ['writer'], includeWorlds: true, includePreset: true,
  scanDepth: 2, vars: {}, maxChars: 6000, worldIds: [], contextWindow: 0, maxTokens: 0,
  worldBudgetPercent: 25, worldBudgetTokens: 0, maxRecursionSteps: 0,
};
await store.saveSettings(baseSettings);

// ---------- 估算与预算
assert.ok(estimateTokens('中文'.repeat(10)) > estimateTokens('abcdefgh'.repeat(10)), '中文保守估算更高');
{
  const b = resolveBudget({ contextWindow: 4096, userContextWindow: 512, maxOutput: 128, percent: 25 });
  assert.equal(b.context, 512, '模型与用户取更严格的一侧');
  assert.equal(b.available, 384);
  assert.equal(b.worldTokens, 128);
}

// ---------- 成对裁减（纯函数）
{
  const messages = [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'U1'.repeat(40) },
    { role: 'assistant', content: 'A1'.repeat(40) },
    { role: 'user', content: 'U2'.repeat(40) },
    { role: 'assistant', content: 'A2'.repeat(40) },
    { role: 'user', content: 'NOW' },
  ];
  const fit = fitMessages({ messages, budget: 90, countTokens: (text) => text.length, perMessage: 1 });
  assert.equal(fit.rejected, false);
  assert.ok(fit.droppedMessages >= 2, '至少裁掉一对');
  assert.ok(fit.droppedPairs >= 1, '按对裁减');
  const roles = fit.messages.map((m) => m.role);
  assert.equal(roles[0], 'system', 'system 不被裁');
  assert.equal(fit.messages[fit.messages.length - 1].content, 'NOW', '当前输入必须保留');
  for (let i = 1; i < roles.length - 1; i += 1) {
    if (roles[i] === 'assistant') assert.equal(roles[i - 1], 'user', '不出现孤 assistant');
  }
}

// ---------- 超小上下文 + 超长输入 → 拒绝，不发请求
{
  await store.saveSettings({ ...baseSettings, contextWindow: 32, maxTokens: 16, maxChars: 10 });
  const work = await workStore.save({ id: 'tiny', title: 'tiny', presetId: 'p', worldIds: ['w'] });
  const llm = fakeLlm({ contextWindow: 4096 });
  const result = await generateForWork({ store, workStore, workId: work.id, message: '超长中文'.repeat(100), llm, model: { provider: 'f', model: 'm' } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'budget/input-too-large');
  assert.equal(llm.calls.length, 0, '超预算不发起请求');
  assert.match(result.detail, /超出可用预算/);
}

// ---------- 总开关关闭：作者注 / outlet 也一起关
{
  await store.saveSettings({ ...baseSettings, enabled: false });
  const work = await workStore.save({ id: 'off', title: 'off', presetId: 'p', worldIds: ['w'], authorNote: 'NOTE_SHOULD_BE_OFF' });
  const llm = fakeLlm();
  const result = await generateForWork({ store, workStore, workId: work.id, message: '雨', llm, model: { provider: 'f', model: 'm' }, save: false });
  assert.equal(result.ok, true);
  const text = llm.calls[0].messages.map((m) => String(m.content?.[0]?.text ?? '')).join('\n');
  assert.doesNotMatch(text, /NOTE_SHOULD_BE_OFF/, '总开关关闭时作者注不注入');
  assert.doesNotMatch(text, /【世界书】/, '世界书不注入');
  assert.doesNotMatch(text, /【预设】/, '预设不注入');
}

// ---------- 正常预算：token 不重复计算
{
  await store.saveSettings({ ...baseSettings, contextWindow: 2048, maxTokens: 128 });
  const work = await workStore.save({ id: 'ok', title: 'ok', presetId: 'p', worldIds: ['w'] });
  const llm = fakeLlm();
  const result = await generateForWork({ store, workStore, workId: work.id, message: '雨', llm, model: { provider: 'f', model: 'm' }, save: false });
  assert.equal(result.ok, true);
  const messages = llm.calls[0].messages;
  const sum = messages.reduce((acc, m) => acc + estimateTokens(m.content?.[0]?.text ?? ''), 0);
  assert.equal(result.meta.tokens, sum, 'tokens 只统计 messages，不重复叠加 system');
}

await rm(root, { recursive: true, force: true });
console.log('budget: 全部通过');
