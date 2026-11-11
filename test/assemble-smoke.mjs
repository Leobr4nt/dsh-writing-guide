#!/usr/bin/env node
/**
 * 组装自测 —— 不需要 Harness。语义对齐 SillyTavern：
 *   prompts + prompt_order、marker 占位、世界书 8 个位置、@D 深度块、概率/常驻/次级键/order。
 *
 *   node test/assemble-smoke.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GuideStore } from '../lib/store.js';
import { assemble, modeMatches, detectMode } from '../lib/assemble.js';
import { normalizePreset, orderedPrompts, promptByIdentifier } from '../lib/preset.js';
import { normalizeWorld, activate, world_info_position } from '../lib/worldinfo.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'wg-assemble-'));
const store = new GuideStore(root);
await store.ensure();

// ---- 预设：ST 结构，prompt_order 里 main 在 worldInfoBefore 之前，jailbreak 在最后
const preset = normalizePreset({
  id: 'base',
  name: '写作基础',
  prompts: [
    { identifier: 'main', name: '主提示词', system_prompt: true, role: 'system', content: '你是作者。叙述者 {{user}}。' },
    { identifier: 'worldInfoBefore', name: '世界书 ↑Char', marker: true },
    { identifier: 'charDescription', name: '角色描述', marker: true },
    { identifier: 'scenario', name: '场景', marker: true },
    { identifier: 'worldInfoAfter', name: '世界书 ↓Char', marker: true },
    { identifier: 'dialogueExamples', name: '示例对话', marker: true },
    { identifier: 'chatHistory', name: '聊天记录', marker: true },
    { identifier: 'jailbreak', name: 'PHI', system_prompt: true, role: 'system', content: '别复述设定。' },
    { identifier: 'disabledOne', name: '被关掉的条目', system_prompt: true, role: 'system', content: '不该出现。' },
  ],
  prompt_order: [{
    character_id: 100000,
    order: [
      { identifier: 'main', enabled: true },
      { identifier: 'worldInfoBefore', enabled: true },
      { identifier: 'charDescription', enabled: true },
      { identifier: 'scenario', enabled: true },
      { identifier: 'worldInfoAfter', enabled: true },
      { identifier: 'dialogueExamples', enabled: true },
      { identifier: 'chatHistory', enabled: true },
      { identifier: 'jailbreak', enabled: true },
      { identifier: 'disabledOne', enabled: false },
    ],
  }],
});
assert.equal(orderedPrompts(preset).length, 8, '禁用条目不算进顺序');

// ---- 世界书：8 个位置都放一条
const world = normalizeWorld({
  id: 'city',
  name: '雨城',
  entries: [
    { uid: 1, comment: '↑Char 常驻', key: [], constant: true, order: 10, position: 0, content: '【before】城市常年有雨。' },
    { uid: 2, comment: '↑Char 关键词', key: ['雨'], order: 5, content: '【before-early】排水沟倒灌。' },
    { uid: 3, comment: '↓Char', key: [], constant: true, order: 20, position: 1, content: '【after】叙事偏冷静。' },
    { uid: 4, comment: '↑AT', key: [], constant: true, order: 30, position: 2, content: '【ANTop】作者注之前。' },
    { uid: 5, comment: '↓AT', key: [], constant: true, order: 40, position: 3, content: '【ANBottom】作者注之后。' },
    { uid: 6, comment: '@D4', key: ['雨'], order: 50, position: 4, depth: 4, role: 0, content: '【D4】她讨厌伞骨漏水。' },
    { uid: 7, comment: '@D1 user', key: ['雨'], order: 60, position: 4, depth: 1, role: 1, content: '【D1-user】更近。' },
    { uid: 8, comment: '↑EM', key: [], constant: true, order: 70, position: 5, content: '【EMTop】示例前。' },
    { uid: 9, comment: '↓EM', key: [], constant: true, order: 80, position: 6, content: '【EMBottom】示例后。' },
    { uid: 10, comment: 'outlet', key: [], constant: true, order: 90, position: 7, outletName: 'quotes', content: '【OUTLET】不该直接进系统提示词。' },
    { uid: 11, comment: '禁用', key: ['雨'], disable: true, order: 100, content: '【disabled】不该出现。' },
    { uid: 12, comment: '概率 0', key: ['雨'], probability: 0, order: 110, content: '【prob0】不该出现。' },
    { uid: 13, comment: '未命中', key: ['雪'], order: 120, content: '【snow】不该出现。' },
  ],
});
await store.savePreset(preset);
await store.saveWorld(world);
await store.saveSettings({ enabled: true, targets: ['writer'], vars: { user: '阿岚', char: '沈砚', persona: '怕雨' } });

const load = async () => ({
  settings: await store.loadSettings(),
  worlds: await store.listWorlds(),
  presets: await store.listPresets(),
  mode: 'writer',
  scanText: '外面在下雨，夜很深。',
});

// ---- 模式门控
const standard = assemble({ ...(await load()), mode: 'standard' });
assert.equal(standard.systemText, '');
assert.equal(standard.meta.targetMatched, false);

// ---- 主体
const result = await load();
const text = assemble(result);
assert.equal(text.meta.injected, true);
assert.equal(text.meta.preset, 'base');
const system = text.systemText;

// 宏
assert.match(system, /叙述者 阿岚。/, '{{user}} 被替换');

// 顺序：main → before(按 order) → ↓Char；PHI 不再进系统段（它在消息里、历史之后）
const posMain = system.indexOf('你是作者');
const posBeforeEarly = system.indexOf('【before-early】');
const posBefore = system.indexOf('【before】');
const posAfter = system.indexOf('【after】');
assert.ok(posMain >= 0 && posBeforeEarly > posMain, 'worldInfoBefore 在 main 之后');
assert.ok(posBeforeEarly < posBefore, '世界书条目按 order 升序（5 在 10 前）');
assert.ok(posAfter > posBefore, '↓Char 在 ↑Char 之后');
assert.equal(system.includes('别复述设定。'), false, 'PHI 不进系统段（普通会话无 post-history 位置）');
assert.equal(
  text.messages.some((message) => message.content.includes('别复述设定。')),
  true,
  'PHI 作为消息保留在历史之后（生成入口使用）',
);

// AN 没有 author's note 时并入 before/after 区
assert.ok(system.includes('【ANTop】'), 'ANTop 未丢');
assert.ok(system.includes('【ANBottom】'), 'ANBottom 未丢');
assert.ok(system.indexOf('【ANTop】') < system.indexOf('【after】'), 'ANTop 在 ↓Char 之前');
assert.ok(text.meta.notes.some((note) => note.includes('ANTop')), '降级要有提示');

// EM 在示例对话位
assert.ok(system.includes('【EMTop】') && system.includes('【EMBottom】'));
assert.ok(system.indexOf('【EMTop】') < system.indexOf('【EMBottom】'));

// 排除项
assert.doesNotMatch(system, /不该出现/, '禁用/概率 0/未命中/被关掉的预设条目都不出现');
assert.doesNotMatch(system, /【OUTLET】/, 'outlet 不进系统提示词');
assert.doesNotMatch(system, /【snow】/);
assert.doesNotMatch(system, /被关掉的条目/);

// @D 深度块
assert.equal(text.depthBlocks.length, 2, '两条 @D 形成两块');
assert.equal(text.depthBlocks[0].depth, 4, 'depth 从远到近');
assert.equal(text.depthBlocks[1].depth, 1);
assert.equal(text.depthBlocks[1].role, 'user', 'role 名字保留');
assert.equal(text.meta.depthSupported, false, '普通会话不支持消息级 @D');
assert.match(system, /【D4】/, '普通会话：@D 并入系统提示词末尾（明确标注为近似）');
assert.ok(system.indexOf('【D4】') > posAfter, '并入在系统段末尾');
assert.ok(text.meta.notes.some((note) => note.includes('deep-frozen')), '@D 的近似行为要写进 notes');

// ---- 有 author's note 条目时，ANTop/ANBottom 围绕它
const withAN = normalizePreset({
  id: 'with-an',
  name: '带作者注',
  prompts: [
    { identifier: 'main', content: '主。' },
    { identifier: 'worldInfoBefore', marker: true },
    { identifier: 'authorsNote', content: '【作者注】', system_prompt: true, role: 'system' },
    { identifier: 'worldInfoAfter', marker: true },
  ],
  prompt_order: [{ order: [
    { identifier: 'main', enabled: true },
    { identifier: 'worldInfoBefore', enabled: true },
    { identifier: 'authorsNote', enabled: true },
    { identifier: 'worldInfoAfter', enabled: true },
  ] }],
});
await store.savePreset(withAN);
await store.saveSettings({ presetId: 'with-an' });
const anText = assemble({ ...(await load()), presets: await store.listPresets() });
assert.ok(anText.systemText.indexOf('【ANTop】') < anText.systemText.indexOf('【作者注】'), 'ANTop 在作者注之前');
assert.ok(anText.systemText.indexOf('【作者注】') < anText.systemText.indexOf('【ANBottom】'), 'ANBottom 在作者注之后');
await store.saveSettings({ presetId: '' });

// ---- 旧格式迁移
const legacy = normalizePreset({ id: 'legacy', name: '旧格式', systemPrompt: '旧系统提示词。', storyString: '{{char}} 的故事', jailbreak: '旧 PHI。' });
assert.equal(promptByIdentifier(legacy, 'main').content, '旧系统提示词。');
assert.equal(promptByIdentifier(legacy, 'jailbreak').content, '旧 PHI。');
assert.ok(promptByIdentifier(legacy, 'storyString'), 'storyString 迁移成独立条目');

// ---- 开关
await store.saveSettings({ enabled: false });
assert.equal(assemble(await load()).systemText, '');
await store.saveSettings({ enabled: true });

// ---- 预算：整块取舍，不切断条目（字符估算，不是 token）
const bigPreset = normalizePreset({
  id: 'big',
  name: '大块预设',
  prompts: [
    { identifier: 'main', content: 'A'.repeat(300) },
    { identifier: 'x2', content: 'B'.repeat(300) },
  ],
  prompt_order: [{ order: [{ identifier: 'main', enabled: true }, { identifier: 'x2', enabled: true }] }],
});
const budgeted = assemble({
  settings: { enabled: true, targets: ['writer'], includeWorlds: false, maxChars: 400, header: '', vars: {} },
  worlds: [],
  presets: [bigPreset],
  mode: 'writer',
  scanText: '',
  random: () => 0,
});
// ---- 字符上限：只报告，不切断（整条省略交给世界书预算）
assert.ok(budgeted.systemText.startsWith('AAAA'), '第一块完整保留');
assert.equal(budgeted.systemText.includes('BBBB'), true, '第二块也完整保留（不切断）');
assert.equal(budgeted.meta.overMaxChars, true, '超限要标记');
assert.ok(budgeted.meta.notes.some((note) => note.includes('未截断')), '超限要有说明');

// ---- 未知宏：原样保留并提示（不吞内容）
const macroPreset = normalizePreset({
  id: 'macro',
  name: '宏预设',
  prompts: [{ identifier: 'main', content: 'A {{nope::x}} B {{char}}' }],
  prompt_order: [{ order: [{ identifier: 'main', enabled: true }] }],
});
const macroResult = assemble({
  settings: { enabled: true, targets: ['writer'], includeWorlds: false, vars: { char: '沈砚' }, maxChars: 6000, header: '' },
  worlds: [],
  presets: [macroPreset],
  mode: 'writer',
  scanText: '',
  random: () => 0,
});
assert.match(macroResult.systemText, /沈砚/, '已知宏被替换');
assert.match(macroResult.systemText, /\{ \{nope::x\}\}/, '未知宏原样保留（{{ 被拆开防插值）');
assert.ok(macroResult.meta.notes.some((note) => note.includes('未执行的宏')), '未知宏要提示');

// ---- 未知 marker / 未出现在 prompt_order 的条目
const unknownMarker = normalizePreset({
  id: 'mk',
  name: '未知 marker',
  prompts: [{ identifier: 'summary', name: 'Summary', marker: true }],
  prompt_order: [{ order: [{ identifier: 'summary', enabled: true }] }],
});
assert.ok(unknownMarker.warnings.some((note) => note.includes('marker')), '未知 marker 要提示保留未执行');

const strictOrder = normalizePreset({
  id: 'strict',
  name: '严格顺序',
  prompts: [{ identifier: 'main', content: 'M' }, { identifier: 'ghost', content: 'G' }],
  prompt_order: [{ order: [{ identifier: 'main', enabled: true }] }],
});
assert.equal(orderedPrompts(strictOrder).length, 1, '未列出的条目不会执行');
assert.ok(strictOrder.warnings.some((note) => note.includes('ghost')), '未列出的条目要提示');

const disabledPrompt = normalizePreset({
  id: 'off',
  name: '禁用条目',
  prompts: [{ identifier: 'main', content: 'MAIN' }, { identifier: 'extra', content: 'EXTRA' }],
  prompt_order: [{ order: [{ identifier: 'main', enabled: true }, { identifier: 'extra', enabled: false }] }],
});
const offResult = assemble({
  settings: { enabled: true, targets: ['writer'], includeWorlds: false, vars: {}, maxChars: 6000, header: '' },
  worlds: [],
  presets: [disabledPrompt],
  mode: 'writer',
  scanText: '',
  random: () => 0,
});
assert.match(offResult.systemText, /MAIN/);
assert.doesNotMatch(offResult.systemText, /EXTRA/, 'enabled:false 的条目真的不执行');

// ---- 概率：真实请求掷骰，预览跳过抽样
const probWorld = normalizeWorld({
  id: 'prob',
  name: '概率书',
  entries: [{ uid: 1, key: ['雨'], probability: 50, content: '【prob50】' }],
});
const probSettings = {
  enabled: true, targets: ['writer'], includeWorlds: true, includePreset: true,
  vars: {}, maxChars: 6000, header: '', worldIds: [],
};
const markerOnly = normalizePreset({
  id: 'marker-only', name: '只放 marker',
  prompts: [{ identifier: 'worldInfoBefore', marker: true }],
  prompt_order: [{ order: [{ identifier: 'worldInfoBefore', enabled: true }] }],
});
const miss = assemble({
  settings: probSettings, worlds: [probWorld], presets: [markerOnly], mode: 'writer',
  scanText: '下雨', random: () => 0.9,
});
assert.doesNotMatch(miss.systemText, /prob50/, 'random=0.9 时 50% 条目不命中');
const hit = assemble({
  settings: probSettings, worlds: [probWorld], presets: [markerOnly], mode: 'writer',
  scanText: '下雨', random: () => 0, preview: true,
});
assert.match(hit.systemText, /prob50/, '预览把概率视为命中');
assert.equal(hit.meta.probabilitySkipped, true, '预览要标注跳过概率抽样');
assert.equal(hit.meta.source, 'preview');

// ---- 角色：非 system 条目被并入系统段并计数
const rolePreset = normalizePreset({
  id: 'roles',
  name: '角色测试',
  prompts: [
    { identifier: 'main', content: 'SYS', role: 'system' },
    { identifier: 'u1', content: 'USERTEXT', role: 'user' },
    { identifier: 'a1', content: 'ASSISTANTTEXT', role: 'assistant' },
  ],
  prompt_order: [{ order: [
    { identifier: 'main', enabled: true },
    { identifier: 'u1', enabled: true },
    { identifier: 'a1', enabled: true },
  ] }],
});
const roleResult = assemble({
  settings: { enabled: true, targets: ['writer'], includeWorlds: false, vars: {}, maxChars: 6000, header: '' },
  worlds: [],
  presets: [rolePreset],
  mode: 'writer',
  scanText: '',
  random: () => 0,
});
assert.equal(roleResult.meta.roles.user, 1);
assert.equal(roleResult.meta.roles.assistant, 1);
assert.ok(roleResult.messages.some((m) => m.role === 'user' && m.content === 'USERTEXT'), 'user 条目作为独立消息保留 role');
assert.ok(roleResult.messages.some((m) => m.role === 'assistant' && m.content === 'ASSISTANTTEXT'), 'assistant 条目作为独立消息保留 role');

// ---- @D：明确声明不支持真注入
const depthWorld = normalizeWorld({  id: 'depth',
  name: '深度书',
  entries: [{ uid: 1, key: [], constant: true, position: 4, depth: 4, role: 0, content: '【DEEP】' }],
});
const depthResult = assemble({
  settings: { enabled: true, targets: ['writer'], includeWorlds: true, includePreset: false, vars: {}, maxChars: 6000, header: '' },
  worlds: [depthWorld],
  presets: [],
  mode: 'writer',
  scanText: '',
  random: () => 0,
});
assert.equal(depthResult.meta.depthSupported, false);
assert.equal(depthResult.meta.depthBlocks, 1);
assert.ok(depthResult.meta.notes.some((note) => note.includes('deep-frozen')), '@D 的近似行为要写明原因');
assert.match(depthResult.systemText, /DEEP/, '@D 文本仍并入系统段（明确标注为近似）');

// ---- outlet：收集但不生效
const outletWorld = normalizeWorld({
  id: 'outlet',
  name: '插座书',
  entries: [{ uid: 1, key: [], constant: true, position: 7, outletName: 'quotes', content: '【OUT】' }],
});
const outletResult = assemble({
  settings: { enabled: true, targets: ['writer'], includeWorlds: true, includePreset: false, vars: {}, maxChars: 6000, header: '' },
  worlds: [outletWorld], presets: [], mode: 'writer', scanText: '', random: () => 0,
});
assert.doesNotMatch(outletResult.systemText, /【OUT】/);
assert.ok(outletResult.meta.notes.some((note) => note.includes('outlet')), 'outlet 要说明未生效');

// ---- 幂等：同一输入重复组装不累加（重试 / 重新生成不会叠内容）
const twiceArgs = {
  settings: { enabled: true, targets: ['writer'], includeWorlds: true, vars: {}, maxChars: 6000, header: '' },
  worlds: [depthWorld],
  presets: [],
  mode: 'writer',
  scanText: '雨',
  random: () => 0,
};
const first = assemble(twiceArgs);
const second = assemble(twiceArgs);
assert.equal(first.systemText, second.systemText, '两次组装结果一致');
assert.equal(second.meta.chars, first.meta.chars);
assert.equal((second.systemText.match(/【DEEP】/g) ?? []).length, 1, '同一内容不重复出现');

// ---- @D 的 depth 方向契约（见 test/depth-contract.mjs 的完整用例）
assert.equal(depthResult.depthBlocks.length, 1);
assert.equal(depthResult.meta.depthBlocks, 1);
assert.equal(
  depthResult.systemText.includes('【DEEP】'),
  true,
  '@D 文本出现在系统段（近似），不是消息数组',
);

// ---- 工具函数
assert.ok(modeMatches(['writer'], 'writer'));
assert.ok(modeMatches(['*'], 'anything'));
assert.equal(modeMatches([], 'writer'), false);
assert.equal(detectMode({ agent: { session: { header: { agentPreset: 'writer' } } } }), 'writer');
assert.deepEqual(
  activate(world, '下雨', () => 0.99).atDepth.map((group) => `${group.depth}:${group.role}`),
  ['4:0', '1:1'],
  'atDepth 按 depth 倒序、role 保留',
);
assert.equal(world_info_position.atDepth, 4);

await rm(root, { recursive: true, force: true });
console.log('assemble-smoke: 全部通过');
