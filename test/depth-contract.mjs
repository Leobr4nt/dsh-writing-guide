#!/usr/bin/env node
/**
 * ST 语义契约测试 —— 用 [user U1, assistant A1, user U2] 验证 depth 0/1/2 的确切落点，
 * 以及同深度内的 role / order 顺序。
 *
 * 参考：SillyTavern release@06bde939fb1e9c4c8d8641d810f0a916b5bce127
 *   public/scripts/openai.js#L810-875 populationInjectionPrompts
 *   public/scripts/openai.js#L1320-1321 messages.shift() 证「数组第 0 项 = 最后一条」
 *   public/scripts/world-info.js#L855 world_info_position；#L96 DEFAULT_DEPTH = 4
 *
 *   node test/depth-contract.mjs
 */
import assert from 'node:assert/strict';
import { insertAtDepth, DEPTH_ROLE_ORDER } from '../lib/depth.js';

const history = [
  { role: 'user', content: 'U1' },
  { role: 'assistant', content: 'A1' },
  { role: 'user', content: 'U2' },
];
const show = (messages) => messages.map((m) => `${m.role}:${m.content}`).join(' | ');

// depth 0 → 最后一条消息之后（提示词底部）
assert.equal(
  show(insertAtDepth(history, [{ depth: 0, role: 'system', content: 'I0' }])),
  'user:U1 | assistant:A1 | user:U2 | system:I0',
);

// depth 1 → 最后一条消息之前
assert.equal(
  show(insertAtDepth(history, [{ depth: 1, role: 'system', content: 'I1' }])),
  'user:U1 | assistant:A1 | system:I1 | user:U2',
);

// depth 2 → 倒数第二条之前（U1 之后）
assert.equal(
  show(insertAtDepth(history, [{ depth: 2, role: 'system', content: 'I2' }])),
  'user:U1 | system:I2 | assistant:A1 | user:U2',
);

// 多个 depth 同时注入：totalInserted 补偿后仍是各自位置
assert.equal(
  show(insertAtDepth(history, [
    { depth: 0, role: 'system', content: 'I0' },
    { depth: 1, role: 'system', content: 'I1' },
  ])),
  'user:U1 | assistant:A1 | system:I1 | user:U2 | system:I0',
);

// 同 depth 内 role 顺序 system → user → assistant（reverse 后 system 最靠输出）
assert.deepEqual(DEPTH_ROLE_ORDER, ['system', 'user', 'assistant']);
assert.equal(
  show(insertAtDepth(history, [
    { depth: 1, role: 'assistant', content: 'RA' },
    { depth: 1, role: 'user', content: 'RU' },
    { depth: 1, role: 'system', content: 'RS' },
  ])),
  'user:U1 | assistant:A1 | assistant:RA | user:RU | system:RS | user:U2',
);

// 同 depth 同 role、不同 injection_order：ST 按 order 从大到小处理，各生成一条消息
// （openai.js#L842-843 `sort((a, b) => +b - +a)`），reverse 后 order 大的更靠近输出
assert.equal(
  show(insertAtDepth(history, [
    { depth: 1, role: 'system', order: 100, content: 'A' },
    { depth: 1, role: 'system', order: 50, content: 'B' },
  ])),
  'user:U1 | assistant:A1 | system:B | system:A | user:U2',
);

// 同 order 同 role 的多条内容合并成一条（ST 用 separator '\n' join，openai.js#L849-852）
assert.equal(
  show(insertAtDepth(history, [
    { depth: 1, role: 'system', order: 100, content: 'A' },
    { depth: 1, role: 'system', order: 100, content: 'B' },
  ])),
  'user:U1 | assistant:A1 | system:A\nB | user:U2',
);

// 超出历史长度：贴到最旧一侧，不抛错
assert.equal(
  show(insertAtDepth(history, [{ depth: 9, role: 'system', content: 'FAR' }])),
  'system:FAR | user:U1 | assistant:A1 | user:U2',
);

// 空历史：depth 0 与 depth 3 都落在唯一位置
assert.equal(show(insertAtDepth([], [{ depth: 0, role: 'system', content: 'X' }])), 'system:X');
assert.equal(show(insertAtDepth([], [{ depth: 3, role: 'system', content: 'Y' }])), 'system:Y');

// 不修改入参
const frozen = history.map((message) => ({ ...message }));
insertAtDepth(history, [{ depth: 0, role: 'system', content: 'Z' }]);
assert.deepEqual(history, frozen, '入参必须保持不变');

console.log('depth-contract: 全部通过（depth 0 = 最后一条之后）');
