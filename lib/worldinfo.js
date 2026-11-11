/**
 * 世界书 / lorebook —— 归一化与命中，语义对齐 SillyTavern。
 *
 * 位置常量与 ST 的 `public/scripts/world-info.js#world_info_position` 一一对应：
 *   before 0 ↑Char    角色定义之前
 *   after  1 ↓Char    角色定义之后
 *   ANTop  2 ↑AT      Author's Note 之前
 *   ANBottom 3 ↓AT    Author's Note 之后
 *   atDepth 4 @D      插进对话倒数第 N 条
 *   EMTop  5 ↑EM      示例对话之前
 *   EMBottom 6 ↓EM    示例对话之后
 *   outlet 7          插座（给别的条目/扩展按名字取用）
 *
 * 命中规则同样照 ST：主键 + constant + selective 次级键 + 概率掷骰 + order 升序。
 */

export const world_info_position = {
  before: 0,
  after: 1,
  ANTop: 2,
  ANBottom: 3,
  atDepth: 4,
  EMTop: 5,
  EMBottom: 6,
  outlet: 7,
};

export const extension_prompt_roles = { system: 0, user: 1, assistant: 2 };
export const ROLE_NAMES = ['system', 'user', 'assistant'];
export const DEFAULT_DEPTH = 4;

/** 名字 ↔ 数字，UI 用名字更好读。 */
export const POSITION_LABELS = [
  { value: 0, key: 'before', label: '↑Char（角色设定之前）' },
  { value: 1, key: 'after', label: '↓Char（角色设定之后）' },
  { value: 2, key: 'ANTop', label: '↑AT（Author\'s Note 之前）' },
  { value: 3, key: 'ANBottom', label: '↓AT（Author\'s Note 之后）' },
  { value: 4, key: 'atDepth', label: '@D（插进对话倒数第 N 条）' },
  { value: 5, key: 'EMTop', label: '↑EM（示例对话之前）' },
  { value: 6, key: 'EMBottom', label: '↓EM（示例对话之后）' },
  { value: 7, key: 'outlet', label: 'outlet（按名字取用）' },
];

const POSITION_ALIASES = {
  before: 0, before_char: 0, '↑char': 0, up_char: 0,
  after: 1, after_char: 1, '↓char': 1, down_char: 1,
  antop: 2, an_top: 2, '↑at': 2,
  anbottom: 3, an_bottom: 3, '↓at': 3,
  atdepth: 4, at_depth: 4, depth: 4, '@d': 4,
  emtop: 5, em_top: 5, '↑em': 5,
  embottom: 6, em_bottom: 6, '↓em': 6,
  outlet: 7,
};

export function normalizePosition(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 0 && value <= 7 ? Math.trunc(value) : 0;
  }
  const key = String(value ?? '').trim().toLowerCase();
  if (key in POSITION_ALIASES) return POSITION_ALIASES[key];
  return 0;
}

export function normalizeRole(value) {
  if (typeof value === 'number' && value >= 0 && value <= 2) return Math.trunc(value);
  const key = String(value ?? '').trim().toLowerCase();
  if (key === 'user' || key === '1') return 1;
  if (key === 'assistant' || key === '2') return 2;
  return 0;
}

function toList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item ?? '')).filter(Boolean);
  if (typeof value === 'string') return value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
  return [];
}

/** 一条世界书条目。字段名同时吃 ST 原样和本插件的写法。 */
export function normalizeEntry(raw, index = 0) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const keys = toList(source.key ?? source.keys ?? source.keywords);
  const secondaryKeys = toList(source.keysecondary ?? source.secondaryKeys ?? source.secondary_keys);
  const probability = Number(source.probability);
  // 未知字段保留在**原层级**（不再套 raw），并清掉会被规范化的旧别名键
  const rest = { ...source };
  for (const alias of ['key', 'keys', 'keywords', 'keysecondary', 'secondaryKeys', 'secondary_keys',
    'disabled', 'disable', 'enabled', 'id', 'raw']) delete rest[alias];
  return {
    ...rest,
    uid: Number.isFinite(Number(source.uid)) ? Number(source.uid) : Number.isFinite(Number(source.id)) ? Number(source.id) : index + 1,
    key: keys,
    keysecondary: secondaryKeys,
    content: String(source.content ?? source.entry ?? ''),
    comment: String(source.comment ?? source.name ?? '').slice(0, 200),
    constant: source.constant === true || source.alwaysOn === true,
    disable: source.disable === true || source.disabled === true || source.enabled === false,
    order: Number.isFinite(Number(source.order)) ? Number(source.order) : 100,
    position: normalizePosition(source.position),
    depth: Number.isFinite(Number(source.depth)) ? Math.max(0, Math.trunc(Number(source.depth))) : DEFAULT_DEPTH,
    role: normalizeRole(source.role),
    probability: Number.isFinite(probability) ? Math.max(0, Math.min(100, Math.trunc(probability))) : 100,
    useProbability: source.useProbability !== false,
    selective: source.selective === true && secondaryKeys.length > 0,
    selectiveLogic: [0, 1, 2, 3].includes(Number(source.selectiveLogic)) ? Number(source.selectiveLogic) : 0,
    matchWholeWords: source.matchWholeWords === true,
    caseSensitive: source.caseSensitive === true,
    excludeRecursion: source.excludeRecursion === true || source.exclude_recursion === true,
    preventRecursion: source.preventRecursion === true || source.prevent_recursion === true,
    /** true = 第 1 轮递归起可用；数字 = 该递归层级起可用（ST delayUntilRecursionLevel）。 */
    delayUntilRecursion: source.delayUntilRecursion ?? source.delay_until_recursion ?? false,
    ignoreBudget: source.ignoreBudget === true || source.ignore_budget === true,
    scanDepth: Number.isFinite(Number(source.scanDepth ?? source.scan_depth))
      ? Math.max(0, Math.trunc(Number(source.scanDepth ?? source.scan_depth)))
      : null,
    outletName: typeof source.outletName === 'string' ? source.outletName : '',
  };
}

/** 一本书。`modes` 为空 = 跟随注入目标模式。 */
export function normalizeWorld(raw, fallbackId = 'world') {
  const source = raw && typeof raw === 'object' ? raw : {};
  const rawEntries = Array.isArray(source.entries)
    ? source.entries
    : source.entries && typeof source.entries === 'object'
      ? Object.values(source.entries)
      : Array.isArray(source)
        ? source
        : [];
  const entries = rawEntries
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry, index) => normalizeEntry(entry, index));
  const id = String(source.id ?? fallbackId ?? 'world');
  const rest = { ...source };
  for (const alias of ['id', 'name', 'title', 'modes', 'entries', 'raw']) delete rest[alias];
  return {
    ...rest,
    id,
    name: String(source.name ?? source.title ?? id),
    modes: Array.isArray(source.modes) ? [...new Set(source.modes.map(String).filter(Boolean))] : [],
    description: typeof source.description === 'string' ? source.description : '',
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : new Date().toISOString(),
    entries,
  };
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matcher(key, options) {
  const body = options.matchWholeWords ? `\\b${escapeRegExp(key)}\\b` : escapeRegExp(key);
  return new RegExp(body, options.caseSensitive ? '' : 'i');
}

const LOGIC = { AND_ANY: 0, NOT_ANY: 1, NOT_ALL: 2, AND_ALL: 3 };

export function entryMatches(entry, text) {
  if (!entry || entry.disable) return false;
  if (entry.constant) return true;
  if (!entry.key.length) return false;
  const options = { matchWholeWords: entry.matchWholeWords, caseSensitive: entry.caseSensitive };
  if (!entry.key.some((key) => key && matcher(key, options).test(text))) return false;
  if (!entry.selective || !entry.keysecondary.length) return true;
  const hits = entry.keysecondary.filter((key) => key && matcher(key, options).test(text)).length;
  switch (entry.selectiveLogic ?? LOGIC.AND_ANY) {
    case LOGIC.NOT_ANY: return hits === 0;
    case LOGIC.NOT_ALL: return hits < entry.keysecondary.length;
    case LOGIC.AND_ALL: return hits === entry.keysecondary.length;
    case LOGIC.AND_ANY:
    default: return hits > 0;
  }
}

/**
 * 命中并把条目分进 ST 的 8 个桶。atDepth 按 (depth, role) 分组，outlet 按名字分组。
 * @param {any} world
 * @param {string} scanText
 * @param {() => number} random 可注入随机源，方便自测
 */
export function activate(world, scanText, random = Math.random) {
  const text = String(scanText ?? '');
  const buckets = {
    before: [],
    after: [],
    ANTop: [],
    ANBottom: [],
    EMTop: [],
    EMBottom: [],
    atDepth: [],
    outlet: {},
  };
  const active = [];
  for (const entry of world?.entries ?? []) {
    if (!entryMatches(entry, text)) continue;
    if (entry.useProbability && entry.probability < 100 && random() * 100 > entry.probability) continue;
    active.push(entry);
  }
  active.sort((a, b) => a.order - b.order || a.uid - b.uid);

  const depthGroups = new Map();
  for (const entry of active) {
    const content = entry.content.trim();
    if (!content) continue;
    switch (entry.position) {
      case world_info_position.before: buckets.before.push(content); break;
      case world_info_position.after: buckets.after.push(content); break;
      case world_info_position.ANTop: buckets.ANTop.push(content); break;
      case world_info_position.ANBottom: buckets.ANBottom.push(content); break;
      case world_info_position.EMTop: buckets.EMTop.push(content); break;
      case world_info_position.EMBottom: buckets.EMBottom.push(content); break;
      case world_info_position.atDepth: {
        const key = `${entry.depth}:${entry.role}`;
        if (!depthGroups.has(key)) depthGroups.set(key, { depth: entry.depth, role: entry.role, entries: [] });
        depthGroups.get(key).entries.push(content);
        break;
      }
      case world_info_position.outlet: {
        const name = entry.outletName || 'default';
        if (!buckets.outlet[name]) buckets.outlet[name] = [];
        buckets.outlet[name].push(content);
        break;
      }
      default: buckets.before.push(content);
    }
  }
  buckets.atDepth = [...depthGroups.values()].sort((a, b) => b.depth - a.depth || b.role - a.role);
  return { all: active, ...buckets };
}

export function countByPosition(entries = []) {
  const counts = new Array(8).fill(0);
  for (const entry of entries) counts[normalizePosition(entry.position)] += 1;
  return counts;
}
