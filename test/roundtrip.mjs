#!/usr/bin/env node
/**
 * 导入导出闭环测试：
 *   三次保存 → 导出（ST 结构）→ 再导入 → 未知扩展字段原层级不丢、raw 不增长、content 取最新值。
 *
 *   node test/roundtrip.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GuideStore } from '../lib/store.js';
import { normalizeWorld } from '../lib/worldinfo.js';
import { normalizePreset } from '../lib/preset.js';
import { toStWorld, toStPreset } from '../lib/export.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'wg-rt-'));
const store = new GuideStore(root);
await store.ensure();

// ---------- 世界书：带 ST 扩展字段
const world = normalizeWorld({
  extensions: { custom: 1 },
  id: 'rt-world',
  name: '雨城',
  entries: [{
    uid: 1,
    key: ['雨'],
    keysecondary: ['夜'],
    selective: true,
    content: 'v1',
    comment: '测试条目',
    order: 10,
    position: 4,
    depth: 2,
    role: 1,
    probability: 80,
    // 未知扩展字段（ST 的 extensions 形态）
    extensions: { sticky: 3, cooldown: 30, delay: 5 },
    cooldown: 30,
    excludeRecursion: true,
  }],
});

let saved = await store.saveWorld(world);
for (let i = 0; i < 3; i += 1) saved = await store.saveWorld(await store.getWorld('rt-world'));

const reread = await store.getWorld('rt-world');
assert.equal(reread.entries[0].raw, undefined, '不再有 raw 字段');
assert.deepEqual(reread.entries[0].extensions, { sticky: 3, cooldown: 30, delay: 5 }, '未知扩展字段在原层级');
assert.equal(reread.entries[0].cooldown, 30);
assert.equal(reread.entries[0].excludeRecursion, true);
const serialized = JSON.stringify(reread);
assert.equal((serialized.match(/"raw"/g) ?? []).length, 0, '保存三次也没有 raw 嵌套');

// 导出 → ST 结构
const exported = toStWorld(reread);
assert.equal(exported.name, '雨城');
assert.ok(exported.entries && typeof exported.entries === 'object' && !Array.isArray(exported.entries), 'ST 的 entries 字典');
const raw1 = JSON.stringify(exported);
assert.equal((raw1.match(/"raw"/g) ?? []).length, 0, '导出里也没有 raw');
assert.deepEqual(exported.entries['1'].extensions, { sticky: 3, cooldown: 30, delay: 5 });
assert.equal(exported.entries['1'].keysecondary[0], '夜');

// 再导入（把导出物当 ST 文件读回来）
const reimported = normalizeWorld(exported, 'rt-world-2');
assert.deepEqual(reimported.entries[0].extensions, { sticky: 3, cooldown: 30, delay: 5 }, '再导入后未知字段仍在');
assert.equal(reimported.entries[0].uid, 1);
assert.equal(reimported.entries[0].content, 'v1');
assert.equal(reimported.entries[0].position, 4);

// 改 content → 保存 → 导出 → 以最新值为准
reimported.entries[0].content = 'v2-最新';
const after = await store.saveWorld({ ...reimported, id: 'rt-world' });
const exported2 = toStWorld(after);
assert.equal(exported2.entries['1'].content, 'v2-最新', '导出取最新 content');
assert.deepEqual(exported2.entries['1'].extensions, { sticky: 3, cooldown: 30, delay: 5 }, '改内容不影响未知字段');

// ---------- 预设：未知字段 + 三次保存
const preset = normalizePreset({
  id: 'rt-preset',
  name: '预设A',
  prompts: [
    { identifier: 'main', content: 'MAIN', role: 'system', temperature: 0.7, custom_unknown: { a: 1 } },
    { identifier: 'chatHistory', marker: true },
  ],
  prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }],
  temperature: 0.9,
  top_p: 0.95,
});
await store.savePreset(preset);
for (let i = 0; i < 2; i += 1) await store.savePreset(await store.getPreset('rt-preset'));
const presetBack = await store.getPreset('rt-preset');
assert.equal(presetBack.prompts[0].raw, undefined, 'prompt 不再有 raw');
assert.deepEqual(presetBack.prompts[0].custom_unknown, { a: 1 }, 'prompt 未知字段原层级');
assert.equal(presetBack.prompts[0].temperature, 0.7);

const stPreset = toStPreset(presetBack);
assert.ok(Array.isArray(stPreset.prompts) && Array.isArray(stPreset.prompt_order), 'ST 预设结构');
assert.equal((JSON.stringify(stPreset).match(/"raw"/g) ?? []).length, 0);
assert.deepEqual(stPreset.prompts[0].custom_unknown, { a: 1 });

const presetAgain = normalizePreset(stPreset, 'rt-preset-2');
assert.deepEqual(presetAgain.prompts[0].custom_unknown, { a: 1 }, '预设再导入不丢未知字段');
assert.equal(presetAgain.prompts[0].content, 'MAIN');
assert.equal(presetBack.temperature, 0.9, '预设顶层 temperature 保留');
assert.equal(presetBack.top_p, 0.95, '预设顶层 top_p 保留');
assert.equal(stPreset.temperature, 0.9, '导出保留 temperature');
assert.equal(stPreset.top_p, 0.95, '导出保留 top_p');
assert.deepEqual(exported.extensions, { custom: 1 }, '世界书顶层 extensions 导出保留');
assert.deepEqual(reimported.extensions, { custom: 1 }, '世界书顶层 extensions 再导入保留');

await rm(root, { recursive: true, force: true });
console.log('roundtrip: 全部通过');
