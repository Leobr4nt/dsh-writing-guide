#!/usr/bin/env node
/**
 * 会话销毁清理：session/disposed 不得抛错（以前 decisionsCache 不可见 → ReferenceError），
 * 且只清当前会话的决策缓存。
 *
 *   node test/session-dispose.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GuideStore } from '../lib/store.js';
import { normalizePreset } from '../lib/preset.js';
import { BindingCache } from '../lib/session-bindings.js';
import { createSessionHook, registerSessionHook } from '../lib/session-hook.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'wg-dispose-'));
const store = new GuideStore(root);
await store.ensure();
await store.savePreset(normalizePreset({
  id: 'p', name: 'P',
  prompts: [{ identifier: 'main', content: '[MAIN]', role: 'system' }, { identifier: 'chatHistory', marker: true }],
  prompt_order: [{ order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }],
}));
await store.saveSettings({
  enabled: true, targets: ['writer'], includeWorlds: false, includePreset: true, scanDepth: 2,
  vars: {}, maxChars: 6000, worldIds: [], contextWindow: 0, maxTokens: 128,
  worldBudgetPercent: 0, worldBudgetTokens: 0, maxRecursionSteps: 0,
});

const bindings = new BindingCache({ bindings: {
  s1: { presetId: 'p', provider: 'catiecli', model: 'm' },
  s2: { presetId: 'p', provider: 'catiecli', model: 'm' },
} });
const transport = async () => ({ ok: true, content: 'x', finish: 'stop', usage: null });
const messages = [
  { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] },
];

// 1) handler 暴露 clearSession
const handler = createSessionHook({ store, bindings, transport, log: () => {}, diagnostics: new Map() });
assert.equal(typeof handler.clearSession, 'function', 'handler 应暴露 clearSession');
assert.equal(handler.clearSession('never-seen'), 0, '未知会话返回 0 且不抛');
assert.equal(handler.clearSession(''), 0, '空 id 返回 0 且不抛');

// 2) 两个会话各产生一条决策缓存 → 只清当前会话
for (const sessionId of ['s1', 's2']) {
  for await (const _chunk of handler({ provider: 'x', model: 'y', sessionId, messages }, sessionId, bindings.get(sessionId))) { /* drain */ }
}
assert.equal(handler.clearSession('s1'), 1, 's1 恰好清掉 1 条');
assert.equal(handler.clearSession('s1'), 0, '再清一次为 0（已清空）');
assert.equal(handler.clearSession('s2'), 1, 's2 的缓存仍在');

// 3) registerSessionHook 的 session/disposed 回调真实触发不抛错
{
  let disposed;
  const ctx = {
    on: (name, fn) => { if (name === 'session/disposed') disposed = fn; return () => {}; },
  };
  const registered = registerSessionHook({
    ctx,
    store,
    bindings,
    transport,
    log: () => {},
    diagnostics: new Map(),
    sessions: { get: () => ({ id: 's1' }) },
    agentPresets: { presetForSession: () => 'writer' },
    isEnabled: () => true,
    llm: null,
  });
  assert.equal(typeof registered, 'function', 'llm/stream 仍注册');
  assert.equal(typeof disposed, 'function', 'session/disposed 已注册');
  assert.doesNotThrow(() => disposed({ id: 's1' }), '销毁已存在会话不抛');
  assert.doesNotThrow(() => disposed({ id: 'unknown' }), '销毁未知会话不抛');
  assert.doesNotThrow(() => disposed(null), 'null 事件不抛');
}

await rm(root, { recursive: true, force: true });
console.log('session-dispose: 全部通过');
