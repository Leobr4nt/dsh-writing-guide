/**
 * 扩展配置存储：writing-guide/extensions.json
 *
 * 分区（互不覆盖，更新必须 merge）：
 *   regex:    { global: RegexScript[] }
 *   template: { enabled: false }            ← 模板模块（由他人实现）
 *   helper:   { enabled: false, scripts: [] } ← 酒馆助手（QuickJS 隔离，由他人实现）
 *   sessions: { <sessionId>: { vars: {} } } ← 会话变量位置
 *
 * 规则：
 *   - 独立于 defaults 与已有会话；不改 settings.json / bindings.json
 *   - 导入的第三方脚本一律 disabled（不自动运行）
 *   - 预设/卡片里的 regex_scripts 只读（不入库）
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

export const EXTENSIONS_VERSION = 1;

const text = (value) => (typeof value === 'string' ? value : '');

export function defaultState() {
  return {
    version: EXTENSIONS_VERSION,
    regex: { global: [] },
    template: { enabled: false },
    helper: { enabled: false, scripts: [] },
    sessions: {},
  };
}

/** 归一化一条正则脚本（保留未知字段，原层级）。 */
export function normalizeRegexScript(source, fallbackId = '') {
  const raw = source && typeof source === 'object' ? source : {};
  const placement = (Array.isArray(raw.placement) ? raw.placement : []).map(Number).filter((value) => Number.isFinite(value));
  return {
    ...raw,
    id: text(raw.id) || fallbackId || `rx-${Math.random().toString(36).slice(2, 10)}`,
    scriptName: text(raw.scriptName ?? raw.name) || '未命名正则',
    findRegex: text(raw.findRegex),
    replaceString: text(raw.replaceString),
    trimStrings: Array.isArray(raw.trimStrings) ? raw.trimStrings.map(text) : [],
    placement,
    disabled: raw.disabled === true,
    markdownOnly: raw.markdownOnly === true,
    promptOnly: raw.promptOnly === true,
    runOnEdit: raw.runOnEdit === true,
    substituteRegex: Number.isFinite(Number(raw.substituteRegex)) ? Number(raw.substituteRegex) : 0,
    minDepth: raw.minDepth != null && raw.minDepth !== '' && Number.isFinite(Number(raw.minDepth)) ? Number(raw.minDepth) : null,
    maxDepth: raw.maxDepth != null && raw.maxDepth !== '' && Number.isFinite(Number(raw.maxDepth)) ? Number(raw.maxDepth) : null,
  };
}

/** 合并状态：缺的分区用默认值补齐，其它分区原样保留。 */
export function mergeState(raw) {
  const base = defaultState();
  const source = raw && typeof raw === 'object' ? raw : {};
  const regex = source.regex && typeof source.regex === 'object' ? source.regex : {};
  const global = Array.isArray(regex.global) ? regex.global
    : (Array.isArray(source.global) ? source.global : []);
  return {
    ...base,
    ...source,
    regex: {
      ...(regex ?? {}),
      global: global.map((script, index) => normalizeRegexScript(script, `g${index + 1}`)),
    },
    template: { ...base.template, ...(source.template ?? {}) },
    helper: { ...base.helper, ...(source.helper ?? {}) },
    sessions: Object.fromEntries(Object.entries({ ...base.sessions, ...(source.sessions ?? {}) }).map(([id, value]) => {
      const entry = value && typeof value === 'object' ? value : {};
      return [id, {
        ...entry,
        vars: entry.vars && typeof entry.vars === 'object' ? entry.vars : {},
        messageVars: entry.messageVars && typeof entry.messageVars === 'object' ? entry.messageVars : {},
        scriptVars: entry.scriptVars && typeof entry.scriptVars === 'object' ? entry.scriptVars : {},
      }];
    })),
  };
}

export class ExtensionStore {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, 'extensions.json');
    /** 串行事务队列：所有写操作排队，避免 RMW 丢分区。 */
    this.queue = Promise.resolve();
  }

  /** 串行执行一次「读-改-写」；fn 返回新状态或 undefined（表示不改）。 */
  update(fn) {
    const run = async () => {
      const current = await this.load();
      const next = await fn(current);
      if (!next) return current;
      return this.save(next);
    };
    const chained = this.queue.then(run, run);
    this.queue = chained.then(() => undefined, () => undefined);
    return chained;
  }

  async load() {
    try {
      return mergeState(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return defaultState();
    }
  }

  async save(state) {
    await mkdir(this.root, { recursive: true });
    const merged = mergeState(state);
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    await rename(tmp, this.file);   // 原子替换
    return merged;
  }

  /** 只改 regex.global，不动其它分区。 */
  async upsert(script, { source = 'global' } = {}) {
    const normalized = normalizeRegexScript(script);
    return this.update((state) => {
      const index = state.regex.global.findIndex((item) => item.id === normalized.id);
      const global = [...state.regex.global];
      if (index >= 0) global[index] = normalized;
      else global.push(normalized);
      return { ...state, regex: { ...state.regex, global, sources: { ...(state.regex.sources ?? {}), [normalized.id]: source } } };
    });
  }

  async remove(id) {
    return this.update((state) => {
      const global = state.regex.global.filter((item) => item.id !== id);
      const sources = { ...(state.regex.sources ?? {}) };
      delete sources[id];
      return { ...state, regex: { ...state.regex, global, sources } };
    });
  }

  async setEnabled(id, enabled) {
    return this.update((state) => {
      const global = state.regex.global.map((item) => (item.id === id ? { ...item, disabled: enabled === false } : item));
      return { ...state, regex: { ...state.regex, global } };
    });
  }

  /** 读会话变量快照（不写）。 */
  async sessionVars(sessionId) {
    const state = await this.load();
    return state.sessions[String(sessionId ?? '')] ?? { vars: {}, messageVars: {}, scriptVars: {}, version: 0 };
  }

  /**
   * 保存会话变量：**替换**语义（不是 merge，删除才能生效）+ 版本 CAS。
   * @param {{vars?:object, messageVars?:object, scriptVars?:object, expectedVersion?:number}} next
   */
  async saveSessionVars(sessionId, next) {
    const id = String(sessionId ?? '');
    return this.update((state) => {
      const current = state.sessions[id] ?? { vars: {}, messageVars: {}, scriptVars: {}, version: 0 };
      if (next?.expectedVersion !== undefined && Number(current.version ?? 0) !== Number(next.expectedVersion)) {
        const error = new Error('会话变量已被其它任务更新，请重试');
        error.code = 'session-vars-conflict';
        throw error;
      }
      const entry = {
        ...current,
        vars: next?.vars ?? current.vars ?? {},
        messageVars: next?.messageVars ?? current.messageVars ?? {},
        scriptVars: next?.scriptVars ?? current.scriptVars ?? {},
        version: Number(current.version ?? 0) + 1,
      };
      if (current.residentState) {
        const residentState = structuredClone(current.residentState);
        residentState.variables ??= {};
        if (next?.vars !== undefined) residentState.variables.chat = structuredClone(next.vars);
        if (next?.scriptVars !== undefined) residentState.variables.scripts = structuredClone(next.scriptVars);
        if (next?.messageVars !== undefined && Number.isInteger(residentState.lastMessageId)) {
          residentState.variables.messages ??= {};
          residentState.variables.messages[residentState.lastMessageId] = structuredClone(next.messageVars);
        }
        entry.residentState = residentState;
      }
      return { ...state, sessions: { ...state.sessions, [id]: entry } };
    });
  }

  /** 模板/助手分区更新（只改自己那一块）。 */
  async updateSection(section, patch) {
    return this.update((state) => ({ ...state, [section]: { ...(state[section] ?? {}), ...(patch ?? {}) } }));
  }
}

/**
 * 执行来源：global → preset → card，**按顺序全部执行**（ST 源码不按 id 跨来源去重）。
 * SPreset.RegexBinding 不参与（因此不会重复执行）。
 */
export function collectRegexSources({ globalScripts = [], preset = null, card = null } = {}) {
  const out = [];
  const push = (raw, source) => {
    for (const script of raw ?? []) out.push({ ...normalizeRegexScript(script, `${source}-${out.length + 1}`), source });
  };
  push(globalScripts, 'global');
  push(preset?.extensions?.regex_scripts, 'preset');
  push(card?.extensions?.regex_scripts, 'card');
  return out;
}
