/**
 * 把组装结果挂到 DSH 的 prompt 流水线上。
 *
 * 只注册一个 section：内容 = 按 ST 的 prompt_order 拼出来的系统提示词。
 * 每次组装 system prompt 都会调 text()，那里现读磁盘、现判模式，
 * 所以面板改完即时生效，只有 section 自身 order 变化需要重新注册。
 */
import {
  HEAD_ORDER,
  SECTION_NAME,
  assemble,
  detectMode,
  modeMatches,
  scanTextFromSession,
} from './assemble.js';

export function createSectionController(ctx, { store, getService }) {
  const state = {
    at: 0,
    source: 'live',
    mode: '',
    injected: false,
    chars: 0,
    charsEstimated: false,
    preset: '',
    presetName: '',
    worlds: [],
    entries: 0,
    depthBlocks: 0,
    depthSupported: false,
    roles: { system: 0, user: 0, assistant: 0 },
    coercedRoles: 0,
    omitted: [],
    order: null,
    reason: '',
    notes: [],
    error: '',
  };
  let disposer = null;
  let currentOrder = null;
  let retry = null;
  let disposed = false;

  const record = (patch) => {
    Object.assign(state, patch, { at: Date.now(), order: currentOrder });
  };

  const promptService = () => {
    try {
      const direct = ctx.systemPrompt;
      if (direct && typeof direct.section === 'function') return direct;
    } catch { /* 代理未注入时点属性会抛 */ }
    try {
      const viaGet = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined;
      if (viaGet && typeof viaGet.section === 'function') return viaGet;
    } catch { /* ignore */ }
    return null;
  };

  const text = (context) => {
    try {
      const settings = store.readSettingsSync();
      const mode = detectMode(context, getService('agentPresets'));
      if (!settings.enabled) {
        record({
          source: 'live', mode, injected: false, chars: 0, preset: '', presetName: '', worlds: [],
          entries: 0, depthBlocks: 0, depthSupported: false, roles: { system: 0, user: 0, assistant: 0 },
          coercedRoles: 0, omitted: [], reason: '未启用', notes: [],
        });
        return '';
      }
      if (!modeMatches(settings.targets, mode)) {
        record({
          source: 'live', mode, injected: false, chars: 0, preset: '', presetName: '', worlds: [],
          entries: 0, depthBlocks: 0, depthSupported: false, roles: { system: 0, user: 0, assistant: 0 },
          coercedRoles: 0, omitted: [], reason: `模式 ${mode || '(未知)'} 不在注入目标里`, notes: [],
        });
        return '';
      }
      // token 估算：优先用宿主的 tokenMeter（仍是估算，不标精确）
      const meter = getService('tokenMeter');
      const countTokens = (text) => {
        try {
          const value = meter?.estimateMessage?.({ role: 'system', content: [{ type: 'text', text: String(text ?? '') }] });
          if (Number.isFinite(value) && value > 0) return value;
        } catch { /* 退回字符估算 */ }
        return Math.max(1, Math.ceil(String(text ?? '').length / 2));
      };
      // 上下文窗口只能来自设置（同步路径不能 await resolveModelInfo）；0 = 不限制世界书预算
      const contextWindow = Number(settings.contextWindow ?? 0) || 0;
      const percent = Number(settings.worldBudgetPercent ?? 25);
      const worldBudgetTokens = Number(settings.worldBudgetTokens ?? 0)
        || (contextWindow > 0 ? Math.max(64, Math.floor((contextWindow * percent) / 100)) : 0);
      const result = assemble({
        settings: { ...settings, worldBudgetTokens },
        worlds: store.readWorldsSync(),
        presets: store.readPresetsSync(),
        mode,
        scanText: scanTextFromSession(context, settings.scanDepth),
        countTokens,
        preview: false,
      });
      record({
        source: 'live',
        mode,
        injected: result.meta.injected,
        chars: result.meta.chars,
        charsEstimated: result.meta.charsEstimated === true,
        preset: result.meta.preset,
        presetName: result.meta.presetName,
        worlds: result.meta.worlds,
        entries: result.meta.entries,
        depthBlocks: result.meta.depthBlocks,
        depthSupported: result.meta.depthSupported,
        roles: result.meta.roles,
        coercedRoles: result.meta.coercedRoles,
        omitted: result.meta.omitted,
        reason: result.meta.reason,
        notes: result.meta.notes ?? [],
        error: '',
      });
      return result.systemText;
    } catch (error) {
      record({ source: 'live', injected: false, chars: 0, reason: 'error', notes: [], error: String(error?.message ?? error) });
      return '';
    }
  };

  const apply = () => {
    // 顺序完全由预设的 prompt_order 决定，section 自身固定在系统提示词最前。
    const order = HEAD_ORDER;
    if (disposer && order === currentOrder) return true;
    const service = promptService();
    if (!service) return false;
    if (disposer) { try { disposer(); } catch { /* ignore */ } disposer = null; }
    currentOrder = order;
    const handle = service.section({ name: SECTION_NAME, order, interpolate: false, text });
    disposer = typeof handle === 'function' ? handle : null;
    return true;
  };

  const mount = () => {
    let ok = false;
    try { ok = apply(); } catch { ok = false; }
    if (ok || retry !== null) return;
    let attempts = 0;
    retry = setInterval(() => {
      attempts += 1;
      let done = false;
      try { done = apply(); } catch { done = false; }
      if (done || attempts >= 40) { clearInterval(retry); retry = null; }
    }, 100);
    try { retry?.unref?.(); } catch { /* ignore */ }
  };
  mount();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (retry !== null) { clearInterval(retry); retry = null; }
    if (disposer) { try { disposer(); } catch { /* ignore */ } disposer = null; }
  };
  if (typeof ctx.effect === 'function') {
    try { ctx.effect(() => dispose); } catch { /* ignore */ }
  }

  return {
    refresh: () => { try { apply(); } catch { /* ignore */ } },
    dispose,
    state: () => ({ ...state, order: currentOrder }),
    get order() { return currentOrder; },
  };
}
