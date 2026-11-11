/**
 * 组装入口（薄封装）：世界书引擎（lore.js）+ 组装计划（plan.js）。
 *
 * 两种消费者：
 *   - 普通 DSH 会话的 section：只能贡献系统提示词 → requestLevel=false，
 *     @D 没有消息级落点，depth 块并入系统段并在 meta.notes 说明（depthSupported=false）
 *   - 本插件自己的写作生成入口：自己构造请求 → requestLevel=true，
 *     @D 直接插进 messages，role 保留（depthSupported=true）
 *
 * 两侧共用同一份「命中 + 计划」，预览与真实请求走同一条代码路径；预览传固定随机源并跳过概率抽样。
 */
import { collectHits } from './lore.js';
import { buildPlan } from './plan.js';
import { orderedPrompts, renderStoryString } from './preset.js';

export const MODE_LABELS = {
  writer: '作家模式',
  standard: '标准模式',
  ptc: 'PTC 模式',
  minimal: '极简模式',
  cordis: '创造模式',
  unrestricted: '无限制模式',
  'unrestricted-child': '无限制模式 · 子任务',
  redteam: '红队模式',
  'redteam-child': '红队模式 · 子任务',
};

export const DEFAULT_TARGET = 'writer';
export const HEAD_ORDER = -99000;
export const TAIL_ORDER = 10150;
export const SECTION_NAME = 'writing-guide';

export function modeLabel(id) {
  const key = String(id ?? '');
  return MODE_LABELS[key] ?? key;
}

export function modeMatches(list, mode) {
  if (!Array.isArray(list) || list.length === 0) return false;
  const id = String(mode ?? '');
  return list.some((item) => item === '*' || String(item) === id);
}

function scopedToMode(scoped, mode) {
  return Array.isArray(scoped) && scoped.length > 0 ? modeMatches(scoped, mode) : true;
}

export function detectMode(context, host) {
  const session = context?.agent?.session;
  const pick = (value) => (typeof value === 'string' ? value.trim() : '');
  let id = '';
  try { id = pick(session?.header?.agentPreset); } catch { /* 代理未注入 */ }
  if (!id) {
    try { id = pick(session?.projectionValues?.agentPreset); } catch { /* ignore */ }
  }
  if (!id) {
    try {
      const events = session?.snapshotEvents?.() ?? [];
      for (let i = events.length - 1; i >= 0; i -= 1) {
        if (events[i]?.type !== 'agent-preset/selected') continue;
        const data = events[i].data ?? {};
        id = pick(data.agentPreset ?? data.preset ?? data.name);
        if (id) break;
      }
    } catch { /* ignore */ }
  }
  if (!id && session) {
    try { id = pick(host?.presetForSession?.(session)); } catch { /* ignore */ }
  }
  if (id) return id;
  try {
    const initiator = host?.currentInitiator?.();
    const ctx2 = initiator?.ctx;
    const composed = ctx2?.agentPresets?.composedPreset?.(ctx2);
    if (typeof composed === 'string' && composed) return composed;
  } catch { /* ignore */ }
  return '';
}

function messageText(message) {
  if (!message) return '';
  if (typeof message === 'string') return message;
  const content = message.content ?? message.mes ?? message.text;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n');
}

/** 最近 depth 条消息（ST 的 world_info_depth 语义：消息条数，不是轮数）。 */
export function scanTextFromSession(context, depth = 2) {
  const session = context?.agent?.session;
  const chunks = [];
  try {
    const events = session?.snapshotEvents?.() ?? [];
    for (const event of events) {
      if (event?.type !== 'user/message' && event?.type !== 'assistant/message') continue;
      const data = event.data ?? {};
      const text = messageText(data.message ?? data);
      if (text.trim()) chunks.push(text);
    }
  } catch { /* 拿不到历史就用空窗口 */ }
  const limit = Math.max(1, Math.min(1000, Math.trunc(Number(depth) || 2)));
  return chunks.slice(-limit).join('\n');
}

export function escapeInterpolation(text) {
  return String(text ?? '').replace(/\{\{/g, '{ {');
}

/**
 * @param {{
 *   settings:any, worlds:any[], presets:any[], mode:string, scanText:string,
 *   random?: () => number, preview?: boolean, requestLevel?: boolean,
 *   conversation?: Array<{role:'user'|'assistant',content:string}>,
 *   countTokens?: (text:string)=>number, decisions?: Map<string,boolean>,
 * }} input
 */
export function assemble({
  settings, worlds, presets, mode, scanText,
  random, preview = false, requestLevel = false,
  conversation = [], countTokens, decisions,
}) {
  const vars = settings?.vars ?? {};
  const notes = [];
  const meta = {
    mode,
    enabled: settings?.enabled === true,
    targetMatched: modeMatches(settings?.targets, mode),
    injected: false,
    preset: '',
    presetName: '',
    worlds: [],
    entries: 0,
    depthBlocks: 0,
    depthSupported: requestLevel,
    requestLevel,
    chars: 0,
    charsEstimated: true,
    roles: { system: 0, user: 0, assistant: 0 },
    coercedRoles: 0,
    omitted: [],
    tokens: 0,
    tokensEstimated: true,
    reason: '',
    notes,
    source: preview ? 'preview' : 'live',
    probabilitySkipped: preview,
  };
  const empty = { systemText: '', messages: [], depthBlocks: [], outlet: {}, meta };
  if (!meta.enabled) { meta.reason = '未启用'; return empty; }
  if (!meta.targetMatched) { meta.reason = `模式 ${mode || '(未知)'} 不在注入目标里`; return empty; }

  const allPresets = Array.isArray(presets) ? presets : [];
  const wanted = settings?.presetId ? allPresets.find((item) => item.id === settings.presetId) : null;
  const fallback = allPresets.find((item) => scopedToMode(item.modes, mode));
  const preset = wanted ?? fallback ?? null;
  if (settings?.presetId && !wanted) { meta.reason = `找不到预设 ${settings.presetId}`; return empty; }
  if (preset && !scopedToMode(preset.modes, mode)) {
    meta.reason = `预设 ${preset.id} 只对其他模式生效`;
    return empty;
  }
  if (preset) {
    meta.preset = preset.id;
    meta.presetName = preset.name;
    for (const warning of preset.warnings ?? []) notes.push(warning);
    if (!orderedPrompts(preset).length) notes.push('预设里没有启用的条目');
  } else if (settings?.includePreset !== false) {
    notes.push('没有可用的预设，只注入世界书');
  }

  // ---- 世界书
  let hits = null;
  if (settings?.includeWorlds !== false) {
    const selected = Array.isArray(settings?.worldIds) && settings.worldIds.length ? new Set(settings.worldIds) : null;
    const picked = [];
    for (const world of Array.isArray(worlds) ? worlds : []) {
      if (selected && !selected.has(world.id)) continue;
      if (!scopedToMode(world.modes, mode)) continue;
      if (!world.entries?.length) continue;
      picked.push(world);
    }
    hits = collectHits({
      books: picked,
      scanText: String(scanText ?? ''),
      random: random ?? Math.random,
      decisions: decisions instanceof Map ? decisions : new Map(),
      maxRecursionSteps: Number(settings?.maxRecursionSteps ?? 0),
    });
    meta.worlds = picked.map((world) => world.id);
    meta.entries = hits.count;
    meta.decisions = Object.fromEntries([...hits.decisions].filter(([, ok]) => ok));
    for (const item of hits.skipped) {
      if (item.reason === '次级键不满足' || item.reason === '概率未通过') continue;
      notes.push(`${item.key}: ${item.reason}`);
    }
  }

  if (!preset && !hits) { meta.reason = '预设与世界书都没有参与'; return empty; }

  const budgetTokens = Number(settings?.worldBudgetTokens ?? 0);
  const plan = buildPlan({
    preset: preset ?? { id: '', name: '', prompts: [], prompt_order: [{ order: [] }] },
    hits: hits ?? { buckets: { before: [], after: [], ANTop: [], ANBottom: [], EMTop: [], EMBottom: [], atDepth: [], outlet: {} }, count: 0 },
    vars,
    authorNote: settings?.authorNote ?? '',
    conversation,
    budgetTokens,
    countTokens,
    maxChars: Number(settings?.maxChars ?? 0),
  });
  for (const note of plan.meta.notes) notes.push(note);

  // ---- 普通会话：@D 没有消息级落点，并入系统段（明确标注）
  let systemText = plan.system;
  if (!requestLevel && plan.depthBlocks.length) {
    meta.depthSupported = false;
    notes.push('DSH 的 llm/stream 对 AgentLoop 请求 deep-frozen，插件只能贡献系统提示词；@D 已并入系统段末尾，不是消息级注入。需要真正 @D 请用本插件的写作生成入口');
    const tail = plan.depthBlocks.map((block) => block.content).filter(Boolean).join('\n');
    if (tail) systemText = systemText ? `${systemText}\n\n${tail}` : tail;
  }

  const header = String(settings?.header ?? '').trim();
  if (header) systemText = systemText ? `${header}\n${systemText}` : header;

  if (!systemText.trim() && !plan.messages.length) {
    meta.reason = meta.omitted.length ? '全部内容超出预算' : '预设与世界书都没有产出内容';
    return empty;
  }

  meta.injected = Boolean(systemText.trim() || plan.messages.length);
  meta.chars = systemText.length;
  meta.charsEstimated = true;
  meta.overMaxChars = plan.meta.overMaxChars === true;
  meta.systemChars = plan.meta.systemChars ?? systemText.length;
  meta.roles = plan.meta.roles;
  meta.coercedRoles = plan.meta.coercedRoles;
  meta.omitted = plan.meta.omitted;
  meta.depthBlocks = plan.depthBlocks.length;
  meta.tokens = plan.meta.tokens;
  meta.tokensEstimated = plan.meta.tokensEstimated;
  meta.reason = 'ok';

  return {
    systemText: escapeInterpolation(systemText),
    messages: plan.messages.map((message) => ({ ...message, content: escapeInterpolation(message.content) })),
    depthBlocks: plan.depthBlocks,
    outlet: plan.outlet,
    meta,
  };
}

export { renderStoryString };
