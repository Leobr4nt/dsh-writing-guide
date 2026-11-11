#!/usr/bin/env node
/**
 * 组合顺序回归：条件裁剪（if）→ 普通变量（char/custom vars）→ 数据宏（setvar/getvar）
 *   - flag=false 时 else 分支里的 setvar **不得执行**
 *   - nested char 值在 setvar 前展开
 *   - 数据宏不应被误报为"未执行的宏"
 *
 *   node test/macro-order.mjs
 */
import assert from 'node:assert/strict';
import { buildPlan } from '../lib/plan.js';
import { normalizePreset } from '../lib/preset.js';

const hits = {
  buckets: { before: [], after: [], ANTop: [], ANBottom: [], EMTop: [], EMBottom: [], atDepth: [], outlet: {} },
  count: 0,
  decisions: new Map(),
};

const planFor = (content, vars) => {
  const preset = normalizePreset({
    id: 'order',
    prompts: [{ identifier: 'a', content, role: 'system', system_prompt: true }],
    prompt_order: [{ order: [{ identifier: 'a', enabled: true }] }],
  });
  return buildPlan({ preset, hits, vars, authorNote: '', conversation: [] });
};

// 1) flag=false：条件块里的 setvar 不执行
{
  const plan = planFor('{{#if flag}}{{setvar::x::BAD}}{{/if}}{{getvar::x}}', { flag: false });
  const text = plan.messages.map((message) => message.content).join('\n');
  assert.doesNotMatch(text, /BAD/, 'false 分支的赋值不得执行');
}

// 2) flag=true：赋值执行，getvar 读到
{
  const plan = planFor('{{#if flag}}{{setvar::x::BAD}}{{/if}}{{getvar::x}}', { flag: true });
  const text = plan.messages.map((message) => message.content).join('\n');
  assert.match(text, /BAD/, 'true 分支应正常执行');
}

// 3) nested char：setvar 的值里含 {{char}}，先展开再赋值
{
  const plan = planFor('{{setvar::who::{{char}}}}{{getvar::who}}', { char: '沈砚' });
  const text = plan.messages.map((message) => message.content).join('\n');
  assert.match(text, /沈砚/, 'char 值应在 setvar 之前展开');
}

// 4) 数据宏不误报为未执行宏
{
  const plan = planFor('{{setvar::k::v}}{{getvar::k}}{{reallyunknown::y}}', {});
  const notes = plan.meta.notes.join('\n');
  assert.match(notes, /reallyunknown/, '真正的未知宏要报出');
  assert.doesNotMatch(notes, /setvar|getvar/, '数据宏不应被误报');
}

console.log('macro-order: 全部通过');
