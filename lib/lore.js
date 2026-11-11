/**
 * 世界书引擎（对齐 SillyTavern release@06bde939fb1e9c4c8d8641d810f0a916b5bce127）
 *
 * 关键源码依据：
 *   world-info.js#L88            sortFn = (a,b) => b.order - a.order（选择优先级；同 order 保持来源顺序）
 *   world-info.js#L69/73/81/82   scanDepth=2 / budget=25% / cap=0 / maxRecursionSteps=0
 *   world-info.js#L337-366       matchKeys：正则优先（flags 自己控制）；完整词多词 = includes，
 *                                单词 = (?:^|\W)(key)(?:$|\W)
 *   world-info.js#L2901-2926     parseRegexFromString：非法正则返回 null（按字面量处理）
 *   world-info.js#L4860          delayUntilRecursion 在**非递归轮**跳过
 *   world-info.js#L4865/4870     递归轮：delay 层级未到跳过；excludeRecursion 跳过
 *   world-info.js#L5080          preventRecursion 的命中**不贡献**递归 buffer
 *   world-info.js#L5097          递归继续条件：有「可用于递归」的新命中
 *   world-info.js#L4943-4977     次级键四种逻辑（NOT_ALL=1, NOT_ANY=2）
 *   world-info.js#L5028-5049     概率：!useProbability 或 probability>=100 直接命中；否则 random()*100 <= p
 *   world-info.js#L855/5204      position 8 桶；@D 用 unshift 后最终按 order 升序
 */
import { world_info_position, DEFAULT_DEPTH, ROLE_NAMES } from './worldinfo.js';

export const world_info_logic = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 };

export const ST_DEFAULTS = {
  scanDepth: 2,
  budgetPercent: 25,
  budgetCap: 0,
  maxRecursionSteps: 0,
  maxScanDepth: 1000,
  depth: DEFAULT_DEPTH,
};

const MAX_RECURSION_ROUNDS = 50;

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** ST 的 parseRegexFromString：格式不合法或 RegExp 抛错都返回 null（按字面量处理）。 */
export function parseRegexKey(raw) {
  const matched = String(raw ?? '').match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
  if (!matched) return null;
  const [, pattern, flags] = matched;
  // 未转义的 / 说明不是我们认可的正则写法
  if (/(^|[^\\])\//.test(pattern)) return null;
  try {
    return new RegExp(pattern.replace('\\/', '/'), flags);
  } catch {
    return null;
  }
}

/**
 * ST 的 matchKeys（world-info.js#L337-366）。
 * 正则：按书写者给的 flags 直接 test，**不**补 i、不做大小写转换。
 * 完整词：多词用 includes，单词用非单词边界（覆盖 C++ 这类符号）。
 */
export function matchKey(text, raw, options = {}) {
  const needleRaw = String(raw ?? '');
  const regex = parseRegexKey(needleRaw);
  if (regex) return regex.test(String(text ?? ''));
  if (!needleRaw) return false;
  const caseSensitive = options.caseSensitive === true || options.matchCase === true;
  const transform = (value) => (caseSensitive ? String(value) : String(value).toLowerCase());
  const haystack = transform(text);
  const needle = transform(needleRaw);
  if (options.matchWholeWords) {
    const words = needle.split(/\s+/).filter(Boolean);
    if (words.length > 1) return haystack.includes(needle);
    try {
      return new RegExp(`(?:^|\\W)(${escapeRegExp(needle)})(?:$|\\W)`).test(haystack);
    } catch {
      return false;
    }
  }
  return haystack.includes(needle);
}

function keysFor(entry) {
  return Array.isArray(entry?.key) ? entry.key : Array.isArray(entry?.keys) ? entry.keys : [];
}

function secondaryFor(entry) {
  return Array.isArray(entry?.keysecondary) ? entry.keysecondary
    : Array.isArray(entry?.secondaryKeys) ? entry.secondaryKeys : [];
}

export function secondaryAllows(entry, text) {
  const secondary = secondaryFor(entry);
  if (!secondary.length) return true;
  const logic = entry.selectiveLogic ?? world_info_logic.AND_ANY;
  let hasAnyMatch = false;
  let hasAllMatch = true;
  for (const key of secondary) {
    const hit = matchKey(text, key, entry);
    if (hit) hasAnyMatch = true;
    if (!hit) hasAllMatch = false;
    if (logic === world_info_logic.AND_ANY && hit) return true;
    if (logic === world_info_logic.NOT_ALL && !hit) return true;
  }
  if (logic === world_info_logic.NOT_ANY && !hasAnyMatch) return true;
  if (logic === world_info_logic.AND_ALL && hasAllMatch) return true;
  return false;
}

export function primaryMatches(entry, text) {
  if (entry?.disable) return false;
  const keys = keysFor(entry);
  if (!keys.length) return false;
  return keys.some((key) => key && matchKey(text, key, entry));
}

export function rollProbability(entry, random = Math.random) {
  if (entry.useProbability === false) return true;
  const probability = Number.isFinite(Number(entry.probability)) ? Number(entry.probability) : 100;
  if (probability >= 100) return true;
  if (probability <= 0) return false;
  return random() * 100 <= probability;
}

function entryKeyOf(book, entry) {
  return `${book.id ?? book.name ?? 'book'}:${entry.uid ?? entry.id ?? 0}`;
}

function contentOf(entry) {
  return String(entry?.content ?? '').trim();
}

/**
 * 递归轮准入（world-info.js#L4860/4865/4870）：
 *   - delayUntilRecursion：初轮一律跳过；递归轮要求当前层级 >= 配置层级
 *   - excludeRecursion：递归轮跳过（ST 的 "exclude from recursion" 指不参与递归扫描）
 */
export function allowsRecursionRound(entry, round, delayLevel = 0) {
  const delay = entry?.delayUntilRecursion;
  if (delay) {
    const level = delay === true ? 1 : Math.max(1, Math.trunc(Number(delay) || 1));
    if (round < level) return false;
  }
  if (round > 0 && entry?.excludeRecursion) return false;
  return true;
}

/**
 * 收集命中。buffer 保留原始扫描文本并**累积**递归内容（ST 的 WorldInfoBuffer.addRecurse）。
 *
 * @param {{books:any[], scanText:string, random?:()=>number, decisions?:Map<string,boolean>, maxRecursionSteps?:number}} input
 */
export function collectHits({ books, scanText, random = Math.random, decisions = new Map(), maxRecursionSteps = 0 }) {
  const ordered = [];
  for (const book of Array.isArray(books) ? books : []) {
    for (const entry of Array.isArray(book?.entries) ? book.entries : []) {
      if (!entry || entry.disable) continue;
      if (entry.uid === undefined) entry.uid = ordered.length + 1;
      ordered.push({ book, entry, key: entryKeyOf(book, entry) });
    }
  }
  // 选择优先级：order 降序；同 order 保持来源顺序（稳定排序，不另加比较键）
  ordered.sort((a, b) => (b.entry.order ?? 100) - (a.entry.order ?? 100));

  const activated = new Map();
  const skipped = [];
  const sourceIndex = new Map(ordered.map((item, index) => [item.key, index]));
  let buffer = String(scanText ?? '');
  const rounds = [];

  for (let round = 0; round <= MAX_RECURSION_ROUNDS; round += 1) {
    if (maxRecursionSteps > 0 && round >= maxRecursionSteps) break;
    const newly = [];
    for (const item of ordered) {
      const { entry, key } = item;
      if (activated.has(key)) continue;
      if (!allowsRecursionRound(entry, round)) {
        if (round === 0 && entry.delayUntilRecursion) skipped.push({ key, reason: '延迟到递归轮' });
        continue;
      }
      // constant：主键/次级键检查之前直接激活（仍走概率）
      const isConstant = entry.constant === true;
      if (!isConstant) {
        if (!primaryMatches(entry, buffer)) continue;
        if (!secondaryAllows(entry, buffer)) {
          skipped.push({ key, reason: '次级键不满足' });
          continue;
        }
      }
      if (!decisions.has(key)) decisions.set(key, rollProbability(entry, random));
      if (decisions.get(key) !== true) {
        skipped.push({ key, reason: '概率未通过' });
        continue;
      }
      activated.set(key, item);
      newly.push(item);
    }
    rounds.push({ round, hits: newly.length });
    if (!newly.length) break;
    // preventRecursion 的命中不参与递归 buffer（world-info.js#L5080）
    const injects = newly.filter((item) => !item.entry.preventRecursion).map((item) => contentOf(item.entry)).filter(Boolean);
    if (!injects.length) break;
    // 累积，不替换
    buffer = `${buffer}\n${injects.join('\n')}`;
  }

  const buckets = {
    before: [], after: [], ANTop: [], ANBottom: [], EMTop: [], EMBottom: [],
    atDepth: [], outlet: {},
  };
  const groups = new Map();
  // 输出顺序：order 升序（同 order 保持来源顺序）
  // ST 最终用 unshift 拼桶：order 升序；同 order 内来源顺序**反转**
  const final = [...activated.values()].sort((a, b) => (a.entry.order ?? 100) - (b.entry.order ?? 100)
    || (sourceIndex.get(b.key) ?? 0) - (sourceIndex.get(a.key) ?? 0));
  for (const item of final) {
    const { entry, book } = item;
    const text = contentOf(entry);
    if (!text) continue;
    const ref = {
      key: item.key,
      book: book.id ?? book.name ?? '',
      uid: entry.uid,
      comment: entry.comment ?? '',
      ignoreBudget: entry.ignoreBudget === true,
      order: entry.order ?? 100,
      text,
    };
    switch (entry.position) {
      case world_info_position.after: buckets.after.push(ref); break;
      case world_info_position.ANTop: buckets.ANTop.push(ref); break;
      case world_info_position.ANBottom: buckets.ANBottom.push(ref); break;
      case world_info_position.EMTop: buckets.EMTop.push(ref); break;
      case world_info_position.EMBottom: buckets.EMBottom.push(ref); break;
      case world_info_position.atDepth: {
        const depth = Number.isFinite(Number(entry.depth)) ? Number(entry.depth) : ST_DEFAULTS.depth;
        const role = ROLE_NAMES[Number.isFinite(Number(entry.role)) ? Number(entry.role) : 0] ?? 'system';
        const groupKey = `${depth}:${role}`;
        if (!groups.has(groupKey)) groups.set(groupKey, { depth, role, order: entry.order ?? 100, refs: [] });
        groups.get(groupKey).refs.push(ref);
        break;
      }
      case world_info_position.outlet: {
        const name = entry.outletName || 'default';
        if (!buckets.outlet[name]) buckets.outlet[name] = [];
        buckets.outlet[name].push(ref);
        break;
      }
      default: buckets.before.push(ref);
    }
  }
  buckets.atDepth = [...groups.values()].sort((a, b) => b.depth - a.depth || b.order - a.order);

  return {
    buckets,
    activated: final,
    decisions,
    rounds,
    skipped,
    count: final.filter((item) => item.entry.position !== world_info_position.outlet).length,
  };
}

/** 预算：单条层面；`ignoreBudget` 必进；选择按 order 降序，输出按 order 升序。 */
export function selectWithinBudget(items, { budget, countTokens, ignoreBudget = (item) => item.ignoreBudget === true }) {
  const orderOf = (item) => Number(item?.order ?? 100);
  const kept = [];
  const omitted = [];
  let used = 0;
  const sorted = [...items].sort((a, b) => orderOf(b) - orderOf(a));
  for (const item of sorted) {
    const tokens = countTokens(item.text);
    if (budget > 0 && !ignoreBudget(item) && used + tokens > budget) {
      omitted.push({ key: item.key, text: item.text, tokens, reason: `超出世界书预算（已用 ${used}/${budget}）` });
      continue;
    }
    kept.push(item);
    if (!ignoreBudget(item)) used += tokens;
  }
  kept.sort((a, b) => orderOf(a) - orderOf(b));
  return { kept, omitted, used };
}
