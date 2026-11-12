/**
 * 会话绑定：sessionId → 写作配置（预设 / 世界书 / 角色卡 / 通道）。
 * 默认配置用于「写作模式」新会话；绑定按 DSH sessionId 隔离，不用"上一次会话"这类全局变量。
 */

import { normalizeRequestTimeoutSeconds } from './request-timeout.js';

export const DEFAULT_BINDING = {
  presetId: '',
  worldIds: [],
  cardId: '',
  provider: 'catiecli',
  model: 'vtx-gemini-4-argon',
  enabled: true,
};

export function normalizeBinding(source) {
  const value = source && typeof source === 'object' ? source : {};
  return {
    presetId: String(value.presetId ?? ''),
    worldIds: Array.isArray(value.worldIds) ? value.worldIds.map(String) : [],
    cardId: String(value.cardId ?? ''),
    provider: String(value.provider ?? DEFAULT_BINDING.provider),
    model: String(value.model ?? DEFAULT_BINDING.model),
    maxTokens: Number.isFinite(Number(value.maxTokens)) ? Number(value.maxTokens) : 0,
    contextWindow: Number.isFinite(Number(value.contextWindow)) ? Number(value.contextWindow) : 0,
    requestTimeoutSeconds: normalizeRequestTimeoutSeconds(value.requestTimeoutSeconds),
    authorNote: typeof value.authorNote === 'string' ? value.authorNote : '',
    worldSelection: ['all', 'selected', 'none'].includes(value.worldSelection)
      ? value.worldSelection
      : (Array.isArray(value.worldIds) && value.worldIds.length ? 'selected' : 'all'),
    useCardBook: value.useCardBook !== false,
    enabled: value.enabled !== false,
  };
}

export function normalizeBindingStore(source) {
  const value = source && typeof source === 'object' ? source : {};
  const bindings = {};
  for (const [sessionId, binding] of Object.entries(value.bindings ?? {})) {
    if (!sessionId) continue;
    bindings[String(sessionId)] = normalizeBinding(binding);
  }
  return {
    enabled: value.enabled !== false,
    defaultBinding: normalizeBinding({ ...DEFAULT_BINDING, ...(value.defaultBinding ?? {}) }),
    bindings,
  };
}

/** 内存缓存：waterfall 只能在同步阶段判定绑定。 */
export class BindingCache {
  constructor(state) {
    this.state = normalizeBindingStore(state);
  }

  get(sessionId) {
    const id = String(sessionId ?? '');
    if (!id) return null;
    return this.state.bindings[id] ?? null;
  }

  /** 写作模式的默认绑定（用于没有显式绑定的新会话）。 */
  defaults() {
    return this.state.defaultBinding;
  }

  replace(state) {
    this.state = normalizeBindingStore(state);
    return this.state;
  }

  set(sessionId, binding) {
    const id = String(sessionId ?? '');
    if (!id) throw new Error('缺少 sessionId');
    this.state.bindings[id] = normalizeBinding(binding);
    return this.state.bindings[id];
  }

  remove(sessionId) {
    const id = String(sessionId ?? '');
    const had = Boolean(this.state.bindings[id]);
    delete this.state.bindings[id];
    return had;
  }

  isEnabled() {
    return this.state.enabled !== false;
  }

  setEnabled(value) {
    this.state.enabled = value !== false;
    return this.state.enabled;
  }

  setDefaults(binding) {
    this.state.defaultBinding = normalizeBinding({ ...this.state.defaultBinding, ...binding });
    return this.state.defaultBinding;
  }

  /** 存盘用的纯对象。 */
  toJSON() {
    return this.state;
  }
}
