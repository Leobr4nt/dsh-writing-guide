#!/usr/bin/env node
/**
 * 受限数据宏测试（自造文本，无第三方内容）
 *   - 顺序扫描：未知宏在前也不阻塞后面的已知宏
 *   - 嵌套 random（setvar 的值里）
 *   - 普通花括号/已转义文本不被改动
 *   - random 只按候选项（无 range 语义）
 *   - 重建稳定、跨会话隔离
 *   - char/user/if/unless/trim/custom vars 仍由 renderStoryString 负责（回归）
 *
 *   node test/macros.mjs
 */
import assert from 'node:assert/strict';
import { createMacroScope, renderMacros, DATA_MACROS } from '../lib/macros.js';
import { renderStoryString } from '../lib/preset.js';

const scope = (seed = 's1') => createMacroScope({ seed });

// 1) 顺序：未知宏在前，不阻塞后面的 getvar/setvar
{
  const s = scope();
  const out = renderMacros('{{nope::x}}{{setvar::k::v}}{{getvar::k}}', s);
  assert.equal(out, '{{nope::x}}v', '未知宏原样保留且后续宏照常执行');
  // 未知宏的提示由 renderStoryString 的 unknown 负责（见 assemble-smoke）
}

// 2) 先赋值后读取 / 覆盖 / setvar 不产出文本
{
  const s = scope();
  assert.equal(renderMacros('A{{setvar::k::1}}B{{setvar::k::2}}C{{getvar::k}}', s), 'ABC2');
}

// 3) 读取在赋值之前 → 空；之后 → 有值
{
  const s = scope();
  assert.equal(renderMacros('前[{{getvar::v}}]{{setvar::v::后}}后[{{getvar::v}}]', s), '前[]后[后]');
}

// 4) 嵌套：setvar 的值里含 random，内层先求值
{
  const s = scope('nested');
  const out = renderMacros('{{setvar::pick::{{random::甲::乙::丙}}}}{{getvar::pick}}', s);
  assert.ok(['甲', '乙', '丙'].includes(out), `候选内取值，实际=${out}`);
}

// 5) random 只按候选项（不是 range）
{
  const s = scope('range');
  const out = renderMacros('{{random::3-7}}', s);
  assert.equal(out, '3-7', '单候选就返回该候选，不解析区间');
}

// 6) 重建稳定：同 seed 两次一致
{
  const text = '{{random::a::b::c::d::e}}|{{random::x::y}}';
  assert.equal(renderMacros(text, scope('stable')), renderMacros(text, scope('stable')));
}

// 7) 跨会话隔离：变量不共享
{
  const a = scope('session-A');
  const b = scope('session-B');
  renderMacros('{{setvar::only::A}}', a);
  assert.equal(renderMacros('[{{getvar::only}}]', b), '[]');
}

// 8) 普通花括号不被改动（不还原、不转义）
{
  const s = scope();
  assert.equal(renderMacros('正文 { 括号 } 和 { { 已经拆开的 } }', s), '正文 { 括号 } 和 { { 已经拆开的 } }');
}

// 9) 非数据宏交给 renderStoryString：char/user/custom vars/if/trim 回归
{
  const s = scope();
  const unknown = new Set();
  const raw = renderMacros('{{char}}/{{mood}}/{{#if flag}}Y{{else}}N{{/if}}', s);
  assert.equal(raw, '{{char}}/{{mood}}/{{#if flag}}Y{{else}}N{{/if}}', '数据宏层不动其它宏');

  const rendered = renderStoryString('{{char}}/{{mood}}', { char: '沈砚', mood: '安静' }, unknown);
  assert.equal(rendered, '沈砚/安静');

  const trimmed = renderStoryString('  前后空白  {{trim}}', { char: 'x' }, unknown);
  assert.equal(trimmed.trim(), '前后空白'.trim());
}

// 10) canary：数据宏集合固定
assert.deepEqual([...DATA_MACROS].sort(), ['getvar', 'random', 'setvar']);

console.log('macros: 全部通过');
