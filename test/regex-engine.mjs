#!/usr/bin/env node
/**
 * 正则兼容实现的本地测试（无网络、无文件执行）。
 *   node test/regex-engine.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PLACEMENT, SUBSTITUTE, shouldRun, runScriptSync, runBatchSafe,
  applyScripts, applyScriptsSafe, trimMatch, escapeRegexMetachars, LIMITS,
} from '../lib/regex-engine.js';
import { ExtensionStore, collectRegexSources, normalizeRegexScript } from '../lib/extension-store.js';

const script = (over = {}) => normalizeRegexScript({
  id: 's1', scriptName: 'test', findRegex: '/foo/g', replaceString: 'bar',
  placement: [PLACEMENT.AI_OUTPUT], disabled: false, ...over,
});

// 1) 基本替换 + 无效/禁用原样
{
  const a = script();
  assert.equal(runScriptSync(a, 'foo foo').output, 'bar bar');
  assert.equal(runScriptSync({ ...a, disabled: true }, 'foo').output, 'foo');
  assert.equal(runScriptSync({ ...a, findRegex: '' }, 'foo').output, 'foo');
  assert.equal(runScriptSync({ ...a, findRegex: '/[/g' }, 'foo').code, 'bad-regex');
}

// 2) placement 过滤
{
  const a = script({ placement: [PLACEMENT.AI_OUTPUT] });
  assert.equal(applyScripts([a], 'foo', { placement: PLACEMENT.AI_OUTPUT }).output, 'bar');
  assert.equal(applyScripts([a], 'foo', { placement: PLACEMENT.USER_INPUT }).output, 'foo');
}

// 3) promptOnly / markdownOnly 场景隔离
{
  const prompt = script({ promptOnly: true });
  assert.equal(applyScripts([prompt], 'foo', { placement: PLACEMENT.AI_OUTPUT, isPrompt: true }).output, 'bar');
  assert.equal(applyScripts([prompt], 'foo', { placement: PLACEMENT.AI_OUTPUT, isMarkdown: true }).output, 'foo');
  const md = script({ markdownOnly: true });
  assert.equal(applyScripts([md], 'foo', { placement: PLACEMENT.AI_OUTPUT, isMarkdown: true }).output, 'bar');
  assert.equal(applyScripts([md], 'foo', { placement: PLACEMENT.AI_OUTPUT }).output, 'foo');
}

// 4) min/maxDepth
{
  const a = script({ minDepth: 2, maxDepth: 5 });
  assert.equal(shouldRun(a, { placement: PLACEMENT.AI_OUTPUT, depth: 1 }), false, '低于 minDepth');
  assert.equal(shouldRun(a, { placement: PLACEMENT.AI_OUTPUT, depth: 3 }), true);
  assert.equal(shouldRun(a, { placement: PLACEMENT.AI_OUTPUT, depth: 6 }), false, '高于 maxDepth');
}

// 5a) // 5) 捕获组 / {{match}} / 命名组 / trimStrings 保持字面（ST 不把它当原生 replace 展开）
{
  const amp = script({ findRegex: '/a/g', replaceString: '[$&]' });
  assert.equal(runScriptSync(amp, 'a').output, '[$&]', '$& 不做原生展开');
}

// 5) 捕获组 / {{match}} / 命名组 / trimStrings
{
  const a = script({ findRegex: '/name:(\\w+)/g', replaceString: '[$1]' });
  assert.equal(runScriptSync(a, 'name:abc').output, '[abc]');

  const b = script({ findRegex: '/x(\\d+)/g', replaceString: '<{{match}}>' });
  assert.equal(runScriptSync(b, 'x42').output, '<x42>');

  const c = script({ findRegex: '/id:(?<num>\\d+)/g', replaceString: '#$<num>' });
  assert.equal(runScriptSync(c, 'id:7').output, '#7');

  const d = script({ findRegex: '/\\[.*?\\]/g', replaceString: '', trimStrings: ['[', ']'] });
  assert.equal(trimMatch('[abc]', d.trimStrings), 'abc');
  assert.equal(runScriptSync(d, 'a[bc]d').output, 'ad');
}

// 6) substituteRegex=2 转义宏字符
{
  assert.equal(escapeRegexMetachars('a.b'), 'a\\.b');
  const a = script({ substituteRegex: SUBSTITUTE.ESCAPED, findRegex: '{{char}}', replaceString: 'X' });
  assert.equal(runScriptSync(a, '沈砚来了', { char: '沈砚' }).output, 'X来了');
}

// 7) 输入/输出上限
{
  const big = 'a'.repeat(LIMITS.maxInputChars + 1);
  assert.equal(runScriptSync(script(), big).code, 'input-too-large');
  const grow = script({ findRegex: '/a/g', replaceString: 'a'.repeat(120) });
  assert.equal(runScriptSync(grow, 'a'.repeat(20000)).code, 'output-too-large');
}

// 8) worker：正常执行 + 灾难回溯被终止
{
  const ok = await applyScriptsSafe([script()], 'foo', { placement: PLACEMENT.AI_OUTPUT });
  assert.equal(ok.ok, true);
  assert.equal(ok.output, 'bar');

  const evil = script({ findRegex: '/(a+)+$/g', replaceString: 'x' });
  const started = Date.now();
  const result = await runBatchSafe({
    scripts: [evil],
    inputs: [{ index: 0, text: 'a'.repeat(4000) + 'b', scene: { placement: PLACEMENT.AI_OUTPUT } }],
    scene: { placement: PLACEMENT.AI_OUTPUT },
    limits: { ...LIMITS, deadlineMs: 300 },
  });
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'timeout', '灾难回溯要被 worker 终止');
  assert.ok(elapsed < 5000, `不应长时间占用宿主（实际 ${elapsed}ms）`);

  const chain = await applyScriptsSafe([script(), script({ id: 's2', findRegex: '/bar/g', replaceString: 'baz' })], 'foo', { placement: PLACEMENT.AI_OUTPUT });
  assert.equal(chain.ok, true);
  assert.equal(chain.output, 'baz');
  assert.equal(chain.applied.length, 2);
}

// 9) 来源合并顺序：全局 → 预设 → 卡片，同 id 后者覆盖
{
  const merged = collectRegexSources({
    globalScripts: [{ id: 'g1', scriptName: 'global', findRegex: '/a/g', placement: [2] }],
    preset: { extensions: { regex_scripts: [{ id: 'p1', scriptName: 'preset', findRegex: '/b/g', placement: [2] }] } },
    card: { extensions: { regex_scripts: [{ id: 'g1', scriptName: 'card-overrides', findRegex: '/c/g', placement: [2] }] } },
  });
  assert.equal(merged.length, 3, '三个来源全部按序执行（不按 id 去重）');
  assert.deepEqual(merged.map((item) => item.source), ['global', 'preset', 'card'], '执行顺序 global→preset→card');
}

// 10) 存储：独立文件、导入默认停用、启停与删除
{
  const root = await mkdtemp(path.join(os.tmpdir(), 'wg-ext-'));
  const store = new ExtensionStore(root);
  const saved = await store.upsert({ id: 'x1', scriptName: '导入', findRegex: '/a/g', replaceString: 'b', placement: [2] }, { source: 'imported' });
  assert.equal(saved.regex.global.length, 1);
  assert.equal(saved.regex.global[0].disabled, false, 'upsert 保留传入的 disabled');
  await store.setEnabled('x1', false);
  assert.equal((await store.load()).regex.global[0].disabled, true, '可停用');
  await store.remove('x1');
  assert.equal((await store.load()).regex.global.length, 0);
  await rm(root, { recursive: true, force: true });
}

// 11) 分区 merge：更新 regex 不丢 template/helper/sessions
{
  const root = await mkdtemp(path.join(os.tmpdir(), 'wg-ext2-'));
  const store = new ExtensionStore(root);
  await store.save({
    ...(await store.load()),
    template: { enabled: false, note: 'keep' },
    helper: { enabled: false, scripts: [{ id: 'h1' }] },
    sessions: { s1: { vars: { mood: '安静' } } },
  });
  await store.upsert({ id: 'r1', findRegex: '/a/g', replaceString: 'b', placement: [2] }, { source: 'imported' });
  const state = await store.load();
  assert.equal(state.template.note, 'keep', 'template 分区不丢');
  assert.equal(state.helper.scripts.length, 1, 'helper 分区不丢');
  assert.equal(state.sessions.s1.vars.mood, '安静', 'sessions 变量不丢');
  await rm(root, { recursive: true, force: true });
}

// 12) 实源对照：flags / zero-width / null-depth / substituteRegex=2 / 命名捕获 trim
{
  // flags 不自动补 g：/a/i 只替换第一处
  const once = script({ findRegex: '/a/', replaceString: 'X' });
  assert.equal(runScriptSync(once, 'a a').output, 'X a', '无 g 只换第一处');

  // zero-width：^ 空插入要生效
  const caret = script({ findRegex: '/^/g', replaceString: '[前]' });
  assert.equal(runScriptSync(caret, 'abc').output, '[前]abc', '零长度匹配不跳过');

  // minDepth/maxDepth 为 null → 不限制
  const noLimit = { ...script(), minDepth: null, maxDepth: null };
  assert.equal(shouldRun(noLimit, { placement: PLACEMENT.AI_OUTPUT, depth: 0 }), true, 'null depth 不限制');

  // substituteRegex=2 只转义宏的值
  const esc = { ...script({ findRegex: '{{char}}', replaceString: 'Y' }), substituteRegex: 2 };
  assert.equal(runScriptSync(esc, 'a.b 与 axb', { char: 'a.b' }).output, 'Y 与 axb', '只匹配字面 a.b');

  // 命名捕获也 trim；替换体里的 char/user 宏会展开
  const named = script({ findRegex: '/x(?<v>\\d+)/g', replaceString: '{{char}}#$<v>', trimStrings: ['9'] });
  assert.equal(runScriptSync(named, 'x19', { char: '沈砚' }).output, '沈砚#1', '命名组 trim + char 宏');

  // trimStrings 同样作用于 $1
  const num = script({ findRegex: '/n(\\d+)/g', replaceString: '<$1>', trimStrings: ['0'] });
  assert.equal(runScriptSync(num, 'n10').output, '<1>', '$1 也 trim');
}

// 13) ST 对照：trimStrings 先宏展开再 trim（完整/编号/命名统一）
{
  const stCase = {
    findRegex: '/(A.B)/g', replaceString: '$1', trimStrings: ['{{char}}'],
    placement: [2], disabled: false,
  };
  assert.equal(runScriptSync(stCase, 'A.B', { char: 'A.B' }).output, '', 'ST 输出空');

  // 命名捕获同样用展开后的 trimStrings
  const named = {
    findRegex: '/x(?<v>\\w+)/g', replaceString: '<$<v>>', trimStrings: ['{{char}}'],
    placement: [2], disabled: false,
  };
  assert.equal(runScriptSync(named, 'xAB', { char: 'B' }).output, '<A>', '命名捕获也 trim');

  // 完整匹配与 $1 不该被重复 trim
  const twice = {
    findRegex: '/(ab)/g', replaceString: '[$1|{{match}}]', trimStrings: ['a'],
    placement: [2], disabled: false,
  };
  assert.equal(runScriptSync(twice, 'ab').output, '[b|b]', '统一一份 trimStrings，不重复 trim');
}

// 14) unicode 零长度：/gu 不能落在代理对中间死循环
{
  const emoji = 'a\u{1F600}b';
  const zero = { findRegex: '/^/gu', replaceString: '#', placement: [2], disabled: false };
  const started = Date.now();
  const out = runScriptSync(zero, emoji).output;
  assert.equal(out, '#' + emoji, '零长度插入一次');
  assert.ok(Date.now() - started < 1000, '不应死循环');

  const emptyEvery = { findRegex: '/(?=b)/gu', replaceString: '-', placement: [2], disabled: false };
  assert.equal(runScriptSync(emptyEvery, emoji).output, 'a\u{1F600}-b', '代理对之后插入');
}

console.log('regex-engine: 全部通过');
