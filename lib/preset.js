import { auditPreset } from './preset-audit.js';
/**
 * 预设 —— 数据结构对齐 SillyTavern 的 Prompt Manager。
 *
 * 一个预设 = `prompts[]`（每条一个可启停的提示词/占位符）+ `prompt_order[]`（渲染顺序）。
 * marker 条目本身不出字，只标记「世界书 / 角色卡字段 / 示例对话 / 聊天记录」这些外部内容插在哪。
 *
 * 与 ST 一致的常量：
 *   injection_position: 0 = RELATIVE（跟着 prompt_order 走）、1 = ABSOLUTE（按 depth 插消息）
 *   role: system / user / assistant
 */

export const INJECTION_POSITION = { RELATIVE: 0, ABSOLUTE: 1 };
export const ROLES = ['system', 'user', 'assistant'];

/**
 * ST 的 marker 标识符；这些条目不产生文字，只占位。
 * 注意 `main` 不在此列：它在 ST 里也是可排序条目，但本身有内容。
 */
export const MARKER_IDENTIFIERS = new Set([
  'worldInfoBefore',
  'worldInfoAfter',
  'charDescription',
  'charPersonality',
  'scenario',
  'personaDescription',
  'dialogueExamples',
  'chatHistory',
]);

/** ST 默认预设的条目清单（顺序即 ST 的 prompt_order）。 */
export function defaultPrompts() {
  return [
    { identifier: 'main', name: '主提示词', system_prompt: true, role: 'system', content: '', marker: false },
    { identifier: 'worldInfoBefore', name: '世界书 ↑Char', system_prompt: true, role: 'system', content: '', marker: true },
    { identifier: 'charDescription', name: '角色描述', system_prompt: true, role: 'system', content: '', marker: true },
    { identifier: 'charPersonality', name: '角色性格', system_prompt: true, role: 'system', content: '', marker: true },
    { identifier: 'scenario', name: '场景', system_prompt: true, role: 'system', content: '', marker: true },
    { identifier: 'worldInfoAfter', name: '世界书 ↓Char', system_prompt: true, role: 'system', content: '', marker: true },
    { identifier: 'dialogueExamples', name: '示例对话', system_prompt: true, role: 'system', content: '', marker: true },
    { identifier: 'chatHistory', name: '聊天记录', system_prompt: true, role: 'system', content: '', marker: true },
    { identifier: 'jailbreak', name: '越狱 / 后置指令（PHI）', system_prompt: true, role: 'system', content: '', marker: false },
  ];
}

function toContent(value) {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function normalizePrompt(raw, index) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const identifier = String(source.identifier ?? source.id ?? `prompt_${index + 1}`);
  const marker = source.marker === true || MARKER_IDENTIFIERS.has(identifier);
  const position = Number(source.injection_position);
  const depth = Number(source.injection_depth);
  const order = Number(source.injection_order);
  const rest = { ...source };
  for (const alias of ['identifier', 'id', 'name', 'content', 'marker', 'role', 'system_prompt',
    'injection_position', 'injection_depth', 'injection_order', 'raw']) delete rest[alias];
  return {
    ...rest,
    identifier,
    name: String(source.name ?? identifier),
    system_prompt: source.system_prompt !== false,
    role: ROLES.includes(String(source.role)) ? String(source.role) : 'system',
    content: marker ? '' : toContent(source.content),
    marker,
    injection_position: position === INJECTION_POSITION.ABSOLUTE ? INJECTION_POSITION.ABSOLUTE : INJECTION_POSITION.RELATIVE,
    injection_depth: Number.isFinite(depth) ? Math.max(0, Math.trunc(depth)) : 4,
    injection_order: Number.isFinite(order) ? Math.trunc(order) : 100,
  };
}

/** 旧格式（systemPrompt / storyString / jailbreak）→ ST 的 prompts + prompt_order。 */
function migrateLegacy(payload) {
  const prompts = defaultPrompts();
  const byId = new Map(prompts.map((prompt) => [prompt.identifier, prompt]));
  const system = toContent(payload.systemPrompt ?? payload.system_prompt ?? payload.content);
  if (system.trim()) byId.get('main').content = system;
  const jailbreak = toContent(payload.jailbreak ?? payload.postHistoryInstructions ?? payload.post_history_instructions);
  if (jailbreak.trim()) byId.get('jailbreak').content = jailbreak;
  const story = toContent(payload.storyString ?? payload.story_string);
  const extra = [];
  if (story.trim()) {
    extra.push({
      identifier: 'storyString',
      name: 'story string（旧字段）',
      system_prompt: true,
      role: 'system',
      content: story,
      marker: false,
    });
  }
  return { prompts, extra };
}

/**
 * 预设归一化。吃 ST 的预设 JSON（prompts + prompt_order）、旧版本插件格式、或整份酒馆 settings.json。
 *
 * 严格按 ST 的 prompt_order 执行：**没出现在 order 里的 prompt 不执行**（ST 也不显示它们），
 * 这些条目和 order 里已失效的 identifier 都会记进 warnings，交给 UI 明确提示。
 */
export function normalizePreset(raw, fallbackId = 'preset') {
  const payload = raw && typeof raw === 'object' ? raw : {};
  const warnings = [];
  const rest = { ...payload };
  for (const key of ['id', 'uploadId', 'name', 'title', 'modes', 'description', 'prompts', 'prompt_order',
    'raw', 'updatedAt']) delete rest[key];
  const base = {
    ...rest,
    id: String(payload.id ?? payload.uploadId ?? fallbackId ?? 'preset'),
    name: String(payload.name ?? payload.title ?? fallbackId ?? 'preset'),
    modes: Array.isArray(payload.modes) ? [...new Set(payload.modes.map(String).filter(Boolean))] : [],
    description: toContent(payload.description),
    updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : new Date().toISOString(),
  };

  let prompts;
  if (Array.isArray(payload.prompts) && payload.prompts.length) {
    prompts = payload.prompts.map((prompt, index) => normalizePrompt(prompt, index));
  } else {
    const migrated = migrateLegacy(payload);
    // storyString 这类旧字段紧跟 main 之后，别落到末尾
    prompts = [...migrated.prompts.slice(0, 1), ...migrated.extra, ...migrated.prompts.slice(1)];
    warnings.push('旧格式已迁移成 prompts + prompt_order（main / jailbreak / storyString）');
  }

  // 同 identifier 重复出现时只保留第一条（历史迁移曾产生重复）
  const seenIds = new Set();
  const deduped = [];
  for (const prompt of prompts) {
    if (seenIds.has(prompt.identifier)) {
      warnings.push(`条目「${prompt.identifier}」重复，已保留第一条`);
      continue;
    }
    seenIds.add(prompt.identifier);
    deduped.push(prompt);
  }
  prompts = deduped;

  // 记录本插件不执行的 ST 字段（Text Completion 侧的 instruct 序列）
  const instruct = payload.instruct ?? payload.prompt?.instruct;
  if (instruct && typeof instruct === 'object') {
    const sequences = ['input_sequence', 'inputSequence', 'output_sequence', 'outputSequence',
      'system_sequence', 'systemSequence', 'stop_sequence', 'stopSequence'];
    if (sequences.some((key) => typeof instruct[key] === 'string' && instruct[key].trim())) {
      warnings.push('预设里的 instruct 序列（input/output/system/stop）未执行：本插件只做 Chat Completion 组装，不插 Text Completion 分隔符');
    }
  }

  const byId = new Map(prompts.map((prompt) => [prompt.identifier, prompt]));
  for (const prompt of prompts) {
    if (prompt.marker && !SUPPORTED_MARKERS.has(prompt.identifier)) {
      warnings.push(`marker「${prompt.identifier}」不被支持，已保留未执行`);
    }
  }

  const rawOrders = Array.isArray(payload.prompt_order) ? payload.prompt_order : [];
  const seen = new Set();
  const order = [];
  const dropped = [];
  for (const group of rawOrders) {
    for (const row of Array.isArray(group?.order) ? group.order : []) {
      const identifier = String(row?.identifier ?? '');
      if (!identifier || seen.has(identifier)) continue;
      seen.add(identifier);
      if (!byId.has(identifier)) { dropped.push(identifier); continue; }
      order.push({ identifier, enabled: row?.enabled !== false });
    }
  }
  if (dropped.length) warnings.push(`prompt_order 引用了不存在的条目：${dropped.join(', ')}（已忽略）`);

  // 严格按 order：prompts 里没被 order 列出的条目不执行
  const unlisted = prompts.filter((prompt) => !seen.has(prompt.identifier)).map((prompt) => prompt.identifier);
  if (unlisted.length && rawOrders.length) {
    warnings.push(`未出现在 prompt_order 里的条目不会执行：${unlisted.join(', ')}`);
  }
  if (!rawOrders.length) {
    // 完全没有 prompt_order（例如手写的 prompts 数组）：按 prompts 顺序生成一份，并说明
    for (const prompt of prompts) order.push({ identifier: prompt.identifier, enabled: true });
    warnings.push('预设没有 prompt_order，已按 prompts 顺序生成一份');
  }

  return {
    ...base,
    prompts,
    prompt_order: [{ character_id: Number(rawOrders[0]?.character_id ?? 100000), order }],
    /** 原样保留，注入不读取；给以后接生成参数留位置。 */
    settings: payload.settings && typeof payload.settings === 'object' ? payload.settings : {},
    warnings,
    compat: auditPreset({ ...payload, prompts, prompt_order: [{ order }] }),
  };
}

/** 本插件真正会展开的 marker；其余 marker 保留但明确提示未执行。 */
export const SUPPORTED_MARKERS = new Set([
  'worldInfoBefore',
  'worldInfoAfter',
  'charDescription',
  'charPersonality',
  'scenario',
  'personaDescription',
  'dialogueExamples',
  'chatHistory',
  'authorsNote',
]);

export function orderedPrompts(preset) {
  if (!preset) return [];
  const byId = new Map((preset.prompts ?? []).map((prompt) => [prompt.identifier, prompt]));
  const order = preset.prompt_order?.[0]?.order ?? [];
  const out = [];
  for (const row of order) {
    if (!row.enabled) continue;
    const prompt = byId.get(row.identifier);
    if (prompt) out.push(prompt);
  }
  return out;
}

/** 取某条提示词（不论是否启用）。 */
export function promptByIdentifier(preset, identifier) {
  return (preset?.prompts ?? []).find((prompt) => prompt.identifier === identifier) ?? null;
}

/**
 * 酒馆 story string 的 handlebars 子集。
 *
 * 宏规则：先处理名字/条件；`vars` 里没有的原样保留。
 * random/getvar 等数据宏由 plan 的后续阶段执行，其余未知宏供 UI 提示。
 */
export function renderStoryString(template, vars, unknown) {
  if (!template) return '';
  // Normalize legacy markers before matching curly macros so a marker inside
  // {{setvar::key::<user>}} is expanded before the assignment is evaluated.
  let out = String(template).replace(/<(user|char|bot)>/gi, (_match,name)=>name.toLowerCase()==='user'?'{{user}}':'{{char}}');
  const blocks = /\{\{#(if|unless)\s+([A-Za-z0-9_]+)\s*\}\}([\s\S]*?)\{\{\/\1\}\}/g;
  for (let guard = 0; guard < 20 && blocks.test(out); guard += 1) {
    out = out.replace(blocks, (_all, kind, key, body) => {
      const [whenTrue, whenFalse = ''] = body.split(/\{\{else\}\}/);
      const truthy = Boolean(vars[key]);
      return (kind === 'if' ? truthy : !truthy) ? whenTrue : whenFalse;
    });
    blocks.lastIndex = 0;
  }
  out = out.replace(/\{\{trim\}\}/gi, '');
  return out.replace(/\{\{([^{}]+)\}\}/g, (all, key) => {
    const name = String(key).trim();
    const builtin = name.toLowerCase();
    if (['user','char'].includes(builtin) && Object.prototype.hasOwnProperty.call(vars,builtin)) return String(vars[builtin] ?? '');
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      const value = vars[name];
      return value === undefined || value === null ? '' : String(value);
    }
    if (unknown) unknown.add(name);
    return all;
  });
}
