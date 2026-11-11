#!/usr/bin/env node
/**
 * 写作模式会话接管（llm/stream）—— 收紧后的接管条件与卡片/预算/取消行为。
 *
 *   node test/session-hook.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GuideStore } from '../lib/store.js';
import { normalizePreset } from '../lib/preset.js';
import { normalizeCard } from '../lib/cards.js';
import { BindingCache } from '../lib/session-bindings.js';
import { registerSessionHook } from '../lib/session-hook.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'wg-hook-'));
const store = new GuideStore(root);
await store.ensure();
await store.savePreset(normalizePreset({
  id: 'p', name: 'P',
  prompts: [
    { identifier: 'main', content: '[MAIN]', role: 'system' },
    { identifier: 'charDescription', marker: true },
    { identifier: 'chatHistory', marker: true },
    { identifier: 'phi', content: '[PHI]', role: 'system', system_prompt: false },
  ],
  prompt_order: [{ order: [
    { identifier: 'main', enabled: true },
    { identifier: 'charDescription', enabled: true },
    { identifier: 'chatHistory', enabled: true },
    { identifier: 'phi', enabled: true },
  ] }],
}));
await store.saveCard(normalizeCard({
  spec: 'chara_card_v2',
  data: {
    name: '沈砚',
    description: '[CARD_DESC]',
    personality: '[CARD_PERSONA]',
    scenario: '[CARD_SCENARIO]',
    first_mes: '[GREET]',
    mes_example: '<START>\n{{user}}: 你好\n{{char}}: 嗯。',
    system_prompt: '[CARD_SYS]{{original}}',
    post_history_instructions: '[CARD_PHI]{{original}}',
    creator_notes: '[NOTES_SHOULD_NOT_APPEAR]',
    tags: ['[TAG]'],
  },
  id: 'card-1',
}));

const baseSettings = {
  enabled: true, targets: ['writer'], includeWorlds: false, includePreset: true, scanDepth: 2,
  vars: {}, maxChars: 6000, worldIds: [], contextWindow: 0, maxTokens: 128,
  worldBudgetPercent: 0, worldBudgetTokens: 0, maxRecursionSteps: 0,
};
await store.saveSettings(baseSettings);

const messages = [
  { role: 'system', content: [{ type: 'text', text: '[HOST_SYS]' }], source: { kind: 'system-prompt' } },
  { role: 'user', content: [{ type: 'text', text: '[TIME]' }], source: { kind: 'system-prompt' } },
  { role: 'user', content: [{ type: 'text', text: '雨夜，写一段' }], source: { kind: 'user' } },
];

const makeHook = ({ bindings, preset = 'writer', transport, diagnostics = new Map(), enabled = true, llm }) => {
  let captured;
  registerSessionHook({
    ctx: { on: (_name, handler) => { captured = handler; return () => {}; } },
    store,
    bindings,
    transport: transport ?? (async () => ({ ok: true, content: '正文', finish: 'stop', usage: null })),
    log: () => {},
    diagnostics,
    llm,
    sessions: { get: () => ({ id: 'x' }) },
    agentPresets: { presetForSession: () => preset },
    isEnabled: () => enabled,
  });
  return captured;
};

const collect = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};

// 1) writer + 显式绑定 → 接管，next 不调用
{
  const bindings = new BindingCache({ bindings: { 's1': { presetId: 'p', provider: 'catiecli', model: 'm' } } });
  const hook = makeHook({ bindings });
  const chunks = await collect(hook({ ...{ provider: 'deepseek-account', model: 'deepseek-flash' }, sessionId: 's1', messages }, () => { throw new Error('next should not be called'); }));
  assert.deepEqual(chunks.map((c) => c.type).filter((t) => t !== 'usage'), ['block-start', 'text-delta', 'block-end', 'finish']);
  assert.equal(chunks[1].text, '正文');
}

// 2) 非 writer 即使有绑定也不接管
{
  const bindings = new BindingCache({ bindings: { 's2': { presetId: 'p', provider: 'catiecli', model: 'm' } } });
  const hook = makeHook({ bindings, preset: 'standard' });
  assert.equal(hook({ provider: 'x', model: 'y', sessionId: 's2', messages }, () => 'PASS'), 'PASS');
}

// 3) writer 无显式绑定 → 用 defaultBinding 接管
{
  const bindings = new BindingCache({ defaultBinding: { presetId: 'p', provider: 'catiecli', model: 'm' }, bindings: {} });
  const hook = makeHook({ bindings });
  const chunks = await collect(hook({ provider: 'x', model: 'y', sessionId: 's3', messages }, () => { throw new Error('should not pass'); }));
  assert.equal(chunks.at(-1).type, 'finish');
}

// 4) 辅助请求（标题/摘要）不接管
{
  const bindings = new BindingCache({ bindings: { 's4': { presetId: 'p', provider: 'catiecli', model: 'm' } } });
  const hook = makeHook({ bindings });
  assert.equal(hook({ provider: 'x', model: 'y', sessionId: 's4', messages, purpose: 'session-title' }, () => 'PASS_AUX'), 'PASS_AUX');
}

// 5) 总开关关闭 → 不接管
{
  const bindings = new BindingCache({ bindings: { 's5': { presetId: 'p', provider: 'catiecli', model: 'm' } } });
  const hook = makeHook({ bindings, enabled: false });
  assert.equal(hook({ provider: 'x', model: 'y', sessionId: 's5', messages }, () => 'PASS_OFF'), 'PASS_OFF');
}

// 6) 卡片：charDescription 走 marker、creator_notes 不进 prompt、开场白只出现一次
{
  const seen = [];
  const bindings = new BindingCache({ bindings: { 's6': { presetId: 'p', cardId: 'card-1', provider: 'catiecli', model: 'm' } } });
  const hook = makeHook({
    bindings,
    transport: async ({ plan }) => {
      seen.push(plan.messages.map((m) => `${m.role}:${m.content}`));
      return { ok: true, content: 'ok', finish: 'stop', usage: null };
    },
  });
  await collect(hook({ provider: 'x', model: 'y', sessionId: 's6', messages }, () => 'no'));
  const joined = seen[0].join('\n');
  assert.match(joined, /\[CARD_DESC\]/, '角色描述走 marker 注入');
  assert.match(joined, /\[CARD_SYS\]\[MAIN\]/, 'system_prompt 覆盖 main 且替换 {{original}}');
  assert.match(joined, /\[CARD_PHI\]\[PHI\]/, 'post_history 覆盖 phi 且替换 {{original}}');
  assert.doesNotMatch(joined, /NOTES_SHOULD_NOT_APPEAR/, 'creator_notes 不进 prompt');
  assert.doesNotMatch(joined, /\[TAG\]/, 'tags 不进 prompt');
  assert.match(joined, /\[GREET\]/, '开场白进入上下文');
  assert.match(joined, /雨夜，写一段/, '真实用户输入保留');
  assert.doesNotMatch(joined, /\[TIME\]/, '框架注入被排除');
  // 第二轮：开场白不应重复追加
  const second = [...messages, { role: 'assistant', content: [{ type: 'text', text: '正文一' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    { role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }];
  await collect(hook({ provider: 'x', model: 'y', sessionId: 's6', messages: second }, () => 'no'));
  const greetingCount = (seen[1].join('\n').match(/\[GREET\]/g) ?? []).length;
  assert.equal(greetingCount, 1, '开场白只出现一次');
}

// 7) 取消 → aborted finish，不产出正文
{
  const bindings = new BindingCache({ bindings: { 's7': { presetId: 'p', provider: 'catiecli', model: 'm' } } });
  const hook = makeHook({
    bindings,
    transport: async () => ({ ok: true, content: '不该出现', finish: 'stop', usage: null }),
  });
  const controller = new AbortController();
  controller.abort();
  const chunks = await collect(hook({ provider: 'x', model: 'y', sessionId: 's7', messages, signal: controller.signal }, () => 'no'));
  assert.equal(chunks.at(-1).type, 'finish');
  assert.equal(chunks.at(-1).reason.kind, 'aborted');
  assert.equal(chunks.some((c) => c.type === 'text-delta'), false);
}

// 8) 端点失败 → error finish
{
  const bindings = new BindingCache({ bindings: { 's8': { presetId: 'p', provider: 'catiecli', model: 'm' } } });
  const hook = makeHook({ bindings, transport: async () => ({ ok: false, finish: 'length' }) });
  const chunks = await collect(hook({ provider: 'x', model: 'y', sessionId: 's8', messages }, () => 'no'));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].reason.kind, 'error');
  assert.equal(chunks[0].reason.failure.code, 'WRITING_GUIDE_OUTPUT_LIMIT');
  assert.match(chunks[0].reason.failure.message, /输出.*上限/);
}

// 9) 预算：上下文被输出预留占满 → 明确拒绝
{
  await store.saveSettings({ ...baseSettings, contextWindow: 32, maxTokens: 32 });
  const bindings = new BindingCache({ bindings: { 's9': { presetId: 'p', provider: 'catiecli', model: 'm' } } });
  const hook = makeHook({ bindings });
  const chunks = await collect(hook({ provider: 'x', model: 'y', sessionId: 's9', messages }, () => 'no'));
  assert.equal(chunks[0].reason.failure.code, 'WRITING_GUIDE_BUDGET');
  await store.saveSettings(baseSettings);
}

// 10) 未设置上限且模型无 metadata → 保守 4096，不拿宿主的 256000
{
  await store.saveSettings({ ...baseSettings, maxTokens: 0, contextWindow: 0 });
  const seen = [];
  const bindings = new BindingCache({ bindings: { 's10': { presetId: 'p', provider: 'catiecli', model: 'm' } } });
  const hook = makeHook({
    bindings,
    transport: async (args) => { seen.push(args); return { ok: true, content: 'x', finish: 'stop', usage: null }; },
  });
  await collect(hook({ provider: 'deepseek-account', model: 'deepseek-flash', sessionId: 's10', messages, maxTokens: 256000 }, () => 'no'));
  assert.equal(seen[0].maxTokens, 4096, '默认上限 4096，不受宿主 256000 影响');
}

// 11) includeWorlds=false 时卡内 characterBook 不得偷偷加入
{
  await store.saveSettings({ ...baseSettings, includeWorlds: false });
  const seen = [];
  const bindings = new BindingCache({ bindings: { 's11': { presetId: 'p', cardId: 'card-1', provider: 'catiecli', model: 'm' } } });
  const hook = makeHook({
    bindings,
    transport: async ({ plan }) => { seen.push(plan.messages.map((m) => m.content).join('\n')); return { ok: true, content: 'x', finish: 'stop', usage: null }; },
  });
  await collect(hook({ provider: 'x', model: 'y', sessionId: 's11', messages }, () => 'no'));
  assert.doesNotMatch(seen[0], /\[BOOK\]|旧书店：一楼三面到顶/, '关闭世界书后卡内 book 也不注入');
  await store.saveSettings(baseSettings);
}

// 12) 绑定里不存在的世界书 → 可见提示，不悄悄换成全部
{
  const diag = new Map();
  const bindings = new BindingCache({ bindings: { 's12': { presetId: 'p', worldIds: ['nope-world'], provider: 'catiecli', model: 'm' } } });
  const hook = makeHook({ bindings, diagnostics: diag });
  await collect(hook({ provider: 'x', model: 'y', sessionId: 's12', messages }, () => 'no'));
  assert.deepEqual(diag.get('s12').missingWorlds, ['nope-world']);
  assert.deepEqual(diag.get('s12').worldIds, ['nope-world']);
}

// 13) worldSelection=none：不用全局书、不产生缺失提示
{
  const diag = new Map();
  const seen = [];
  const bindings = new BindingCache({ bindings: { s13: { presetId: 'p', worldSelection: 'none', worldIds: [], provider: 'catiecli', model: 'm' } } });
  const hook = makeHook({ bindings, diagnostics: diag, transport: async ({ plan }) => { seen.push(plan.messages.map((m) => m.content).join(String.fromCharCode(10))); return { ok: true, content: 'x', finish: 'stop', usage: null }; } });
  await collect(hook({ provider: 'x', model: 'y', sessionId: 's13', messages }, () => 'no'));
  assert.deepEqual(diag.get('s13').missingWorlds, [], 'none 不产生缺失提示');
}

// 14) transport 抛错 → 诊断仍存在（pending 已写），ok:false / finish:error，无正文
{
  const diag = new Map();
  const bindings = new BindingCache({ bindings: { s14: { presetId: 'p', provider: 'catiecli', model: 'm' } } });
  const hook = makeHook({
    bindings,
    diagnostics: diag,
    transport: async () => { throw Object.assign(new Error('写作端点超时（1s 无响应）'), { code: 'timeout' }); },
  });
  const chunks = await collect(hook({ provider: 'x', model: 'y', sessionId: 's14', messages }, () => 'no'));
  const record = diag.get('s14');
  assert.ok(record, 'transport 抛错也要有诊断');
  assert.equal(record.ok, false);
  assert.equal(record.finish, 'error');
  assert.equal(record.phase, 'failed');
  assert.equal(record.error.code, 'timeout');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].type, 'finish');
  assert.equal(chunks[0].reason.kind, 'error');
  assert.match(chunks[0].reason.failure.message, /超时/);
  assert.equal(JSON.stringify(record).includes('content'), false, '诊断不含正文');
}

// 15) 正则只在发送副本转换：transport 看到替换后的文本，原始 messages 不变
{
  const seen = [];
  const bindings = new BindingCache({ bindings: { s15: { presetId: 'p', provider: 'catiecli', model: 'm' } } });
  const extensionStore = {
    load: async () => ({
      global: [{
        id: 'rx1', scriptName: 'demo', findRegex: '/foo/g', replaceString: 'bar',
        placement: [1, 2], disabled: false, substituteRegex: 0, trimStrings: [],
      }],
    }),
  };
  let captured;
  registerSessionHook({
    ctx: { on: (_name, handler) => { captured = handler; return () => {}; } },
    store,
    bindings,
    transport: async ({ plan }) => { seen.push(plan.messages.map((m) => m.content)); return { ok: true, content: 'ok', finish: 'stop', usage: null }; },
    log: () => {},
    diagnostics: new Map(),
    sessions: { get: () => ({ id: 'x' }) },
    agentPresets: { presetForSession: () => 'writer' },
    isEnabled: () => true,
    llm: null,
    extensionStore,
  });
  const original = [
    { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'foo 原始' }] },
  ];
  const stream = captured({ provider: 'x', model: 'y', sessionId: 's15', messages: original }, () => 'no');
  for await (const _chunk of stream) { /* drain */ }
  const sentUser = seen[0].find((line) => String(line).includes('bar'));
  assert.ok(sentUser, '发送副本里 user 文本已被正则替换');
  assert.equal(String(original[0].content[0].text), 'foo 原始', '原始 DSH 历史未被修改');
}

// 16) 模板渲染失败 → 终止本次生成（标准 error finish），不调用 transport
{
  const diag = new Map();
  const bindings = new BindingCache({ bindings: { s16: { presetId: 'p', provider: 'catiecli', model: 'm' } } });
  let transportCalls = 0;
  let captured;
  registerSessionHook({
    ctx: { on: (_name, handler) => { captured = handler; return () => {}; } },
    store,
    bindings,
    transport: async () => { transportCalls += 1; return { ok: true, content: 'x', finish: 'stop', usage: null }; },
    log: () => {},
    diagnostics: diag,
    sessions: { get: () => ({ id: 'x' }) },
    agentPresets: { presetForSession: () => 'writer' },
    isEnabled: () => true,
    llm: null,
    extensionStore: {
      load: async () => ({ regex: { global: [] }, template: { enabled: true, allowedPresetIds: ['p'] }, helper: { enabled: false, scripts: [] }, sessions: {} }),
      sessionVars: async () => ({ vars: {}, messageVars: {}, scriptVars: {}, version: 1 }),
      saveSessionVars: async () => ({}),
    },
    runTemplateBatch: async () => { throw new Error('EJS boom'); },
  });
  const stream = captured({ provider: 'x', model: 'y', sessionId: 's16', messages }, () => 'no');
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(transportCalls, 0, '模板失败不得发请求');
  assert.equal(chunks.at(-1).type, 'finish');
  assert.equal(chunks.at(-1).reason.kind, 'error');
  assert.equal(chunks.at(-1).reason.failure.code, 'WRITING_GUIDE_TEMPLATE');
  assert.match(chunks.at(-1).reason.failure.message, /模板渲染失败/);
  assert.equal(diag.get('s16')?.ok, false);
}

// A saved per-session output/context limit reaches both budget and transport.
{
  await store.saveSettings({ ...baseSettings, maxTokens: 4096, contextWindow: 8192 });
  const bindings = new BindingCache({ bindings: {
    custom: { presetId: 'p', provider: 'catiecli', model: 'm', maxTokens: 12288, contextWindow: 65536 },
    other: { presetId: 'p', provider: 'catiecli', model: 'm' },
  } });
  const sent = [], diagnostics = new Map();
  const transport = async args => { sent.push(args); return { ok: true, content: 'ok', finish: 'stop' }; };
  const hook = makeHook({ bindings, diagnostics, transport });
  await collect(hook({ sessionId: 'custom', messages }, () => { throw Error('unexpected delegation'); }));
  assert.equal(sent.at(-1).maxTokens, 12288);
  assert.equal(diagnostics.get('custom').outputCap, 12288);
  assert.equal(diagnostics.get('custom').context, 65536);
  await collect(hook({ sessionId: 'other', messages }, () => { throw Error('unexpected delegation'); }));
  assert.equal(sent.at(-1).maxTokens, 4096, 'another session keeps the global fallback');
  const capped = makeHook({ bindings, diagnostics, transport,
    llm: { resolveModelInfo: async () => ({ defaultMaxTokens: 8192, context: { contextWindow: 32768 } }) },
  });
  await collect(capped({ sessionId: 'custom', messages }, () => { throw Error('unexpected delegation'); }));
  assert.equal(sent.at(-1).maxTokens, 8192, 'model output capacity still caps the requested limit');
  assert.equal(diagnostics.get('custom').context, 32768);
}

await rm(root, { recursive: true, force: true });
console.log('session-hook: 全部通过');
