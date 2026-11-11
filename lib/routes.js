import { forgetExtensionOwner } from './scope-cleanup.js';
import { ExtensionScopes } from './extension-scopes.js';
import { registerScopeRoutes } from './scope-routes.js';
import { randomUUID } from 'node:crypto';
/**
 * HTTP API：/api/writing-guide/*
 *
 * 面板和 Agent 工具共用同一套读写；每次改完都从磁盘重读，所以不需要缓存。
 */
import { normalizeWorld, POSITION_LABELS } from './worldinfo.js';
import { normalizePreset, orderedPrompts } from './preset.js';
import { assemble, HEAD_ORDER, TAIL_ORDER, DEFAULT_TARGET } from './assemble.js';
import { slug } from './store.js';
import { toStWorld, toStPreset } from './export.js';
import { normalizeCard, toStCard } from './cards.js';

const MAX_UPLOAD = 16 * 1024 * 1024;

function sendJson(res, status, value) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}

async function readBody(req, limit = MAX_UPLOAD) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求体超过 16 MB'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 });
  }
}

function match(pattern, pathname) {
  const keys = [];
  const source = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z0-9_]+)/g, (_all, key) => { keys.push(key); return '([^/]+)'; });
  const found = new RegExp(`^${source}$`).exec(pathname);
  if (!found) return null;
  const params = {};
  keys.forEach((key, index) => { params[key] = decodeURIComponent(found[index + 1] ?? ''); });
  return params;
}

function summaryWorld(world) {
  const positions = new Array(8).fill(0);
  for (const entry of world.entries) positions[entry.position] = (positions[entry.position] ?? 0) + 1;
  return {
    id: world.id,
    name: world.name,
    modes: world.modes,
    description: world.description,
    entries: world.entries.length,
    positions,
    constants: world.entries.filter((entry) => entry.constant).length,
    disabled: world.entries.filter((entry) => entry.disable).length,
    updatedAt: world.updatedAt,
  };
}

function summaryPreset(preset) {
  return {
    id: preset.id,
    name: preset.name,
    modes: preset.modes,
    description: preset.description,
    prompts: preset.prompts.length,
    compat: preset.compat ? { partial: preset.compat.partial ?? [], unsupported: preset.compat.unsupported ?? [] } : null,
    enabled: orderedPrompts(preset).length,
    markers: preset.prompts.filter((prompt) => prompt.marker).map((prompt) => prompt.identifier),
    updatedAt: preset.updatedAt,
  };
}

/** 从上传体里取出 [{name, payload}]；支持 files[]、data 两种写法。 */
function collectUploads(body) {
  const files = [];
  if (Array.isArray(body?.files)) {
    for (const file of body.files) {
      const name = String(file?.name ?? 'imported.json');
      let payload = file?.data ?? file?.json;
      if (payload === undefined && typeof file?.text === 'string') {
        try { payload = JSON.parse(file.text); } catch { continue; }
      }
      if (payload !== undefined) files.push({ name, payload });
    }
  } else if (body?.data !== undefined) {
    files.push({ name: String(body.name ?? 'imported.json'), payload: body.data });
  }
  return files;
}

export function createGuideRoutes({ store, listModes, lastState, onSettingsSaved, workStore, generate, defaultModel, listRoutes, bindings, listSessions, extensionStore = null, runtime = null, readSessionMessages = null, scopes = null }) {
  const routes = [];
  const on = (method, pattern, handler) => routes.push({ method, pattern, handler });

  if(extensionStore)registerScopeRoutes(on,{readBody,store,scopes:scopes??new ExtensionScopes({store,extensionStore}),extensionStore,listSessions,readSessionMessages,runtime});

  on('GET', '/state', async () => {
    const [settings, worlds, presets, modes] = await Promise.all([
      store.loadSettings(),
      store.listWorlds(),
      store.listPresets(),
      listModes(),
    ]);
    return {
      ok: true,
      /** 数据结构版本：2 = SillyTavern 结构（prompts + prompt_order / 8 个世界书位置）。 */
      api: 2,
      settings,
      worlds: worlds.map(summaryWorld),
      presets: presets.map(summaryPreset),
      modes,
      positions: POSITION_LABELS,
      last: lastState(),
      model: typeof defaultModel === 'function' ? defaultModel() : null,
      routes: typeof listRoutes === 'function' ? await listRoutes() : [],
      authorNotePlacement: { depth: 4, role: 'system', note: '预设没有 authorsNote marker 时的默认落点' },
      section: { name: 'writing-guide', headOrder: HEAD_ORDER, tailOrder: TAIL_ORDER, defaultTarget: DEFAULT_TARGET },
      dataRoot: store.root,
    };
  });

  on('GET', '/modes', async () => ({ ok: true, modes: await listModes() }));

  on('POST', '/settings', async (req) => {
    const body = await readBody(req);
    const settings = await store.saveSettings(body.patch ?? body.settings ?? {});
    onSettingsSaved?.();
    return { ok: true, settings, last: lastState() };
  });

  // ------------------------------------------------------------- worlds
  // ---- 扩展：正则 / 模板 / 助手
  const requireExtensionStore = () => {
    if (!extensionStore) throw Object.assign(new Error('扩展存储不可用'), { status: 501 });
    return extensionStore;
  };

  on('GET', '/extensions', async () => {
    const state = extensionStore ? await extensionStore.load() : null;
    const scripts = state?.regex?.global ?? [];
    return {
      ok: true,
      regex: scripts.map((script) => ({
        ...script,
        id: script.id,
        scriptName: script.scriptName,
        placement: script.placement,
        disabled: script.disabled,
        markdownOnly: script.markdownOnly,
        promptOnly: script.promptOnly,
        minDepth: script.minDepth,
        maxDepth: script.maxDepth,
        source: state?.regex?.sources?.[script.id] ?? 'global',
      })),
      template: { enabled: state?.template?.enabled === true, allowedPresetIds: state?.template?.allowedPresetIds ?? [] },
      helper: { enabled: state?.helper?.enabled === true, scripts: (state?.helper?.scripts ?? []).map((script) => ({ id: script.id, name: script.name ?? script.id, enabled: script.enabled === true, source: script.source ?? 'imported', hasContent: typeof script.content === 'string' && script.content.length > 0 })) },
      unsupported: [
        'SPreset.RegexBinding（不执行，避免与新引擎重复）',
        'WORLD_INFO(5) 正则：世界书条目内容暂不转换',
        'REASONING(6) 正则：暂不处理',
        '显示侧正则：宿主无 assistant 正文专用 slot，仅提供预览',
        'helper 的宿主事件/网络/UI 库 API：不支持',
      ],
    };
  });

  on('POST', '/extensions/regex', async (req) => {
    const body = await readBody(req);
    const store2 = requireExtensionStore();
    const saved = await store2.upsert(body?.script ?? body, { source: body?.source ?? 'global' });
    return { ok: true, count: saved.regex.global.length };
  });

  on('POST', '/extensions/regex/:id/enabled', async (req, _res, _url, { id }) => {
    const body = await readBody(req);
    const store2 = requireExtensionStore();
    await store2.setEnabled(id, body?.enabled !== false);
    return { ok: true };
  });

  on('DELETE', '/extensions/regex/:id', async (_req, _res, _url, { id }) => {
    const store2 = requireExtensionStore();
    await store2.remove(id);
    return { ok: true };
  });

  on('POST', '/extensions/regex/import', async(req)=>{
    const body=await readBody(req);const raw=body.data??body;const incoming=Array.isArray(raw)?raw:raw.extensions?.regex_scripts??raw.regex_scripts??[raw];
    if(incoming.length>200 || incoming.some(s=>typeof s?.findRegex!=='string'))throw Object.assign(new Error('请导入正则对象、数组或包含 regex_scripts 的预设'),{status:400});
    const store2=requireExtensionStore();
    for(const script of incoming)await store2.upsert({...script,id:randomUUID(),disabled:true},{source:'imported'});
    return {ok:true,imported:incoming.length};
  });
  on('POST', '/extensions/regex/preview', async (req) => {
    const body=await readBody(req);const state=await requireExtensionStore().load();
    const {applyScriptsSafe}=await import('./regex-engine.js');
    let scripts=[...state.regex.global];
    if(body.presetId)scripts.push(...((await store.getPreset(String(body.presetId)))?.extensions?.regex_scripts??[]));
    if(body.scriptId)scripts=scripts.filter(s=>s.id===body.scriptId);
    const text=String(body.text??'');if(text.length>200000)throw Object.assign(new Error('预览文本超过 200000 字符'),{status:400});
    const scene={placement:Number(body.placement??2),depth:body.depth==null||body.depth===''?undefined:Number(body.depth),char:String(body.char??''),user:String(body.user??'用户')};
    let result;
    if(body.mode==='display')result=await applyScriptsSafe(scripts,text,{...scene,isMarkdown:true});
    else { const raw=await applyScriptsSafe(scripts,text,scene);result=raw.ok?await applyScriptsSafe(scripts,raw.output,{...scene,isPrompt:true}):raw; }
    return {ok:true,mode:body.mode==='display'?'display':'send',result};
  });
  on('POST','/extensions/template/preview',async(req)=>{
    const body=await readBody(req);if(!runtime?.runTemplateBatch)throw new Error('模板运行时不可用');
    const result=await runtime.runTemplateBatch({texts:[String(body.text??'')],variables:body.variables??{},context:{char:String(body.char??''),user:'用户'},seed:'preview'});
    return {ok:true,...result};
  });
  on('POST', '/extensions/helper/enabled', async (req) => {
    const body = await readBody(req);
    const store2 = requireExtensionStore();
    const state = await store2.updateSection('helper', { enabled: body?.enabled === true });
    return { ok: true, enabled: state.helper.enabled === true };
  });

  on('POST', '/extensions/template', async (req) => {
    const body = await readBody(req);
    const store2 = requireExtensionStore();
    const state = await store2.updateSection('template', {
      enabled: body?.enabled === true,
      allowedPresetIds: Array.isArray(body?.allowedPresetIds) ? body.allowedPresetIds.map(String) : [],
    });
    return { ok: true, template: state.template };
  });

  on('POST', '/extensions/helper/import', async(req)=>{
    const body=await readBody(req);const incoming=[];
    function walk(node,folders=[]){
      if(folders.length>12)throw new Error('脚本目录层级过深');
      if(Array.isArray(node)){node.forEach(n=>walk(n,folders));return;}
      if(!node||typeof node!=='object')return;
      if(node.type==='folder'){walk(node.scripts,[...folders,{...node,scripts:undefined}]);return;}
      if(typeof node.content==='string'){incoming.push({...node,id:randomUUID(),originalId:node.id??null,source:'imported',folders,name:String(node.name??'未命名脚本'),enabled:false});return;}
      for(const key of ['script','scripts','tavern_helper','tavernHelper','extensions','folders'])if(node[key])walk(node[key],folders);
    }
    walk(body.data??body);
    if(!incoming.length||incoming.length>100)throw Object.assign(new Error('未找到有效脚本，或超过 100 个脚本'),{status:400});
    const saved=await requireExtensionStore().update(state=>({...state,helper:{...state.helper,scripts:[...state.helper.scripts,...incoming]}}));
    return {ok:true,imported:incoming.length,total:saved.helper.scripts.length};
  });
  on('POST','/extensions/helper/:id/enabled',async(req,_res,_url,{id})=>{
    const body=await readBody(req);
    await requireExtensionStore().update(state=>{
      if(!state.helper.scripts.some(s=>s.id===id))throw Object.assign(new Error('脚本不存在'),{status:404});
      return {...state,helper:{...state.helper,scripts:state.helper.scripts.map(s=>s.id===id?{...s,enabled:body.enabled===true}:s)}};
    });return {ok:true};
  });
  on('POST', '/extensions/helper/run', async (req) => {
    const body = await readBody(req);
    const store2 = requireExtensionStore();
    if (!runtime || typeof runtime.runHelperScript !== 'function') {
      throw Object.assign(new Error('模板/助手运行时不可用'), { status: 501 });
    }
    const sessionId = String(body?.sessionId ?? '');
    if (!sessionId) throw Object.assign(new Error('缺少 sessionId'), { status: 400 });
    if (typeof readSessionMessages !== 'function') throw Object.assign(new Error('无法读取会话消息'), { status: 501 });
    const sessionInfo = await readSessionMessages(sessionId);
    if (sessionInfo?.error) {
      throw Object.assign(new Error(`无法读取会话事件：${sessionInfo.error}`), { status: 502 });
    }
    if (!sessionInfo || sessionInfo.writer !== true) {
      throw Object.assign(new Error('该会话不是写作模式（writer）'), { status: 400 });
    }
    const chatMessages = Array.isArray(sessionInfo.messages) ? sessionInfo.messages : [];   // 空会话也允许（仅初始化变量）
    const state = await store2.load();
    if (state.helper?.enabled !== true) throw Object.assign(new Error('助手总开关未启用'), { status: 400 });
    const script = (state.helper.scripts ?? []).find((item) => item.id === String(body?.scriptId ?? ''));
    if (!script) throw Object.assign(new Error('找不到该助手脚本'), { status: 404 });
    if (script.enabled !== true) throw Object.assign(new Error('该脚本未启用（导入默认停用）'), { status: 400 });
    const snapshot = await store2.sessionVars(sessionId);
    const result = await runtime.runHelperScript({
      script: { id: script.id, content: script.content },
      variables: snapshot.vars ?? {},
      scriptVariables: snapshot.scriptVars?.[script.id] ?? {},
      chatMessages,
      context: { char: '', user: '用户', model: '' },
      signal: undefined,
    });
    // 失败不落库（抛错直接到这里之前就中断）；成功才按字段保存
    try {
      const saved = await store2.saveSessionVars(sessionId, {
        vars: result?.variables ?? snapshot.vars ?? {},
        messageVars: snapshot.messageVars ?? {},
        scriptVars: { ...(snapshot.scriptVars ?? {}), [script.id]: result?.scriptVariables ?? {} },
        expectedVersion: snapshot.version,
      });
      return { ok: true, result: result?.result ?? null, logs: result?.logs ?? [], version: saved.sessions?.[sessionId]?.version ?? null };
    } catch (error) {
      if (error?.code === 'session-vars-conflict') throw Object.assign(new Error(error.message), { status: 409 });
      throw error;
    }
  });

  // ---- 角色卡
  on('GET', '/cards', async () => ({ ok: true, cards: await store.listCards() }));

  on('POST', '/cards', async (req) => {
    const body = await readBody(req);
    const card = normalizeCard(body?.card ?? body);
    await store.saveCard(card);
    return { ok: true, card };
  });

  on('POST', '/cards/import', async (req) => {
    const body = await readBody(req);
    if (body?.pngBase64) {
      const buffer = Buffer.from(String(body.pngBase64), 'base64');
      const { cardFromPng } = await import('./cards.js');
      const card = cardFromPng(buffer);
      if (!card) throw Object.assign(new Error('PNG 里没有 chara / ccv3 元数据'), { status: 400 });
      await store.saveCard(card);
      return { ok: true, card };
    }
    const card = normalizeCard(body?.card ?? body);
    await store.saveCard(card);
    return { ok: true, card };
  });

  on('GET', '/cards/:id/export', async (_req, _res, _url, { id }) => {
    const card = await store.getCard(id);
    if (!card) throw Object.assign(new Error(`没有这张角色卡：${id}`), { status: 404 });
    return { ok: true, card: toStCard(card) };
  });

  on('DELETE', '/cards/:id', async (_req, _res, _url, { id }) => {
    await forgetExtensionOwner(extensionStore,'character',id);
    await store.deleteCard(id);
    return { ok: true };
  });

  // ---- 会话绑定
  on('GET', '/bindings', async () => ({
    ok: true,
    enabled: bindings ? bindings.isEnabled() : true,
    defaults: bindings ? bindings.defaults() : {},
    bindings: bindings ? bindings.toJSON().bindings : {},
  }));

  on('POST', '/bindings', async (req) => {
    const body = await readBody(req);
    if (!bindings) throw Object.assign(new Error('绑定服务不可用'), { status: 501 });
    if (body?.enabled !== undefined && !body?.sessionId) bindings.setEnabled(body.enabled);
    if (body?.defaults) bindings.setDefaults(body.defaults);
    if (body?.sessionId) {
      if (body.remove) bindings.remove(String(body.sessionId));
      else bindings.set(String(body.sessionId), body.binding ?? body);
    }
    await store.saveBindings(bindings.toJSON());
    return { ok: true, enabled: bindings.isEnabled(), defaults: bindings.defaults(), bindings: bindings.toJSON().bindings };
  });

  on('GET', '/sessions', async () => {
    let result = [];
    try {
      result = (typeof listSessions === 'function' ? await listSessions() : []) ?? [];
    } catch { result = []; }
    // collectSessions 返回 { rows, attempts }；旧实现返回数组。这里统一成数组。
    const sessions = Array.isArray(result) ? result : (Array.isArray(result?.rows) ? result.rows : []);
    const attempts = Array.isArray(result?.attempts) ? result.attempts : [];
    return { ok: true, sessions, attempts };
  });

  on('GET', '/world/:id/export', async (_req, _res, _url, { id }) => {
    const world = await store.getWorld(id);
    if (!world) throw Object.assign(new Error(`没有这本世界书：${id}`), { status: 404 });
    return { ok: true, world: toStWorld(world) };
  });

  on('GET', '/preset/:id/export', async (_req, _res, _url, { id }) => {
    const preset = await store.getPreset(id);
    if (!preset) throw Object.assign(new Error(`没有这份预设：${id}`), { status: 404 });
    return { ok: true, preset: toStPreset(preset) };
  });

  on('GET', '/world/:id', async (_req, _res, _url, { id }) => {
    const world = await store.getWorld(id);
    if (!world) throw Object.assign(new Error(`没有这本世界书：${id}`), { status: 404 });
    return { ok: true, world };
  });

  on('POST', '/world/create', async (req) => {
    const body = await readBody(req);
    const name = String(body.name ?? '新世界书');
    const world = normalizeWorld({
      id: slug(body.id ?? name, 'world'),
      name,
      modes: Array.isArray(body.modes) ? body.modes : [],
      entries: [],
    });
    const saved = await store.saveWorld(world);
    return { ok: true, world: saved };
  });

  on('POST', '/world/save', async (req) => {
    const body = await readBody(req);
    const incoming = body.world ?? {};
    if (!incoming.id) throw Object.assign(new Error('缺少 world.id'), { status: 400 });
    const saved = await store.saveWorld({ ...incoming, updatedAt: new Date().toISOString() });
    return { ok: true, world: saved };
  });

  on('POST', '/world/delete', async (req) => {
    const body = await readBody(req);
    await store.deleteWorld(String(body.id ?? ''));
    return { ok: true, worlds: (await store.listWorlds()).map(summaryWorld) };
  });

  on('POST', '/world/import', async (req) => {
    const body = await readBody(req);
    const uploads = collectUploads(body);
    if (!uploads.length) throw Object.assign(new Error('没有解析到可导入的世界书 JSON'), { status: 400 });
    const modes = Array.isArray(body.modes) ? body.modes : [];
    const imported = [];
    for (const upload of uploads) {
      const baseName = String(upload.name ?? 'world.json').replace(/\.json$/i, '');
      const id = slug(String(body.idPrefix ?? baseName), 'world');
      const world = normalizeWorld({ ...(upload.payload ?? {}), id, modes }, id);
      if (!world.name || world.name === id) world.name = baseName;
      imported.push(await store.saveWorld(world));
    }
    return { ok: true, imported: imported.map(summaryWorld), worlds: (await store.listWorlds()).map(summaryWorld) };
  });

  // ------------------------------------------------------------ presets
  on('GET', '/preset/:id', async (_req, _res, _url, { id }) => {
    const preset = await store.getPreset(id);
    if (!preset) throw Object.assign(new Error(`没有这份预设：${id}`), { status: 404 });
    return { ok: true, preset };
  });

  on('POST', '/preset/create', async (req) => {
    const body = await readBody(req);
    const name = String(body.name ?? '新预设');
    const preset = normalizePreset({
      id: slug(body.id ?? name, 'preset'),
      name,
      modes: Array.isArray(body.modes) ? body.modes : [],
      systemPrompt: body.systemPrompt ?? '',
      storyString: body.storyString ?? '',
    });
    const saved = await store.savePreset(preset);
    return { ok: true, preset: saved };
  });

  on('POST', '/preset/save', async (req) => {
    const body = await readBody(req);
    const incoming = body.preset ?? {};
    if (!incoming.id) throw Object.assign(new Error('缺少 preset.id'), { status: 400 });
    const saved = await store.savePreset({ ...incoming, updatedAt: new Date().toISOString() });
    return { ok: true, preset: saved };
  });

  on('POST', '/preset/delete', async (req) => {
    const body = await readBody(req);
    await forgetExtensionOwner(extensionStore,'preset',String(body.id??''));
    await store.deletePreset(String(body.id ?? ''));
    return { ok: true, presets: (await store.listPresets()).map(summaryPreset) };
  });

  on('POST', '/preset/import', async (req) => {
    const body = await readBody(req);
    const uploads = collectUploads(body);
    if (!uploads.length) throw Object.assign(new Error('没有解析到可导入的预设 JSON'), { status: 400 });
    const modes = Array.isArray(body.modes) ? body.modes : [];
    const imported = [];
    for (const upload of uploads) {
      const baseName = String(upload.name ?? 'preset.json').replace(/\.json$/i, '');
      const id = slug(String(body.idPrefix ?? upload.payload?.name ?? baseName), 'preset');
      const preset = normalizePreset({ ...(upload.payload ?? {}), id, modes }, id);
      if (!preset.name || preset.name === id) preset.name = baseName;
      imported.push(await store.savePreset(preset));
    }
    return { ok: true, imported: imported.map(summaryPreset), presets: (await store.listPresets()).map(summaryPreset) };
  });

  // ------------------------------------------------------------ preview
  on('POST', '/preview', async (req) => {
    const body = await readBody(req);
    const saved = await store.loadSettings();
    const settings = { ...saved, ...(body.overrides ?? {}) };
    const mode = String(body.mode ?? '').trim() || lastState().mode || '';
    const result = assemble({
      settings,
      worlds: await store.listWorlds(),
      presets: await store.listPresets(),
      mode,
      scanText: String(body.scanText ?? ''),
      // 预览：跳过概率抽样（等价于概率全部命中），避免与真实请求各自重抽后误称一致
      random: () => 0,
      preview: true,
    });
    return { ok: true, ...result, settings };
  });

  on('GET', '/positions', async () => ({ ok: true, positions: POSITION_LABELS }));

  // ------------------------------------------------------------- 作品 / 生成
  on('GET', '/work/list', async () => ({ ok: true, works: workStore ? await workStore.list() : [] }));

  on('POST', '/work/save', async (req) => {
    if (!workStore) throw Object.assign(new Error('work store 不可用'), { status: 501 });
    const body = await readBody(req);
    try {
      const saved = await workStore.save(body.work ?? body);
      return { ok: true, work: saved };
    } catch (error) {
      throw Object.assign(new Error(String(error?.message ?? error)), { status: 400 });
    }
  });

  on('POST', '/work/delete', async (req) => {
    if (!workStore) throw Object.assign(new Error('work store 不可用'), { status: 501 });
    const body = await readBody(req);
    await workStore.remove(String(body.id ?? ''));
    return { ok: true };
  });

  on('GET', '/work/:id', async (_req, _res, _url, { id }) => {
    if (!workStore) throw Object.assign(new Error('work store 不可用'), { status: 501 });
    const meta = await workStore.load(id);
    if (!meta) throw Object.assign(new Error(`没有这个作品：${id}`), { status: 404 });
    return { ok: true, work: meta, chat: await workStore.chat(id) };
  });

  on('POST', '/work/generate', async (req, res) => {
    if (!workStore || typeof generate !== 'function') throw Object.assign(new Error('生成通道不可用'), { status: 501 });
    const body = await readBody(req);
    // 客户端断开 → 取消上游请求；正常响应结束（writableEnded）不取消
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(new Error('client disconnected')); };
    res.on?.('close', onClose);
    try {
      const result = await generate({
        workId: String(body.workId ?? body.id ?? ''),
        message: String(body.message ?? ''),
        save: body.save !== false,
        signal: controller.signal,
      });
      return { ok: result.ok, ...result };
    } finally {
      res.off?.('close', onClose);
    }
  });

  return async function handle(req, res, url) {
    const pathname = url.pathname.replace(/^\/api\/writing-guide/, '') || '/';
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const params = match(route.pattern, pathname);
      if (!params) continue;
      try {
        const value = await route.handler(req, res, url, params);
        if (res.writableEnded || res.headersSent) return true;
        sendJson(res, 200, value ?? { ok: true });
        return true;
      } catch (error) {
        if (!res.headersSent) sendJson(res, error?.status ?? 500, { ok: false, error: error?.message ?? String(error) });
        else res.end();
        return true;
      }
    }
    return false;
  };
}
