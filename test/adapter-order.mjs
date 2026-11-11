#!/usr/bin/env node
/**
 * 适配器序列化能力测试（假 llm）：非 in-history 时不得静默丢 system 位置。
 *
 *   node test/adapter-order.mjs
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

const root = await mkdtemp(path.join(os.tmpdir(), 'wg-adapter-'));
const store = new GuideStore(root);
const workStore = new WorkStore(root);
await store.ensure();

const fakeLlm = ({ systemPromptUpdate, contextWindow = 4096 } = {}) => {
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

await store.saveWorld(normalizeWorld({
  id: 'w', name: 'W',
  entries: [{ uid: 1, key: ['雨'], constant: true, content: '【WI】' }],
}));
await store.savePreset(normalizePreset({
  id: 'p', name: 'P',
  prompts: [
    { identifier: 'main', content: '【MAIN】' },
    { identifier: 'worldInfoBefore', marker: true },
    { identifier: 'chatHistory', marker: true },
    { identifier: 'jailbreak', content: '【PHI】' },
  ],
  prompt_order: [{ order: [
    { identifier: 'main', enabled: true },
    { identifier: 'worldInfoBefore', enabled: true },
    { identifier: 'chatHistory', enabled: true },
    { identifier: 'jailbreak', enabled: true },
  ] }],
}));
const base = {
  enabled: true, targets: ['writer'], includeWorlds: true, includePreset: true,
  scanDepth: 2, vars: {}, maxChars: 6000, worldIds: [], contextWindow: 4096, maxTokens: 128,
  worldBudgetPercent: 25, worldBudgetTokens: 0, maxRecursionSteps: 0, degradeOrder: false,
};
await store.saveSettings({ ...base, adapterInHistory: false, degradeOrder: false });

// 1) 非 in-history + 历史后 system → 明确拒绝，不发请求
{
  const work = await workStore.save({ id: 'a1', title: 'A1', presetId: 'p', worldIds: ['w'] });
  const llm = fakeLlm({});
  const result = await generateForWork({ store, workStore, workId: work.id, message: '雨', llm, model: { provider: 'deepseek-account', model: 'deepseek-flash' } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'adapter/no-in-history-system');
  assert.equal(llm.calls.length, 0, '不兼容时不得静默生成');
  assert.match(result.detail, /in-history/);
}

// 2) 显式 degradeOrder：合并成一条 system，并标记顺序退化
{
  await store.saveSettings({ ...base, degradeOrder: true });
  const work = await workStore.save({ id: 'a2', title: 'A2', presetId: 'p', worldIds: ['w'] });
  const llm = fakeLlm({});
  const result = await generateForWork({ store, workStore, workId: work.id, message: '雨', llm, model: { provider: 'deepseek-account', model: 'deepseek-flash' }, save: false });
  assert.equal(result.ok, true);
  const messages = llm.calls[0].messages;
  assert.equal(messages.filter((m) => m.role === 'system').length, 1, '只有一条 system');
  assert.equal(messages[0].role, 'system');
  const systemText = messages[0].content.map((b) => b.text).join('');
  assert.match(systemText, /【MAIN】/);
  assert.match(systemText, /【WI】/);
  assert.match(systemText, /【PHI】/, '降级也要保留内容');
  assert.equal(result.meta.orderDegraded, true);
  await store.saveSettings({ ...base, adapterInHistory: false, degradeOrder: false });
}

// 3) in-history 适配器：保留多条 system 与 PHI 位置
{
  const work = await workStore.save({ id: 'a3', title: 'A3', presetId: 'p', worldIds: ['w'] });
  await store.saveSettings({ ...base, adapterInHistory: true });
  const llm = fakeLlm({ systemPromptUpdate: 'in-history' });
  const result = await generateForWork({ store, workStore, workId: work.id, message: '雨', llm, model: { provider: 'catiecli', model: 'vtx-gemini-4-argon' }, save: false });
  assert.equal(result.ok, true);
  const messages = llm.calls[0].messages;
  const roles = messages.map((m) => m.role);
  assert.ok(roles.filter((role) => role === 'system').length >= 2, 'system 没被合并');
  assert.equal(roles[roles.length - 1], 'system', 'PHI 仍在历史之后');
  const phi = messages[messages.length - 1].content.map((b) => b.text).join('');
  assert.match(phi, /【PHI】/);
  assert.equal(result.meta.orderDegraded, undefined);
  await store.saveSettings({ ...base, adapterInHistory: false, degradeOrder: false });
}

// 4) 非 in-history 且没有历史后 system：前置 system 合并为一条也能生成
{
  const simple = normalizePreset({
    id: 'simple', name: 'S',
    prompts: [
      { identifier: 'main', content: '【M1】' },
      { identifier: 'worldInfoBefore', marker: true },
      { identifier: 'chatHistory', marker: true },
    ],
    prompt_order: [{ order: [
      { identifier: 'main', enabled: true },
      { identifier: 'worldInfoBefore', enabled: true },
      { identifier: 'chatHistory', enabled: true },
    ] }],
  });
  await store.savePreset(simple);
  const work = await workStore.save({ id: 'a4', title: 'A4', presetId: 'simple', worldIds: ['w'] });
  const llm = fakeLlm({});
  const result = await generateForWork({ store, workStore, workId: work.id, message: '雨', llm, model: { provider: 'deepseek-account', model: 'deepseek-flash' }, save: false });
  assert.equal(result.ok, true);
  const messages = llm.calls[0].messages;
  assert.equal(messages.filter((m) => m.role === 'system').length, 1, '前置 system 已合并');
  assert.match(messages[0].content.map((b) => b.text).join(''), /【M1】[\s\S]*【WI】/, '内容顺序保持');
  assert.equal(result.meta.systemMerged, true);
}

// 5) deepseek 系谎报 in-history metadata 时仍按 leading-only（不信任 metadata）
{
  await store.saveSettings({ ...base, degradeOrder: false });
  const work = await workStore.save({ id: 'a5', title: 'A5', presetId: 'p', worldIds: ['w'] });
  const llm = fakeLlm({ systemPromptUpdate: 'in-history' }); // 谎报
  const result = await generateForWork({
    store, workStore, workId: work.id, message: '雨', llm,
    model: { provider: 'deepseek-account', model: 'deepseek-flash' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'adapter/no-in-history-system', 'deepseek 系不看 metadata');
  assert.equal(llm.calls.length, 0);
}

await rm(root, { recursive: true, force: true });
console.log('adapter-order: 全部通过');
