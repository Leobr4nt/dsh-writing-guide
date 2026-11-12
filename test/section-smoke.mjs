#!/usr/bin/env node
/**
 * section 挂载自测：假 Cordis ctx，验证「注册 → 按模式返回文本 → 撤掉」。
 *   node test/section-smoke.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GuideStore } from '../lib/store.js';
import { createSectionController } from '../lib/section.js';
import { normalizePreset } from '../lib/preset.js';
import { normalizeWorld } from '../lib/worldinfo.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'wg-section-'));
const store = new GuideStore(root);
await store.ensure();

await store.savePreset(normalizePreset({
  id: 'base',
  name: '写作基础',
  prompts: [
    { identifier: 'main', content: '按预设写。' },
    { identifier: 'worldInfoBefore', marker: true },
    { identifier: 'jailbreak', content: '别复述。' },
  ],
  prompt_order: [{ order: [
    { identifier: 'main', enabled: true },
    { identifier: 'worldInfoBefore', enabled: true },
    { identifier: 'jailbreak', enabled: true },
  ] }],
}));
await store.saveWorld(normalizeWorld({
  id: 'city',
  name: '雨城',
  entries: [
    { uid: 1, comment: '基调', key: [], constant: true, content: '常年有雨。' },
    { uid: 2, comment: '@D', key: [], constant: true, position: 4, depth: 4, content: '深度条目。' },
  ],
}));
await store.saveSettings({ enabled: true, targets: ['writer', 'legacy-writer'] });

const sections = [];
const removals = [];
const promptService = {
  section(section) {
    sections.push(section);
    return () => { removals.push(section.name); };
  },
};
const fakeCtx = {
  get(name) {
    if (name === 'systemPrompt') return promptService;
    if (name === 'agentPresets') return { presetForSession: () => null };
    return undefined;
  },
  effect(fn) { const disposer = fn(); return () => disposer?.(); },
};

const controller = createSectionController(fakeCtx, { store, getService: (name) => fakeCtx.get(name) });
assert.equal(sections.length, 1);
assert.equal(sections[0].name, 'writing-guide');
assert.equal(sections[0].interpolate, false);
assert.ok(sections[0].order < 0, '固定在系统提示词最前');

const context = (preset, messages = []) => ({
  agent: {
    session: {
      header: { agentPreset: preset },
      snapshotEvents: () => messages,
    },
  },
});
const messages = [{ type: 'user/message', data: { role: 'user', content: '下雨了。' } }];

assert.equal(sections[0].text(context('writer', messages)), '', 'writer never falls back to hidden legacy injection');
assert.match(controller.state().reason, /会话接管/);
const hit = sections[0].text(context('legacy-writer', messages));
assert.match(hit, /按预设写。/);
assert.match(hit, /常年有雨。/);
assert.match(hit, /深度条目。/, '@D 并入系统提示词');
assert.ok(hit.indexOf('别复述。') < hit.indexOf('深度条目。'), 'PHI 在 @D 之前');
assert.equal(controller.state().injected, true);
assert.equal(controller.state().mode, 'legacy-writer');
assert.equal(controller.state().depthBlocks, 1);

assert.equal(sections[0].text(context('standard', messages)), '', '其它模式为空');
assert.match(controller.state().reason, /不在注入目标/);
assert.equal(sections[0].text({}), '');

await store.saveSettings({ enabled: false });
assert.equal(sections[0].text(context('legacy-writer', messages)), '');
assert.equal(controller.state().reason, '未启用');

controller.dispose();
assert.ok(removals.includes('writing-guide'));

await rm(root, { recursive: true, force: true });
console.log('section-smoke: 全部通过');
