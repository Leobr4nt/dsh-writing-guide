#!/usr/bin/env node
/**
 * ExtensionScopes 测试：同 id 跨 scope、编辑不外泄、文件夹 gate、坏 shape、重导入防重。
 *   node test/extension-scopes.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GuideStore } from '../lib/store.js';
import { ExtensionStore } from '../lib/extension-store.js';
import { ExtensionScopes, flattenEnabled } from '../lib/extension-scopes.js';
import { normalizePreset } from '../lib/preset.js';
import { normalizeCard } from '../lib/cards.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'wg-scopes-'));
const store = new GuideStore(root);
await store.ensure();
const extensionStore = new ExtensionStore(root);
await extensionStore.save({
  regex: { global: [{ id: 'g1', scriptName: 'G1', findRegex: '/a/g', placement: [2], replaceString:'' }] },
  helper: { enabled: true, scripts: [{ id: 'h1', name: 'H1', enabled: true, content:'' }] },
  template: { enabled: false },
  sessions: {},
});
await store.savePreset(normalizePreset({
  id: 'p1', name: 'P1',
  prompts: [{ identifier: 'main', content: 'M' }],
  prompt_order: [{ order: [{ identifier: 'main', enabled: true, content:'' }] }],
  extensions: {
    regex_scripts: [{ id: 'g1', scriptName: 'P-G1', findRegex: '/b/g', placement: [2], replaceString:'' }],
    tavern_helper: { scripts: [
      { id: 'h1', name: 'P-H1', enabled: true, content:'' },
      { type: 'folder', name: 'F', enabled: false, scripts: [{ id: 'hf', name: 'HF', enabled: true, content:'' }] },
    ] },
  },
}));
await store.saveCard(normalizeCard({
  id: 'c1', spec: 'chara_card_v2',
  data: { name: 'C1', extensions: { regex_scripts: [{ id: 'g1', scriptName: 'C-G1', findRegex: '/c/g', placement: [2], replaceString:'' }] } },
}));

const scopes = new ExtensionScopes({ store, extensionStore });

// 1) list：三 scope + 允许状态
{
  const list = await scopes.list({ presetId: 'p1', cardId: 'c1' });
  assert.deepEqual(list.map((row) => row.type), ['global', 'preset', 'character']);
  assert.equal(list[0].regexAllowed, true, 'global 永远允许');
  assert.equal(list[1].regexAllowed, false, 'preset 默认未授权');
  assert.equal(list[1].helperAllowed, false, 'preset helper 默认未授权');
}

// 2) 授权后 resolve：同 id 跨 scope 不混淆，顺序 global→preset→character
{
  await scopes.setAllowed({ type: 'preset', id: 'p1', kind: 'regex', enabled: true, content:'' });
  await scopes.setAllowed({ type: 'preset', id: 'p1', kind: 'helper', enabled: true, content:'' });
  await scopes.setAllowed({ type: 'character', id: 'c1', kind: 'regex', enabled: true, content:'' });
  const resolved = await scopes.resolve({ presetId: 'p1', cardId: 'c1' });
  const regexIds = resolved.regex.map((row) => `${row.scopeType}:${row.scriptName}`);
  assert.deepEqual(regexIds, ['global:G1', 'preset:P-G1', 'character:C-G1'], '三来源都执行且带 scope');
  const helperKeys = resolved.scripts.map((row) => row.key);
  assert.ok(helperKeys.includes(JSON.stringify(['global','global','h1'])), 'global helper');
  assert.ok(helperKeys.includes(JSON.stringify(['preset','p1','h1'])), '同 id 在不同 scope 有不同复合 key');
  const presetH1 = resolved.scripts.find((row) => row.key === JSON.stringify(['preset','p1','h1']));
  assert.deepEqual(presetH1.path, [0], 'path 指向原数组位置');
}

// 3) 文件夹 gate：enabled=false 的目录下脚本不进入
{
  const flat = flattenEnabled([{ type: 'folder', enabled: false, scripts: [{ id: 'x', enabled: true, content:'' }] }]);
  assert.equal(flat.length, 0, '文件夹 gate 生效');
  const on = flattenEnabled([{ type: 'folder', enabled: true, scripts: [{ id: 'x', enabled: true, content:'' }] }]);
  assert.equal(on.length, 1);
  assert.deepEqual(on[0].path, [0, 0]);
}

// 4) 编辑 preset 不外泄到 global / character
{
  await scopes.updateItem({ type: 'preset', id: 'p1', kind: 'regex', path: [0], item: { id: 'g1', scriptName: 'P-G1-EDIT', findRegex: '/b/g', placement: [2], replaceString:'' } });
  const globalState = await extensionStore.load();
  assert.equal(globalState.regex.global[0].scriptName, 'G1', 'global 未被改');
  const preset = await store.getPreset('p1');
  assert.equal(preset.extensions.regex_scripts[0].scriptName, 'P-G1-EDIT', 'preset 已改');
  const card = await store.getCard('c1');
  assert.equal(card.extensions.regex_scripts[0].scriptName, 'C-G1', 'card 未被改');
}

// 5) 坏 shape：报错且不清空
{
  await assert.rejects(() => scopes.replace({ type: 'preset', id: 'p1', kind: 'regex', items: 'not-array' }), (error) => error.code === 'bad-shape');
  const preset = await store.getPreset('p1');
  assert.equal(preset.extensions.regex_scripts.length, 1, '坏 shape 不清空数据');
  await assert.rejects(() => scopes.updateItem({ type: 'preset', id: 'p1', kind: 'regex', path: [9], item: {} }), /path 越界/);
}

// 6) 重新导入同 id：本 scope 内重映射，不影响其他 source
{
  const before = (await extensionStore.load()).regex.global.length;
  const result = await scopes.importItems({ type: 'preset', id: 'p1', kind: 'regex', items: [{ id: 'g1', scriptName: 'NEW', findRegex: '/d/g', placement: [2], replaceString:'' }] });
  assert.equal(result.count, 2);
  const preset = await store.getPreset('p1');
  assert.notEqual(preset.extensions.regex_scripts[1].id, 'g1', '本 scope 内重映射');
  assert.equal((await extensionStore.load()).regex.global.length, before, 'global 不受影响');
}

await rm(root, { recursive: true, force: true });
console.log('extension-scopes: 全部通过');
