/**
 * 写作指导的数据根：~/.dsh/writing-guide/
 *
 *   worlds/<id>.json    世界书：{ id, name, modes, entries[] }
 *   presets/<id>.json   预设：  { id, name, modes, systemPrompt, storyString, ... }
 *   settings.json       注入设置：目标模式、位置、扫描深度……
 *
 * 这里只做「读写 + 归一化」，命中逻辑在 worldinfo.js，提示词组装在 assemble.js。
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeWorld } from './worldinfo.js';
import { normalizePreset } from './preset.js';
import { DEFAULT_WRITING_MODES, normalizeWritingModes } from './writing-modes.js';

export const DEFAULT_DATA_DIR = path.join(os.homedir(), '.dsh', 'writing-guide');

export const DEFAULT_SETTINGS = {
  enabled: true,
  /** 使用完整写作流程的 DSH 模式；空列表表示不接管任何模式。 */
  writingModes: [...DEFAULT_WRITING_MODES],
  /** 旧系统段追加注入的目标，不能隐式升级为完整写作接管。 */
  targets: ['writer'],
  /** 用哪份预设；'' = 第一份模式命中的预设。 */
  presetId: '',
  /** 参与注入的世界书 id；[] = 全部。 */
  worldIds: [],
  /** 旧系统段兼容设置；正常写作的 @D 位置由消息级组装计划处理。 */
  depthMode: 'prompt',
  scanDepth: 2,
  maxChars: 6000,
  /** 世界书预算（token）；0 = 按 contextWindow × worldBudgetPercent 计算，再不行则不限制。 */
  worldBudgetTokens: 0,
  worldBudgetPercent: 25,
  contextWindow: 0,
  temperature: undefined,
  maxTokens: undefined,
  /** ST 的 world_info_max_recursion_steps（总扫描轮数上限，0 = 不限制）。 */
  maxRecursionSteps: 0,
  header: '',
  /** 作者注：预设里有 authorsNote marker 时用它，没有时按 ST 默认落点 depth 4 / system 插入。 */
  authorNote: '',
  /** 适配器不支持 in-history 时，是否允许把历史后的 system 近似并入顶部（默认不允许）。 */
  degradeOrder: false,
  includePreset: true,
  includeWorlds: true,
  /** 写作模式使用绑定角色卡；这些字段用作全局人设与卡片缺省补充。 */
  vars: {
    user: 'User',
    char: '',
    description: '',
    personality: '',
    scenario: '',
    persona: '',
    examples: '',
  },
};

export function safeJoin(root, ...parts) {
  const base = path.resolve(root);
  const resolved = path.resolve(base, ...parts);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw Object.assign(new Error('路径越界'), { code: 'EWGPATH' });
  }
  return resolved;
}

export function slug(value, fallback = 'item') {
  const cleaned = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 60);
  return cleaned || `${fallback}-${Date.now().toString(36)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function asStringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item ?? '').trim()).filter(Boolean))];
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const vars = source.vars && typeof source.vars === 'object' ? source.vars : {};
  const text = (value, fallback = '') => (typeof value === 'string' ? value : fallback);
  return {
    enabled: source.enabled !== false,
    writingModes: normalizeWritingModes(source.writingModes),
    targets: source.targets === undefined ? [...DEFAULT_SETTINGS.targets] : asStringList(source.targets),
    presetId: typeof source.presetId === 'string' ? source.presetId : '',
    worldIds: asStringList(source.worldIds),
    depthMode: source.depthMode === 'messages' ? 'messages' : 'prompt',
    scanDepth: clampInt(source.scanDepth, 1, 1000, DEFAULT_SETTINGS.scanDepth),
    maxChars: clampInt(source.maxChars, 200, 60000, DEFAULT_SETTINGS.maxChars),
    worldBudgetTokens: clampInt(source.worldBudgetTokens, 0, 1000000, 0),
    worldBudgetPercent: clampInt(source.worldBudgetPercent, 0, 100, 25),
    contextWindow: clampInt(source.contextWindow, 0, 10000000, 0),
    maxRecursionSteps: clampInt(source.maxRecursionSteps, 0, 100, 0),
    temperature: source.temperature != null && source.temperature !== '' && Number.isFinite(Number(source.temperature)) ? Number(source.temperature) : undefined,
    maxTokens: Number.isFinite(Number(source.maxTokens)) ? Number(source.maxTokens) : undefined,
    header: text(source.header, DEFAULT_SETTINGS.header),
    authorNote: text(source.authorNote,''),
    degradeOrder: source.degradeOrder === true,
    includePreset: source.includePreset !== false,
    includeWorlds: source.includeWorlds !== false,
    vars: {
      user: text(vars.user, 'User'),
      char: text(vars.char),
      description: text(vars.description),
      personality: text(vars.personality),
      scenario: text(vars.scenario),
      persona: text(vars.persona),
      examples: text(vars.examples),
    },
  };
}

export class GuideStore {
  constructor(root) {
    this.root = path.resolve(root || DEFAULT_DATA_DIR);
  }

  dir(...parts) {
    return safeJoin(this.root, ...parts);
  }

  get worldsDir() { return this.dir('worlds'); }
  get presetsDir() { return this.dir('presets'); }
  get settingsFile() { return this.dir('settings.json'); }
  worldFile(id) { return this.dir('worlds', `${path.basename(String(id))}.json`); }
  presetFile(id) { return this.dir('presets', `${path.basename(String(id))}.json`); }

  async ensure() {
    await Promise.all([
      mkdir(this.worldsDir, { recursive: true }),
      mkdir(this.presetsDir, { recursive: true }),
    ]);
    return this;
  }

  // ---------------------------------------------------------------- world

  async listWorlds() {
    let files = [];
    try { files = await readdir(this.worldsDir); } catch { return []; }
    const out = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(await readFile(path.join(this.worldsDir, file), 'utf8'));
        out.push(normalizeWorld(raw, file.replace(/\.json$/, '')));
      } catch { /* 坏文件跳过，不让一个文件拖垮整页 */ }
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    return out;
  }

  async getWorld(id) {
    try {
      return normalizeWorld(JSON.parse(await readFile(this.worldFile(id), 'utf8')), String(id));
    } catch {
      return null;
    }
  }

  async saveWorld(world) {
    const normalized = normalizeWorld(world, world?.id);
    await mkdir(this.worldsDir, { recursive: true });
    await writeFile(this.worldFile(normalized.id), `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    return normalized;
  }

  async deleteWorld(id) {
    await rm(this.worldFile(id), { force: true });
    const settings = await this.loadSettings();
    if (settings.worldIds.includes(String(id))) {
      await this.saveSettings({ worldIds: settings.worldIds.filter((item) => item !== String(id)) });
    }
    return true;
  }

  // --------------------------------------------------------------- preset

  async listPresets() {
    let files = [];
    try { files = await readdir(this.presetsDir); } catch { return []; }
    const out = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(await readFile(path.join(this.presetsDir, file), 'utf8'));
        out.push(normalizePreset(raw, file.replace(/\.json$/, '')));
      } catch { /* 同上 */ }
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    return out;
  }

  async getPreset(id) {
    try {
      return normalizePreset(JSON.parse(await readFile(this.presetFile(id), 'utf8')), String(id));
    } catch {
      return null;
    }
  }

  async savePreset(preset) {
    const normalized = normalizePreset(preset, preset?.id);
    await mkdir(this.presetsDir, { recursive: true });
    await writeFile(this.presetFile(normalized.id), `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    return normalized;
  }

  async deletePreset(id) {
    await rm(this.presetFile(id), { force: true });
    const settings = await this.loadSettings();
    if (settings.presetId === String(id)) await this.saveSettings({ presetId: '' });
    return true;
  }

  // ------------------------------------------------------------- settings

  // ------------------------------------------------------------------ card

  get cardsDir() { return path.join(this.root, 'cards'); }

  cardFile(id) { return path.join(this.cardsDir, `${String(id).replace(/[^A-Za-z0-9._-]/g, '_')}.json`); }

  async listCards() {
    let files = [];
    try { files = await readdir(this.cardsDir); } catch { return []; }
    const out = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(await readFile(path.join(this.cardsDir, file), 'utf8'));
        out.push(raw);
      } catch { /* 跳过坏文件 */ }
    }
    return out;
  }

  async getCard(id) {
    try {
      return JSON.parse(await readFile(this.cardFile(id), 'utf8'));
    } catch { return null; }
  }

  async saveCard(card) {
    const id = String(card?.id || '').trim();
    if (!id) throw new Error('角色卡缺少 id');
    await mkdir(this.cardsDir, { recursive: true });
    const normalized = { ...card, id };
    await writeFile(this.cardFile(id), `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    return normalized;
  }

  async deleteCard(id) {
    await rm(this.cardFile(id), { force: true });
    return true;
  }

  async loadBindings() {
    try {
      const raw = JSON.parse(await readFile(path.join(this.root, 'bindings.json'), 'utf8'));
      return raw && typeof raw === 'object' ? raw : { defaultBinding: {}, bindings: {} };
    } catch {
      return { defaultBinding: {}, bindings: {} };
    }
  }

  async saveBindings(state) {
    await mkdir(this.root, { recursive: true });
    await writeFile(path.join(this.root, 'bindings.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return state;
  }

  async loadSettings() {
    try {
      return normalizeSettings(JSON.parse(await readFile(this.settingsFile, 'utf8')));
    } catch {
      return normalizeSettings({});
    }
  }

  async saveSettings(patch) {
    const next = normalizeSettings({ ...(await this.loadSettings()), ...(patch ?? {}) });
    await writeFile(this.settingsFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return next;
  }

  async exists(file) {
    return stat(file).then(() => true).catch(() => false);
  }

  // 同步读：section provider 每次组装都要现读，不能 await。
  readSettingsSync() {
    try {
      return normalizeSettings(JSON.parse(readFileSync(this.settingsFile, 'utf8')));
    } catch {
      return normalizeSettings({});
    }
  }

  readWorldsSync() {
    let files = [];
    try { files = readdirSync(this.worldsDir); } catch { return []; }
    const out = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        out.push(normalizeWorld(JSON.parse(readFileSync(path.join(this.worldsDir, file), 'utf8')), file.replace(/\.json$/, '')));
      } catch { /* 跳过坏文件 */ }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }

  readPresetsSync() {
    let files = [];
    try { files = readdirSync(this.presetsDir); } catch { return []; }
    const out = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        out.push(normalizePreset(JSON.parse(readFileSync(path.join(this.presetsDir, file), 'utf8')), file.replace(/\.json$/, '')));
      } catch { /* 跳过坏文件 */ }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }
}
