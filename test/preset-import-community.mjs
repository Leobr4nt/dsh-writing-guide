#!/usr/bin/env node
/**
 * 预设导入 + 数据宏的可移植回归（**合成 fixture**，不依赖任何用户/第三方文件）。
 *
 *   node test/preset-import-community.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GuideStore } from '../lib/store.js';
import { normalizePreset } from '../lib/preset.js';
import { auditPreset } from '../lib/preset-audit.js';
import { toStPreset } from '../lib/export.js';
import { assemble } from '../lib/assemble.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'wg-fixture-'));
const store = new GuideStore(root);
await store.ensure();

// 合成一个"社区风格"预设：变量宏、嵌套 random、禁用条目、未知宏、扩展数据
const fixture = {
  id: 'fixture-community',
  name: 'fixture 社区风格',
  temperature: 0.9,
  prompts: [
    { identifier: 'main', content: '{{setvar::mood::安静}}{{char}}的基调是{{getvar::mood}}' },
    { identifier: 'turn', content: '第二人称：{{user}}推门进入' },
    { identifier: 'pick', content: '{{setvar::item::{{random::铜铃::旧信::苔痕}}}}{{getvar::item}}' },
    { identifier: 'disabledOne', content: '{{setvar::shouldNot::1}}禁用条目不执行' },
    { identifier: 'unknownOne', content: '{{unknownmac::x}}' },
    { identifier: 'chatHistory', marker: true },
  ],
  prompt_order: [{ order: [
    { identifier: 'main', enabled: true },
    { identifier: 'turn', enabled: true },
    { identifier: 'pick', enabled: true },
    { identifier: 'disabledOne', enabled: false },
    { identifier: 'unknownOne', enabled: true },
    { identifier: 'chatHistory', enabled: true },
  ] }],
  extensions: {
    regex_scripts: [{ scriptName: 'demo', findRegex: '/a/g', replaceString: 'b', disabled: false }],
    tavern_helper: { scripts: [{ name: 'demo', content: 'console.log(1)' }], variables: {} },
    SPreset: { ChatSquash: { x: 1 }, MacroNest: true },
  },
};

const compat = auditPreset(fixture);
assert.deepEqual(compat.markers.unsupported, [], 'marker 全支持');
assert.equal(compat.counts.enabled, 5, '启用 5 条');
assert.equal(compat.counts.disabled, 1, '禁用 1 条');
assert.ok(compat.macros.unsupported.some(([name]) => name === 'unknownmac'), '未知宏要报出');
assert.ok((compat.partial ?? []).some((line) => line.includes('正则')), '正则走发送副本（partial），不是完全不支持');
assert.ok(compat.partial.some((line) => line.includes('酒馆助手')&&line.includes('常驻')), '脚本报告区分已实现的常驻能力与兼容缺口');
assert.ok(!compat.partial.some(line=>line.includes('变量仅在本次组装内有效')),'旧的临时变量说明不再出现');
assert.ok(compat.usable.some(line=>line.includes('持久化')),'报告说明普通宏的聊天变量保存能力');

const preset = normalizePreset({ ...fixture, id: 'fixture-community' });
preset.compat = { unsupported: ['STALE_REPORT'] };
await store.savePreset(preset);
const stored = await store.getPreset('fixture-community');

assert.ok(stored.compat.macros.supported.some(([name]) => name === 'random'));
assert.ok(stored.compat.macros.supported.some(([name]) => name === 'setvar'));
assert.ok(!stored.compat.unsupported.includes('STALE_REPORT'));
assert.ok(!stored.compat.macros.unsupported.some(([name]) => ['setvar','getvar','random'].includes(name)));
// 结构 & 扩展保留
assert.equal(stored.prompts.length, fixture.prompts.length);
assert.equal(stored.extensions.regex_scripts.length, 1, '扩展数据保留');
assert.equal(stored.extensions.tavern_helper.scripts.length, 1, '内嵌脚本仅作数据');

// 组装：变量宏生效、禁用条目不执行、未知宏提示
const result = assemble({
  settings: { enabled: true, targets: ['writer'], includeWorlds: false, vars: { char: '沈砚', user: '我' }, maxChars: 6000, header: '' },
  worlds: [],
  presets: [stored],
  mode: 'writer',
  scanText: '',
  conversation: [],
  requestLevel: true,
  random: () => 0.5,
});

const systemText = result.systemText ?? result.system ?? '';
assert.match(systemText, /沈砚的基调是安静/, 'setvar → getvar 在同一组装内生效');
assert.match(systemText, /第二人称：我推门进入/, 'user 宏展开');
assert.match(systemText, /(铜铃|旧信|苔痕)/, '嵌套 random 展开为候选项之一');
assert.doesNotMatch(systemText, /禁用条目不执行/, '禁用条目不进入上下文');
assert.ok(result.meta.notes.some((note) => note.includes('unknownmac') || note.includes('未执行')), '未知宏要提示');
assert.equal(systemText.includes('shouldNot'), false, '禁用条目的 setvar 不执行');

// 导出往返
const exported = toStPreset(stored);
const back = normalizePreset(exported, 'fixture-community-2');
assert.equal(back.prompts.length, stored.prompts.length);
assert.equal(back.extensions.regex_scripts.length, 1);

// 不写会话绑定
assert.deepEqual((await store.loadBindings()).bindings ?? {}, {});

await rm(root, { recursive: true, force: true });
console.log('preset-import-community: 全部通过（合成 fixture）');
