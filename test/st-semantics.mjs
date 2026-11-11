#!/usr/bin/env node
/**
 * ST 语义固定用例（独立于实现，期望值由源码推导）。
 *
 * 参考：SillyTavern release@06bde939fb1e9c4c8d8641d810f0a916b5bce127
 *   world-info.js#L88   sortFn = (a,b) => b.order - a.order（预算优先级）
 *   world-info.js#L69   world_info_depth = 2
 *   world-info.js#L73   world_info_budget = 25(%)
 *   world-info.js#L82   world_info_max_recursion_steps = 0
 *   world-info.js#L4943-4977  次级键四种逻辑真值表
 *   world-info.js#L5028-5049  概率：<= probability 命中
 *   world-info.js#L5204-5247  position 分桶
 *   openai.js#L866-873   @D 插入方向（depth 0 = 最后一条之后）
 */
import assert from 'node:assert/strict';
import { normalizeWorld } from '../lib/worldinfo.js';
import { normalizePreset } from '../lib/preset.js';
import { collectHits, world_info_logic, matchKey } from '../lib/lore.js';
import { buildPlan } from '../lib/plan.js';
import { insertAtDepth } from '../lib/depth.js';

const book = (id, entries) => normalizeWorld({ id, name: id, entries });
const hitsOf = (books, scanText, options = {}) => collectHits({ books, scanText, random: () => 0.5, ...options });

// ---------------------------------------------------------------- 关键词
assert.ok(matchKey('雨夜', '雨'), '子串命中');
assert.equal(matchKey('YEYE', '雨'), false);
assert.ok(matchKey('Rain', 'rain'), '默认大小写不敏感');
assert.equal(matchKey('Rain', 'rain', { caseSensitive: true }), false, '大小写敏感时不命中');
// 正则：flags 由书写者控制，插件不补 i（world-info.js#L337-342）
assert.equal(matchKey('rain', '/Rain/'), false, '无 i flag 的裸正则应大小写敏感');
assert.ok(matchKey('Rain', '/Rain/'), '字面一致时命中');
assert.ok(matchKey('rain', '/Rain/i'), '带 i flag 时命中');
// 非法正则 → 当字面量（world-info.js#L2901-2926）
assert.ok(matchKey('/[/', '/[/'), '非法正则按字面量匹配');
assert.equal(matchKey('abc', '/[/'), false);
// 完整词：单词用非单词边界，多词用 includes（world-info.js#L349-362）
assert.ok(matchKey('C++', 'C++', { matchWholeWords: true }), 'C++ 作为完整词命中自己');
assert.ok(matchKey('foobig citybar', 'big city', { matchWholeWords: true }), '多词完整词 = includes');
assert.ok(matchKey('a rain city', 'rain', { matchWholeWords: true }), '单词完整词命中');
assert.equal(matchKey('raining', 'rain', { matchWholeWords: true }), false, '单词完整词不命中子串');

// ---------------------------------------------------------- 常驻 / 禁用
{
  const world = book('b1', [
    { uid: 1, key: [], constant: true, content: '常驻' },
    { uid: 2, key: ['雨'], content: '关键词' },
    { uid: 3, key: [], constant: true, disable: true, content: '禁用常驻' },
    { uid: 4, key: ['雨'], disable: true, content: '禁用关键词' },
  ]);
  const hits = hitsOf([world], '下雨了');
  // 同 order（默认 100）：ST 用 unshift 拼桶，最终顺序 = 来源顺序反转
  assert.deepEqual(hits.buckets.before.map((ref) => ref.text), ['关键词', '常驻']);
}

// -------------------------------------------------- 次级键四种逻辑真值表
const selectiveCase = (logic, secondary, text) => {
  const world = book('logic', [{
    uid: 1, key: ['主'], keysecondary: secondary, selective: true, selectiveLogic: logic, content: 'X',
  }]);
  return hitsOf([world], text).count === 1;
};
assert.equal(world_info_logic.AND_ANY, 0);
assert.equal(world_info_logic.NOT_ALL, 1);
assert.equal(world_info_logic.NOT_ANY, 2);
assert.equal(world_info_logic.AND_ALL, 3);
assert.equal(selectiveCase(0, ['甲'], '主 甲'), true, 'AND_ANY：任一命中');
assert.equal(selectiveCase(0, ['甲', '乙'], '主 甲'), true, 'AND_ANY：部分命中');
assert.equal(selectiveCase(3, ['甲', '乙'], '主 甲 乙'), true, 'AND_ALL：全部命中');
assert.equal(selectiveCase(3, ['甲', '乙'], '主 甲'), false, 'AND_ALL：缺一不命中');
assert.equal(selectiveCase(1, ['甲', '乙'], '主 甲'), true, 'NOT_ALL：存在未命中');
assert.equal(selectiveCase(1, ['甲', '乙'], '主 甲 乙'), false, 'NOT_ALL：全命中反而不激活');
assert.equal(selectiveCase(2, ['甲', '乙'], '主 甲'), false, 'NOT_ANY：有一个命中就不激活');
assert.equal(selectiveCase(2, ['甲', '乙'], '主 丙'), true, 'NOT_ANY：全不命中才激活');

// --------------------------------------------------------------- 概率
{
  const world = book('prob', [
    { uid: 1, key: ['雨'], probability: 100, content: 'P100' },
    { uid: 2, key: ['雨'], probability: 0, content: 'P0' },
    { uid: 3, key: ['雨'], probability: 50, content: 'P50' },
    { uid: 4, key: ['雨'], probability: 50, useProbability: false, content: 'P-off' },
  ]);
  const zero = collectHits({ books: [world], scanText: '雨', random: () => 0 });
  assert.deepEqual(zero.buckets.before.map((ref) => ref.text).sort(), ['P-off', 'P100', 'P50'], 'P0 永不命中');
  const high = collectHits({ books: [world], scanText: '雨', random: () => 0.99 });
  assert.deepEqual(high.buckets.before.map((ref) => ref.text).sort(), ['P-off', 'P100'], 'random=0.99 时 P50 失败');
  // 决策复用：同一 decisions Map 重跑不会重抽
  const decisions = new Map();
  const first = collectHits({ books: [world], scanText: '雨', random: () => 0, decisions });
  const second = collectHits({ books: [world], scanText: '雨', random: () => 0.99, decisions });
  assert.deepEqual(
    first.buckets.before.map((ref) => ref.key).sort(),
    second.buckets.before.map((ref) => ref.key).sort(),
    '固定 decisions 后重试结果一致',
  );
}

// --------------------------------------------------------------- 递归
{
  // A 触发 B；B 再触发 A → 不得无限
  const world = book('recur', [
    { uid: 1, key: ['甲'], content: '看到乙' },
    { uid: 2, key: ['乙'], content: '看到甲' },
  ]);
  const hits = hitsOf([world], '甲');
  assert.equal(hits.count, 2, '递归命中 B');
  assert.ok(hits.rounds.length <= 10, `递归要有限（轮数 ${hits.rounds.length}）`);

  // excludeRecursion：该条目在**递归轮**被跳过（world-info.js#L4870）
  const excluded = book('excl', [
    { uid: 1, key: ['甲'], content: '看到乙' },
    { uid: 2, key: ['乙'], content: '乙内容', excludeRecursion: true },
  ]);
  assert.equal(hitsOf([excluded], '甲').count, 1, 'excludeRecursion 条目在递归轮不参与');

  // preventRecursion：可以被激活，但它的内容**不贡献**递归 buffer（world-info.js#L5080）
  const prevented = book('prev', [
    { uid: 1, key: ['甲'], content: '看到乙' },
    { uid: 2, key: ['乙'], content: '看到丙', preventRecursion: true },
    { uid: 3, key: ['丙'], content: '丙内容' },
  ]);
  const prevHits = hitsOf([prevented], '甲');
  assert.equal(prevHits.count, 2, 'preventRecursion 条目自身可以命中');
  assert.equal(prevHits.activated.some((item) => item.entry.uid === 3), false, '它的内容不进递归 buffer，所以丙不命中');

  // delayUntilRecursion：初轮必须跳过（world-info.js#L4860），递归轮才参与
  const delayed = book('delay', [
    { uid: 1, key: ['甲'], content: '看到乙' },
    { uid: 2, key: ['乙'], content: '延迟条目', delayUntilRecursion: true },
  ]);
  assert.equal(hitsOf([delayed], '乙').count, 0, '初轮直接命中也不激活');
  assert.equal(hitsOf([delayed], '甲').count, 2, '递归轮才参与');

  // constant 在主/次键检查之前激活，不被 selective 拦住
  const constantSelective = book('const-sel', [
    { uid: 1, key: [], keysecondary: ['必须出现'], selective: true, constant: true, content: '常驻' },
  ]);
  assert.equal(hitsOf([constantSelective], '什么都没有').count, 1, 'constant 跳过次级键检查');

  // buffer 累积而不是替换：A→B 后 B 的内容仍能触发 C
  const chain = book('chain', [
    { uid: 1, key: ['甲'], content: '看到乙' },
    { uid: 2, key: ['乙'], content: '看到丙' },
    { uid: 3, key: ['丙'], content: '丙内容' },
  ]);
  assert.equal(hitsOf([chain], '甲').count, 3, '递归 buffer 累积，链式命中 C');

  // maxRecursionSteps 是总轮数上限：1 = 只扫一轮（无递归），2 = 允许一次递归
  const limited1 = hitsOf([world], '甲', { maxRecursionSteps: 1 });
  assert.equal(limited1.count, 1, 'max=1 只扫一轮');
  const limited2 = hitsOf([world], '甲', { maxRecursionSteps: 2 });
  assert.equal(limited2.count, 2, 'max=2 允许一次递归');
  const limited0 = hitsOf([world], '甲', { maxRecursionSteps: 0 });
  assert.equal(limited0.count, 2, '0 = 不限制轮数，但无新命中即停');
}

// -------------------------------------------- 相同 uid 不同书 / 稳定排序
{
  const a = book('book-a', [{ uid: 1, key: [], constant: true, order: 10, content: 'A10' }]);
  const b = book('book-b', [{ uid: 1, key: [], constant: true, order: 10, content: 'B10' }]);
  const hits = hitsOf([a, b], '');
  assert.equal(hits.count, 2, '相同 uid 不同书都命中');
  assert.equal(new Set(hits.buckets.before.map((ref) => ref.key)).size, 2, '身份用 book:uid 区分');

  const ordered = book('order', [
    { uid: 1, key: [], constant: true, order: 30, content: 'O30' },
    { uid: 2, key: [], constant: true, order: 10, content: 'O10' },
    { uid: 3, key: [], constant: true, order: 20, content: 'O20' },
  ]);
  assert.deepEqual(
    hitsOf([ordered], '').buckets.before.map((ref) => ref.text),
    ['O10', 'O20', 'O30'],
    '输出按 order 升序',
  );
}

// --------------------------------------------------------------- 8 位置
{
  const world = book('pos', [0, 1, 2, 3, 4, 5, 6, 7].map((position, index) => ({
    uid: index + 1, key: [], constant: true, position, content: `P${position}`,
    ...(position === 4 ? { depth: 3, role: 1 } : {}),
    ...(position === 7 ? { outletName: 'quotes' } : {}),
  })));
  const hits = hitsOf([world], '');
  assert.deepEqual(hits.buckets.before.map((r) => r.text), ['P0']);
  assert.deepEqual(hits.buckets.after.map((r) => r.text), ['P1']);
  assert.deepEqual(hits.buckets.ANTop.map((r) => r.text), ['P2']);
  assert.deepEqual(hits.buckets.ANBottom.map((r) => r.text), ['P3']);
  assert.deepEqual(hits.buckets.EMTop.map((r) => r.text), ['P5']);
  assert.deepEqual(hits.buckets.EMBottom.map((r) => r.text), ['P6']);
  assert.equal(hits.buckets.atDepth[0].depth, 3);
  assert.equal(hits.buckets.atDepth[0].role, 'user');
  assert.deepEqual(hits.buckets.outlet.quotes.map((r) => r.text), ['P7']);
}

// ------------------------------------------------------- 预算（单条层面）
{
  const world = book('budget', [
    { uid: 1, key: [], constant: true, order: 100, content: 'H' },   // 优先选
    { uid: 2, key: [], constant: true, order: 50, content: 'M' },
    { uid: 3, key: [], constant: true, order: 10, content: 'L' },
  ]);
  const hits = hitsOf([world], '');
  const preset = normalizePreset({
    id: 'p', name: 'p',
    prompts: [
      { identifier: 'main', content: '' },
      { identifier: 'worldInfoBefore', marker: true },
    ],
    prompt_order: [{ order: [{ identifier: 'main', enabled: true }, { identifier: 'worldInfoBefore', enabled: true }] }],
  });
  const countTokens = () => 10;
  const plan = buildPlan({ preset, hits, budgetTokens: 25, countTokens });
  assert.equal(plan.meta.omitted.length, 1, '预算只够两条');
  assert.match(plan.meta.omitted[0].label, /budget/, '省略项带 book:uid 身份');
  // order 大的先选 → 被省略的是 order 最小的 L
  assert.ok(plan.system.includes('H') && plan.system.includes('M'));
  assert.equal(plan.system.includes('L'), false, '低优先级条目整条省略');
}

// ------------------------------- 预设禁用 marker 时不得偷偷追加世界书
{
  const world = book('noplace', [{ uid: 1, key: [], constant: true, content: 'BEFORE' }]);
  const preset = normalizePreset({
    id: 'p', name: 'p',
    prompts: [{ identifier: 'main', content: 'MAIN' }, { identifier: 'worldInfoBefore', marker: true }],
    prompt_order: [{ order: [{ identifier: 'main', enabled: true }, { identifier: 'worldInfoBefore', enabled: false }] }],
  });
  const plan = buildPlan({ preset, hits: hitsOf([world], ''), countTokens: () => 1 });
  assert.equal(plan.system.includes('BEFORE'), false, '禁用 marker 时世界书不注入');
  assert.deepEqual(plan.meta.unplaced, ['before'], '未注入的位置要报告');
  assert.ok(plan.meta.notes.some((note) => note.includes('未注入')));
}

// ----------------------------- 作者注没有 marker 时按 ST 默认落点插入
{
  const preset = normalizePreset({
    id: 'p', name: 'p', prompts: [{ identifier: 'main', content: 'MAIN' }],
    prompt_order: [{ order: [{ identifier: 'main', enabled: true }] }],
  });
  const plan = buildPlan({
    preset,
    hits: hitsOf([], ''),
    authorNote: '记住：第三人称。',
    conversation: [{ role: 'user', content: 'U1' }, { role: 'assistant', content: 'A1' }],
    countTokens: () => 1,
  });
  const idx = plan.messages.findIndex((message) => message.content.includes('第三人称'));
  assert.ok(idx >= 0, '作者注不能丢');
  assert.equal(plan.messages[idx].role, 'system', '作者注角色');
  assert.equal(plan.depthBlocks[0].depth, 4, '默认 depth 4');
  assert.ok(plan.meta.notes.some((note) => note.includes('authorsNote')), '要说明落点来自默认值');
}

// ------------------------------------------- 超限不截断（只报告）
{
  const preset = normalizePreset({
    id: 'p', name: 'p', prompts: [{ identifier: 'main', content: 'X'.repeat(200) }],
    prompt_order: [{ order: [{ identifier: 'main', enabled: true }] }],
  });
  const plan = buildPlan({ preset, hits: hitsOf([], ''), maxChars: 50, countTokens: () => 1 });
  assert.equal(plan.system.length, 200, '不切断内容');
  assert.equal(plan.meta.overMaxChars, true, '要标记超限');
  assert.ok(plan.meta.notes.some((note) => note.includes('未截断')));
}

// ------------------------------------- main 配 ABSOLUTE 也要走 depth
{
  const preset = normalizePreset({
    id: 'p', name: 'p',
    prompts: [{ identifier: 'main', content: 'ABS-MAIN', injection_position: 1, injection_depth: 2, role: 'system' }],
    prompt_order: [{ order: [{ identifier: 'main', enabled: true }] }],
  });
  const plan = buildPlan({
    preset, hits: hitsOf([], ''),
    conversation: [{ role: 'user', content: 'U1' }, { role: 'assistant', content: 'A1' }, { role: 'user', content: 'U2' }],
    countTokens: () => 1,
  });
  assert.equal(plan.system.includes('ABS-MAIN'), false, 'main 走 ABSOLUTE 时不能进系统段');
  assert.deepEqual(plan.messages.map((message) => message.content), ['U1', 'ABS-MAIN', 'A1', 'U2'], '按 depth 2 插入');
}

// ------------------------------------------------ 消息级：depth / role / PHI
{
  const world = book('msg', [
    { uid: 1, key: [], constant: true, position: 0, content: '【before】' },
    { uid: 2, key: [], constant: true, position: 1, content: '【after】' },
    { uid: 3, key: [], constant: true, position: 4, depth: 0, role: 0, content: '【D0】' },
    { uid: 4, key: [], constant: true, position: 4, depth: 1, role: 1, content: '【D1】' },
    { uid: 5, key: [], constant: true, position: 4, depth: 2, role: 2, content: '【D2】' },
  ]);
  const hits = hitsOf([world], '');
  const preset = normalizePreset({
    id: 'p', name: 'p',
    prompts: [
      { identifier: 'main', content: 'MAIN' },
      { identifier: 'worldInfoBefore', marker: true },
      { identifier: 'worldInfoAfter', marker: true },
      { identifier: 'chatHistory', marker: true },
      { identifier: 'jailbreak', content: 'PHI' },
    ],
    prompt_order: [{ order: [
      { identifier: 'main', enabled: true },
      { identifier: 'worldInfoBefore', enabled: true },
      { identifier: 'worldInfoAfter', enabled: true },
      { identifier: 'chatHistory', enabled: true },
      { identifier: 'jailbreak', enabled: true },
    ] }],
  });
  const conversation = [
    { role: 'user', content: 'U1' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'U2' },
  ];
  const plan = buildPlan({ preset, hits, conversation, countTokens: () => 1 });
  const show = plan.messages.map((m) => `${m.role}:${m.content}`).join(' | ');
  assert.equal(
    show,
    'system:MAIN | system:【before】 | system:【after】 | user:U1 | assistant:【D2】 | assistant:A1 | user:【D1】 | user:U2 | system:【D0】 | system:PHI',
    '深度只作用于对话块：depth2 在倒数第二条前、depth1 在最后一条前、depth0 在最后之后；PHI 仍在历史之后',
  );
  assert.match(plan.system, /MAIN/);
  assert.match(plan.system, /【before】/);
  assert.match(plan.system, /【after】/);
  assert.equal(plan.system.includes('PHI'), false, 'PHI 不进系统段，作为消息排在历史之后');
  assert.deepEqual(plan.meta.roles, { system: 5, user: 3, assistant: 2 }, '最终消息里的角色计数（含历史）');
}

// --------------------------------------------- 空历史 / 越界 depth / 不拆消息
{
  const world = book('edge', [{ uid: 1, key: [], constant: true, position: 4, depth: 9, content: 'FAR' }]);
  const preset = normalizePreset({ id: 'p', name: 'p', prompts: [{ identifier: 'main', content: 'M' }], prompt_order: [{ order: [{ identifier: 'main', enabled: true }] }] });
  const plan = buildPlan({ preset, hits: hitsOf([world], ''), conversation: [], countTokens: () => 1 });
  assert.deepEqual(
    plan.messages.map((m) => `${m.role}:${m.content}`),
    ['system:M', 'system:FAR'],
    '没有对话历史时深度条目放在 chatHistory 位置（末尾），main 仍作为消息保留',
  );
  // insertAtDepth 保持纯函数（tool call/result 由调用方保证配对，本插件不拆）
  const withTools = [
    { role: 'user', content: 'u' },
    { role: 'assistant', content: 'call' },
    { role: 'tool', content: 'result' },
  ];
  const out = insertAtDepth(withTools, [{ depth: 0, role: 'system', content: 'D0' }]);
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'tool', 'system'], 'depth 0 不插进 tool 对之间');
}

console.log('st-semantics: 全部通过');
