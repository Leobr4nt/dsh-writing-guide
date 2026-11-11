/**
 * 组装计划：预设 prompt_order + 世界书 8 桶 → 真正的请求形状。
 *
 *   1. 完整消息顺序按 prompt_order 保留（system/user/assistant 相对位置不搬动，PHI 在历史之后）。
 *   2. @D / ABSOLUTE 只作用于 chatHistory 展开的对话块，再放回完整顺序。
 *   3. 世界书位置只由各自 marker 决定；marker 禁用/缺失不注入，只在 meta.unplaced 报告。
 *   4. 预算只做在世界书单条层面（order 降序选、升序输出）；字符上限只报告不切断。
 */
import { insertAtDepth } from './depth.js';
import { selectWithinBudget } from './lore.js';
import { orderedPrompts, renderStoryString, SUPPORTED_MARKERS, defaultPrompts } from './preset.js';

export const MARKER_LABELS = {
  worldInfoBefore: '世界书 ↑Char',
  worldInfoAfter: '世界书 ↓Char',
  charDescription: '角色描述',
  charPersonality: '角色性格',
  scenario: '场景',
  personaDescription: '角色人设',
  dialogueExamples: '示例对话',
  chatHistory: '聊天记录',
  authorsNote: '作者注',
};

export const AUTHOR_NOTE_DEFAULT = { depth: 4, role: 'system' };

const defaultCountTokens = (text) => Math.max(1, Math.ceil(String(text ?? '').length / 4));

export function buildPlan({
  preset,
  hits,
  vars = {},
  authorNote = '',
  conversation = [],
  budgetTokens = 0,
  countTokens = defaultCountTokens,
  maxChars = 0,
  includePostHistoryInSystem = false,
  /** 角色卡示例对话：在 dialogueExamples marker 处展开为独立 user/assistant 消息（不占 @D 历史深度）。 */
  exampleMessages = [],
  /** 适配器不支持 in-history 时，把「历史之前」的多条 system 合成一条（不丢内容，只去边界）。 */
  mergeSystem = false,
}) {
  const unknown = new Set();
  const notes = [];
  const meta = {
    preset: preset?.id ?? '',
    presetName: preset?.name ?? '',
    entries: hits?.count ?? 0,
    depthBlocks: 0,
    roles: { system: 0, user: 0, assistant: 0 },
    coercedRoles: 0,
    omitted: [],
    unplaced: [],
    tokens: 0,
    tokensEstimated: countTokens === defaultCountTokens,
    systemChars: 0,
    overMaxChars: false,
    notes,
    probability: hits?.decisions ? Object.fromEntries([...hits.decisions].filter(([, ok]) => ok)) : {},
  };

  const buckets = hits?.buckets ?? {
    before: [], after: [], ANTop: [], ANBottom: [], EMTop: [], EMBottom: [], atDepth: [], outlet: {},
  };

  const allWorldItems = [
    ...buckets.before, ...buckets.after, ...buckets.ANTop, ...buckets.ANBottom,
    ...buckets.EMTop, ...buckets.EMBottom, ...buckets.atDepth.flatMap((group) => group.refs),
  ];
  const budgetResult = selectWithinBudget(allWorldItems, {
    budget: budgetTokens,
    countTokens,
    ignoreBudget: (item) => Boolean(item.ignoreBudget),
  });
  const keep = new Set(budgetResult.kept.map((item) => item.key));
  meta.omitted = budgetResult.omitted.map((item) => ({ label: item.key, chars: item.text.length, reason: item.reason }));
  if (meta.omitted.length) {
    notes.push(`世界书超出预算，整条省略 ${meta.omitted.length} 条（${meta.omitted.map((item) => item.label).join('、')}）`);
  }
  const keepRefs = (list) => list.filter((ref) => keep.has(ref.key)).map((ref) => ref.text).filter(Boolean).join('\n');
  const keepDepthGroups = buckets.atDepth
    .map((group) => ({ ...group, refs: group.refs.filter((ref) => keep.has(ref.key)) }))
    .filter((group) => group.refs.length);

  // 预设被关闭/为空时使用默认 marker 布局：世界书与对话仍然生效（不是"关掉一切"）
  let prompts = orderedPrompts(preset);
  if (!prompts.length) {
    prompts = defaultPrompts();
    notes.push('没有启用的预设条目，使用默认 marker 布局（世界书/历史仍生效）');
  }
  const anText = String(authorNote ?? '').trim();
  const hasAuthorsNote = prompts.some((prompt) => prompt.identifier === 'authorsNote');

  const seq = [];
  const depthBlocks = [];
  const consumed = new Set();
  const pushText = (label, raw, role) => {
    const text = renderStoryString(String(raw ?? ''), vars, unknown).trim();
    if (!text) return;
    seq.push({ kind: 'text', label, role, text });
  };
  const pushWorld = (key, label) => {
    if (consumed.has(key)) return;
    consumed.add(key);
    const text = keepRefs(buckets[key]);
    if (text) seq.push({ kind: 'text', label, role: 'system', text });
  };

  for (const prompt of prompts) {
    const id = prompt.identifier;
    switch (id) {
      case 'worldInfoBefore':
        pushWorld('before', MARKER_LABELS.worldInfoBefore);
        if (!hasAuthorsNote) pushWorld('ANTop', '世界书 ↑AT');
        break;
      case 'worldInfoAfter':
        pushWorld('after', MARKER_LABELS.worldInfoAfter);
        if (!hasAuthorsNote) pushWorld('ANBottom', '世界书 ↓AT');
        break;
      case 'authorsNote':
        pushWorld('ANTop', '世界书 ↑AT');
        pushText('作者注', prompt.content || anText, 'system');
        pushWorld('ANBottom', '世界书 ↓AT');
        break;
      case 'dialogueExamples':
        pushWorld('EMTop', '世界书 ↑EM');
        pushText('示例对话', prompt.content, prompt.role);
        if (Array.isArray(exampleMessages) && exampleMessages.length) {
          seq.push({ kind: 'messages', label: 'examples', rows: exampleMessages.map((row) => ({ role: row.role, content: row.content })) });
        } else if (vars.examples) {
          pushText('{{examples}}', vars.examples, 'system');
        }
        pushWorld('EMBottom', '世界书 ↓EM');
        break;
      case 'charDescription':
        if (vars.description) pushText('{{description}}', vars.description, 'system');
        break;
      case 'charPersonality':
        if (vars.personality) pushText('{{personality}}', vars.personality, 'system');
        break;
      case 'scenario':
        if (vars.scenario) pushText('{{scenario}}', vars.scenario, 'system');
        break;
      case 'personaDescription':
        if (vars.persona) pushText('{{persona}}', vars.persona, 'system');
        break;
      case 'chatHistory':
        seq.push({ kind: 'chat' });
        break;
      default: {
        if (id.startsWith('outlet:')) {
          const name = id.slice('outlet:'.length);
          const list = (buckets.outlet?.[name] ?? []).filter((ref) => keep.has(ref.key));
          if (list.length) pushText(`outlet:${name}`, list.map((ref) => ref.text).join('\n'), 'system');
          break;
        }
        if (prompt.marker) {
          if (!SUPPORTED_MARKERS.has(id)) notes.push(`marker「${id}」不被支持，已跳过`);
          break;
        }
        if (prompt.injection_position === 1) {
          const text = renderStoryString(prompt.content, vars, unknown).trim();
          if (text) depthBlocks.push({ depth: prompt.injection_depth, role: prompt.role, order: prompt.injection_order, content: text, source: `preset:${id}` });
          break;
        }
        pushText(id, prompt.content, prompt.role);
        break;
      }
    }
  }

  if (anText && !hasAuthorsNote) {
    depthBlocks.push({ ...AUTHOR_NOTE_DEFAULT, order: 100, content: anText, source: 'authorNote' });
    notes.push(`作者注没有 authorsNote marker，按 ST 的默认落点插入：depth=${AUTHOR_NOTE_DEFAULT.depth} role=${AUTHOR_NOTE_DEFAULT.role}`);
  }
  if (!hasAuthorsNote && (buckets.ANTop.length || buckets.ANBottom.length)) {
    notes.push("预设里没有 Author's Note 条目，世界书 ANTop/ANBottom 已按 ↑Char/↓Char 位置并入");
  }

  const unplaced = ['before', 'after', 'ANTop', 'ANBottom', 'EMTop', 'EMBottom']
    .filter((key) => !consumed.has(key) && buckets[key]?.length);
  if (unplaced.length) {
    meta.unplaced = unplaced;
    notes.push(`世界书位置未注入（预设里没有对应 marker 或已禁用）：${unplaced.join(', ')} —— 按预设配置保留未生效`);
  }

  for (const group of keepDepthGroups) {
    depthBlocks.push({
      depth: group.depth,
      role: group.role,
      order: group.order ?? 100,
      content: group.refs.map((ref) => ref.text).join('\n'),
      source: 'worldinfo',
    });
  }
  depthBlocks.sort((a, b) => b.depth - a.depth || a.order - b.order);
  meta.depthBlocks = depthBlocks.length;

  const outlets = Object.keys(buckets.outlet ?? {});
  if (outlets.length) notes.push(`outlet 条目已收集（${outlets.join(', ')}），本插件不自动消费（可通过 outlet 文本接口取用）`);

  const conversationMessages = (Array.isArray(conversation) ? conversation : [])
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant') && String(message.content ?? '').trim())
    .map((message) => ({ role: message.role, content: String(message.content) }));

  const hasChatMarker = seq.some((item) => item.kind === 'chat');
  if (!hasChatMarker && (conversationMessages.length || depthBlocks.length)) {
    seq.push({ kind: 'chat' });
    notes.push('预设没有 chatHistory marker，对话/深度内容按默认位置（末尾）插入');
  }

  let historyBlock;
  if (depthBlocks.length && conversationMessages.length) {
    historyBlock = insertAtDepth(
      conversationMessages,
      depthBlocks.map((block) => ({ depth: block.depth, role: block.role, order: block.order, content: block.content })),
    );
  } else if (depthBlocks.length) {
    historyBlock = depthBlocks
      .slice()
      .sort((a, b) => b.depth - a.depth || a.order - b.order)
      .map((block) => ({ role: block.role, content: block.content }));
    notes.push('没有对话历史，深度条目按 depth 顺序放在 chatHistory 位置（不是真实深度插入）');
  } else {
    historyBlock = conversationMessages;
  }

  const messages = [];
  for (const item of seq) {
    if (item.kind === 'chat') messages.push(...historyBlock);
    else if (item.kind === 'messages') messages.push(...item.rows.map((row) => ({ role: row.role, content: row.content })));
    else messages.push({ role: item.role, content: item.text });
  }
  const depthContents = new Set(depthBlocks.map((block) => block.content));
  if (depthContents.size && !messages.some((message) => depthContents.has(message.content))) {
    messages.push(...depthBlocks.map((block) => ({ role: block.role, content: block.content })));
    notes.push('深度条目没有找到 chatHistory 插入点，已追加到消息末尾');
  }

  // 历史之后的 system 条目数：非 in-history 适配器无法表达它们的位置
  const chatPos = seq.findIndex((item) => item.kind === 'chat');
  meta.postHistorySystemCount = chatPos === -1
    ? 0
    : seq.slice(chatPos + 1).filter((item) => item.kind === 'text' && item.role === 'system').length;

  if (mergeSystem) {
    const firstNonSystem = messages.findIndex((message) => message.role !== 'system');
    const headEnd = firstNonSystem === -1 ? messages.length : firstNonSystem;
    if (headEnd > 1) {
      const head = messages.slice(0, headEnd);
      messages.splice(0, headEnd, { role: 'system', content: head.map((message) => message.content).join('\n\n') });
      meta.systemMerged = true;
      notes.push(`适配器不支持 in-history，已把 ${head.length} 条前置 system 合并为一条（内容顺序不变）`);
    }
  }

  for (const message of messages) meta.roles[message.role] = (meta.roles[message.role] ?? 0) + 1;

  const chatAt = seq.findIndex((item) => item.kind === 'chat');
  const beforeChat = chatAt === -1 ? seq : seq.slice(0, chatAt);
  const afterChat = chatAt === -1 ? [] : seq.slice(chatAt + 1);
  const systemParts = beforeChat.filter((item) => item.kind === 'text' && item.role === 'system').map((item) => item.text);
  const postHistory = afterChat.filter((item) => item.kind === 'text' && item.role === 'system');
  if (postHistory.length) {
    if (includePostHistoryInSystem) {
      systemParts.push(...postHistory.map((item) => item.text));
      notes.push(`普通会话：历史之后的 ${postHistory.length} 条内容被并入系统提示词末尾（位置不等于 ST 的 post-history）`);
    } else {
      notes.push(`历史之后的 ${postHistory.length} 条内容不进入系统段（生成入口里它们是历史之后的消息）`);
    }
  }

  let system = systemParts.join('\n\n');
  meta.systemChars = system.length;
  if (maxChars > 0 && system.length > maxChars) {
    meta.overMaxChars = true;
    notes.push(`系统段 ${system.length} 字符超过上限 ${maxChars}，未截断（按整条保留，请调大上限或删除条目）`);
  }
  if (unknown.size) notes.push(`未执行的宏（原样保留）：${[...unknown].map((name) => `{{${name}}}`).join(' ')}`);

  // 不重复计算：messages 已包含 system 文本；只有 section 路径（messages 为空）才按 systemParts 统计
  const depthTokens = depthBlocks.reduce((sum, block) => sum + countTokens(block.content), 0);
  meta.tokens = messages.length
    ? messages.reduce((sum, message) => sum + countTokens(message.content), 0)
    : systemParts.reduce((sum, text) => sum + countTokens(text), 0) + depthTokens;

  return {
    system,
    messages,
    depthBlocks,
    outlet: buckets.outlet ?? {},
    meta: { ...meta, injected: Boolean(system.trim() || messages.length), notes },
  };
}
