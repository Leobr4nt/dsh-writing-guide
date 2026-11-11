/**
 * 写作指导 —— Host 半边。
 *
 * 职责：
 *   1. 数据根（默认 ~/.dsh/writing-guide/）里的世界书与预设的读写；
 *   2. /api/writing-guide/* 给面板用；
 *   3. 一个 prompt section：按「当前会话的 DSH 模式」把预设 + 命中世界书注入系统提示词；
 *   4. 一个 Agent 工具 writing_guide，让模型自己也能看/改这些数据。
 *
 * 插件本身不调用模型，只管「喂设定」。
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { DEFAULT_DATA_DIR, DEFAULT_SETTINGS, GuideStore } from './lib/store.js';
import { createGuideRoutes } from './lib/routes.js';
import { createSectionController } from './lib/section.js';
import { DEFAULT_TARGET, MODE_LABELS, assemble, modeMatches } from './lib/assemble.js';
import { normalizePreset, orderedPrompts } from './lib/preset.js';
import { normalizeWorld } from './lib/worldinfo.js';
import { WorkStore } from './lib/work.js';
import { collectHits } from './lib/lore.js';
import { buildPlan } from './lib/plan.js';
import { streamGeneration, isSuccessfulFinish } from './lib/generate.js';
import { generateForWork } from './lib/writer.js';
import { resolveChatRoute, resolveTransportKey, postChatCompletion, buildChatBody } from './lib/chat-transport.js';
import { BindingCache } from './lib/session-bindings.js';
import { ExtensionStore } from './lib/extension-store.js';
import { runTemplateBatch, runHelperScript } from './lib/extension-runtime.js';
import { registerSessionHook } from './lib/session-hook.js';

export const inject = ['webServer'];

const SAMPLE_PRESET = normalizePreset({
  id: 'sample-writing',
  name: '示例 · 写作基础（ST 结构）',
  modes: [],
  prompts: [
    {
      identifier: 'main',
      name: '主提示词',
      system_prompt: true,
      role: 'system',
      marker: false,
      content: [
        '你是一位小说作者，正在写一篇第一人称的都市短篇。',
        '规则：',
        '- 用具体的动作、对话和感官细节推进，不写剧情梗概，不替读者总结。',
        '- 每段 3~6 句，留白比解释重要。',
        '- 保持人物已有设定；需要新元素时先写它怎么出现，再写它是什么。',
      ].join('\n'),
    },
    { identifier: 'worldInfoBefore', name: '世界书 ↑Char', system_prompt: true, role: 'system', content: '', marker: true },
    { identifier: 'charDescription', name: '角色描述', system_prompt: true, role: 'system', content: '', marker: true },
    { identifier: 'charPersonality', name: '角色性格', system_prompt: true, role: 'system', content: '', marker: true },
    { identifier: 'scenario', name: '场景', system_prompt: true, role: 'system', content: '', marker: true },
    { identifier: 'worldInfoAfter', name: '世界书 ↓Char', system_prompt: true, role: 'system', content: '', marker: true },
    { identifier: 'dialogueExamples', name: '示例对话', system_prompt: true, role: 'system', content: '', marker: true },
    { identifier: 'chatHistory', name: '聊天记录', system_prompt: true, role: 'system', content: '', marker: true },
    {
      identifier: 'jailbreak',
      name: '越狱 / 后置指令（PHI）',
      system_prompt: true,
      role: 'system',
      marker: false,
      content: '继续写，不要复述设定，不要解释你的写法。',
    },
  ],
  prompt_order: [{
    character_id: 100000,
    order: ['main', 'worldInfoBefore', 'charDescription', 'charPersonality', 'scenario', 'worldInfoAfter', 'dialogueExamples', 'chatHistory', 'jailbreak']
      .map((identifier) => ({ identifier, enabled: true })),
  }],
});

const SAMPLE_WORLD = normalizeWorld({
  id: 'sample-rain-city',
  name: '示例 · 雨城',
  modes: [],
  entries: [
    {
      uid: 1,
      comment: '城市基调（常驻，↑Char）',
      key: [],
      constant: true,
      order: 10,
      position: 0,
      content: '这座城市一年有二百天在下雨，路灯是钠黄色的，积水把光摊成一片。',
    },
    {
      uid: 2,
      comment: '下雨才出现（↑Char）',
      key: ['雨', '下雨', '雨声'],
      order: 20,
      position: 0,
      content: '下雨时，旧城区的排水沟会倒灌，空气里有铁锈味；便利店的塑料门帘一掀就是一股热气。',
    },
    {
      uid: 3,
      comment: '贴着对话的细节（@D4）',
      key: ['雨', '伞'],
      order: 30,
      position: 4,
      depth: 4,
      role: 0,
      content: '她讨厌伞骨漏水时滴在手腕上的那一下。',
    },
    {
      uid: 4,
      comment: '角色设定之后的氛围（↓Char）',
      key: [],
      constant: true,
      order: 40,
      position: 1,
      content: '叙事口吻偏冷静，短句多，少用形容词堆叠。',
    },
  ],
});

export function apply(ctx, config = {}) {
  const store = new GuideStore(config.dataDir || DEFAULT_DATA_DIR);
  const bindingCache = new BindingCache({ defaultBinding: {}, bindings: {} });
  const extensionStore = new ExtensionStore(store.root);
  const sessionDiagnostics = new Map();
  const sessionListDiagnostics = [];
  const logger = typeof ctx.logger === 'function' ? ctx.logger('writing-guide') : null;
  const log = (message) => { try { logger?.info?.(message); } catch { /* 日志是尽力而为 */ } };

  /** 现取服务：本行挂载时 systemPrompt / agentPresets 可能还没就绪。 */
  const service = (name) => {
    try {
      const viaGet = typeof ctx.get === 'function' ? ctx.get(name) : undefined;
      if (viaGet) return viaGet;
    } catch { /* ignore */ }
    try {
      return ctx[name];
    } catch {
      return undefined;
    }
  };

  /** DSH 现有模式名册；作家模式永远在列表里，即便还没声明。 */
  const listModes = async () => {
    const presets = service('agentPresets');
    let rows = [];
    try {
      if (presets && typeof presets.list === 'function') rows = await presets.list();
      else if (presets && typeof presets.remoteExportList === 'function') rows = (await presets.remoteExportList())?.presets ?? [];
    } catch (error) {
      log(`读取模式名册失败：${error?.message ?? error}`);
    }
    const modes = [];
    const seen = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = String(row?.id ?? '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      modes.push({
        id,
        name: String(row?.name ?? MODE_LABELS[id] ?? id),
        description: typeof row?.description === 'string' ? row.description : '',
        isDefault: row?.isDefault === true || row?.default === true,
        broken: typeof row?.broken === 'string' ? row.broken : '',
      });
    }
    if (!seen.has(DEFAULT_TARGET)) {
      modes.unshift({
        id: DEFAULT_TARGET,
        name: MODE_LABELS[DEFAULT_TARGET] ?? DEFAULT_TARGET,
        description: '写作指导的默认落点；该模式还没声明时注入不会生效。',
        isDefault: false,
        broken: '',
        declared: false,
      });
    }
    return modes;
  };

  /** 宿主里选好的默认模型；插件 config 可覆盖。 */
  const defaultModel = () => {
    try {
      const selection = service('agentDefaultModel')?.currentSelection?.();
      if (selection?.provider && selection?.model) return selection;
    } catch { /* 服务未就绪 */ }
    return { provider: String(config.provider ?? ''), model: String(config.model ?? '') };
  };

  const section = createSectionController(ctx, { store, getService: service });

  const workStore = new WorkStore(store.root);
  /** 薄 Chat Completions transport：只服务作品显式选择的 chat route。 */
  const chatTransport = async ({ route, plan, maxTokens, temperature, signal }) => {
    const config = await resolveChatRoute({
      settings: service('settings'),
      provider: route.provider,
      model: route.model,
    });
    const apiKey = await resolveTransportKey({ credentials: service('credentials'), apiKeyEnv: config.apiKeyEnv });
    const body = buildChatBody({
      model: config.model,
      messages: plan.messages,
      maxTokens,
      temperature,
    });
    return postChatCompletion({ baseURL: config.baseURL, apiKey, body, signal });
  };

  const generate = (request) => generateForWork({
    store,
    workStore,
    llm: service('llm'),
    model: defaultModel(),
    chatTransport,
    ...request,
  });
  /** 已配置 route 列表：只列 provider/model，不读凭证。 */
  const listRoutes = async () => {
    const llm = service('llm');
    const out = [];
    try {
      const providers = llm?.listProviders?.() ?? [];
      for (const provider of providers) {
        const models = await llm.listModels(provider.id).catch(() => []);
        for (const model of models) {
          out.push({ provider: provider.id, providerName: provider.name, model: model.id, modelName: model.name });
        }
      }
    } catch { /* 列不出来就返回空 */ }
    return out;
  };

  // 写作模式接管：只对已绑定会话生效
  ctx.effect(() => registerSessionHook({
    ctx,
    store,
    bindings: bindingCache,
    transport: (args) => chatTransport(args),
    log,
    diagnostics: sessionDiagnostics,
    sessions: service('sessions'),
    agentPresets: service('agentPresets'),
    llm: service('llm'),
    extensionStore,
    runTemplateBatch,
    isEnabled: () => bindingCache.isEnabled(),
  }));

  /** 现有 DSH 会话列表：HTTP 与 tool 共用同一实现。 */
  const collectSessions = async () => {
    const gateway = service('typertGateway');
    const controller = service('sessionController');
    const query = service('sessionQuery');
    let raw = [];
    const attempts = [];
    if (gateway && typeof gateway.invoke === 'function') {
      let peer;
      try {
        peer = service('connection')?.createPeer?.({ principal: { kind: 'owner' }, interactions: 'none' });
        const result = await gateway.invoke({
          namespace: 'session',
          method: 'list',
          args: { _request: {} },
          peer,
          signal: AbortSignal.timeout?.(5000),
        });
        raw = Array.isArray(result) ? result : (result?.sessions ?? result?.items ?? []);
      } catch (error) {
        attempts.push({ step: 'gateway', error: String(error?.message ?? error) });
      } finally {
        try { peer?.dispose?.(); } catch { /* ignore */ }
      }
    }
    if (!raw.length) { try { raw = (await controller?.list?.()) ?? []; } catch (error) { attempts.push({ step: 'controller', error: String(error?.message ?? error) }); raw = []; } }
    if (!raw.length) { try { raw = (await query?.list?.()) ?? []; } catch (error) { attempts.push({ step: 'query', error: String(error?.message ?? error) }); raw = []; } }

    const valuesOf = (entry) => {
      const direct = entry?.projections?.values;
      if (direct && typeof direct === 'object') return direct;
      const summaryDirect = entry?.summary?.projections?.values;
      if (summaryDirect && typeof summaryDirect === 'object') return summaryDirect;
      const projections = entry?.projections ?? entry?.summary?.projections;
      if (Array.isArray(projections)) {
        for (const item of projections) if (item?.values && typeof item.values === 'object') return item.values;
      }
      return entry?.values && typeof entry.values === 'object' ? entry.values : {};
    };

    const rows = (Array.isArray(raw) ? raw : []).map((entry) => {
      const values = valuesOf(entry);
      const id = String(entry?.sessionId ?? entry?.id ?? '');
      const preset = String(values.agentPreset ?? entry?.agentPreset ?? '');
      return {
        id,
        title: String(values.title ?? entry?.title ?? ''),
        preset,
        writer: preset === 'writer',
      };
    }).filter((row) => row.id);
    return { rows, attempts };
  };

  /** 读某会话的**真实** user/assistant 消息（gateway session/events，bridge 同款调用）。 */
  const readSessionMessages = async (sessionId) => {
    const gateway = service('typertGateway');
    let peer;
    try {
      const listing = await collectSessions();
      const info = listing.rows.find(row => row.id === sessionId);
      if (!info) throw new Error('找不到会话');
      if (!info.writer) return { writer:false, preset:info.preset, messages:[] };
      peer = service('connection').createPeer({ principal:{kind:'owner'}, interactions:'none' });
      const records = []; let beforeSeq;
      for (let page=0; page<25; page++) {
        const result = await gateway.invoke({namespace:'session',method:'events',args:{request:{address:{kind:'session',sessionId},maxMessages:40,...(beforeSeq===undefined?{}:{beforeSeq})}},peer,signal:AbortSignal.timeout(5000)});
        if (!Array.isArray(result?.records)) throw new Error('会话事件响应格式无效');
        records.push(...result.records);
        if (!result.hasMore) break;
        const seqs=result.records.map(r=>r.event?.seq).filter(Number.isFinite);
        if (!seqs.length || page===24) throw new Error('会话过长，首批助手最多读取 1000 条原始消息');
        beforeSeq=Math.min(...seqs);
      }
      const messages=records.sort((a,b)=>(a.event?.seq??0)-(b.event?.seq??0)).flatMap(record=>{
        const event=record.event;
        const message=event?.type==='user/message'?event.data:event?.type==='assistant/message'?event.data?.message:null;
        if(!message || (event.type==='user/message' && message.source?.kind!=='user'))return [];
        const parts=Array.isArray(message.content)?message.content:[];
        if(parts.some(block=>block.type==='tool-call'))return [];
        const content=parts.filter(block=>block.type==='text').map(block=>block.text??'').join('');
        return content.trim()?[{role:message.role,content}]:[];
      });
      return {writer:true,preset:info.preset,messages};
    } catch(error) { return {writer:false,messages:[],error:String(error?.message??error)}; }
    finally { peer?.dispose?.(); }
  };

  const routes = createGuideRoutes({
    store,
    listModes,
    lastState: () => section.state(),
    onSettingsSaved: () => section.refresh(),
    workStore,
    generate,
    defaultModel,
    listRoutes,
    bindings: bindingCache,
    extensionStore,
    runtime: { runTemplateBatch, runHelperScript },
    readSessionMessages,
    listSessions: collectSessions,
  });

  const boot = async () => {
    await mkdir(store.root, { recursive: true });

    await store.ensure();
    try {
      bindingCache.replace(await store.loadBindings());
      log(`session bindings loaded: ${Object.keys(bindingCache.toJSON().bindings).length}`);
    } catch (error) {
      log(`bindings load failed: ${error?.message ?? error}`);
    }
    if (!existsSync(store.settingsFile)) {
      await writeFile(store.settingsFile, `${JSON.stringify({ ...DEFAULT_SETTINGS, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
    }
    if (config.seedSamples !== false) {
      if ((await store.listPresets()).length === 0) await store.savePreset(SAMPLE_PRESET);
      if ((await store.listWorlds()).length === 0) await store.saveWorld(SAMPLE_WORLD);
    }
    log(`就绪：${store.root}`);
  };
  const booting = boot().catch((error) => log(`启动失败：${error?.message ?? error}`));

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/writing-guide',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', ctx.webServer.getOrigin());
      // 与 DSH 浏览器连接同一套认证：不带凭证/来源不符直接 401/403
      const connection = service('connection');
      if (!connection || typeof connection.requestRejection !== 'function') {
        // 认证服务不可用时拒绝（fail-closed），不放行任何写/生成请求
        res.statusCode = 403;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: false, error: '认证服务不可用，已拒绝' }));
        return;
      }
      {
        const rejection = connection.requestRejection({ headers: req.headers });
        if (rejection) {
          res.statusCode = rejection;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ok: false, error: rejection === 401 ? '认证失败' : '来源被拒绝' }));
          return;
        }
      }
      try {
        await booting;
        if (await routes(req, res, url)) return;
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: false, error: `没有这个接口：${url.pathname}` }));
      } catch (error) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ok: false, error: error?.message ?? String(error) }));
        } else {
          res.end();
        }
      }
    },
  }));

  // ---------------------------------------------------------------- 工具
  const tools = service('tools');
  if (tools && config.enableTool !== false) {
    ctx.effect(() => tools.register({
      name: 'writing_guide',
      description:
        'Read or edit the writing-guide data: lorebooks, prompt presets, and which DSH modes receive the assembled injection (writer mode by default).',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'modes', 'worlds', 'world', 'presets', 'preset', 'world_save', 'preset_save', 'delete', 'set', 'preview'],
            description:
              'status/set = injection settings; worlds/world = lorebooks; presets/preset = prompt presets; world_save/preset_save = upsert; delete = remove by id; preview = assemble text; modes = DSH preset roster.',
          },
          id: { type: 'string', description: '实体 id（world_*/preset_*/delete/world/preset 用）。' },
          payload: {
            type: 'object',
            description: 'action=set 时为设置 patch；action=world_save/preset_save 时为完整实体。',
            additionalProperties: true,
          },
          mode: { type: 'string', description: 'preview 用哪个 DSH 模式组装（默认最近一次真实组装的模式）。' },
          scanText: { type: 'string', description: 'preview 用的世界书扫描文本。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' }, detail: { type: 'string' } },
          required: ['ok'],
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.detail ?? (value?.ok ? 'ok' : '失败')) }],
      },
      async execute(input) {
        await booting;
        const action = String(input?.action ?? 'status');
        const detail = async (value) => ({ ok: true, detail: JSON.stringify(value, null, 2) });

        if (action === 'presets_list') {
        const presets = service('agentPresets');
        let list = [];
        let inventory = [];
        try { list = (await presets?.list?.()) ?? []; } catch (error) { list = [{ error: String(error?.message ?? error) }]; }
        try { inventory = (await presets?.compositionInventory?.()) ?? []; } catch { inventory = []; }
        return {
          ok: true,
          detail: JSON.stringify({
            presets: (Array.isArray(list) ? list : []).map((row) => ({
              id: row?.id, name: row?.name, broken: row?.broken, isDefault: row?.isDefault,
            })),
            inventory: (Array.isArray(inventory) ? inventory : []).map((row) => ({
              id: row?.id, name: row?.name, broken: row?.broken,
              rows: (row?.rows ?? []).map((entry) => ({ id: entry?.entryId, name: entry?.moduleName, state: entry?.fiberState, enabled: entry?.enabled })),
            })),
          }, null, 2),
        };
      }
      if (action === 'sessions_list') {
        const result = await collectSessions();
        return { ok: true, detail: JSON.stringify(result, null, 2) };
      }
      if (action === 'session_create') {
        const controller = service('sessionController');
        if (!controller || typeof controller.create !== 'function') {
          return { ok: false, detail: 'sessionController 不可用，请在 UI 新建会话并选「写作模式」' };
        }
        try {
          const created = await controller.create({
            agentPreset: String(input?.payload?.agentPreset ?? 'writer'),
            ...(input?.payload?.title ? { title: String(input.payload.title) } : {}),
          });
          return { ok: true, detail: JSON.stringify({ id: String(created?.id ?? created?.sessionId ?? '') }) };
        } catch (error) {
          return { ok: false, detail: `创建会话失败：${error?.message ?? error}` };
        }
      }
      if (action === 'session_bind') {
        const sessionId = String(input?.payload?.sessionId ?? '');
        if (!sessionId) return { ok: false, detail: '缺少 sessionId' };
        const binding = bindingCache.set(sessionId, input?.payload?.binding ?? input?.payload ?? {});
        await store.saveBindings(bindingCache.toJSON());
        return { ok: true, detail: JSON.stringify(binding, null, 2) };
      }
      if (action === 'session_unbind') {
        const sessionId = String(input?.payload?.sessionId ?? '');
        const removed = bindingCache.remove(sessionId);
        await store.saveBindings(bindingCache.toJSON());
        return { ok: true, detail: removed ? '已解除绑定' : '该会话本来没有绑定' };
      }
      if (action === 'session_default') {
        const binding = bindingCache.setDefaults(input?.payload ?? {});
        await store.saveBindings(bindingCache.toJSON());
        return { ok: true, detail: JSON.stringify({ binding, enabled: bindingCache.isEnabled() }, null, 2) };
      }
      if (action === 'session_enable') {
        const enabled = bindingCache.setEnabled(input?.payload?.enabled !== false);
        await store.saveBindings(bindingCache.toJSON());
        return { ok: true, detail: enabled ? '写作模式已启用' : '写作模式已停用（放行给宿主模型）' };
      }
      if (action === 'session_list') {
        return {
          ok: true,
          detail: JSON.stringify({
            enabled: bindingCache.isEnabled(),
            defaults: bindingCache.defaults(),
            bindings: bindingCache.toJSON().bindings,
            diagnostics: Object.fromEntries(sessionDiagnostics),
          }, null, 2),
        };
      }
      if (action === 'modes') {
          const modes = await listModes();
          return { ok: true, detail: modes.map((mode) => `${mode.id}\t${mode.name}${mode.isDefault ? ' (默认)' : ''}${mode.declared === false ? ' (未声明)' : ''}${mode.broken ? ' [broken]' : ''}`).join('\n') };
        }
        if (action === 'worlds') {
          const worlds = await store.listWorlds();
          return detail(worlds.map((world) => ({
            id: world.id, name: world.name, modes: world.modes, entries: world.entries.length,
            constants: world.entries.filter((entry) => entry.constant).length,
          })));
        }
        if (action === 'world') {
          const world = await store.getWorld(String(input?.id ?? ''));
          if (!world) return { ok: false, detail: `没有这本世界书：${input?.id ?? '(空)'}` };
          return detail(world);
        }
        if (action === 'presets') {
          const presets = await store.listPresets();
          return detail(presets.map((preset) => ({
            id: preset.id,
            name: preset.name,
            modes: preset.modes,
            prompts: preset.prompts.length,
            enabled: orderedPrompts(preset).length,
          })));
        }
        if (action === 'preset') {
          const preset = await store.getPreset(String(input?.id ?? ''));
          if (!preset) return { ok: false, detail: `没有这份预设：${input?.id ?? '(空)'}` };
          return detail(preset);
        }
        if (action === 'world_save') {
          const saved = await store.saveWorld({ ...(input?.payload ?? {}), id: input?.payload?.id ?? input?.id });
          return detail({ id: saved.id, entries: saved.entries.length, modes: saved.modes });
        }
        if (action === 'preset_save') {
          const saved = await store.savePreset({ ...(input?.payload ?? {}), id: input?.payload?.id ?? input?.id });
          return detail({ id: saved.id, name: saved.name, modes: saved.modes });
        }
        if (action === 'delete') {
          const id = String(input?.id ?? '');
          if (!id) return { ok: false, detail: '需要 id' };
          const had = input?.payload?.kind === 'preset' ? await store.getPreset(id) : await store.getWorld(id);
          if (!had) return { ok: false, detail: `没有这个 id：${id}` };
          if (input?.payload?.kind === 'preset') await store.deletePreset(id);
          else await store.deleteWorld(id);
          return { ok: true, detail: `已删除 ${id}` };
        }
        if (action === 'set') {
          const settings = await store.saveSettings(input?.payload ?? {});
          section.refresh();
          return detail(settings);
        }
        if (action === 'preview') {
          const settings = await store.loadSettings();
          const mode = String(input?.mode ?? '').trim() || section.state().mode || '';
          const result = assemble({
            settings,
            worlds: await store.listWorlds(),
            presets: await store.listPresets(),
            mode,
            scanText: String(input?.scanText ?? ''),
            random: () => 0,
            preview: true,
          });
          const head = `[preview] mode=${mode || '(未知)'} injected=${result.meta.injected} chars=${result.meta.chars}(估算) `
            + `preset=${result.meta.preset || '-'} worlds=${result.meta.worlds.join(',') || '-'} `
            + `depthBlocks=${result.meta.depthBlocks}(不支持真注入) roles=${JSON.stringify(result.meta.roles)} reason=${result.meta.reason}`;
          const omitted = result.meta.omitted?.length
            ? `\n\n省略（整块）：${result.meta.omitted.map((item) => `${item.label}(${item.chars}字, ${item.reason})`).join('；')}`
            : '';
          const depth = result.depthBlocks.length
            ? `\n\n--- @D 深度块（仅并入系统段，不是消息级注入）---\n` + result.depthBlocks
              .map((block) => `[depth=${block.depth} role=${block.role}] ${block.content}`)
              .join('\n')
            : '';
          const notes = result.meta.notes?.length ? `\n\n注意：${result.meta.notes.join('；')}` : '';
          return { ok: true, detail: `${head}${omitted}${depth}${notes}\n\n${result.systemText || '(空)'}` };
        }
        const settings = await store.loadSettings();
        const worlds = await store.listWorlds();
        const presets = await store.listPresets();
        return detail({
          settings,
          dataRoot: store.root,
          targets: settings.targets.map((id) => ({ id, matched: modeMatches(settings.targets, id) })),
          worlds: worlds.map((world) => ({ id: world.id, name: world.name, modes: world.modes, entries: world.entries.length })),
          presets: presets.map((preset) => ({ id: preset.id, name: preset.name, modes: preset.modes })),
          last: section.state(),
        });
      },
    }));
  }

  // ---------------------------------------------------------- 写作生成入口
  // 为什么独立：llm/stream 对 AgentLoop 请求 deep-frozen，插件只能贡献系统提示词。
  // 这里自建 GenerateOptions（不冻结），@D/role/PHI 才能真正落在 messages 上。
  const chatTool = {
    name: 'writing_chat',
    description:
      'Generate one writing turn through this plugin\'s own request path (messages-level world info / @D / role preserved). Separate from the normal DSH conversation: it does not use or modify the agent transcript.',
    parameters: {
      type: 'object',
      properties: {
        work: { type: 'string', description: '作品 id（先在 writing_work 里创建）' },
        message: { type: 'string', description: '本轮用户输入' },
        save: { type: 'boolean', description: '成功后是否把 user/assistant 两条写入作品历史（默认 true）' },
      },
      required: ['work', 'message'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          detail: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.detail ?? '') }],
    },
    async execute(input) {
      const result = await generateForWork({
        store,
        workStore,
        workId: input?.work,
        message: input?.message,
        save: input?.save !== false,
        llm: service('llm'),
        model: defaultModel(),
        chatTransport,
      });
      if (!result.ok) return { ok: false, detail: result.detail };
      return { ok: true, detail: `[writing_chat] ${result.detail}\n\n${result.text}` };
    },
  };

  const workTool = {
    name: 'writing_work',
    description: 'List, create, update, delete writing works (title / preset / world books / author note) used by writing_chat.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'save', 'delete', 'export'] },
        id: { type: 'string' },
        payload: { type: 'object', additionalProperties: true },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['ok'] },
      render: (_args, value) => [{ type: 'text', text: String(value?.detail ?? '') }],
    },
    async execute(input) {
      const action = String(input?.action ?? 'list');
      if (action === 'list') {
        const works = await workStore.list();
        return { ok: true, detail: JSON.stringify(works.map((work) => ({ id: work.id, title: work.title, presetId: work.presetId, worldIds: work.worldIds, messages: work.messages })), null, 2) };
      }
      if (action === 'get' || action === 'export') {
        const meta = await workStore.load(String(input?.id ?? ''));
        if (!meta) return { ok: false, detail: `没有这个作品：${input?.id ?? ''}` };
        const chat = await workStore.chat(meta.id);
        if (action === 'export') return { ok: true, detail: JSON.stringify({ ...meta, chat }, null, 2) };
        return { ok: true, detail: JSON.stringify({ ...meta, messages: chat.length }, null, 2) };
      }
      if (action === 'delete') {
        await workStore.remove(String(input?.id ?? ''));
        return { ok: true, detail: '已删除' };
      }
      try {
        const saved = await workStore.save({ ...(input?.payload ?? {}), id: input?.payload?.id ?? input?.id });
        return { ok: true, detail: JSON.stringify(saved, null, 2) };
      } catch (error) {
        return { ok: false, detail: String(error?.message ?? error) };
      }
    },
  };

  if (tools) {
    ctx.effect(() => tools.register(chatTool));
    ctx.effect(() => tools.register(workTool));
  }

  log(`已挂载 ${ctx.webServer.getOrigin()}/api/writing-guide（数据：${store.root}）`);
}
