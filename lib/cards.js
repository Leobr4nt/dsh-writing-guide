import { exportHelperFields } from './helper-export.js';
/**
 * 角色卡：ST Character Card v1 / v2 / v3 + PNG `chara`/`ccv3` tEXt。
 *
 * 幂等：`normalizeCard` 同时接受 ST 原始结构（spec+data / v1 顶层）与内部结构，
 * 因此「保存 → 读取 → 再归一化」不会丢字段。
 *
 * 层级：ST 顶层未知字段进 `outer`，data 内未知字段进 `custom`，导出时各回各层。
 * 导出：`toStCard` 输出真正的 v2/v3（`character_book` 转回 keys/insertion_order/enabled/extensions）。
 */
import { normalizeEntry } from './worldinfo.js';

const MAX_PNG_BYTES = 20 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const text = (value) => (typeof value === 'string' ? value : '');
const asArray = (value, label) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  return value;
};

/** ST 顶层字段 */
const ST_TOP = new Set(['spec', 'spec_version', 'data', 'name', 'description', 'personality', 'scenario',
  'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions',
  'alternate_greetings', 'character_book', 'tags', 'creator', 'character_version', 'extensions']);
/** 内部字段（幂等读取用） */
const INTERNAL = new Set(['id', 'outer', 'custom', 'firstMes', 'mesExample', 'systemPrompt',
  'postHistoryInstructions', 'alternateGreetings', 'characterBook', 'creatorNotes', 'characterVersion',
  'greetingPolicy']);

const pick = (...values) => {
  for (const value of values) if (value !== undefined && value !== null) return value;
  return undefined;
};

export function readPngTextChunks(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('PNG 需要 Buffer');
  if (buffer.length < 8 || buffer.length > MAX_PNG_BYTES) throw new Error('PNG 体积不合法');
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('不是 PNG 文件（签名不匹配）');
  const out = {};
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const crcEnd = dataStart + length + 4;
    if (crcEnd > buffer.length) throw new Error('PNG chunk 越界（文件可能损坏）');
    if (type === 'tEXt') {
      const data = buffer.subarray(dataStart, dataStart + length);
      const zero = data.indexOf(0);
      if (zero > 0) out[data.toString('latin1', 0, zero)] = data.toString('latin1', zero + 1);
    }
    offset = crcEnd;
    if (type === 'IEND') break;
  }
  return out;
}

export function cardFromPng(buffer) {
  const chunks = readPngTextChunks(buffer);
  const encoded = chunks.ccv3 ?? chunks.chara;
  if (!encoded) return null;
  if (encoded.length > MAX_JSON_BYTES) throw new Error('PNG 内角色卡元数据过大');
  let json;
  try {
    json = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch (error) {
    throw new Error(`PNG 内角色卡不是合法 base64 JSON：${error?.message ?? error}`);
  }
  return normalizeCard(json);
}

/** 内部 entry → ST card book entry */
export function bookToSt(book) {
  if (!book) return null;
  return {
    name: book.name,
    entries: (book.entries ?? []).map((entry) => ({
      id: entry.uid,
      keys: entry.key ?? [],
      secondary_keys: entry.keysecondary ?? [],
      content: entry.content ?? '',
      comment: entry.comment ?? '',
      constant: entry.constant === true,
      selective: entry.selective !== false,
      selectiveLogic: entry.selectiveLogic ?? 0,
      insertion_order: entry.order ?? 100,
      enabled: entry.disable !== true,
      position: entry.position ?? 0,
      depth: entry.depth ?? null,
      role: entry.role ?? 0,
      probability: entry.probability ?? 100,
      extensions: {
        position: entry.position ?? 0,
        depth: entry.depth ?? null,
        role: entry.role ?? 0,
        probability: entry.probability ?? 100,
        selectiveLogic: entry.selectiveLogic ?? 0,
        case_sensitive: entry.caseSensitive === true,
        match_whole_words: entry.matchWholeWords === true,
      },
    })),
  };
}

/** ST card book entry → 内部 world entries */
function bookFromSt(book, fallbackName) {
  if (book === undefined || book === null) return null;
  if (typeof book !== 'object') throw new Error('character_book 必须是对象');
  const entries = asArray(book.entries, 'character_book.entries');
  return {
    name: text(book.name) || fallbackName,
    entries: entries.map((entry, index) => {
      if (!entry || typeof entry !== 'object') throw new Error(`character_book.entries[${index}] 必须是对象`);
      const ext = entry.extensions && typeof entry.extensions === 'object' ? entry.extensions : {};
      return normalizeEntry({
        uid: pick(entry.id, entry.uid, index + 1),
        key: asArray(pick(entry.keys, entry.key), 'entry.keys'),
        keysecondary: asArray(pick(entry.secondary_keys, entry.keysecondary), 'entry.secondary_keys'),
        content: text(entry.content),
        comment: text(pick(entry.comment, entry.name)),
        constant: entry.constant === true,
        selective: entry.selective !== false,
        selectiveLogic: pick(ext.selectiveLogic, entry.selectiveLogic, entry.selective_logic, 0),
        order: pick(entry.insertion_order, entry.order, index + 100),
        position: pick(ext.position, entry.position, 0),
        depth: pick(ext.depth, entry.depth, null),
        role: pick(ext.role, entry.role, 0),
        probability: pick(ext.probability, entry.probability, 100),
        disable: entry.enabled === false,
        caseSensitive: pick(ext.case_sensitive, entry.case_sensitive, false),
        matchWholeWords: pick(ext.match_whole_words, entry.match_whole_words, false),
      }, String(pick(entry.id, entry.uid, index + 1)));
    }),
  };
}

/** 归一化（幂等）：同时接受 ST 结构与内部结构。 */
export function normalizeCard(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('角色卡必须是对象');
  const spec = text(payload.spec);
  const source = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  const name = text(pick(source.name, payload.name));
  if (!name) throw new Error('角色卡缺少 name');

  // 未知字段分层
  const outer = { ...(payload.outer && typeof payload.outer === 'object' ? payload.outer : {}) };
  for (const [key, value] of Object.entries(payload)) {
    if (ST_TOP.has(key) || INTERNAL.has(key)) continue;
    outer[key] = value;
  }
  const custom = { ...(payload.custom && typeof payload.custom === 'object' ? payload.custom : {}) };
  for (const [key, value] of Object.entries(source)) {
    if (ST_TOP.has(key) || INTERNAL.has(key)) continue;
    custom[key] = value;
  }

  return {
    id: text(pick(payload.id, source.id)),
    spec: spec === 'chara_card_v3' ? 'chara_card_v3' : (spec === 'chara_card_v2' ? 'chara_card_v2' : 'chara_card_v1'),
    outer,
    custom,
    name,
    description: text(pick(source.description, payload.description)),
    personality: text(pick(source.personality, payload.personality)),
    scenario: text(pick(source.scenario, payload.scenario)),
    firstMes: text(pick(source.first_mes, payload.first_mes, source.firstMes, payload.firstMes)),
    mesExample: text(pick(source.mes_example, payload.mes_example, source.mesExample, payload.mesExample)),
    systemPrompt: text(pick(source.system_prompt, payload.system_prompt, source.systemPrompt, payload.systemPrompt)),
    postHistoryInstructions: text(pick(source.post_history_instructions, payload.post_history_instructions,
      source.postHistoryInstructions, payload.postHistoryInstructions)),
    alternateGreetings: asArray(pick(source.alternate_greetings, payload.alternate_greetings,
      source.alternateGreetings, payload.alternateGreetings), 'alternate_greetings').map(text),
    characterBook: bookFromSt(pick(source.character_book, payload.character_book, source.characterBook, payload.characterBook), `${name}的世界书`),
    creatorNotes: text(pick(source.creator_notes, payload.creator_notes, source.creatorNotes, payload.creatorNotes)),
    tags: asArray(pick(source.tags, payload.tags), 'tags').map(text),
    creator: text(pick(source.creator, payload.creator)),
    characterVersion: text(pick(source.character_version, payload.character_version, source.characterVersion, payload.characterVersion)),
    extensions: (pick(source.extensions, payload.extensions) && typeof pick(source.extensions, payload.extensions) === 'object')
      ? pick(source.extensions, payload.extensions) : {},
    greetingPolicy: text(pick(source.greeting_policy, payload.greeting_policy, source.greetingPolicy, payload.greetingPolicy)) || 'first',
  };
}

/** 导出为真正的 v2/v3（outer 回顶层，custom 回 data，book 回卡格式）。 */
export function toStCard(card) {
  const spec = card.spec === 'chara_card_v3' ? 'chara_card_v3' : 'chara_card_v2';
  const data = {
    ...(card.custom ?? {}),
    name: card.name,
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    first_mes: card.firstMes,
    mes_example: card.mesExample,
    creator_notes: card.creatorNotes,
    system_prompt: card.systemPrompt,
    post_history_instructions: card.postHistoryInstructions,
    alternate_greetings: card.alternateGreetings,
    ...(card.characterBook ? { character_book: bookToSt(card.characterBook) } : {}),
    tags: card.tags,
    creator: card.creator,
    character_version: card.characterVersion,
    extensions: exportHelperFields(card.extensions),
  };
  if (card.greetingPolicy && card.greetingPolicy !== 'first') data.greeting_policy = card.greetingPolicy;
  return {
    spec,
    spec_version: spec === 'chara_card_v3' ? '3.0' : '2.0',
    ...(card.outer ?? {}),
    data,
  };
}

export function applyCardMacros(input, { char = '', user = '用户', original = '' } = {}) {
  return String(input ?? '')
    .replaceAll('{{char}}', char)
    .replaceAll('{{user}}', user)
    .replaceAll('{{original}}', original);
}

export function resolveCardPrompts(card, { originalSystem = '', originalPostHistory = '', user = '用户' } = {}) {
  if (!card) return { system: originalSystem, postHistory: originalPostHistory, replacedSystem: false, replacedPostHistory: false };
  const char = card.name;
  return {
    system: card.systemPrompt ? applyCardMacros(card.systemPrompt, { char, user, original: originalSystem }) : originalSystem,
    postHistory: card.postHistoryInstructions
      ? applyCardMacros(card.postHistoryInstructions, { char, user, original: originalPostHistory })
      : originalPostHistory,
    replacedSystem: Boolean(card.systemPrompt),
    replacedPostHistory: Boolean(card.postHistoryInstructions),
  };
}

/** mes_example：ST 的 <START> 与「角色名: / You:」标记 → 示例消息 */
export function parseExampleMessages(mesExample, { char = '', user = '用户' } = {}) {
  const rows = [];
  const blocks = String(mesExample ?? '').split(/<START>/i).map((part) => part.trim()).filter(Boolean);
  for (const block of blocks) {
    for (const line of block.split(/\r?\n/).filter((row) => row.trim())) {
      const match = line.match(/^\s*([^:：]{1,40})[:：]\s*(.*)$/);
      if (!match) {
        rows.push({ role: 'assistant', content: applyCardMacros(line.trim(), { char, user }) });
        continue;
      }
      const speaker = match[1].trim();
      const body = match[2].trim();
      if (!body) continue;
      rows.push({
        role: speaker === char || speaker === '{{char}}' ? 'assistant' : 'user',
        content: applyCardMacros(body, { char, user }),
      });
    }
  }
  return rows;
}

export function pickGreeting(card, { user = '用户' } = {}) {
  if (!card) return '';
  const policy = card.greetingPolicy || 'first';
  if (policy === 'none') return '';
  if (policy.startsWith('alternate:')) {
    const index = Number(policy.slice('alternate:'.length));
    const value = card.alternateGreetings[index];
    if (!value) throw new Error(`开场白策略无效：alternate:${index} 不存在`);
    return applyCardMacros(value, { char: card.name, user });
  }
  return applyCardMacros(card.firstMes, { char: card.name, user });
}
