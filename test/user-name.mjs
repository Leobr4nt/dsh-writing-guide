#!/usr/bin/env node
// Synthetic fixtures only: node test/user-name.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { normalizeUserName, replaceNameMacros } from '../lib/name-macros.js';
import { BindingCache, normalizeBinding } from '../lib/session-bindings.js';
import { normalizePreset, renderStoryString } from '../lib/preset.js';
import { normalizeCard, pickGreeting } from '../lib/cards.js';
import { buildPlan } from '../lib/plan.js';
import { createMacroScope, macroVariables } from '../lib/macros.js';
import { GuideStore } from '../lib/store.js';
import { ExtensionStore } from '../lib/extension-store.js';
import { ExtensionScopes } from '../lib/extension-scopes.js';
import { createGuideRoutes } from '../lib/routes.js';
import { registerSessionHook } from '../lib/session-hook.js';
import { runTemplateBatch } from '../lib/extension-runtime.js';
import { buildChatBody, postChatCompletion } from '../lib/chat-transport.js';
import { ResidentRuntime } from '../lib/resident-runtime.js';

const first = '合成甲$&', second = '合成乙', renamed = '合成丙$&', char = '合成角色$&';
const rencheng = '{{setvar::rencheng::third <user>}}{{getvar::rencheng}}';
const ejsNames = '<%- user %>|<%- userName %>|<%- char %>|<%- charName %>|<%- assistantName %>';
const expectedNames = user => `${user}|${user}|${char}|${char}|${char}`;

await test('binding names normalize strings only; aliases replace once with literal values', () => {
  for (const value of [undefined, null, '', ' \t\r\n ', 42, false, {}, ['合成名字']]) {
    assert.equal(normalizeUserName(value), '用户');
    assert.equal(normalizeBinding({ userName: value }).userName, '用户');
  }
  assert.equal(normalizeBinding({}).userName, '用户');
  assert.equal(normalizeUserName(` \t${first}\n`), first);
  const literal = "合成$&$$$`$'$1";
  assert.equal(replaceNameMacros('<user>|<UsEr>|{{user}}|{{ USER }}|<char>|<CHAR>|<BoT>|{{ChAr}}',
    { user: literal, char }), [literal, literal, literal, literal, char, char, char, char].join('|'));
  assert.equal(replaceNameMacros('<user>|{{char}}', { user: '<char>{{char}}', char: '<user>{{user}}' }),
    '<char>{{char}}|<user>{{user}}', 'replacement values are not recursively expanded');
  assert.equal(replaceNameMacros('<START>|<username>|{{unknown}}|{{setvar::x::v}}', { user: first, char }),
    '<START>|<username>|{{unknown}}|{{setvar::x::v}}', 'unrelated syntax is preserved');
  assert.equal(renderStoryString('<USER>|<bot>|{{UsEr}}|{{ChAr}}', { user: literal, char }),
    [literal, char, literal, char].join('|'));
});

await test('legacy aliases inside setvar expand before data macros, including excluded branches', () => {
  const macroScope = createMacroScope({ seed: 'synthetic-user-name' });
  const content = `${rencheng}|{{setvar::both::<UsEr>/<BoT>/{{ChAr}}}}{{getvar::both}}`
    + '{{#if disabled}}{{setvar::excluded::<user>}}{{/if}}';
  const preset = normalizePreset({ id: 'macro', prompts: [{ identifier: 'main', content }],
    prompt_order: [{ order: [{ identifier: 'main', enabled: true }] }] });
  const plan = buildPlan({ preset, vars: { user: first, char, disabled: false }, macroScope });
  assert.equal(plan.messages.map(row => row.content).join('\n'), `third ${first}|${first}/${char}/${char}`);
  assert.equal(macroVariables(macroScope).rencheng, `third ${first}`);
  assert.equal(macroVariables(macroScope).excluded, undefined);
  assert.doesNotMatch(plan.meta.notes.join('\n'), /setvar|getvar|<user>/i);
});

await test('normal writer transport, previews and resident browser use the selected binding', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wg-user-name-'));
  const store = new GuideStore(root), ext = new ExtensionStore(root);
  const scopes = new ExtensionScopes({ store, extensionStore: ext });
  const bindings = new BindingCache({});
  const captured = [], diagnostics = new Map();
  let resident;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    captured.push({ url: req.url, body: JSON.parse(raw) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'SYNTHETIC_ACK' }, finish_reason: 'stop' }] }));
  });
  try {
    await store.ensure();
    await new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
    });
    const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
    const transport = async ({ route, plan, maxTokens, signal, onRequest }) => postChatCompletion({
      baseURL, apiKey: 'synthetic-key', signal, onRequest, timeoutMs: 10000,
      body: buildChatBody({ model: route.model, messages: plan.messages, maxTokens }),
    });
    const prompts = [
      { identifier: 'main', content: `[MAIN]<UsEr>|{{USER}}|<char>|<BoT>\n[RENCHENG]${rencheng}\n[EJS]${ejsNames}` },
      ...['worldInfoBefore', 'charDescription', 'charPersonality', 'scenario', 'dialogueExamples', 'chatHistory']
        .map(identifier => ({ identifier, marker: true })),
      { identifier: 'phi', content: '[PHI]<user>', role: 'system' },
    ];
    const regex = [
      { id: 'raw', findRegex: '/RX_RAW/g', replaceString: '[RAW]<UsEr>/<BoT>', placement: [1, 2] },
      { id: 'send', findRegex: '/RX_SEND/g', replaceString: '[SEND]{{USER}}', placement: [1, 2], promptOnly: true },
      { id: 'display', findRegex: '/RX_DISPLAY/g', replaceString: '[DISPLAY]{{USER}}', placement: [1, 2], markdownOnly: true },
    ];
    const preset = { id: 'p', name: 'Synthetic names', prompts,
      prompt_order: [{ order: prompts.map(({ identifier }) => ({ identifier, enabled: true })) }],
      extensions: { regex_scripts: regex } };
    await store.savePreset(preset);
    const card = normalizeCard({ id: 'c', name: char,
      description: '[DESC]<USER>/<char>', personality: '[PERSONALITY]{{uSeR}}', scenario: '[SCENARIO]<user>/<BOT>',
      first_mes: '[GREETING]<user>/<BoT>', alternate_greetings: ['[ALT]{{USER}}/<char>'],
      mes_example: '<START>\n<UsEr>: [EX_USER]<user>/<char>\n<BoT>: [EX_CHAR]{{USER}}/{{CHAR}}',
      system_prompt: '[CARD_SYS]<user>\n{{original}}', post_history_instructions: '[CARD_PHI]<user>\n{{original}}',
    });
    await store.saveCard(card);
    await store.saveWorld({ id: 'w', name: 'Synthetic world', entries: [
      { uid: 1, constant: true, position: 0, content: '[WORLD]<UsEr>/{{CHAR}}/<BoT>' },
    ] });
    await store.saveSettings({ enabled: true, includePreset: true, includeWorlds: true,
      contextWindow: 0, maxTokens: 128, maxChars: 0, worldBudgetTokens: 0,
      vars: { user: 'GLOBAL_NAME_MUST_NOT_WIN' } });
    await ext.updateSection('template', { enabled: true, allowedPresetIds: ['p'] });
    await scopes.setAllowed({ type: 'preset', id: 'p', kind: 'regex', enabled: true });
    const baseBinding = { presetId: 'p', cardId: 'c', worldIds: ['w'], worldSelection: 'selected',
      provider: 'synthetic', model: 'synthetic-model' };
    const history = [
      { id: 'old-user', role: 'user', source: { kind: 'user' }, content: 'OLD_USER <user> {{USER}} <% throw Error("history must stay literal") %>' },
      { id: 'old-char', role: 'assistant', content: 'OLD_ASSISTANT <BoT> {{char}}' },
      { id: 'current', role: 'user', source: { kind: 'user' }, content: 'CURRENT RX_RAW RX_SEND' },
    ];
    const readingHistory = [{ id: 'display', role: 'user', source: { kind: 'user' }, content: 'RX_RAW RX_DISPLAY RX_SEND' }];
    const sourcesBefore = structuredClone({ preset, card, regex, history, readingHistory });
    const routes = createGuideRoutes({ store, bindings, extensionStore: ext, scopes, runtime: { runTemplateBatch },
      listModes: () => [], lastState: () => ({}), getSessionInfo: async id => ({ id, writer: true }),
      readSessionMessages: async () => ({ writer: true, messages: readingHistory }) });
    const call = async (url, body) => {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
      req.method = body === undefined ? 'GET' : 'POST';
      let answer;
      const res = { setHeader() {}, end(value) { answer = { status: this.statusCode, ...JSON.parse(value) }; } };
      assert.equal(await routes(req, res, new URL('/api/writing-guide' + url, 'http://fixture.invalid')), true);
      assert.equal(answer.status, 200, `${url}: ${JSON.stringify(answer)}`);
      assert.equal(answer.ok, true);
      return answer;
    };
    const saveBinding = (sessionId, userName, extra = {}) => call('/bindings', {
      sessionId, binding: { ...baseBinding, userName, ...extra },
    });
    await call('/bindings', { defaults: baseBinding });
    await saveBinding('a', ` \t${first}\n`);
    await saveBinding('b', second);
    await saveBinding('empty', ' \t ');
    const persisted = new BindingCache(await new GuideStore(root).loadBindings());
    assert.equal(persisted.get('a').userName, first);
    assert.equal(persisted.get('b').userName, second);
    assert.equal(persisted.get('empty').userName, '用户');
    assert.equal(persisted.defaults().userName, '用户');
    bindings.replace(persisted.toJSON());
    const materialPaths = [store.presetFile('p'), store.cardFile('c'), store.worldFile('w'), store.settingsFile];
    const materialBytes = await Promise.all(materialPaths.map(file => readFile(file, 'utf8')));
    const makeWriter = residentManager => {
      let stream;
      registerSessionHook({ ctx: { on(event, handler) { if (event === 'llm/stream') stream = handler; return () => {}; } },
        store, bindings, transport, diagnostics, extensionStore: ext, scopes, runTemplateBatch, residentManager,
        sessions: { get: id => ({ id }) }, agentPresets: { presetForSession: () => 'writer' }, isEnabled: () => true });
      return stream;
    };
    const run = async (writer, sessionId) => {
      const count = captured.length, chunks = [];
      for await (const chunk of writer({ sessionId, provider: 'host', model: 'host', messages: history },
        () => assert.fail('normal writer must reach its own transport'))) chunks.push(chunk);
      assert.equal(chunks.at(-1)?.reason?.kind, 'stop', JSON.stringify({ sessionId, chunks, diagnostic: diagnostics.get(sessionId) }));
      assert.equal(captured.length, count + 1, 'one actual loopback request per generation');
      assert.equal(captured.at(-1).url, '/v1/chat/completions');
      assert.equal(captured.at(-1).body.model, 'synthetic-model');
      return captured.at(-1).body.messages;
    };
    const assertSent = (messages, user) => {
      const text = messages.map(row => row.content).join('\n');
      for (const expected of [`[MAIN]${user}|${user}|${char}|${char}`, `[RENCHENG]third ${user}`,
        `[EJS]${expectedNames(user)}`, `[CARD_SYS]${user}`, `[CARD_PHI]${user}`, `[PHI]${user}`,
        `[WORLD]${user}/${char}/${char}`, `[DESC]${user}/${char}`, `[PERSONALITY]${user}`, `[SCENARIO]${user}/${char}`]) {
        assert.ok(text.includes(expected), `missing transport content: ${expected}\n${text}`);
      }
      for (const [role, content] of [['user', `[EX_USER]${user}/${char}`], ['assistant', `[EX_CHAR]${user}/${char}`],
        ['assistant', `[GREETING]${user}/${char}`], ['user', `CURRENT [RAW]${user}/${char} [SEND]${user}`],
        ...history.slice(0, 2).map(row => [row.role, row.content])]) {
        assert.equal(messages.filter(row => row.role === role && row.content === content).length, 1, content);
      }
      assert.ok(!text.includes('GLOBAL_NAME_MUST_NOT_WIN'));
      for (const other of [first, second, renamed].filter(name => name !== user)) assert.ok(!text.includes(other), `leaked ${other}`);
    };

    await t.test('writer A/B/A, unnamed binding and defaults reach real transport without rewriting history', async () => {
      const writer = makeWriter();
      for (const [id, name] of [['a', first], ['b', second], ['a', first], ['empty', '用户'], ['unbound', '用户']]) {
        assertSent(await run(writer, id), name);
        assert.equal((await ext.sessionVars(id)).vars.rencheng, `third ${name}`);
      }
      await saveBinding('a', renamed);
      assertSent(await run(writer, 'a'), renamed);
      assertSent(await run(writer, 'b'), second);
      assert.equal(pickGreeting({ ...card, greetingPolicy: 'alternate:0' }, { user: first }), `[ALT]${first}/${char}`);
    });

    await t.test('selected-session reading, regex and template previews refresh names without committing variables', async () => {
      const stateBefore = await readFile(ext.file, 'utf8');
      for (const [id, name] of [['a', first], ['b', second], ['a', renamed], ['empty', '用户']]) {
        await saveBinding(id, name);
        const reading = await call('/reading?sessionId=' + id);
        const display = await call('/extensions/scope/preview', { sessionId: id, text: readingHistory[0].content, mode: 'display', placement: 1 });
        const expected = `[RAW]${name}/${char} [DISPLAY]${name} RX_SEND`;
        assert.equal(reading.messages[0].text, expected);
        assert.equal(reading.messages[0].original, readingHistory[0].content);
        assert.equal(display.context.userName, name);
        assert.equal(display.result.ok, true);
        assert.equal(display.result.output, expected);
        const send = await call('/extensions/scope/preview', { sessionId: id, text: 'RX_RAW RX_SEND', mode: 'send', placement: 1 });
        assert.equal(send.result.ok, true);
        assert.equal(send.result.output, `[RAW]${name}/${char} [SEND]${name}`);
        const preview = await call('/extensions/template/preview', { sessionId: id,
          text: `<UsEr>|{{USER}}|<BoT>|${ejsNames}<% setLocalVar("previewOnly",true); %>` });
        assert.deepEqual(preview.texts, [`${name}|${name}|${char}|${expectedNames(name)}`]);
      }
      const fallback = await call('/extensions/template/preview', { text: ejsNames });
      assert.deepEqual(fallback.texts, [expectedNames('用户')]);
      assert.equal(await readFile(ext.file, 'utf8'), stateBefore, 'preview cannot commit EJS variables');
    });

    await t.test('SPreset squash prefixes and single-message names receive the binding name', async () => {
      const writer = makeWriter();
      for (const [id, config, expected] of [
        ['squash', { ChatSquash: { enabled: true, role: 'user', user_prefix: '[SQUASH]<USER>|{{UsEr}}:',
          char_prefix: '[CHAR]<BoT>:', prefix_system: '[SYSTEM]{{USER}}:' } }, `[SQUASH]${first}|${first}:`],
        ['single', { ForcedPostProcessing: { enabled: true, mode: 'single' } }, `${first}: CURRENT`],
      ]) {
        await store.savePreset({ id, prompts: [{ identifier: 'main', content: 'SYNTHETIC_MAIN' }, { identifier: 'chatHistory', marker: true }],
          prompt_order: [{ order: ['main', 'chatHistory'].map(identifier => ({ identifier, enabled: true })) }],
          extensions: { SPreset: config } });
        await saveBinding(id, first, { presetId: id });
        const text = (await run(writer, id)).map(row => row.content).join('\n');
        assert.ok(text.includes(expected), text);
        assert.ok(text.includes(id === 'squash' ? `[CHAR]${char}:` : `${char}: [GREETING]${first}/${char}`), text);
      }
    });

    await t.test('real resident browser receives user at startup, keeps aliases and isolates renamed sessions', async () => {
      resident = new ResidentRuntime({ store, extensionStore: ext, scopes });
      await ext.updateSection('resident', { enabled: true, sessionIds: ['a', 'b', 'empty'] });
      const writer = makeWriter(resident);
      for (const [id, name] of [['a', first], ['b', second], ['a', first], ['a', renamed], ['empty', '用户']]) {
        await saveBinding(id, name);
        const messages = await run(writer, id);
        const browser = resident.sessions.get(id).runtime;
        assert.deepEqual(await browser.render([`${ejsNames}|<%- SillyTavern.name1 %>|<%- substituteParams("<UsEr>/{{USER}}/<BoT>") %>`]),
          [`${expectedNames(name)}|${name}|${name}/${name}/${char}`], 'browser defaults use startup user without explicit context');
        const snapshot = await browser.snapshot();
        assert.ok(snapshot.chat.filter(row => row.is_user).every(row => row.name === name));
        assert.equal(snapshot.chat[0].mes, `[GREETING]${name}/${char}`);
        assertSent(messages, name);
      }
    });

    assert.deepEqual({ preset, card, regex, history, readingHistory }, sourcesBefore, 'source fixtures and original history remain unchanged');
    assert.deepEqual(await Promise.all(materialPaths.map(file => readFile(file, 'utf8'))), materialBytes,
      'generation and previews must not rewrite saved preset, card, world or global settings');
  } finally {
    await resident?.dispose();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
